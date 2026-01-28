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
    uiAnnounceSeq: 0,
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

    if (m.type === "patchState" && m.patch && typeof m.patch === "object") {
      const announce = m.announce === true;
      const announceKey = typeof m.announceKey === "string" ? m.announceKey : "";
      const patch = m.patch as Partial<AppState>;
      runtime.state = { ...runtime.state, ...patch };

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

      const needsReprocess =
        Object.prototype.hasOwnProperty.call(patch, "targetLang") || Object.prototype.hasOwnProperty.call(patch, "translateEnabled");
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
      if (announce && announceKey) {
        void announceOptionChange(announceKey);
      }
      await persistAndRefresh();
      return;
    }
  }

  async function announceOptionChange(key: string): Promise<void> {
    if (!runtime.state.ttsEnabled || runtime.state.ttsMute || runtime.state.appPaused) return;
    if (!runtime.state.uiAnnouncementsEnabled) return;
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
      if (runtime.isSpeaking || runtime.isPaused) {
        await backend.request("stop");
        runtime.isSpeaking = false;
        runtime.isPaused = false;
      }
      if (token !== runtime.uiAnnounceSeq) return;
      await backend.request("speak_queue", {
        queue: [phrase],
        voice_id: uiVoiceId,
        rate: runtime.state.ttsRate,
        volume: runtime.state.ttsVolume,
        app_paused: runtime.state.appPaused,
        muted: runtime.state.ttsMute,
      });
    } catch {
      // ignore
    }
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
    const templates: Record<string, string> = {
      fr: "la langue cible est {label}",
      en: "the target language is {label}",
      de: "die Zielsprache ist {label}",
      es: "el idioma de destino es {label}",
      it: "la lingua di destinazione è {label}",
      pt: "o idioma de destino é {label}",
      nl: "de doeltaal is {label}",
      ru: "целевой язык — {label}",
      ja: "ターゲット言語は{label}です",
      zh: "目标语言是{label}",
      ar: "اللغة المستهدفة هي {label}",
    };
    return (templates[baseLang(uiLang)] || templates.fr).replace("{label}", label);
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
      voice: `la voix est maintenant ${ctx.voiceLabel}`,
      rate: `la vitesse de la voix est réglée sur ${ctx.ratePct} pour cent`,
      volume: `le volume est réglé sur ${ctx.volumePct} pour cent`,
      ui_announcements: ctx.uiAnnouncements ? "les annonces audio de l'interface sont activées" : "les annonces audio de l'interface sont désactivées",
      app_paused: ctx.appPaused ? "le service est en pause" : "le service est actif",
      tts_mute: ctx.muted ? "le tts est en mode muet" : "le tts n'est plus en mode muet",
      translate: ctx.translateEnabled ? "la traduction est activée" : "la traduction est désactivée",
      auto_read: ctx.autoRead ? "la lecture automatique est activée" : "la lecture automatique est désactivée",
      bar_top: ctx.barTop ? "la barre flottante est affichée" : "la barre flottante est masquée",
      bar_start: ctx.barStart
        ? "la barre flottante s'affichera au démarrage"
        : "la barre flottante ne s'affichera pas au démarrage",
      show_text: ctx.showText ? "l'affichage du texte est activé" : "l'affichage du texte est désactivé",
      target_lang: ctx.targetPhrase,
    };
    const en: Record<string, string> = {
      voice: `the voice is now ${ctx.voiceLabel}`,
      rate: `the voice speed is set to ${ctx.ratePct} percent`,
      volume: `the volume is set to ${ctx.volumePct} percent`,
      ui_announcements: ctx.uiAnnouncements ? "interface audio announcements are enabled" : "interface audio announcements are disabled",
      app_paused: ctx.appPaused ? "the service is paused" : "the service is active",
      tts_mute: ctx.muted ? "tts is muted" : "tts is unmuted",
      translate: ctx.translateEnabled ? "translation is enabled" : "translation is disabled",
      auto_read: ctx.autoRead ? "auto read is enabled" : "auto read is disabled",
      bar_top: ctx.barTop ? "floating bar is shown" : "floating bar is hidden",
      bar_start: ctx.barStart ? "floating bar will show on startup" : "floating bar will not show on startup",
      show_text: ctx.showText ? "translation window is shown" : "translation window is hidden",
      target_lang: ctx.targetPhrase,
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
