import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { CodexSessionsWatcher, type SessionsWatcherEvent } from "./sessionsWatcher";
import { PythonBackendClient, type BackendEvent, type BackendLaunch } from "./pythonClient";
import { loadState, saveState, type AppState } from "./state";
import { OptionsViewProvider, type OptionsViewModel } from "./views/optionsView";
import {
  baseLang,
  buildAnnouncePhrases,
  hasVoiceForLang,
  pickVoiceForLang,
  targetLangPhrase,
  type Voice,
} from "./langUtils";

type ProcessResult = {
  display_text?: unknown;
  label?: unknown;
  detected_lang?: unknown;
  effective_lang?: unknown;
  voice_id?: unknown;
  queue?: unknown;
};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("CodexAudio");
  // Delay startup a bit so Codex session metadata (cwd) is ready.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const state = await loadState(context);
  if (state.ttsEnabled === false) {
    state.ttsEnabled = true;
    await saveState(context, state);
  }
  // Avoid showing stale text from previous sessions on startup.
  state.lastDisplayText = "";
  state.lastQueue = [];
  state.lastTranslationLabel = "";
  let stateChangedOnStart = false;
  if (!state.showTranslationOnStart && state.showTranslationWindow) {
    state.showTranslationWindow = false;
    stateChangedOnStart = true;
  }
  if (!state.showMiniBarOnStart && state.miniBarVisible) {
    state.miniBarVisible = false;
    stateChangedOnStart = true;
  }
  if (stateChangedOnStart) {
    await saveState(context, state);
  }

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.name = "CodexAudio";
  status.command = "codexAudio.openOptions";
  status.show();
  context.subscriptions.push(status);

  const backend = new PythonBackendClient((evt) => onBackendEvent(evt));
  context.subscriptions.push(backend);

  const runtime = {
    state,
    backendOk: false,
    voices: [] as Voice[],
    availableLanguages: [] as string[],
    lastDetectedLang: "?" as string,
    lastSpokenLang: "?" as string,
    lastStatusText: "" as string,
    isSpeaking: false,
    isPaused: false,
    lastQueue: [] as string[],
    lastSourceText: "" as string,
    translateAvailable: true,
    optionsVisible: false,
    deferStartupWindows: true,
    backendInfoRetryCount: 0,
    backendInfoRetryTimer: undefined as NodeJS.Timeout | undefined,
    backendRestartCount: 0,
    backendRestartTimer: undefined as NodeJS.Timeout | undefined,
    uiAnnounceSeq: 0,
    uiAnnouncePending: null as null | {
      token: number;
      phrase: string;
      voiceId: string;
      rate: number;
      volume: number;
      force: boolean;
    },
  };
  let warnedMissingPython = false;

  const optionsProvider = new OptionsViewProvider(context, (msg) => onOptionsMessage(msg));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(OptionsViewProvider.viewType, optionsProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const watcher = new CodexSessionsWatcher((evt) => onWatcherEvent(evt), {
    pollIntervalMs: getCfgNumber("pollIntervalMs", 500),
    readLastOnStart: false,
    scrubTtsFields: getCfgBool("scrubTtsFields", false),
    workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "",
    codexLogFile: resolveCodexLogFile(),
    displayLang: () => baseLang(runtime.state.targetLang || runtime.state.uiLang || "fr"),
  });
  watcher.start();
  context.subscriptions.push({ dispose: () => watcher.stop() });

  await startBackend();
  await refreshBackendInfo();
  // Show startup windows immediately when the user enabled "on start".
  runtime.deferStartupWindows = !(
    runtime.state.showMiniBarOnStart || runtime.state.showTranslationOnStart
  );
  if (runtime.backendOk) {
    const beforeVoice = runtime.state.ttsVoiceId;
    applyVoiceForCurrentLang();
    if (beforeVoice !== runtime.state.ttsVoiceId) {
      await saveState(context, runtime.state);
    }
    await syncBackendWindows();
  }
  refreshUi();

  context.subscriptions.push(
    vscode.commands.registerCommand("codexAudio.openOptions", async () => {
      try {
        await vscode.commands.executeCommand(`${OptionsViewProvider.viewType}.focus`);
        return;
      } catch {
        // ignore (command may not exist if manifest is misconfigured)
      }
      await vscode.commands.executeCommand("workbench.view.extension.codexAudio");
      optionsProvider.show();
    }),
    vscode.commands.registerCommand("codexAudio.openTranslation", () => {
      void ensureBackend().then(async () => {
        if (!runtime.backendOk) return;
        runtime.state.showTranslationWindow = !runtime.state.showTranslationWindow;
        runtime.deferStartupWindows = false;
        await backend.request("show_translation", { show: runtime.state.showTranslationWindow });
        await persistAndRefresh();
      });
    }),
    vscode.commands.registerCommand("codexAudio.playPause", async () => {
      await ensureBackend();
      if (!runtime.backendOk) return;
      if (runtime.isSpeaking && !runtime.isPaused) {
        await backend.request("pause");
        runtime.isPaused = true;
      } else if (runtime.isPaused) {
        await backend.request("resume");
        runtime.isPaused = false;
      } else {
        if (!canSpeakForTarget()) return;
        // replay last queue if any
        if (runtime.lastQueue.length) {
          await backend.request("speak_queue", {
            queue: runtime.lastQueue,
            voice_id: runtime.state.ttsVoiceId,
            rate: runtime.state.ttsRate,
            volume: runtime.state.ttsVolume,
            app_paused: runtime.state.appPaused,
            muted: runtime.state.ttsMute,
          });
        }
      }
      refreshUi();
    }),
    vscode.commands.registerCommand("codexAudio.stop", async () => {
      await ensureBackend();
      if (!runtime.backendOk) return;
      await backend.request("stop");
      runtime.isSpeaking = false;
      runtime.isPaused = false;
      await backend.request("update_state", {
        app_paused: runtime.state.appPaused,
        muted: runtime.state.ttsMute,
        playing: false,
        theme: runtime.state.uiTheme,
        ui_lang: runtime.state.uiLang,
      });
      refreshUi();
    }),
    vscode.commands.registerCommand("codexAudio.toggleMute", async () => {
      runtime.state.ttsMute = !runtime.state.ttsMute;
      if (runtime.state.ttsMute) {
        await ensureBackend();
        if (runtime.backendOk) await backend.request("stop");
      }
      await ensureBackend();
      if (runtime.backendOk) {
        await backend.request("update_state", {
          app_paused: runtime.state.appPaused,
          muted: runtime.state.ttsMute,
          playing: runtime.isSpeaking && !runtime.isPaused,
          theme: runtime.state.uiTheme,
          ui_lang: runtime.state.uiLang,
        });
      }
      await persistAndRefresh();
    }),
    vscode.commands.registerCommand("codexAudio.togglePauseService", async () => {
      runtime.state.appPaused = !runtime.state.appPaused;
      if (runtime.state.appPaused) {
        await ensureBackend();
        if (runtime.backendOk) await backend.request("stop");
      }
      await ensureBackend();
      if (runtime.backendOk) {
        await backend.request("update_state", {
          app_paused: runtime.state.appPaused,
          muted: runtime.state.ttsMute,
          playing: runtime.isSpeaking && !runtime.isPaused,
          theme: runtime.state.uiTheme,
          ui_lang: runtime.state.uiLang,
        });
        await backend.request("show_translation", { show: shouldShowTranslation(false) });
        await backend.request("show_minibar", { show: shouldShowMiniBar(false) });
      }
      await persistAndRefresh();
    }),
  );

  async function startBackend(): Promise<void> {
    const launch = resolveBackendLaunch();
    if (!launch) {
      runtime.backendOk = false;
      output.appendLine("[backend] Python non configuré pour ce workspace.");
      return;
    }
    try {
      backend.start(launch);
      runtime.backendOk = true;
      runtime.backendRestartCount = 0;
      if (runtime.backendRestartTimer) {
        clearTimeout(runtime.backendRestartTimer);
        runtime.backendRestartTimer = undefined;
      }
      output.appendLine(`[backend] started: ${launch.label}`);
    } catch (e) {
      runtime.backendOk = false;
      output.appendLine(`[backend] failed start: ${String(e)}`);
    }
  }

  async function ensureBackend(): Promise<void> {
    if (runtime.backendOk && backend.isRunning()) return;
    runtime.backendOk = false;
    await startBackend();
    if (runtime.backendOk) await refreshBackendInfo();
  }

  async function syncBackendWindows(): Promise<void> {
    if (!runtime.backendOk) return;
    if (runtime.state.lastDisplayText && runtime.state.lastDisplayText.trim()) {
      const q =
        Array.isArray(runtime.state.lastQueue) && runtime.state.lastQueue.length
          ? runtime.state.lastQueue
          : [runtime.state.lastDisplayText];
      try {
        await backend.request("set_translation", {
          label: runtime.state.lastTranslationLabel || runtime.state.targetLang,
          text: runtime.state.lastDisplayText,
          queue: q,
          is_initial: true,
        });
      } catch {
        // ignore
      }
    }
    if (!runtime.deferStartupWindows) {
      try {
        await backend.request("show_minibar", { show: shouldShowMiniBar(true) });
      } catch {
        // ignore
      }
      try {
        await backend.request("show_translation", { show: shouldShowTranslation(true) });
      } catch {
        // ignore
      }
    } else {
      // Force-hide on startup to avoid showing windows right after update/reload.
      try {
        await backend.request("show_minibar", { show: false });
      } catch {
        // ignore
      }
      try {
        await backend.request("show_translation", { show: false });
      } catch {
        // ignore
      }
    }
    try {
      await backend.request("update_state", {
        app_paused: runtime.state.appPaused,
        muted: runtime.state.ttsMute,
        playing: runtime.isSpeaking && !runtime.isPaused,
      });
    } catch {
      // ignore
    }
  }

  async function refreshBackendInfo(): Promise<void> {
    if (!runtime.backendOk) return;
    try {
      const voices = (await backend.request("list_voices")) as Voice[];
      const langs = (await backend.request("list_available_languages")) as string[];
      const caps = (await backend.request("capabilities")) as { translate_available?: unknown };
      runtime.voices = Array.isArray(voices) ? voices : [];
      runtime.availableLanguages = Array.isArray(langs) ? langs : [];
      runtime.translateAvailable = !!caps?.translate_available;
      if (runtime.backendInfoRetryTimer) {
        clearTimeout(runtime.backendInfoRetryTimer);
        runtime.backendInfoRetryTimer = undefined;
      }
      if (runtime.voices.length === 0) {
        scheduleBackendInfoRetry();
      } else {
        runtime.backendInfoRetryCount = 0;
        const beforeVoice = runtime.state.ttsVoiceId;
        applyVoiceForCurrentLang();
        if (beforeVoice !== runtime.state.ttsVoiceId) {
          await saveState(context, runtime.state);
        }
      }
      if (!runtime.translateAvailable && runtime.state.translateEnabled) {
        runtime.state.translateEnabled = false;
        await saveState(context, runtime.state);
      }
      runtime.backendOk = true;
      refreshUi();
    } catch (e) {
      runtime.backendOk = false;
      runtime.voices = [];
      runtime.availableLanguages = [];
      runtime.translateAvailable = true;
      output.appendLine(`[backend] refresh failed: ${String(e)}`);
    }
  }

  function scheduleBackendInfoRetry(): void {
    if (!backend.isRunning()) return;
    if (runtime.backendInfoRetryTimer) return;
    if (runtime.backendInfoRetryCount >= 6) return;
    runtime.backendInfoRetryCount += 1;
    runtime.backendInfoRetryTimer = setTimeout(() => {
      runtime.backendInfoRetryTimer = undefined;
      void refreshBackendInfo();
    }, 2000);
  }

  function scheduleBackendRestart(): void {
    if (runtime.backendRestartTimer) return;
    if (runtime.backendRestartCount >= 3) return;
    runtime.backendRestartCount += 1;
    runtime.backendRestartTimer = setTimeout(() => {
      runtime.backendRestartTimer = undefined;
      void ensureBackend()
        .then(() => refreshUi())
        .catch(() => {
          // ignore
        });
    }, 2500);
  }

  function onBackendEvent(evt: BackendEvent): void {
    if (evt.type === "backend_exit") {
      runtime.backendOk = false;
      runtime.isSpeaking = false;
      runtime.isPaused = false;
      output.appendLine(`[backend] exit code=${evt.code} signal=${evt.signal ?? ""}`);
      scheduleBackendRestart();
      output.show(true);
      refreshUi();
      return;
    }
    if (evt.type === "started") {
      runtime.isSpeaking = true;
      runtime.isPaused = false;
      void ensureBackend().then(async () => {
        if (!runtime.backendOk) return;
        await backend.request("update_state", {
          app_paused: runtime.state.appPaused,
          muted: runtime.state.ttsMute,
          playing: true,
          theme: runtime.state.uiTheme,
          ui_lang: runtime.state.uiLang,
        });
      });
      refreshUi();
      return;
    }
    if (evt.type === "finished") {
      runtime.isSpeaking = false;
      runtime.isPaused = false;
      void ensureBackend().then(async () => {
        if (!runtime.backendOk) return;
        await backend.request("update_state", {
          app_paused: runtime.state.appPaused,
          muted: runtime.state.ttsMute,
          playing: false,
          theme: runtime.state.uiTheme,
          ui_lang: runtime.state.uiLang,
        });
      });
      void playPendingUiAnnouncement();
      refreshUi();
      return;
    }
    if (evt.type === "error") {
      output.appendLine(`[backend:error] ${evt.message}`);
      refreshUi();
      return;
    }
    if (evt.type === "ui_cmd") {
      if (evt.cmd === "openOptions") {
        void vscode.commands.executeCommand("codexAudio.openOptions");
        return;
      }
      if (evt.cmd === "openTranslation") {
        void vscode.commands.executeCommand("codexAudio.openTranslation");
        return;
      }
      if (evt.cmd === "translationClosed") {
        runtime.state.showTranslationWindow = false;
        void backend.request("show_translation", { show: false }).catch(() => {
          // ignore
        });
        void persistAndRefresh();
        return;
      }
      if (evt.cmd === "openFile") {
        const p = String((evt as any).path || "");
        if (!p) return;
        try {
          const uri = vscode.Uri.file(p);
          void vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true });
        } catch {
          // ignore
        }
        return;
      }
      if (evt.cmd === "playPause") {
        void vscode.commands.executeCommand("codexAudio.playPause");
        return;
      }
      if (evt.cmd === "stop") {
        void vscode.commands.executeCommand("codexAudio.stop");
        return;
      }
      if (evt.cmd === "toggleMute") {
        void vscode.commands.executeCommand("codexAudio.toggleMute");
        return;
      }
      return;
    }
    if (evt.type === "log") {
      if (evt.message === "backend_ready") {
        void syncBackendWindows();
        if (!runtime.voices.length) {
          void refreshBackendInfo();
        }
        return;
      }
      output.appendLine(evt.message);
      return;
    }
  }

  function onWatcherEvent(evt: SessionsWatcherEvent): void {
    if (evt.type === "codex_session") {
      const label = evt.name && evt.name.trim() ? evt.name.trim() : evt.id;
      output.appendLine(`[sessions] ${label} (${evt.id}) > ${evt.action}`);
      return;
    }
    if (evt.type === "loaded") {
      void onNewAssistantMessage(evt.text, true, true);
      return;
    }
    if (evt.type === "message") {
      void onNewAssistantMessage(evt.text, evt.initial === true, true);
      return;
    }
  }

  async function onNewAssistantMessage(text: string, isInitial: boolean, allowSpeak: boolean): Promise<void> {
    if (runtime.state.appPaused) return;
    await ensureBackend();
    if (!runtime.backendOk) return;

    if (!isInitial) {
      await maybeShowDeferredWindows();
    }

    runtime.lastSourceText = text;

    const wantsAutoRead =
      allowSpeak &&
      runtime.state.autoReadNewResponses &&
      runtime.state.ttsEnabled &&
      !runtime.state.ttsMute &&
      !runtime.state.appPaused;

    if (wantsAutoRead) {
      try {
        await backend.request("stop");
      } catch {
        // ignore
      }
    }

    let res: any;
    try {
      res = await backend.request("process", {
        text,
        target_lang: runtime.state.targetLang,
        translate_enabled: runtime.state.translateEnabled,
        voice_id: runtime.state.ttsVoiceId,
        tts_lang: runtime.state.translateEnabled ? runtime.state.targetLang : "",
      });
    } catch {
      return;
    }

    const displayText = String(res?.display_text ?? text);
    const label = String(res?.label ?? runtime.state.targetLang);
    const detected = String(res?.detected_lang ?? "?");
    const effective = String(res?.effective_lang ?? runtime.state.targetLang);
    const chosenVoice = String(res?.voice_id ?? runtime.state.ttsVoiceId);
    const queue = Array.isArray(res?.queue) ? (res.queue as string[]) : [];
    const normalizedQueue = normalizeQueue(queue, displayText);
    const shouldSpeakThisResponse = wantsAutoRead && !!chosenVoice && normalizedQueue.length > 0;

    runtime.lastDetectedLang = detected || runtime.lastDetectedLang;
    runtime.lastSpokenLang = effective || runtime.lastSpokenLang;
    runtime.state.ttsVoiceId = chosenVoice || runtime.state.ttsVoiceId;
    {
      const spoken = baseLang(effective || runtime.state.targetLang);
      if (spoken && chosenVoice) runtime.state.voicePerLang[spoken] = chosenVoice;
    }
    if (!runtime.state.translateEnabled) {
      const d = (runtime.lastDetectedLang || "").trim().toLowerCase();
      if (d && d !== "?" && runtime.state.targetLang.toLowerCase() !== d) {
        runtime.state.targetLang = d;
      }
    }
    runtime.lastQueue = normalizedQueue;
    runtime.state.lastDisplayText = displayText;
    runtime.state.lastTranslationLabel = label;
    runtime.state.lastQueue = normalizedQueue;

    const showTextWindow = runtime.state.showTranslationWindow;
    try {
      await backend.request("set_translation", {
        label,
        text: displayText,
        queue: normalizedQueue,
        is_initial: isInitial === true,
      });
      await backend.request("show_translation", { show: showTextWindow });
    } catch {
      // ignore
    }

    if (runtime.state.autoReadNewResponses && !shouldSpeakThisResponse) {
      output.appendLine(
        `[auto-read] bloqué: ttsEnabled=${runtime.state.ttsEnabled} mute=${runtime.state.ttsMute} paused=${runtime.state.appPaused} voiceReady=${!!chosenVoice} queue=${normalizedQueue.length}`,
      );
    }

    if (shouldSpeakThisResponse) {
      try {
        await backend.request("speak_queue", {
          queue: normalizedQueue,
          voice_id: runtime.state.ttsVoiceId,
          rate: runtime.state.ttsRate,
          volume: runtime.state.ttsVolume,
          app_paused: runtime.state.appPaused,
          muted: runtime.state.ttsMute,
        });
        output.appendLine(`[auto-read] lecture lancée (${normalizedQueue.length} segments).`);
      } catch {
        // ignore
      }
    }

    await persistAndRefresh();
  }

  async function onOptionsMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;

    if (m.type === "cmd" && typeof m.cmd === "string") {
      const cmd = m.cmd;
      if (cmd === "openTranslation") {
        await vscode.commands.executeCommand("codexAudio.openTranslation");
        return;
      }
      if (cmd === "playPause") {
        await vscode.commands.executeCommand("codexAudio.playPause");
        return;
      }
      if (cmd === "stop") {
        await vscode.commands.executeCommand("codexAudio.stop");
        return;
      }
      if (cmd === "toggleMute") {
        await vscode.commands.executeCommand("codexAudio.toggleMute");
        return;
      }
      if (cmd === "testVoice") {
        await ensureBackend();
        if (!runtime.backendOk) return;
        if (!runtime.voices.length) {
          await refreshBackendInfo();
        }
        const uiLang = baseLang(runtime.state.uiLang || "fr");
        const voiceId =
          pickVoiceForLang(runtime.voices, runtime.state.ttsVoiceId, "", uiLang) ||
          runtime.voices[0]?.id ||
          runtime.state.ttsVoiceId;
        if (!voiceId) {
          vscode.window.showWarningMessage("CodexAudio: aucune voix installée pour tester.");
          return;
        }
        const text = uiLang === "fr" ? "Test de voix." : "Voice test.";
        try {
          await backend.request("speak_after", {
            queue: [text],
            voice_id: voiceId,
            rate: runtime.state.ttsRate,
            volume: runtime.state.ttsVolume,
            app_paused: false,
            muted: false,
          });
        } catch (err) {
          const msg = String(err || "Erreur test voix");
          output.appendLine(`[test-voice] ${msg}`);
          vscode.window.showWarningMessage(`CodexAudio: test voix échoué: ${msg}`);
        }
        return;
      }
    }

    if (m.type === "optionsVisibility" && typeof m.visible === "boolean") {
      runtime.optionsVisible = m.visible;
      return;
    }

    if (m.type === "patchState" && m.patch && typeof m.patch === "object") {
      const announce = m.announce === true;
      const announceKey = typeof m.announceKey === "string" ? m.announceKey : "";
      const patch = m.patch as Partial<AppState>;
      runtime.state = { ...runtime.state, ...patch };
      const targetLangChanged = Object.prototype.hasOwnProperty.call(patch, "targetLang");
      const translateChanged = Object.prototype.hasOwnProperty.call(patch, "translateEnabled");
      const shouldInterrupt = targetLangChanged || translateChanged;
      let reprocessQueue: string[] | null = null;

      if (patch.uiLang) {
        const ui = baseLang(String(patch.uiLang));
        runtime.state.uiLang = ui;
        applyVoiceForCurrentLang();
      }

      if (patch.translateEnabled === false) {
        runtime.state.savedTargetLang = runtime.state.targetLang;
        const d = (runtime.lastDetectedLang || "").trim().toLowerCase();
        if (d && d !== "?") runtime.state.targetLang = d;
      } else if (patch.translateEnabled === true) {
        const saved = (runtime.state.savedTargetLang || "").trim().toLowerCase();
        if (saved) runtime.state.targetLang = saved;
      }

      if (patch.targetLang) {
        runtime.state.targetLang = String(patch.targetLang).trim().toLowerCase();
        applyVoiceForCurrentLang();
      }

      if (patch.ttsVoiceId) {
        const lang = currentVoiceLangKey();
        if (lang) runtime.state.voicePerLang[lang] = patch.ttsVoiceId;
      }

      if (shouldInterrupt) {
        await interruptPlayback();
      }

      const needsReprocess = targetLangChanged || translateChanged;
      if (needsReprocess && runtime.lastSourceText && runtime.lastSourceText.trim()) {
        await ensureBackend();
        if (runtime.backendOk) {
          try {
            const res = await backend.request<ProcessResult>("process", {
              text: runtime.lastSourceText,
              target_lang: runtime.state.targetLang,
              translate_enabled: runtime.state.translateEnabled,
              voice_id: runtime.state.ttsVoiceId,
              tts_lang: runtime.state.translateEnabled ? runtime.state.targetLang : "",
            });
            const displayText = String(res?.display_text ?? runtime.lastSourceText);
            const label = String(res?.label ?? runtime.state.targetLang);
            const detected = String(res?.detected_lang ?? "?");
            const effective = String(res?.effective_lang ?? runtime.state.targetLang);
            const chosenVoice = String(res?.voice_id ?? runtime.state.ttsVoiceId);
            const queue = Array.isArray(res?.queue) ? (res.queue as string[]) : [];
            const normalizedQueue = normalizeQueue(queue, displayText);

            runtime.lastDetectedLang = detected || runtime.lastDetectedLang;
            runtime.lastSpokenLang = effective || runtime.lastSpokenLang;
            runtime.state.ttsVoiceId = chosenVoice || runtime.state.ttsVoiceId;
            {
              const spoken = baseLang(effective || runtime.state.targetLang);
              if (spoken && chosenVoice) runtime.state.voicePerLang[spoken] = chosenVoice;
            }
            runtime.lastQueue = normalizedQueue;
            runtime.state.lastDisplayText = displayText;
            runtime.state.lastTranslationLabel = label;
            runtime.state.lastQueue = normalizedQueue;
            reprocessQueue = normalizedQueue;

            await backend.request("set_translation", {
              label,
              text: displayText,
              queue: normalizedQueue,
              is_initial: false,
            });
          } catch {
            // ignore
          }
        }
      }

      if (patch.appPaused || patch.ttsMute || patch.ttsEnabled === false) {
        await ensureBackend();
        if (runtime.backendOk) await backend.request("stop");
      }
      await ensureBackend();
      if (runtime.backendOk) {
        await backend.request("update_state", {
          app_paused: runtime.state.appPaused,
          muted: runtime.state.ttsMute,
          playing: runtime.isSpeaking && !runtime.isPaused,
          theme: runtime.state.uiTheme,
          ui_lang: runtime.state.uiLang,
        });
        await backend.request("show_translation", { show: shouldShowTranslation(false) });
        await backend.request("show_minibar", { show: shouldShowMiniBar(false) });
      }
      const shouldSpeakReprocess =
        targetLangChanged &&
        Array.isArray(reprocessQueue) &&
        reprocessQueue.length > 0 &&
        runtime.state.ttsEnabled &&
        !runtime.state.ttsMute &&
        !runtime.state.appPaused &&
        canSpeakForTarget();
      if (shouldSpeakReprocess) {
        await ensureBackend();
        if (runtime.backendOk) {
          try {
            await backend.request("speak_queue", {
              queue: reprocessQueue,
              voice_id: runtime.state.ttsVoiceId,
              rate: runtime.state.ttsRate,
              volume: runtime.state.ttsVolume,
              app_paused: runtime.state.appPaused,
              muted: runtime.state.ttsMute,
            });
          } catch {
            // ignore
          }
        }
      } else if (announce && announceKey) {
        void announceOptionChange(announceKey);
      }
      await persistAndRefresh();
      return;
    }
  }

  async function announceOptionChange(key: string): Promise<void> {
    const force = runtime.optionsVisible;
    const allowWhenDisabled = force || key === "ui_announcements";
    if (!runtime.state.uiAnnouncementsEnabled && !allowWhenDisabled) return;
    if (runtime.state.ttsMute) return;
    const token = ++runtime.uiAnnounceSeq;
    await ensureBackend();
    if (!runtime.backendOk) return;
    if (token !== runtime.uiAnnounceSeq) return;

    const uiLang = baseLang(runtime.state.uiLang);
    const uiVoiceId = pickVoiceForLang(
      runtime.voices,
      runtime.state.voicePerLang?.[uiLang] || "",
      runtime.state.ttsVoiceId,
      uiLang,
    );
    if (!uiVoiceId) return;
    const ratePct = Math.round((runtime.state.ttsRate || 1) * 100);
    const volumePct = Math.round(runtime.state.ttsVolume ?? 80);
    const voiceLabel = (() => {
      const id = uiVoiceId || "";
      const v = runtime.voices.find((x) => x.id === id);
      if (v) return v.name;
      return id ? id : "Auto";
    })();

    const targetPhrase = targetLangPhrase(uiLang, runtime.state.targetLang);
    const phrases = buildAnnouncePhrases(uiLang, {
      voiceLabel,
      ratePct,
      volumePct,
      appPaused: runtime.state.appPaused,
      muted: runtime.state.ttsMute,
      translateEnabled: runtime.state.translateEnabled,
      uiAnnouncements: runtime.state.uiAnnouncementsEnabled,
      autoRead: runtime.state.autoReadNewResponses,
      barTop: runtime.state.miniBarVisible,
      barStart: runtime.state.showMiniBarOnStart,
      showText: runtime.state.showTranslationWindow,
      showTextStart: runtime.state.showTranslationOnStart,
      targetPhrase,
      theme: runtime.state.uiTheme === "light" ? "light" : "dark",
    });

    const phrase = phrases[key];
    if (!phrase) return;

    try {
      if (token !== runtime.uiAnnounceSeq) return;
      const payload = {
        token,
        phrase,
        voiceId: uiVoiceId,
        rate: runtime.state.ttsRate,
        volume: runtime.state.ttsVolume,
        force,
      };
      if (runtime.isSpeaking) {
        runtime.uiAnnouncePending = payload;
        return;
      }
      runtime.uiAnnouncePending = null;
      await playUiAnnouncement(payload);
    } catch {
      // ignore
    }
  }

  async function playUiAnnouncement(payload: {
    token: number;
    phrase: string;
    voiceId: string;
    rate: number;
    volume: number;
    force: boolean;
  }): Promise<void> {
    if (payload.token !== runtime.uiAnnounceSeq) return;
    await ensureBackend();
    if (!runtime.backendOk) return;
    if (runtime.state.ttsMute) return;
    if (runtime.isSpeaking) return;
    await backend.request("speak_queue", {
      queue: [payload.phrase],
      voice_id: payload.voiceId,
      rate: payload.rate,
      volume: payload.volume,
      app_paused: runtime.state.appPaused,
      muted: runtime.state.ttsMute,
    });
  }

  async function playPendingUiAnnouncement(): Promise<void> {
    const pending = runtime.uiAnnouncePending;
    if (!pending) return;
    if (runtime.isSpeaking) return;
    if (runtime.state.ttsMute) return;
    runtime.uiAnnouncePending = null;
    await playUiAnnouncement(pending);
  }

  async function interruptPlayback(): Promise<void> {
    await ensureBackend();
    if (!runtime.backendOk) return;
    if (!runtime.isSpeaking && !runtime.isPaused) return;
    try {
      await backend.request("stop");
    } catch {
      // ignore
    }
    runtime.isSpeaking = false;
    runtime.isPaused = false;
  }

  function currentVoiceLangKey(): string {
    const lang = runtime.state.translateEnabled
      ? runtime.state.targetLang
      : runtime.lastDetectedLang && runtime.lastDetectedLang !== "?"
        ? runtime.lastDetectedLang
        : runtime.state.targetLang;
    return baseLang(lang || runtime.state.uiLang);
  }

  function applyVoiceForCurrentLang(): void {
    const lang = currentVoiceLangKey();
    const preferred = runtime.state.voicePerLang?.[baseLang(lang)] || "";
    const chosen = pickVoiceForLang(runtime.voices, preferred, runtime.state.ttsVoiceId, lang);
    if (chosen) {
      runtime.state.ttsVoiceId = chosen;
      runtime.state.voicePerLang[lang] = chosen;
    }
  }

  function shouldShowTranslation(useStartFlag: boolean): boolean {
    if (runtime.state.appPaused) return false;
    if (!runtime.state.showTranslationWindow) return false;
    return useStartFlag ? runtime.state.showTranslationOnStart : true;
  }

  function shouldShowMiniBar(useStartFlag: boolean): boolean {
    if (runtime.state.appPaused) return false;
    if (!runtime.state.miniBarVisible) return false;
    return useStartFlag ? runtime.state.showMiniBarOnStart : true;
  }

  async function persistAndRefresh(): Promise<void> {
    await saveState(context, runtime.state);
    refreshUi();
  }

  function refreshUi(): void {
    const engine = runtime.state.ttsVoiceId.startsWith("winrt:") ? "WinRT" : runtime.state.ttsVoiceId ? "Custom" : "Auto";
    let text = "";
    if (!runtime.backendOk) {
      text = "$(warning) Backend Python indisponible";
    } else if (runtime.state.appPaused) {
      text = `$(debug-pause) Pause • ${engine}`;
    } else if (runtime.isPaused) {
      text = `$(debug-pause) Pause lecture • ${engine}`;
    } else if (runtime.isSpeaking) {
      text = `$(unmute) Lecture… (${runtime.lastDetectedLang} → ${runtime.state.targetLang}) • ${engine}`;
    } else {
      text = `$(check) Actif • Dernière langue: ${runtime.lastDetectedLang} • ${engine}`;
    }
    if (runtime.state.ttsMute) text += " • $(mute) Muet";
    if (!runtime.state.translateEnabled) text += " • $(globe) Traduction OFF";
    runtime.lastStatusText = text;
    status.text = `CodexAudio: ${text}`;

    const model: OptionsViewModel = {
      state: runtime.state,
      voices: runtime.voices,
      availableLanguages: runtime.availableLanguages,
      statusText: text,
      detectedLang: runtime.lastDetectedLang,
      backendOk: runtime.backendOk,
      translateAvailable: runtime.translateAvailable,
    };
    optionsProvider.setModel(model);
  }

  function getCfgString(key: string, def: string): string {
    return vscode.workspace.getConfiguration("codexAudio").get<string>(key, def);
  }
  function getCfgNumber(key: string, def: number): number {
    return vscode.workspace.getConfiguration("codexAudio").get<number>(key, def);
  }
  function getCfgBool(key: string, def: boolean): boolean {
    return vscode.workspace.getConfiguration("codexAudio").get<boolean>(key, def);
  }

  function resolvePathPlaceholders(raw: string): string {
    let out = String(raw || "");
    if (!out) return out;
    if (out.includes("${workspaceFolder}")) {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
      if (folder) out = out.replaceAll("${workspaceFolder}", folder);
    }
    return out;
  }

  function resolveBackendLaunch(): BackendLaunch | undefined {
    if (process.platform === "win32") {
      const exe = path.join(context.extensionPath, "backend-win", "CodexAudioBackend", "CodexAudioBackend.exe");
      if (fs.existsSync(exe)) {
        return {
          command: exe,
          args: [],
          label: "CodexAudioBackend.exe",
        };
      }
    }

    const pythonPath = resolvePythonPath();
    if (!pythonPath) return undefined;
    const trimmedPythonPath = pythonPath.trim();
    const expectsExplicitPython =
      trimmedPythonPath.includes("\\") ||
      trimmedPythonPath.includes("/") ||
      (process.platform === "win32" && trimmedPythonPath.includes(":")) ||
      trimmedPythonPath.toLowerCase().endsWith(".exe");

    return {
      command: pythonPath,
      args: [path.join(context.extensionPath, "python", "codex_audio_backend.py")],
      label: pythonPath,
      expectedPython: expectsExplicitPython ? trimmedPythonPath : "",
    };
  }

  function resolveCodexLogFile(): string | undefined {
    const ownLogDir = context.logUri?.fsPath || "";
    if (!ownLogDir) return undefined;
    const exthostDir = path.dirname(ownLogDir);
    return path.join(exthostDir, "openai.chatgpt", "Codex.log");
  }

  function resolvePythonPath(): string | undefined {
    const configured = resolvePathPlaceholders(getCfgString("pythonPath", ""));
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
    const venvCandidate =
      workspaceFolder && process.platform === "win32"
        ? path.join(workspaceFolder, ".venv", "Scripts", "python.exe")
        : workspaceFolder
          ? path.join(workspaceFolder, ".venv", "bin", "python")
          : "";

    const candidates: string[] = [];
    if (configured) candidates.push(configured);
    if (venvCandidate && venvCandidate !== configured) candidates.push(venvCandidate);

    const missing: string[] = [];
    for (const candidate of candidates) {
      if (!candidate.trim()) continue;
      const looksLikePath =
        candidate.includes("\\") ||
        candidate.includes("/") ||
        (process.platform === "win32" && candidate.includes(":")) ||
        candidate.toLowerCase().endsWith(".exe");
      if (!looksLikePath) return candidate;
      if (fs.existsSync(candidate)) return candidate;
      missing.push(candidate);
    }

    if (missing.length && !warnedMissingPython) {
      warnedMissingPython = true;
      output.appendLine(`[backend] python introuvable, chemins testés: ${missing.join(" ; ")}`);
    }

    return undefined;
  }

  async function maybeShowDeferredWindows(): Promise<void> {
    if (!runtime.deferStartupWindows) return;
    runtime.deferStartupWindows = false;
    if (!runtime.backendOk) return;
    try {
      await backend.request("show_minibar", { show: shouldShowMiniBar(false) });
    } catch {
      // ignore
    }
    try {
      await backend.request("show_translation", { show: shouldShowTranslation(false) });
    } catch {
      // ignore
    }
  }

  function hasVoiceForUiLang(): boolean {
    return hasVoiceForLang(runtime.voices, runtime.state.uiLang);
  }

  function hasVoiceForTargetLang(): boolean {
    return hasVoiceForLang(runtime.voices, runtime.state.targetLang);
  }

  function canSpeakForTarget(): boolean {
    return hasVoiceForTargetLang();
  }

  function normalizeQueue(queue: string[], fallbackText: string): string[] {
    if (Array.isArray(queue) && queue.length > 0) return queue;
    const fallback = String(fallbackText || "").trim();
    return fallback ? [fallback] : [];
  }
}

export function deactivate(): void {
  // handled by disposables
}
