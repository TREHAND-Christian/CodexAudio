import * as vscode from "vscode";
import { CodexSessionsWatcher, type SessionsWatcherEvent } from "./sessionsWatcher";
import { PythonBackendClient, type BackendEvent } from "./pythonClient";
import { loadState, saveState, type AppState } from "./state";
import { OptionsViewProvider, type OptionsViewModel } from "./views/optionsView";

type Voice = { id: string; name: string; languages: string[]; engine?: string };

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("CodexAudio");
  const state = await loadState(context);

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

  const optionsProvider = new OptionsViewProvider(context, (msg) => onOptionsMessage(msg));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(OptionsViewProvider.viewType, optionsProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const watcher = new CodexSessionsWatcher((evt) => onWatcherEvent(evt), {
    pollIntervalMs: getCfgNumber("pollIntervalMs", 500),
    readLastOnStart: getCfgBool("readLastOnStart", true),
    scrubTtsFields: getCfgBool("scrubTtsFields", true),
  });
  watcher.start();
  context.subscriptions.push({ dispose: () => watcher.stop() });

  await startBackend();
  await refreshBackendInfo();
  if (runtime.backendOk) {
    const beforeVoice = runtime.state.ttsVoiceId;
    applyVoiceForCurrentLang();
    if (beforeVoice !== runtime.state.ttsVoiceId) {
      await saveState(context, runtime.state);
    }
  }
  if (runtime.backendOk) {
    try {
      if (runtime.state.lastDisplayText && runtime.state.lastDisplayText.trim()) {
        const q =
          Array.isArray(runtime.state.lastQueue) && runtime.state.lastQueue.length
            ? runtime.state.lastQueue
            : [runtime.state.lastDisplayText];
        await backend.request("set_translation", {
          label: runtime.state.lastTranslationLabel || runtime.state.targetLang,
          text: runtime.state.lastDisplayText,
          queue: q,
        });
      }
      await backend.request("show_minibar", { show: runtime.state.showMiniBarOnStart && runtime.state.miniBarVisible });
      await backend.request("show_translation", { show: runtime.state.showTranslationWindow });
      await backend.request("update_state", {
        app_paused: runtime.state.appPaused,
        muted: runtime.state.ttsMute,
        playing: runtime.isSpeaking && !runtime.isPaused,
      });
    } catch {
      // ignore
    }
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
        await backend.request("show_translation", { show: true });
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
        });
      }
      await persistAndRefresh();
    }),
  );

  async function startBackend(): Promise<void> {
    const pythonPath = getCfgString("pythonPath", "");
    try {
      backend.start(pythonPath, context.extensionPath);
      runtime.backendOk = true;
      output.appendLine(`[backend] started: ${pythonPath}`);
    } catch (e) {
      runtime.backendOk = false;
      vscode.window.showErrorMessage(`CodexAudio: impossible de démarrer le backend Python: ${String(e)}`);
      output.appendLine(`[backend] failed start: ${String(e)}`);
    }
  }

  async function ensureBackend(): Promise<void> {
    if (runtime.backendOk && backend.isRunning()) return;
    runtime.backendOk = false;
    await startBackend();
    if (runtime.backendOk) await refreshBackendInfo();
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
      if (!hasVoiceForUiLang() && runtime.state.autoReadNewResponses) {
        runtime.state.autoReadNewResponses = false;
        await saveState(context, runtime.state);
      }
      if (!runtime.translateAvailable && runtime.state.translateEnabled) {
        runtime.state.translateEnabled = false;
        await saveState(context, runtime.state);
      }
      runtime.backendOk = true;
    } catch (e) {
      runtime.backendOk = false;
      runtime.voices = [];
      runtime.availableLanguages = [];
      runtime.translateAvailable = true;
      vscode.window.showWarningMessage(`CodexAudio: backend Python indisponible: ${String(e)}`);
      output.appendLine(`[backend] refresh failed: ${String(e)}`);
    }
  }

  function onBackendEvent(evt: BackendEvent): void {
    if (evt.type === "backend_exit") {
      runtime.backendOk = false;
      runtime.isSpeaking = false;
      runtime.isPaused = false;
      output.appendLine(`[backend] exit code=${evt.code} signal=${evt.signal ?? ""}`);
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
        });
      });
      void playPendingUiAnnouncement();
      refreshUi();
      return;
    }
    if (evt.type === "error") {
      vscode.window.showWarningMessage(`CodexAudio: ${evt.message}`);
      output.appendLine(`[backend:error] ${evt.message}`);
      output.show(true);
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
      output.appendLine(evt.message);
      return;
    }
  }

  function onWatcherEvent(evt: SessionsWatcherEvent): void {
    if (evt.type === "message") {
      void onNewAssistantMessage(evt.text);
      return;
    }
  }

  async function onNewAssistantMessage(text: string): Promise<void> {
    if (runtime.state.appPaused) return;
    await ensureBackend();
    if (!runtime.backendOk) return;

    runtime.lastSourceText = text;

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
    runtime.lastQueue = queue;
    runtime.state.lastDisplayText = displayText;
    runtime.state.lastTranslationLabel = label;
    runtime.state.lastQueue = queue.length ? queue : [displayText];

    const showTextWindow = runtime.state.showTranslationWindow;
    try {
      await backend.request("set_translation", {
        label,
        text: displayText,
        queue: queue.length ? queue : [displayText],
      });
      await backend.request("show_translation", { show: showTextWindow });
    } catch {
      // ignore
    }

    if (
      runtime.state.autoReadNewResponses &&
      runtime.state.ttsEnabled &&
      !runtime.state.ttsMute &&
      !runtime.state.appPaused &&
      canSpeakForTarget()
    ) {
      try {
        await backend.request("stop");
        await backend.request("speak_queue", {
          queue,
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
        if (!canSpeakForTarget()) return;
        const text = runtime.state.uiLang === "fr" ? "Test de voix." : "Voice test.";
        await backend.request("stop");
        await backend.request("speak_queue", {
          queue: [text],
          voice_id: runtime.state.ttsVoiceId,
          rate: runtime.state.ttsRate,
          volume: runtime.state.ttsVolume,
          app_paused: runtime.state.appPaused,
          muted: runtime.state.ttsMute,
        });
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
      const shouldInterrupt = (announce && !!announceKey) || targetLangChanged;
      let reprocessQueue: string[] | null = null;

      if (patch.uiLang) {
        const ui = baseLang(String(patch.uiLang));
        runtime.state.uiLang = ui;
        applyVoiceForCurrentLang();
        if (!hasVoiceForUiLang() && runtime.state.autoReadNewResponses) {
          runtime.state.autoReadNewResponses = false;
        }
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
            const res = await backend.request("process", {
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

            runtime.lastDetectedLang = detected || runtime.lastDetectedLang;
            runtime.lastSpokenLang = effective || runtime.lastSpokenLang;
            runtime.state.ttsVoiceId = chosenVoice || runtime.state.ttsVoiceId;
            {
              const spoken = baseLang(effective || runtime.state.targetLang);
              if (spoken && chosenVoice) runtime.state.voicePerLang[spoken] = chosenVoice;
            }
            runtime.lastQueue = queue;
            runtime.state.lastDisplayText = displayText;
            runtime.state.lastTranslationLabel = label;
            runtime.state.lastQueue = queue.length ? queue : [displayText];
            reprocessQueue = runtime.state.lastQueue;

            await backend.request("set_translation", {
              label,
              text: displayText,
              queue: queue.length ? queue : [displayText],
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
        });
        await backend.request("show_translation", { show: runtime.state.showTranslationWindow });
        await backend.request("show_minibar", { show: runtime.state.miniBarVisible });
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
    if (runtime.state.ttsMute && !force) return;
    const token = ++runtime.uiAnnounceSeq;
    await ensureBackend();
    if (!runtime.backendOk) return;
    if (token !== runtime.uiAnnounceSeq) return;

    const uiLang = baseLang(runtime.state.uiLang);
    const uiVoiceId = pickVoiceForLang(uiLang);
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
      targetPhrase,
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
    if (runtime.state.ttsMute && !payload.force) return;
    if (runtime.isSpeaking) return;
    await backend.request("speak_queue", {
      queue: [payload.phrase],
      voice_id: payload.voiceId,
      rate: payload.rate,
      volume: payload.volume,
      app_paused: runtime.state.appPaused,
      muted: payload.force ? false : runtime.state.ttsMute,
    });
  }

  async function playPendingUiAnnouncement(): Promise<void> {
    const pending = runtime.uiAnnouncePending;
    if (!pending) return;
    if (runtime.isSpeaking) return;
    if (runtime.state.ttsMute && !pending.force) return;
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

  function targetLangPhrase(uiLang: string, targetLang: string): string {
    const label = {
      fr: "Français",
      en: "English",
      de: "Deutsch",
      es: "Español",
      it: "Italiano",
      pt: "Português",
      nl: "Nederlands",
      ru: "Русский",
      ja: "日本語",
      zh: "中文",
      ar: "العربية",
    }[baseLang(targetLang)] || baseLang(targetLang);
    return label || (baseLang(uiLang) === "en" ? "Auto" : "Auto");
  }

  function buildAnnouncePhrases(
    uiLang: string,
    ctx: {
      voiceLabel: string;
      ratePct: number;
      volumePct: number;
      appPaused: boolean;
      muted: boolean;
      translateEnabled: boolean;
      uiAnnouncements: boolean;
      autoRead: boolean;
      barTop: boolean;
      barStart: boolean;
      showText: boolean;
      targetPhrase: string;
    },
  ): Record<string, string> {
    const fr: Record<string, string> = {
      voice: `La voix est réglée sur ${ctx.voiceLabel}.`,
      rate: `La vitesse est réglée à ${ctx.ratePct} %.`,
      volume: `Le volume est réglé à ${ctx.volumePct} %.`,
      ui_announcements: `Les annonces audio de l'interface sont ${ctx.uiAnnouncements ? "activées" : "désactivées"}.`,
      app_paused: ctx.appPaused ? "Le service est en pause." : "Le service est actif.",
      tts_mute: ctx.muted ? "La lecture est coupée." : "La lecture est active.",
      translate: `La traduction est ${ctx.translateEnabled ? "activée" : "désactivée"}.`,
      auto_read: `La lecture automatique est ${ctx.autoRead ? "activée" : "désactivée"}.`,
      bar_top: `La barre flottante est ${ctx.barTop ? "affichée" : "masquée"}.`,
      bar_start: ctx.barStart ? "La barre flottante s'affiche au démarrage." : "La barre flottante ne s'affiche pas au démarrage.",
      show_text: `La fenêtre texte est ${ctx.showText ? "affichée" : "masquée"}.`,
      target_lang: `La langue cible est ${ctx.targetPhrase}.`,
    };
    const en: Record<string, string> = {
      voice: `The voice is set to ${ctx.voiceLabel}.`,
      rate: `The speed is set to ${ctx.ratePct} percent.`,
      volume: `The volume is set to ${ctx.volumePct} percent.`,
      ui_announcements: `Interface announcements are ${ctx.uiAnnouncements ? "enabled" : "disabled"}.`,
      app_paused: ctx.appPaused ? "The service is paused." : "The service is active.",
      tts_mute: ctx.muted ? "Playback is muted." : "Playback is active.",
      translate: `Translation is ${ctx.translateEnabled ? "enabled" : "disabled"}.`,
      auto_read: `Auto-read is ${ctx.autoRead ? "enabled" : "disabled"}.`,
      bar_top: `The floating bar is ${ctx.barTop ? "shown" : "hidden"}.`,
      bar_start: ctx.barStart ? "The floating bar shows on startup." : "The floating bar does not show on startup.",
      show_text: `The text window is ${ctx.showText ? "shown" : "hidden"}.`,
      target_lang: `The target language is ${ctx.targetPhrase}.`,
    };
    const table = baseLang(uiLang) === "en" ? en : fr;
    return table;
  }

  function baseLang(code: string): string {
    return String(code || "")
      .trim()
      .toLowerCase()
      .split("-")[0] || "fr";
  }

  function hasVoiceForLang(code: string): boolean {
    const c = baseLang(code);
    if (!c) return false;
    return runtime.voices.some((v) => {
      const langs = Array.isArray(v.languages) ? v.languages : [];
      return langs.some((l) => String(l || "").toLowerCase().startsWith(c));
    });
  }

  function hasVoiceForUiLang(): boolean {
    return hasVoiceForLang(runtime.state.uiLang);
  }

  function hasVoiceForTargetLang(): boolean {
    return hasVoiceForLang(runtime.state.targetLang);
  }

  function canSpeakForTarget(): boolean {
    return hasVoiceForTargetLang() && hasVoiceForUiLang();
  }

  function voiceMatchesLang(voiceId: string, lang: string): boolean {
    const id = String(voiceId || "").trim();
    if (!id) return false;
    const c = baseLang(lang);
    for (const v of runtime.voices) {
      if (v && v.id === id) {
        const langs = Array.isArray(v.languages) ? v.languages : [];
        return langs.some((l) => String(l || "").toLowerCase().startsWith(c));
      }
    }
    return false;
  }

  function pickVoiceForLang(lang: string): string {
    const c = baseLang(lang);
    const preferred = runtime.state.voicePerLang?.[c];
    if (preferred && voiceMatchesLang(preferred, c)) return preferred;
    if (voiceMatchesLang(runtime.state.ttsVoiceId, c)) return runtime.state.ttsVoiceId;
    for (const v of runtime.voices) {
      const langs = Array.isArray(v.languages) ? v.languages : [];
      if (langs.some((l) => String(l || "").toLowerCase().startsWith(c))) return v.id;
    }
    return "";
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
    const chosen = pickVoiceForLang(lang);
    if (chosen) {
      runtime.state.ttsVoiceId = chosen;
      runtime.state.voicePerLang[lang] = chosen;
    }
  }

  async function persistAndRefresh(): Promise<void> {
    await saveState(context, runtime.state);
    refreshUi();
  }

  function refreshUi(): void {
    const engine = runtime.state.ttsVoiceId.startsWith("winrt:") ? "WinRT" : runtime.state.ttsVoiceId ? "Custom" : "Auto";
    let text = "";
    if (runtime.state.appPaused) {
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
}

export function deactivate(): void {
  // handled by disposables
}
