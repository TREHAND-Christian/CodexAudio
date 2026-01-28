import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export type AppState = {
  uiLang: string;
  uiAnnouncementsEnabled: boolean;
  autoReadNewResponses: boolean;
  miniBarVisible: boolean;
  showMiniBarOnStart: boolean;
  showTranslationWindow: boolean;
  appPaused: boolean;
  ttsEnabled: boolean;
  ttsMute: boolean;
  ttsVoiceId: string;
  ttsRate: number; // 0.5..2.0
  ttsVolume: number; // 0..100
  translateEnabled: boolean;
  targetLang: string;
  savedTargetLang: string;
  voicePerLang: Record<string, string>;
  lastDisplayText: string;
  lastTranslationLabel: string;
  lastQueue: string[];
};

export const DEFAULT_STATE: AppState = {
  uiLang: "fr",
  uiAnnouncementsEnabled: true,
  autoReadNewResponses: true,
  miniBarVisible: true,
  showMiniBarOnStart: true,
  showTranslationWindow: true,
  appPaused: false,
  ttsEnabled: true,
  ttsMute: false,
  ttsVoiceId: "winrt:Microsoft Paul",
  ttsRate: 1.0,
  ttsVolume: 80,
  translateEnabled: true,
  targetLang: "fr",
  savedTargetLang: "fr",
  voicePerLang: { fr: "winrt:Microsoft Paul" },
  lastDisplayText: "",
  lastTranslationLabel: "",
  lastQueue: [],
};

const KEY = "codexAudio.state.v1";
const STATE_PATH = (() => {
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "CodexAudio", "state.json");
})();

async function readFileState(): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function writeFileState(obj: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(obj, null, 2), "utf8");
}

export async function loadState(ctx: vscode.ExtensionContext): Promise<AppState> {
  const fileObj = await readFileState();
  const raw =
    (fileObj?.extensionState as Partial<AppState> | undefined) ||
    (fileObj as Partial<AppState> | undefined) ||
    ctx.globalState.get<Partial<AppState>>(KEY);
  if (fileObj == null && raw) {
    const next: Record<string, unknown> = {};
    next.extensionState = raw;
    await writeFileState(next);
  }
  return {
    ...DEFAULT_STATE,
    ...(raw || {}),
    voicePerLang: typeof raw?.voicePerLang === "object" && raw?.voicePerLang ? raw.voicePerLang : DEFAULT_STATE.voicePerLang,
    lastQueue: Array.isArray(raw?.lastQueue) ? raw!.lastQueue! : DEFAULT_STATE.lastQueue,
  };
}

export async function saveState(ctx: vscode.ExtensionContext, state: AppState): Promise<void> {
  const fileObj = (await readFileState()) || {};
  fileObj.extensionState = state;
  await writeFileState(fileObj);
  await ctx.globalState.update(KEY, state);
}
