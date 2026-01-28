(function () {
  const vscode = acquireVsCodeApi();

  /** @type {any} */
  let model = null;

  const UI_TRANSLATIONS = {
    fr: {
      grp_general: "Général",
      ui_lang: "Langue interface :",
      ui_announcements: "Annonces audio de l'interface",
      auto_read: "Lecture automatique des nouvelles réponses",
      bar_top: "Afficher la barre flottante",
      bar_start: "Afficher la barre flottante au démarrage",
      show_text: "Afficher la fenêtre de traduction",
      grp_tts: "TTS",
      app_paused: "Mettre le service en pause",
      tts_mute: "Muet (coupe la lecture)",
      voice: "Voix :",
      rate: "Vitesse :",
      volume: "Volume :",
      test: "Tester la voix",
      translate: "Traduire si nécessaire (googletrans)",
      translate_off: "Traduction indisponible (Python 3.13+ / googletrans)",
      target: "Langue cible :",
    },
    en: {
      grp_general: "General",
      ui_lang: "Interface language:",
      ui_announcements: "Interface audio announcements",
      auto_read: "Auto-read new responses",
      bar_top: "Show the floating bar",
      bar_start: "Show the floating bar on startup",
      show_text: "Show the translation window",
      grp_tts: "TTS",
      app_paused: "Pause the service",
      tts_mute: "Mute (stop playback)",
      voice: "Voice:",
      rate: "Speed:",
      volume: "Volume:",
      test: "Test voice",
      translate: "Translate if needed (googletrans)",
      translate_off: "Translation unavailable (Python 3.13+ / googletrans)",
      target: "Target language:",
    },
    de: {
      grp_general: "Allgemein",
      ui_lang: "Sprache der Oberfläche:",
      ui_announcements: "Audioansagen der Oberfläche",
      auto_read: "Neue Antworten automatisch lesen",
      bar_top: "Schwebebalken anzeigen",
      bar_start: "Schwebebalken beim Start anzeigen",
      show_text: "Übersetzungsfenster anzeigen",
      grp_tts: "TTS",
      app_paused: "Dienst pausieren",
      tts_mute: "Stumm (Wiedergabe stoppen)",
      voice: "Stimme:",
      rate: "Geschwindigkeit:",
      volume: "Lautstärke:",
      test: "Stimme testen",
      translate: "Übersetzen wenn nötig (googletrans)",
      translate_off: "Übersetzung nicht verfügbar (Python 3.13+ / googletrans)",
      target: "Zielsprache:",
    },
    es: {
      grp_general: "General",
      ui_lang: "Idioma de la interfaz:",
      ui_announcements: "Anuncios de audio de la interfaz",
      auto_read: "Lectura automática de nuevas respuestas",
      bar_top: "Mostrar la barra flotante",
      bar_start: "Mostrar la barra flotante al iniciar",
      show_text: "Mostrar la ventana de traducción",
      grp_tts: "TTS",
      app_paused: "Pausar el servicio",
      tts_mute: "Silencio (detener reproducción)",
      voice: "Voz:",
      rate: "Velocidad:",
      volume: "Volumen:",
      test: "Probar voz",
      translate: "Traducir si es necesario (googletrans)",
      translate_off: "Traducción no disponible (Python 3.13+ / googletrans)",
      target: "Idioma de destino:",
    },
    it: {
      grp_general: "Generale",
      ui_lang: "Lingua dell'interfaccia:",
      ui_announcements: "Annunci audio dell'interfaccia",
      auto_read: "Lettura automatica delle nuove risposte",
      bar_top: "Mostra la barra flottante",
      bar_start: "Mostra la barra flottante all'avvio",
      show_text: "Mostra la finestra di traduzione",
      grp_tts: "TTS",
      app_paused: "Metti in pausa il servizio",
      tts_mute: "Muto (ferma la riproduzione)",
      voice: "Voce:",
      rate: "Velocità:",
      volume: "Volume:",
      test: "Test voce",
      translate: "Traduci se necessario (googletrans)",
      translate_off: "Traduzione non disponibile (Python 3.13+ / googletrans)",
      target: "Lingua di destinazione:",
    },
    pt: {
      grp_general: "Geral",
      ui_lang: "Idioma da interface:",
      ui_announcements: "Anúncios de áudio da interface",
      auto_read: "Leitura automática de novas respostas",
      bar_top: "Mostrar a barra flutuante",
      bar_start: "Mostrar a barra flutuante ao iniciar",
      show_text: "Mostrar a janela de tradução",
      grp_tts: "TTS",
      app_paused: "Pausar o serviço",
      tts_mute: "Mudo (parar reprodução)",
      voice: "Voz:",
      rate: "Velocidade:",
      volume: "Volume:",
      test: "Testar voz",
      translate: "Traduzir se necessário (googletrans)",
      translate_off: "Tradução indisponível (Python 3.13+ / googletrans)",
      target: "Idioma alvo:",
    },
    nl: {
      grp_general: "Algemeen",
      ui_lang: "Interface taal:",
      ui_announcements: "Audioaankondigingen van de interface",
      auto_read: "Nieuwe antwoorden automatisch lezen",
      bar_top: "Zwevende balk tonen",
      bar_start: "Zwevende balk bij opstarten tonen",
      show_text: "Vertaalvenster tonen",
      grp_tts: "TTS",
      app_paused: "Service pauzeren",
      tts_mute: "Dempen (afspelen stoppen)",
      voice: "Stem:",
      rate: "Snelheid:",
      volume: "Volume:",
      test: "Stem testen",
      translate: "Vertalen indien nodig (googletrans)",
      translate_off: "Vertaling niet beschikbaar (Python 3.13+ / googletrans)",
      target: "Doeltaal:",
    },
    ru: {
      grp_general: "Общее",
      ui_lang: "Язык интерфейса:",
      ui_announcements: "Аудио‑объявления интерфейса",
      auto_read: "Авточтение новых ответов",
      bar_top: "Показывать плавающую панель",
      bar_start: "Показывать плавающую панель при запуске",
      show_text: "Показывать окно перевода",
      grp_tts: "TTS",
      app_paused: "Поставить службу на паузу",
      tts_mute: "Без звука (остановить воспроизведение)",
      voice: "Голос:",
      rate: "Скорость:",
      volume: "Громкость:",
      test: "Тест голоса",
      translate: "Переводить при необходимости (googletrans)",
      translate_off: "Перевод недоступен (Python 3.13+ / googletrans)",
      target: "Целевой язык:",
    },
    ja: {
      grp_general: "一般",
      ui_lang: "UI 言語:",
      ui_announcements: "インターフェース音声アナウンス",
      auto_read: "新しい回答を自動読み上げ",
      bar_top: "フローティングバーを表示",
      bar_start: "起動時にフローティングバーを表示",
      show_text: "翻訳ウィンドウを表示",
      grp_tts: "TTS",
      app_paused: "サービスを一時停止",
      tts_mute: "ミュート（再生停止）",
      voice: "音声:",
      rate: "速度:",
      volume: "音量:",
      test: "音声テスト",
      translate: "必要なら翻訳 (googletrans)",
      translate_off: "翻訳不可 (Python 3.13+ / googletrans)",
      target: "ターゲット言語:",
    },
    zh: {
      grp_general: "通用",
      ui_lang: "界面语言:",
      ui_announcements: "界面语音提示",
      auto_read: "自动朗读新回复",
      bar_top: "显示浮动栏",
      bar_start: "启动时显示浮动栏",
      show_text: "显示翻译窗口",
      grp_tts: "TTS",
      app_paused: "暂停服务",
      tts_mute: "静音（停止播放）",
      voice: "语音:",
      rate: "语速:",
      volume: "音量:",
      test: "测试语音",
      translate: "需要时翻译 (googletrans)",
      translate_off: "翻译不可用 (Python 3.13+ / googletrans)",
      target: "目标语言:",
    },
    ar: {
      grp_general: "عام",
      ui_lang: "لغة الواجهة:",
      ui_announcements: "إعلانات صوتية للواجهة",
      auto_read: "قراءة تلقائية للردود الجديدة",
      bar_top: "إظهار الشريط العائم",
      bar_start: "إظهار الشريط العائم عند البدء",
      show_text: "إظهار نافذة الترجمة",
      grp_tts: "TTS",
      app_paused: "إيقاف الخدمة مؤقتًا",
      tts_mute: "كتم الصوت (إيقاف التشغيل)",
      voice: "الصوت:",
      rate: "السرعة:",
      volume: "الصوت:",
      test: "اختبار الصوت",
      translate: "ترجمة عند الحاجة (googletrans)",
      translate_off: "الترجمة غير متاحة (Python 3.13+ / googletrans)",
      target: "اللغة المستهدفة:",
    },
  };

  const uiLangSelect = byId("uiLangSelect");
  const uiAnnouncements = byId("uiAnnouncements");
  const autoRead = byId("autoRead");
  const barTop = byId("barTop");
  const barStart = byId("barStart");
  const showText = byId("showText");
  const pauseService = byId("pauseService");
  const mute = byId("mute");
  const targetLangSelect = byId("targetLangSelect");
  const voice = byId("voice");
  const rate = byId("rate");
  const volume = byId("volume");
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

    renderLangSelect(
      uiLangSelect,
      LANG_OPTIONS,
      String(s.uiLang || "fr").toLowerCase(),
      false,
      (val) => postPatchWithAnnounce({ uiLang: val }, "ui_lang", false),
      (code) => voiceAvailability(code, model.voices || []),
    );
    uiAnnouncements.checked = !!s.uiAnnouncementsEnabled;
    autoRead.checked = !!s.autoReadNewResponses;
    barTop.checked = !!s.miniBarVisible;
    barStart.checked = !!s.showMiniBarOnStart;
    showText.checked = !!s.showTranslationWindow;
    pauseService.checked = !!s.appPaused;
    mute.checked = !!s.ttsMute;
    const translateAvailable = !!model.translateAvailable;
    translate.disabled = !translateAvailable;
    const tr = UI_TRANSLATIONS[String(s.uiLang || "fr").toLowerCase()] || UI_TRANSLATIONS.fr;
    lblTranslate.textContent = translateAvailable ? tr.translate : tr.translate_off;
    translate.checked = translateAvailable && !!s.translateEnabled;

    const targetDisabled = !(translateAvailable && translate.checked);
    renderLangSelect(
      targetLangSelect,
      LANG_OPTIONS,
      String(s.targetLang || "fr").toLowerCase(),
      targetDisabled,
      (val) => postPatchWithAnnounce({ targetLang: val }, "target_lang", true),
      (code) => voiceAvailability(code, model.voices || []),
    );

    const voiceLang = String(translateAvailable && translate.checked ? s.targetLang || "fr" : s.uiLang || "fr").toLowerCase();
    fillVoices(voice, model.voices || [], s.ttsVoiceId, voiceLang);

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
    const disableTtsForTarget = !targetHasVoice || !uiHasVoice;
    mute.disabled = disableTtsForTarget;
    voice.disabled = disableTtsForTarget || voice.disabled;
    rate.disabled = disableTtsForTarget;
    volume.disabled = disableTtsForTarget;
    btnTest.disabled = disableTtsForTarget;
    autoRead.disabled = !uiHasVoice;
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
    const dim = size === "small" ? 14 : 16;
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
  showText.addEventListener("change", () => postPatchWithAnnounce({ showTranslationWindow: showText.checked }, "show_text", true));
  pauseService.addEventListener("change", () => postPatchWithAnnounce({ appPaused: pauseService.checked }, "app_paused", true));
  mute.addEventListener("change", () => postPatchWithAnnounce({ ttsMute: mute.checked }, "tts_mute", true));
  translate.addEventListener("change", () => postPatchWithAnnounce({ translateEnabled: translate.checked }, "translate", true));

  // targetLang handled by custom dropdown
  voice.addEventListener("change", () => postPatchWithAnnounce({ ttsVoiceId: voice.value }, "voice", true));

  rate.addEventListener("input", () => {
    rateVal.textContent = `${rate.value}%`;
    postPatchWithAnnounce({ ttsRate: Math.max(0.5, Math.min(2.0, Number(rate.value) / 100)) }, "rate", false);
  });
  rate.addEventListener("change", () => {
    postPatchWithAnnounce({ ttsRate: Math.max(0.5, Math.min(2.0, Number(rate.value) / 100)) }, "rate", true);
  });
  volume.addEventListener("input", () => {
    volVal.textContent = `${volume.value}%`;
    postPatchWithAnnounce({ ttsVolume: Math.max(0, Math.min(100, Number(volume.value))) }, "volume", false);
  });
  volume.addEventListener("change", () => {
    postPatchWithAnnounce({ ttsVolume: Math.max(0, Math.min(100, Number(volume.value))) }, "volume", true);
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
    setText("grpGeneralTitle", tr.grp_general);
    setText("lblUiLang", tr.ui_lang);
    setText("lblUiAnnouncements", tr.ui_announcements);
    setText("lblAutoRead", tr.auto_read);
    setText("lblBarTop", tr.bar_top);
    setText("lblBarStart", tr.bar_start);
    setText("lblShowText", tr.show_text);
    setText("grpTtsTitle", tr.grp_tts);
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
