export type Voice = { id: string; name: string; languages: string[]; engine?: string };

export function baseLang(code: string): string {
  return (
    String(code || "")
      .trim()
      .toLowerCase()
      .split("-")[0] || "fr"
  );
}

export function targetLangPhrase(uiLang: string, targetLang: string): string {
  const label =
    {
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

export function buildAnnouncePhrases(
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
    showTextStart: boolean;
    targetPhrase: string;
    theme: "dark" | "light";
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
    show_text_start: ctx.showTextStart
      ? "La fenêtre texte s'affiche au démarrage."
      : "La fenêtre texte ne s'affiche pas au démarrage.",
    target_lang: `La langue cible est ${ctx.targetPhrase}.`,
    theme: `Le thème de la fenêtre est ${ctx.theme === "light" ? "clair" : "sombre"}.`,
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
    show_text_start: ctx.showTextStart
      ? "The text window shows on startup."
      : "The text window does not show on startup.",
    target_lang: `The target language is ${ctx.targetPhrase}.`,
    theme: `The window theme is ${ctx.theme === "light" ? "light" : "dark"}.`,
  };
  return baseLang(uiLang) === "en" ? en : fr;
}

export function hasVoiceForLang(voices: Voice[], code: string): boolean {
  const c = baseLang(code);
  if (!c) return false;
  return voices.some((v) => {
    const langs = Array.isArray(v.languages) ? v.languages : [];
    return langs.some((l) => String(l || "").toLowerCase().startsWith(c));
  });
}

export function voiceMatchesLang(voices: Voice[], voiceId: string, lang: string): boolean {
  const id = String(voiceId || "").trim();
  if (!id) return false;
  const c = baseLang(lang);
  for (const v of voices) {
    if (v && v.id === id) {
      const langs = Array.isArray(v.languages) ? v.languages : [];
      return langs.some((l) => String(l || "").toLowerCase().startsWith(c));
    }
  }
  return false;
}

export function pickVoiceForLang(
  voices: Voice[],
  preferredVoiceId: string,
  fallbackVoiceId: string,
  lang: string,
): string {
  const c = baseLang(lang);
  if (preferredVoiceId && voiceMatchesLang(voices, preferredVoiceId, c)) return preferredVoiceId;
  if (fallbackVoiceId && voiceMatchesLang(voices, fallbackVoiceId, c)) return fallbackVoiceId;
  for (const v of voices) {
    const langs = Array.isArray(v.languages) ? v.languages : [];
    if (langs.some((l) => String(l || "").toLowerCase().startsWith(c))) return v.id;
  }
  return "";
}
