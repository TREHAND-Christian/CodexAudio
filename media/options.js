(function () {
  const vscode = acquireVsCodeApi();

  /** @type {any} */
  let model = null;

  const UI_TRANSLATIONS = {
    fr: {
      grp_main: "Principal",
      grp_interface: "Interface",
      grp_text: "Fenêtre texte",
      ui_lang: "Langue interface :",
      ui_announcements: "Annonces audio de l'interface",
      auto_read: "Lecture automatique des nouvelles réponses",
      bar_top: "Afficher la barre flottante",
      bar_start: "Afficher la barre flottante au démarrage",
      theme: "Thème fenêtre :",
      theme_dark: "Sombre",
      theme_light: "Clair",
      show_text: "Afficher la fenêtre texte",
      show_text_start: "Afficher la fenêtre texte au démarrage",
      app_paused: "Mettre le service en pause",
      tts_mute: "Muet",
      muted_voice: "Muet",
      voice: "Voix :",
      rate: "Vitesse :",
      volume: "Volume :",
      test: "Tester la voix",
      translate: "Traduire si nécessaire (googletrans)",
      translate_off: "Traduction indisponible (Python 3.13+ / googletrans)",
      target: "Langue cible :",
    },
    en: {
      grp_main: "Main",
      grp_interface: "Interface",
      grp_text: "Text window",
      ui_lang: "Interface language:",
      ui_announcements: "Interface audio announcements (stops playback)",
      auto_read: "Auto-read new responses",
      bar_top: "Show the floating bar",
      bar_start: "Show the floating bar on startup",
      theme: "Window theme:",
      theme_dark: "Dark",
      theme_light: "Light",
      show_text: "Show the text window",
      show_text_start: "Show the text window on startup",
      app_paused: "Pause the service",
      tts_mute: "Mute",
      muted_voice: "Muted",
      voice: "Voice:",
      rate: "Speed:",
      volume: "Volume:",
      test: "Test voice",
      translate: "Translate if needed (googletrans)",
      translate_off: "Translation unavailable (Python 3.13+ / googletrans)",
      target: "Target language:",
    },
    de: {
      grp_main: "Haupt",
      grp_interface: "Oberfläche",
      grp_text: "Textfenster",
      ui_lang: "Sprache der Oberfläche:",
      ui_announcements: "Audioansagen der Oberfläche (stoppt die Wiedergabe)",
      auto_read: "Neue Antworten automatisch lesen",
      bar_top: "Schwebebalken anzeigen",
      bar_start: "Schwebebalken beim Start anzeigen",
      theme: "Fensterdesign:",
      theme_dark: "Dunkel",
      theme_light: "Hell",
      show_text: "Textfenster anzeigen",
      show_text_start: "Textfenster beim Start anzeigen",
      app_paused: "Dienst pausieren",
      tts_mute: "Stumm",
      muted_voice: "Stumm",
      voice: "Stimme:",
      rate: "Geschwindigkeit:",
      volume: "Lautstärke:",
      test: "Stimme testen",
      translate: "Übersetzen wenn nötig (googletrans)",
      translate_off: "Übersetzung nicht verfügbar (Python 3.13+ / googletrans)",
      target: "Zielsprache:",
    },
    es: {
      grp_main: "Principal",
      grp_interface: "Interfaz",
      grp_text: "Ventana de texto",
      ui_lang: "Idioma de la interfaz:",
      ui_announcements: "Anuncios de audio de la interfaz (interrumpe la reproducción)",
      auto_read: "Lectura automática de nuevas respuestas",
      bar_top: "Mostrar la barra flotante",
      bar_start: "Mostrar la barra flotante al iniciar",
      theme: "Tema de ventana:",
      theme_dark: "Oscuro",
      theme_light: "Claro",
      show_text: "Mostrar la ventana de texto",
      show_text_start: "Mostrar la ventana de texto al iniciar",
      app_paused: "Pausar el servicio",
      tts_mute: "Silencio",
      muted_voice: "Silencio",
      voice: "Voz:",
      rate: "Velocidad:",
      volume: "Volumen:",
      test: "Probar voz",
      translate: "Traducir si es necesario (googletrans)",
      translate_off: "Traducción no disponible (Python 3.13+ / googletrans)",
      target: "Idioma de destino:",
    },
    it: {
      grp_main: "Principale",
      grp_interface: "Interfaccia",
      grp_text: "Finestra di testo",
      ui_lang: "Lingua dell'interfaccia:",
      ui_announcements: "Annunci audio dell'interfaccia (interrompe la riproduzione)",
      auto_read: "Lettura automatica delle nuove risposte",
      bar_top: "Mostra la barra flottante",
      bar_start: "Mostra la barra flottante all'avvio",
      theme: "Tema finestra:",
      theme_dark: "Scuro",
      theme_light: "Chiaro",
      show_text: "Mostra la finestra di testo",
      show_text_start: "Mostra la finestra di testo all'avvio",
      app_paused: "Metti in pausa il servizio",
      tts_mute: "Muto",
      muted_voice: "Muto",
      voice: "Voce:",
      rate: "Velocità:",
      volume: "Volume:",
      test: "Test voce",
      translate: "Traduci se necessario (googletrans)",
      translate_off: "Traduzione non disponibile (Python 3.13+ / googletrans)",
      target: "Lingua di destinazione:",
    },
    pt: {
      grp_main: "Principal",
      grp_interface: "Interface",
      grp_text: "Janela de texto",
      ui_lang: "Idioma da interface:",
      ui_announcements: "Anúncios de áudio da interface (interrompe a reprodução)",
      auto_read: "Leitura automática de novas respostas",
      bar_top: "Mostrar a barra flutuante",
      bar_start: "Mostrar a barra flutuante ao iniciar",
      theme: "Tema da janela:",
      theme_dark: "Escuro",
      theme_light: "Claro",
      show_text: "Mostrar a janela de texto",
      show_text_start: "Mostrar a janela de texto ao iniciar",
      app_paused: "Pausar o serviço",
      tts_mute: "Mudo",
      muted_voice: "Mudo",
      voice: "Voz:",
      rate: "Velocidade:",
      volume: "Volume:",
      test: "Testar voz",
      translate: "Traduzir se necessário (googletrans)",
      translate_off: "Tradução indisponível (Python 3.13+ / googletrans)",
      target: "Idioma alvo:",
    },
    nl: {
      grp_main: "Hoofd",
      grp_interface: "Interface",
      grp_text: "Tekstvenster",
      ui_lang: "Interface taal:",
      ui_announcements: "Audioaankondigingen van de interface (onderbreekt de weergave)",
      auto_read: "Nieuwe antwoorden automatisch lezen",
      bar_top: "Zwevende balk tonen",
      bar_start: "Zwevende balk bij opstarten tonen",
      theme: "Vensterthema:",
      theme_dark: "Donker",
      theme_light: "Licht",
      show_text: "Tekstvenster tonen",
      show_text_start: "Tekstvenster bij opstarten tonen",
      app_paused: "Service pauzeren",
      tts_mute: "Dempen",
      muted_voice: "Gedempt",
      voice: "Stem:",
      rate: "Snelheid:",
      volume: "Volume:",
      test: "Stem testen",
      translate: "Vertalen indien nodig (googletrans)",
      translate_off: "Vertaling niet beschikbaar (Python 3.13+ / googletrans)",
      target: "Doeltaal:",
    },
    ru: {
      grp_main: "Основное",
      grp_interface: "Интерфейс",
      grp_text: "Окно текста",
      ui_lang: "Язык интерфейса:",
      ui_announcements: "Аудио‑объявления интерфейса (прерывает воспроизведение)",
      auto_read: "Авточтение новых ответов",
      bar_top: "Показывать плавающую панель",
      bar_start: "Показывать плавающую панель при запуске",
      theme: "Тема окна:",
      theme_dark: "Темная",
      theme_light: "Светлая",
      show_text: "Показывать окно текста",
      show_text_start: "Показывать окно текста при запуске",
      app_paused: "Поставить службу на паузу",
      tts_mute: "Без звука",
      muted_voice: "Без звука",
      voice: "Голос:",
      rate: "Скорость:",
      volume: "Громкость:",
      test: "Тест голоса",
      translate: "Переводить при необходимости (googletrans)",
      translate_off: "Перевод недоступен (Python 3.13+ / googletrans)",
      target: "Целевой язык:",
    },
    ja: {
      grp_main: "メイン",
      grp_interface: "インターフェース",
      grp_text: "テキストウィンドウ",
      ui_lang: "UI 言語:",
      ui_announcements: "インターフェース音声アナウンス（再生を止めます）",
      auto_read: "新しい回答を自動読み上げ",
      bar_top: "フローティングバーを表示",
      bar_start: "起動時にフローティングバーを表示",
      theme: "ウィンドウテーマ:",
      theme_dark: "ダーク",
      theme_light: "ライト",
      show_text: "テキストウィンドウを表示",
      show_text_start: "起動時にテキストウィンドウを表示",
      app_paused: "サービスを一時停止",
      tts_mute: "ミュート",
      muted_voice: "ミュート",
      voice: "音声:",
      rate: "速度:",
      volume: "音量:",
      test: "音声テスト",
      translate: "必要なら翻訳 (googletrans)",
      translate_off: "翻訳不可 (Python 3.13+ / googletrans)",
      target: "ターゲット言語:",
    },
    zh: {
      grp_main: "主要",
      grp_interface: "界面",
      grp_text: "文本窗口",
      ui_lang: "界面语言:",
      ui_announcements: "界面语音提示（会中断播放）",
      auto_read: "自动朗读新回复",
      bar_top: "显示浮动栏",
      bar_start: "启动时显示浮动栏",
      theme: "窗口主题:",
      theme_dark: "深色",
      theme_light: "浅色",
      show_text: "显示文本窗口",
      show_text_start: "启动时显示文本窗口",
      app_paused: "暂停服务",
      tts_mute: "静音",
      muted_voice: "静音",
      voice: "语音:",
      rate: "语速:",
      volume: "音量:",
      test: "测试语音",
      translate: "需要时翻译 (googletrans)",
      translate_off: "翻译不可用 (Python 3.13+ / googletrans)",
      target: "目标语言:",
    },
    ar: {
      grp_main: "رئيسي",
      grp_interface: "الواجهة",
      grp_text: "نافذة النص",
      ui_lang: "لغة الواجهة:",
      ui_announcements: "إعلانات صوتية للواجهة (توقف التشغيل)",
      auto_read: "قراءة تلقائية للردود الجديدة",
      bar_top: "إظهار الشريط العائم",
      bar_start: "إظهار الشريط العائم عند البدء",
      theme: "نسق النافذة:",
      theme_dark: "داكن",
      theme_light: "فاتح",
      show_text: "إظهار نافذة النص",
      show_text_start: "إظهار نافذة النص عند البدء",
      app_paused: "إيقاف الخدمة مؤقتًا",
      tts_mute: "كتم الصوت",
      muted_voice: "كتم الصوت",
      voice: "الصوت:",
      rate: "السرعة:",
      volume: "الصوت:",
      test: "اختبار الصوت",
      translate: "ترجمة عند الحاجة (googletrans)",
      translate_off: "الترجمة غير متاحة (Python 3.13+ / googletrans)",
      target: "اللغة المستهدفة:",
    },
  };

  const app = byId("app");
  const uiLangSelect = byId("uiLangSelect");
  const uiAnnouncements = byId("uiAnnouncements");
  const autoRead = byId("autoRead");
  const barTop = byId("barTop");
  const barStart = byId("barStart");
  const themeDark = byId("themeDark");
  const themeLight = byId("themeLight");
  const showText = byId("showText");
  const showTextStart = byId("showTextStart");
  const pauseService = byId("pauseService");
  const mute = byId("mute");
  const targetLangSelect = byId("targetLangSelect");
  const voice = byId("voice");
  const rate = byId("rate");
  const rateDec = byId("rateDec");
  const rateInc = byId("rateInc");
  const volume = byId("volume");
  const volDec = byId("volDec");
  const volInc = byId("volInc");
  const translate = byId("translate");
  const lblTranslate = byId("lblTranslate");
  const btnTest = byId("btnTest");
  const rateVal = byId("rateVal");
  const volVal = byId("volVal");
  const status = byId("status");
  const uiLangSpeaker = byId("uiLangSpeaker");
  const targetLangSpeaker = byId("targetLangSpeaker");

  btnTest.addEventListener("click", () => vscode.postMessage({ type: "cmd", cmd: "testVoice" }));

  function render() {
    if (!model) return;
    const s = model.state;
    const uiBase = String(s.uiLang || "fr").toLowerCase();
    applyTranslations(uiBase);

    status.textContent = model.backendOk ? model.statusText : "Backend Python indisponible";
    app.classList.toggle("app-paused", !!s.appPaused);

    renderLangSelect(
      uiLangSelect,
      LANG_OPTIONS,
      String(s.uiLang || "fr").toLowerCase(),
      !!s.appPaused,
      (val) => postPatchWithAnnounce({ uiLang: val }, "ui_lang", false),
      (code) => voiceAvailability(code, model.voices || []),
    );
    uiAnnouncements.checked = !!s.uiAnnouncementsEnabled;
    autoRead.checked = !!s.autoReadNewResponses;
    barTop.checked = !!s.miniBarVisible;
    barStart.checked = !!s.showMiniBarOnStart;
    const theme = String(s.uiTheme || "dark").toLowerCase() === "light" ? "light" : "dark";
    themeDark.classList.toggle("is-active", theme === "dark");
    themeLight.classList.toggle("is-active", theme === "light");
    themeDark.disabled = !!s.appPaused;
    themeLight.disabled = !!s.appPaused;
    showText.checked = !!s.showTranslationWindow;
    showTextStart.checked = !!s.showTranslationOnStart;
    pauseService.checked = !!s.appPaused;
    mute.checked = !!s.ttsMute;
    const translateAvailable = !!model.translateAvailable;
    translate.disabled = !translateAvailable || !!s.appPaused;
    const tr = UI_TRANSLATIONS[String(s.uiLang || "fr").toLowerCase()] || UI_TRANSLATIONS.fr;
    lblTranslate.textContent = translateAvailable ? tr.translate : tr.translate_off;
    translate.checked = translateAvailable && !!s.translateEnabled;
    barStart.disabled = !!s.appPaused;
    showTextStart.disabled = !!s.appPaused;

    const targetDisabled = !(translateAvailable && translate.checked) || !!s.appPaused;
    renderLangSelect(
      targetLangSelect,
      LANG_OPTIONS,
      String(s.targetLang || "fr").toLowerCase(),
      targetDisabled,
      (val) => postPatchWithAnnounce({ targetLang: val }, "target_lang", true),
      (code) => voiceAvailability(code, model.voices || []),
    );

    const voiceLang = String(translateAvailable && translate.checked ? s.targetLang || "fr" : s.uiLang || "fr").toLowerCase();
    const muted = !!s.ttsMute;
    const mutedLabel = tr.muted_voice || tr.tts_mute || "Muted";
    if (muted) {
      renderMutedVoice(voice, mutedLabel);
    } else {
      fillVoices(voice, model.voices || [], s.ttsVoiceId, voiceLang);
    }
    voice.classList.toggle("is-muted", muted);

    rate.value = String(Math.round((s.ttsRate || 1) * 100));
    rateVal.textContent = `${rate.value}%`;
    volume.value = String(s.ttsVolume ?? 80);
    volVal.textContent = `${volume.value}%`;

    const voices = Array.isArray(model.voices) ? model.voices : [];
    const uiAvail = voiceAvailability(uiBase, voices);
    const targetAvail = voiceAvailability(String(s.targetLang || "fr").toLowerCase(), voices);
    setSpeakerStatus(uiLangSpeaker, uiAvail);
    setSpeakerStatus(targetLangSpeaker, targetAvail);

    const uiHasVoice = uiAvail === "available";
    const targetHasVoice = targetAvail === "available";
    const disableTtsForTarget = !targetHasVoice;
    const pauseDisabled = !!s.appPaused;
    mute.disabled = disableTtsForTarget || pauseDisabled;
    voice.disabled = disableTtsForTarget || muted || pauseDisabled || voice.disabled;
    rate.disabled = disableTtsForTarget || muted || pauseDisabled;
    volume.disabled = disableTtsForTarget || muted || pauseDisabled;
    btnTest.disabled = pauseDisabled;
    autoRead.disabled = pauseDisabled || !targetHasVoice;
    uiAnnouncements.disabled = pauseDisabled;
    barTop.disabled = pauseDisabled;
    barStart.disabled = pauseDisabled;
    showText.disabled = pauseDisabled;
    showTextStart.disabled = pauseDisabled;
  }

  const LANG_OPTIONS = [
    ["Français", "fr"],
    ["English", "en"],
    ["Deutsch", "de"],
    ["Español", "es"],
    ["Italiano", "it"],
    ["Português", "pt"],
    ["Nederlands", "nl"],
    ["Русский", "ru"],
    ["日本語", "ja"],
    ["中文", "zh"],
    ["العربية", "ar"],
  ];

  function baseLang(code) {
    return String(code || "").toLowerCase().split("-")[0];
  }

  function voiceAvailability(code, voices) {
    const c = baseLang(code);
    if (!c) return "missing";
    const list = Array.isArray(voices) ? voices : [];
    if (!list.length) return "missing";
    const ok = list.some((v) => {
      const langs = Array.isArray(v.languages) ? v.languages : [];
      return langs.some((l) => String(l || "").toLowerCase().startsWith(c));
    });
    return ok ? "available" : "missing";
  }

  function setSpeakerStatus(el, status) {
    if (!el) return;
    if (!el.classList.contains("speaker-icon")) {
      el.classList.add("speaker-icon");
    }
    if (!el.querySelector("svg")) {
      el.innerHTML = speakerSvgHtml("small");
    }
    el.classList.toggle("missing", status === "missing");
    el.classList.toggle("unknown", status === "unknown");
    el.classList.toggle("is-missing", status === "missing");
    el.classList.toggle("is-unknown", status === "unknown");
  }

  function fillVoices(select, voices, currentId, lang) {
    const c = String(lang || "").toLowerCase().split("-")[0];
    const list = Array.isArray(voices) ? voices : [];
    const filtered = c
      ? list.filter((v) => {
          const langs = Array.isArray(v.languages) ? v.languages : [];
          return langs.some((l) => String(l || "").toLowerCase().startsWith(c));
        })
      : list.slice();
    filtered.sort((a, b) => {
      const ea = a.engine === "winrt" ? 0 : 1;
      const eb = b.engine === "winrt" ? 0 : 1;
      if (ea !== eb) return ea - eb;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
    select.innerHTML = "";
    if (!filtered.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(Aucune voix installée pour cette langue)";
      select.appendChild(opt);
      select.disabled = true;
      return;
    }
    select.disabled = false;
    for (const v of filtered) {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.name;
      select.appendChild(opt);
    }
    if (currentId) {
      select.value = currentId;
      if (select.value !== currentId) select.selectedIndex = 0;
    } else {
      select.selectedIndex = 0;
    }
  }

  function renderMutedVoice(select, label) {
    select.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = label;
    select.appendChild(opt);
  }

  let openSelect = null;

  function renderLangSelect(root, options, value, disabled, onChange, availabilityFn) {
    if (!root) return;
    root.innerHTML = "";
    root.classList.toggle("is-disabled", !!disabled);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "select-btn";
    btn.disabled = !!disabled;

    const current = options.find((o) => o[1] === value) || options[0];
    btn.textContent = "";
    const btnSpeaker = createSpeakerIcon(availabilityFn ? availabilityFn(value) : "unknown", "small");
    const btnText = document.createElement("span");
    btnText.className = "select-text";
    btnText.textContent = current ? current[0] : value;
    btn.appendChild(btnSpeaker);
    btn.appendChild(btnText);

    const list = document.createElement("div");
    list.className = "select-list";

    for (const [label, code] of options) {
      const item = document.createElement("div");
      item.className = "select-item";
      if (code === value) item.classList.add("is-selected");

      const sp = createSpeakerIcon(availabilityFn ? availabilityFn(code) : "unknown", "small");

      const text = document.createElement("span");
      text.className = "select-text";
      text.textContent = label;

      item.appendChild(sp);
      item.appendChild(text);
      item.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeOpenSelect();
        onChange(code);
      });
      list.appendChild(item);
    }

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (disabled) return;
      if (openSelect === root) {
        closeOpenSelect();
      } else {
        openSelect = root;
        root.classList.add("is-open");
      }
    });

    root.appendChild(btn);
    root.appendChild(list);
  }

  function closeOpenSelect() {
    if (!openSelect) return;
    openSelect.classList.remove("is-open");
    openSelect = null;
  }

  document.addEventListener("click", () => closeOpenSelect());

  function speakerSvgHtml(size) {
    const dim = size === "small" ? 18 : 20;
    return (
      `<svg aria-hidden="true" viewBox="0 0 24 24" width="${dim}" height="${dim}" focusable="false">` +
      '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.1-3.8v7.6A4.5 4.5 0 0 0 16.5 12zm2.5 0a7 7 0 0 0-3.5-6.1v12.2A7 7 0 0 0 19 12z"/>' +
      "</svg>"
    );
  }

  function createSpeakerIcon(status, size) {
    const wrap = document.createElement("span");
    wrap.className = `speaker-icon ${size || ""}`.trim();
    if (status === "missing") wrap.classList.add("missing");
    if (status === "unknown") wrap.classList.add("unknown");
    wrap.innerHTML = speakerSvgHtml(size);
    return wrap;
  }

  function postPatch(patch) {
    vscode.postMessage({ type: "patchState", patch, announce: true });
  }

  function postPatchWithAnnounce(patch, key, announce) {
    vscode.postMessage({ type: "patchState", patch, announce: !!announce, announceKey: key || "" });
  }

  // uiLang handled by custom dropdown
  autoRead.addEventListener("change", () => postPatchWithAnnounce({ autoReadNewResponses: autoRead.checked }, "auto_read", true));
  uiAnnouncements.addEventListener("change", () =>
    postPatchWithAnnounce({ uiAnnouncementsEnabled: uiAnnouncements.checked }, "ui_announcements", true),
  );
  barTop.addEventListener("change", () => postPatchWithAnnounce({ miniBarVisible: barTop.checked }, "bar_top", true));
  barStart.addEventListener("change", () => postPatchWithAnnounce({ showMiniBarOnStart: barStart.checked }, "bar_start", true));
  themeDark.addEventListener("click", () => postPatchWithAnnounce({ uiTheme: "dark" }, "theme", true));
  themeLight.addEventListener("click", () => postPatchWithAnnounce({ uiTheme: "light" }, "theme", true));
  showText.addEventListener("change", () => postPatchWithAnnounce({ showTranslationWindow: showText.checked }, "show_text", true));
  showTextStart.addEventListener("change", () =>
    postPatchWithAnnounce({ showTranslationOnStart: showTextStart.checked }, "show_text_start", true),
  );
  pauseService.addEventListener("change", () => postPatchWithAnnounce({ appPaused: pauseService.checked }, "app_paused", true));
  mute.addEventListener("change", () => postPatchWithAnnounce({ ttsMute: mute.checked }, "tts_mute", true));
  translate.addEventListener("change", () => postPatchWithAnnounce({ translateEnabled: translate.checked }, "translate", true));

  // targetLang handled by custom dropdown
  voice.addEventListener("change", () => postPatchWithAnnounce({ ttsVoiceId: voice.value }, "voice", true));

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function applyRate(announce) {
    const v = clamp(Number(rate.value), 50, 200);
    rate.value = String(v);
    rateVal.textContent = `${v}%`;
    postPatchWithAnnounce({ ttsRate: Math.max(0.5, Math.min(2.0, v / 100)) }, "rate", !!announce);
  }

  function applyVolume(announce) {
    const v = clamp(Number(volume.value), 0, 100);
    volume.value = String(v);
    volVal.textContent = `${v}%`;
    postPatchWithAnnounce({ ttsVolume: v }, "volume", !!announce);
  }

  rate.addEventListener("input", () => applyRate(false));
  rate.addEventListener("change", () => applyRate(true));
  volume.addEventListener("input", () => applyVolume(false));
  volume.addEventListener("change", () => applyVolume(true));

  rateDec.addEventListener("click", () => {
    rate.value = String(Number(rate.value || 100) - 5);
    applyRate(true);
  });
  rateInc.addEventListener("click", () => {
    rate.value = String(Number(rate.value || 100) + 5);
    applyRate(true);
  });
  volDec.addEventListener("click", () => {
    volume.value = String(Number(volume.value || 80) - 5);
    applyVolume(true);
  });
  volInc.addEventListener("click", () => {
    volume.value = String(Number(volume.value || 80) + 5);
    applyVolume(true);
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === "model") {
      model = msg.model;
      render();
    }
  });

  function byId(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing element: ${id}`);
    return el;
  }

  function applyTranslations(lang) {
    const base = String(lang || "fr").toLowerCase();
    const tr = UI_TRANSLATIONS[base] || UI_TRANSLATIONS.fr;
    document.documentElement.lang = base;
    setText("grpMainTitle", tr.grp_main);
    setText("grpInterfaceTitle", tr.grp_interface);
    setText("grpTextTitle", tr.grp_text);
    setText("lblUiLang", tr.ui_lang);
    setText("lblUiAnnouncements", tr.ui_announcements);
    setText("lblAutoRead", tr.auto_read);
    setText("lblBarTop", tr.bar_top);
    setText("lblBarStart", tr.bar_start);
    setText("lblTheme", tr.theme);
    setText("themeDark", tr.theme_dark);
    setText("themeLight", tr.theme_light);
    setText("lblShowText", tr.show_text);
    setText("lblShowTextStart", tr.show_text_start);
    setText("lblPauseService", tr.app_paused);
    setText("lblMute", tr.tts_mute);
    setText("lblVoice", tr.voice);
    setText("lblRateCaption", tr.rate);
    setText("lblVolCaption", tr.volume);
    setText("btnTest", tr.test);
    setText("lblTarget", tr.target);
  }

  function setText(id, txt) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = String(txt || "");
  }
})();
