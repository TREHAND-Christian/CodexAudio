import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import fg from "fast-glob";

export type SessionsWatcherEvent =
  | { type: "log"; message: string }
  | { type: "file"; file: string }
  | {
      type: "codex_session";
      action: "ouverture" | "inactive";
      id: string;
      name?: string;
      source: "vscode_codex_log";
    }
  | { type: "loaded"; text: string; key: string; source: "codex_sessions"; file: string }
  | { type: "message"; text: string; key: string; source: "codex_sessions"; initial?: boolean };

export type SessionsWatcherOptions = {
  pollIntervalMs: number;
  readLastOnStart: boolean;
  scrubTtsFields: boolean;
  scrubIdleMs: number;
  scrubMinIntervalMs: number;
  pattern: string;
  scrubKeys: string[];
  workspaceRoot?: string;
  codexLogRecentMs: number;
  codexLogFile?: string;
  displayLang?: () => string;
};

type AssistantHit = { text: string; key: string; ts: number; cwd?: string };
type RolloutSummary = { last?: AssistantHit; cwd?: string };
type LatestRollout = { file: string; last?: AssistantHit; cwd?: string };
type CodexLogCandidate = { file: string; mtimeMs: number };
type WorkspaceConversation = { id: string; name?: string; cwd?: string; updatedAt: number };

const DEFAULT_SCRUB_KEYS = [
  "tts",
  "audio",
  "voice",
  "phonemes",
  "timings",
  "durations",
  "audio_url",
  "audio_base64",
];

export class CodexSessionsWatcher {
  private readonly onEvent: (evt: SessionsWatcherEvent) => void;
  private readonly opts: SessionsWatcherOptions;

  private timer: NodeJS.Timeout | undefined;
  private currentFile: string | undefined;
  private currentFileCwd: string | undefined;
  private activeConversationId = "";
  private lastSessionEventKey = "";
  private codexLogFile: string | undefined;
  private codexLogPos = 0;
  private readonly startedAt = Date.now();
  private pos = 0;
  private lastEmittedKey = "";
  private listedWorkspaceConversations = false;
  private lastContextNoticeKey = "";
  private lastScrubAt = 0;
  private scrubPending = false;

  constructor(
    onEvent: (evt: SessionsWatcherEvent) => void,
    opts?: Partial<SessionsWatcherOptions>,
  ) {
    this.onEvent = onEvent;
    this.opts = {
      pollIntervalMs: 500,
      readLastOnStart: false,
      scrubTtsFields: false,
      scrubIdleMs: 1000,
      scrubMinIntervalMs: 2000,
      pattern: "**/rollout-*.jsonl",
      scrubKeys: DEFAULT_SCRUB_KEYS,
      codexLogRecentMs: 45_000,
      ...opts,
    };
  }

  start(): void {
    this.stop();
    this.onEvent({ type: "log", message: "[sessions] watcher démarré" });
    this.tick().catch(() => {});
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, this.opts.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private sessionsRoot(): string {
    const home =
      process.env.USERPROFILE ||
      process.env.HOME ||
      process.env.HOMEPATH ||
      "";
    return path.join(home, ".codex", "sessions");
  }

  private codexRoot(): string {
    const home =
      process.env.USERPROFILE ||
      process.env.HOME ||
      process.env.HOMEPATH ||
      "";
    return path.join(home, ".codex");
  }

  private async readConversationName(conversationId: string): Promise<string | undefined> {
    if (!conversationId) return undefined;
    const indexPath = path.join(this.codexRoot(), "session_index.jsonl");
    try {
      const raw = await fsp.readFile(indexPath, "utf8");
      let found: string | undefined;
      for (const line of raw.split(/\r?\n/g)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as Record<string, unknown>;
          if (obj.id === conversationId && typeof obj.thread_name === "string") {
            found = obj.thread_name;
          }
        } catch {
          // ignore
        }
      }
      return found;
    } catch {
      return undefined;
    }
  }

  private async readConversationNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const indexPath = path.join(this.codexRoot(), "session_index.jsonl");
    try {
      const raw = await fsp.readFile(indexPath, "utf8");
      for (const line of raw.split(/\r?\n/g)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as Record<string, unknown>;
          if (typeof obj.id === "string" && typeof obj.thread_name === "string") {
            names.set(obj.id, obj.thread_name);
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    return names;
  }

  private vscodeLogsRoot(): string {
    const appData = process.env.APPDATA || "";
    if (appData) return path.join(appData, "Code", "logs");
    const home = process.env.USERPROFILE || process.env.HOME || "";
    return path.join(home, "AppData", "Roaming", "Code", "logs");
  }

  private async findActiveRollout(conversationId: string): Promise<LatestRollout | undefined> {
    if (!conversationId) return undefined;
    const root = this.sessionsRoot();
    try {
      await fsp.access(root);
    } catch {
      return undefined;
    }
    const files = await fg(`**/rollout-*${conversationId}.jsonl`, {
      cwd: root,
      absolute: true,
      onlyFiles: true,
      dot: true,
      suppressErrors: true,
    });
    if (files.length === 0) return undefined;
    let best: { file: string; last?: AssistantHit; ts: number } | undefined;
    for (const file of files) {
      try {
        const st = await fsp.stat(file);
        const summary = await this.readRolloutSummary(file);
        const ts = st.mtimeMs ?? summary.last?.ts ?? 0;
        if (!best || ts >= best.ts) {
          best = { file, last: summary.last, ts };
        }
      } catch {
        // ignore
      }
    }
    if (!best) return undefined;
    const summary = await this.readRolloutSummary(best.file);
    return { file: best.file, last: summary.last, cwd: summary.cwd };
  }

  private conversationIdFromFile(file: string): string | undefined {
    const match = /rollout-[\w:.-]+-([0-9a-f-]{36})\.jsonl$/i.exec(path.basename(file));
    return match?.[1];
  }

  private async listWorkspaceConversations(): Promise<WorkspaceConversation[]> {
    const root = this.sessionsRoot();
    const workspaceRoot = this.opts.workspaceRoot;
    if (!workspaceRoot) return [];
    try {
      await fsp.access(root);
    } catch {
      return [];
    }
    const names = await this.readConversationNames();
    const files = await fg(this.opts.pattern, {
      cwd: root,
      absolute: true,
      onlyFiles: true,
      dot: true,
      suppressErrors: true,
    });
    const byId = new Map<string, WorkspaceConversation>();
    for (const file of files) {
      try {
        const st = await fsp.stat(file);
        const summary = await this.readRolloutSummary(file);
        const cwd = summary.last?.cwd ?? summary.cwd;
        if (!this.matchesWorkspace(cwd)) continue;
        const id = this.conversationIdFromFile(file);
        if (!id) continue;
        const name = names.get(id)?.trim();
        if (!name) continue;
        const updatedAt = st.mtimeMs || summary.last?.ts || 0;
        const prev = byId.get(id);
        if (!prev || updatedAt >= prev.updatedAt) {
          byId.set(id, {
            id,
            name,
            cwd,
            updatedAt,
          });
        }
      } catch {
        // ignore
      }
    }
    return Array.from(byId.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private formatConversationList(conversations: WorkspaceConversation[]): string {
    if (conversations.length === 0) {
      return this.displayLang() === "en"
        ? "- No conversation is available for the opened folder."
        : "- Aucune conversation n'est disponible pour le dossier ouvert.";
    }
    return conversations
      .map((c) => {
        const title = c.name && c.name.trim() ? c.name.trim() : "Conversation sans titre";
        return `- ${title}`;
      })
      .join("\n");
  }

  private availableConversationsPhrase(count: number): string {
    if (this.displayLang() === "en") {
      if (count === 1) return "The conversation available in this context is:";
      if (count > 1) return "The conversations available in this context are:";
      return "No conversation is available in this context:";
    }
    if (count === 1) return "La conversation disponible dans ce contexte est :";
    if (count > 1) return "Les conversations disponibles dans ce contexte sont :";
    return "Aucune conversation n'est disponible dans ce contexte :";
  }

  private workspaceLabel(): string {
    const root = this.opts.workspaceRoot || "";
    return root ? path.basename(root) : "dossier ouvert";
  }

  private displayLang(): string {
    try {
      const raw = this.opts.displayLang?.() || "fr";
      return String(raw).trim().toLowerCase().split("-")[0] || "fr";
    } catch {
      return "fr";
    }
  }

  private async emitWorkspaceConversationList(): Promise<void> {
    if (this.listedWorkspaceConversations) return;
    this.listedWorkspaceConversations = true;
    const conversations = await this.listWorkspaceConversations();
    const text =
      this.displayLang() === "en"
        ? `For folder: ${this.workspaceLabel()}\n\n${this.availableConversationsPhrase(conversations.length)}\n\n${this.formatConversationList(conversations)}`
        : `Pour le dossier : ${this.workspaceLabel()}\n\n${this.availableConversationsPhrase(conversations.length)}\n\n${this.formatConversationList(conversations)}`;
    this.onEvent({
      type: "loaded",
      text,
      key: `workspace-conversations:${this.opts.workspaceRoot || ""}:${conversations.map((c) => c.id).join(",")}`,
      source: "codex_sessions",
      file: "",
    });
  }

  private async emitOutOfContextNotice(conversationId: string): Promise<void> {
    const key = `out-of-context:${conversationId}`;
    if (key === this.lastContextNoticeKey) return;
    this.lastContextNoticeKey = key;
    const conversations = await this.listWorkspaceConversations();
    const conversationTitle = (await this.readConversationName(conversationId)) || "Conversation sans titre";
    const text =
      this.displayLang() === "en"
        ? `For folder: ${this.workspaceLabel()}\n\nThe conversation "${conversationTitle}" is out of context.\n\n${this.availableConversationsPhrase(conversations.length)}\n\n${this.formatConversationList(conversations)}`
        : `Pour le dossier : ${this.workspaceLabel()}\n\nLa conversation "${conversationTitle}" est hors contexte.\n\n${this.availableConversationsPhrase(conversations.length)}\n\n${this.formatConversationList(conversations)}`;
    this.onEvent({
      type: "loaded",
      text,
      key,
      source: "codex_sessions",
      file: "",
    });
  }

  private async findLatestCodexLog(): Promise<CodexLogCandidate | undefined> {
    if (this.opts.codexLogFile) {
      try {
        const st = await fsp.stat(this.opts.codexLogFile);
        return { file: this.opts.codexLogFile, mtimeMs: st.mtimeMs || 0 };
      } catch {
        return undefined;
      }
    }

    const root = this.vscodeLogsRoot();
    try {
      await fsp.access(root);
    } catch {
      return undefined;
    }
    const files = await fg("*/window*/exthost/openai.chatgpt/Codex.log", {
      cwd: root,
      absolute: true,
      onlyFiles: true,
      dot: true,
      suppressErrors: true,
    });
    let best: CodexLogCandidate | undefined;
    for (const file of files) {
      try {
        const st = await fsp.stat(file);
        const mtimeMs = st.mtimeMs || 0;
        if (!best || mtimeMs > best.mtimeMs) best = { file, mtimeMs };
      } catch {
        // ignore
      }
    }
    return best;
  }

  private parseCodexLogTimestamp(line: string): number | null {
    const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3})/.exec(line);
    if (!match) return null;
    const t = Date.parse(`${match[1]}T${match[2]}`);
    return Number.isNaN(t) ? null : t;
  }

  private parseConversationResume(line: string, allowOld: boolean): string | undefined {
    const match =
      /(?:maybe_resume_success|Conversation created) conversationId=([0-9a-f-]+)/i.exec(line) ||
      /turn\/started.*?(?:threadId|conversationId)["=: ]+["']?([0-9a-f-]+)/i.exec(line) ||
      /thread\/status\/changed.*?(?:threadId|conversationId)["=: ]+["']?([0-9a-f-]+).*?(?:"type"\s*:\s*"active"|type=active)/i.exec(line) ||
      /(?:threadId|conversationId)["=: ]+["']?([0-9a-f-]+).*?(?:turn\/started|thread\/status\/changed).*?(?:"type"\s*:\s*"active"|type=active)/i.exec(line);
    if (!match) return undefined;
    if (!allowOld) {
      const ts = this.parseCodexLogTimestamp(line);
      const minTs = Math.max(this.startedAt - 5_000, Date.now() - this.opts.codexLogRecentMs);
      if (!ts || ts < minTs) return undefined;
    }
    return match[1];
  }

  private async emitSessionEvent(action: "ouverture" | "inactive", id: string, force = false): Promise<void> {
    if (!id) return;
    const key = `${action}:${id}`;
    if (!force && key === this.lastSessionEventKey) return;
    this.lastSessionEventKey = key;
    const name = await this.readConversationName(id);
    this.onEvent({
      type: "codex_session",
      action,
      id,
      name,
      source: "vscode_codex_log",
    });
  }

  private async updateActiveConversationFromCodexLog(): Promise<void> {
    const latestLog = await this.findLatestCodexLog();
    if (!latestLog) return;

    const changedLog = latestLog.file !== this.codexLogFile;
    if (changedLog) {
      this.codexLogFile = latestLog.file;
      this.codexLogPos = 0;
    }

    let st: fs.Stats;
    try {
      st = await fsp.stat(latestLog.file);
    } catch {
      return;
    }

    if (this.codexLogPos > st.size) this.codexLogPos = 0;
    const isFirstRead = this.codexLogPos === 0;
    const start = isFirstRead ? Math.max(0, st.size - 256_000) : this.codexLogPos;
    if (st.size <= start) {
      this.codexLogPos = st.size;
      return;
    }

    const fd = await fsp.open(latestLog.file, "r");
    try {
      const buf = Buffer.alloc(st.size - start);
      await fd.read(buf, 0, buf.length, start);
      const text = buf.toString("utf8");
      for (const line of text.split(/\r?\n/g)) {
        const id = this.parseConversationResume(line, !isFirstRead);
        if (id) {
          const previousId = this.activeConversationId;
          if (previousId && previousId !== id) await this.emitSessionEvent("inactive", previousId);
          this.activeConversationId = id;
          this.currentFile = undefined;
          this.currentFileCwd = undefined;
          this.pos = 0;
          this.lastEmittedKey = "";
          this.lastContextNoticeKey = "";
          this.onEvent({ type: "log", message: `[sessions] conversation Codex active via log VS Code: ${id}` });
          await this.emitSessionEvent("ouverture", id, true);
        }
      }
    } finally {
      await fd.close();
      this.codexLogPos = st.size;
    }
  }

  private parseTimestamp(obj: Record<string, unknown>): number | null {
    const raw = obj.timestamp;
    if (typeof raw === "string") {
      const t = Date.parse(raw);
      if (!Number.isNaN(t)) return t;
    }
    return null;
  }

  private normalizePath(p: string): string {
    return String(p || "")
      .replace(/\//g, "\\")
      .trim()
      .toLowerCase();
  }

  private matchesWorkspace(cwd: string | undefined): boolean {
    const root = this.opts.workspaceRoot;
    if (!root) return true;
    if (!cwd) return false;
    const a = this.normalizePath(cwd);
    const b = this.normalizePath(root);
    return a === b || a.startsWith(b + "\\") || this.matchesRenamedWorkspace(cwd, root);
  }

  private matchesRenamedWorkspace(cwd: string, root: string): boolean {
    try {
      if (fs.existsSync(cwd) || !fs.existsSync(root)) return false;
      if (this.normalizePath(path.dirname(cwd)) !== this.normalizePath(path.dirname(root))) {
        return false;
      }
      const oldName = path.basename(cwd).toLowerCase();
      const newName = path.basename(root).toLowerCase();
      const stripRenameSuffix = (name: string) => name.replace(/(?:[-_ ]?(?:new|old|copy|copie)\d*)$/i, "");
      return stripRenameSuffix(oldName) === newName || stripRenameSuffix(newName) === oldName;
    } catch {
      return false;
    }
  }

  private async readRolloutSummary(file: string): Promise<RolloutSummary> {
    try {
      const st = await fsp.stat(file);
      const size = st.size || 0;
      const tailSize = Math.min(size, 2_000_000);
      const start = Math.max(0, size - tailSize);
      const fd = await fsp.open(file, "r");
      try {
        const buf = Buffer.alloc(size - start);
        await fd.read(buf, 0, buf.length, start);
        const text = buf.toString("utf8");
        const lines = text.split(/\r?\n/g);
        let last: { text: string; key: string; ts: number; cwd?: string } | undefined;
        let currentCwd: string | undefined;
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed) as Record<string, unknown>;
            if (obj.type === "turn_context" && obj.payload && typeof obj.payload === "object") {
              const p = obj.payload as Record<string, unknown>;
              if (typeof p.cwd === "string") currentCwd = p.cwd;
            }
            const res = this.extractAssistantText(obj);
            if (res) {
              const ts = this.parseTimestamp(obj) ?? st.mtimeMs ?? 0;
              last = { text: res.text, key: res.key, ts, cwd: currentCwd };
            }
          } catch {
            // ignore
          }
        }
        return { last, cwd: currentCwd };
      } finally {
        await fd.close();
      }
    } catch {
      return {};
    }
  }

  private payloadToText(payload: unknown): string {
    if (payload && typeof payload === "object") {
      const p = payload as Record<string, unknown>;
      const content = p.content;
      if (typeof content === "string") return content.trim();
      if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const item of content) {
          if (item && typeof item === "object") {
            const d = item as Record<string, unknown>;
            const txt = d.text;
            if (typeof txt === "string") parts.push(txt);
          }
        }
        return parts.join("").trim();
      }
    }
    return "";
  }

  private extractAssistantText(obj: unknown): { text: string; key: string } | undefined {
    if (!obj || typeof obj !== "object") return undefined;
    const o = obj as Record<string, unknown>;

    const t = (o.type || o.event) as unknown;
    const payload = o.payload as unknown;

    if (t === "response_item" && payload && typeof payload === "object") {
      const p = payload as Record<string, unknown>;
      if (p.role === "assistant") {
        const text = this.payloadToText(p);
        if (text) {
          const mid = String((p.id as unknown) || (o.id as unknown) || "");
          const key = mid ? mid : `hash:${String(hashString(text))}`;
          return { text, key };
        }
      }
    }

    const role = (o.role || o.author) as unknown;
    if (role === "assistant") {
      const content = o.content as unknown;
      if (typeof content === "string" && content.trim()) {
        const text = content.trim();
        const key = String((o.id as unknown) || `hash:${String(hashString(text))}`);
        return { text, key };
      }
    }

    const msg = o.message as unknown;
    if (msg && typeof msg === "object") {
      const m = msg as Record<string, unknown>;
      const r = (m.role || m.author) as unknown;
      if (r === "assistant") {
        const c = m.content as unknown;
        if (typeof c === "string" && c.trim()) {
          const text = c.trim();
          const key = String((m.id as unknown) || (o.id as unknown) || `hash:${String(hashString(text))}`);
          return { text, key };
        }
      }
    }

    return undefined;
  }

  private async tick(): Promise<void> {
    await this.emitWorkspaceConversationList();
    await this.updateActiveConversationFromCodexLog();
    if (!this.activeConversationId) return;

    const latest = await this.findActiveRollout(this.activeConversationId);
    if (!latest) return;

    const activeCwd = latest.last?.cwd ?? latest.cwd;
    if (this.opts.workspaceRoot && !this.matchesWorkspace(activeCwd)) {
      await this.emitOutOfContextNotice(this.activeConversationId);
      this.currentFile = undefined;
      this.currentFileCwd = undefined;
      this.pos = 0;
      this.lastEmittedKey = "";
      return;
    }

    if (latest.file !== this.currentFile) {
      this.currentFile = latest.file;
      this.currentFileCwd = latest.last?.cwd ?? latest.cwd;
      this.onEvent({ type: "file", file: latest.file });
      if (latest.last && latest.last.key !== this.lastEmittedKey) {
        this.lastEmittedKey = latest.last.key;
        if (this.opts.readLastOnStart) {
          this.onEvent({
            type: "message",
            text: latest.last.text,
            key: latest.last.key,
            source: "codex_sessions",
            initial: true,
          });
        } else {
          this.onEvent({
            type: "loaded",
            text: `${this.displayLang() === "en" ? "Latest response:" : "Derniere reponse :"}\n\n${latest.last.text}`,
            key: latest.last.key,
            source: "codex_sessions",
            file: latest.file,
          });
        }
      } else if (latest.last) {
        this.lastEmittedKey = latest.last.key;
      }
      if (this.opts.scrubTtsFields) {
        this.scrubPending = true;
        await this.maybeScrubFile(latest.file);
      }
      try {
        const st = await fsp.stat(latest.file);
        this.pos = st.size;
      } catch {
        this.pos = 0;
      }
    }

    if (!this.currentFile) return;

    try {
      const fd = await fsp.open(this.currentFile, "r");
      try {
        const st = await fd.stat();
        const size = st.size;
        if (this.pos > size) this.pos = size;
        if (size === this.pos) {
          // nothing new
        } else {
          const buf = Buffer.alloc(size - this.pos);
          await fd.read(buf, 0, buf.length, this.pos);
          const text = buf.toString("utf8");
          const lines = text.split(/\r?\n/g);
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const obj = JSON.parse(trimmed) as unknown;
              if (
                obj &&
                typeof obj === "object" &&
                (obj as any).type === "turn_context" &&
                (obj as any).payload &&
                typeof (obj as any).payload === "object" &&
                typeof (obj as any).payload.cwd === "string"
              ) {
                this.currentFileCwd = String((obj as any).payload.cwd);
              }
              const res = this.extractAssistantText(obj);
              if (res && res.key !== this.lastEmittedKey) {
                this.lastEmittedKey = res.key;
                this.onEvent({ type: "message", text: res.text, key: res.key, source: "codex_sessions" });
              }
              if (this.opts.scrubTtsFields && this.scrubAny(obj)) {
                this.scrubPending = true;
              }
            } catch {
              // ignore
            }
          }
        }
        this.pos = size;
      } finally {
        await fd.close();
      }
    } catch {
      // ignore (file being written/rotated)
    }

    if (this.currentFile && this.scrubPending) {
      await this.maybeScrubFile(this.currentFile);
    }
  }

  private scrubAny(obj: unknown): boolean {
    // quick heuristic: if any key matches scrubKeys (case-insensitive)
    const keys = new Set(this.opts.scrubKeys.map((k) => k.toLowerCase()));
    const stack: unknown[] = [obj];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur) continue;
      if (Array.isArray(cur)) {
        for (const it of cur) stack.push(it);
        continue;
      }
      if (typeof cur === "object") {
        for (const [k, v] of Object.entries(cur as Record<string, unknown>)) {
          if (keys.has(k.toLowerCase())) return true;
          stack.push(v);
        }
      }
    }
    return false;
  }

  private deleteScrubKeys(obj: unknown): unknown {
    const keys = new Set(this.opts.scrubKeys.map((k) => k.toLowerCase()));
    if (Array.isArray(obj)) {
      return obj.map((v) => this.deleteScrubKeys(v));
    }
    if (obj && typeof obj === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (keys.has(k.toLowerCase())) continue;
        out[k] = this.deleteScrubKeys(v);
      }
      return out;
    }
    return obj;
  }

  private async maybeScrubFile(file: string): Promise<void> {
    if (!this.opts.scrubTtsFields) return;
    const now = Date.now();
    if (now - this.lastScrubAt < this.opts.scrubMinIntervalMs) return;

    let st: fs.Stats;
    try {
      st = await fsp.stat(file);
    } catch {
      return;
    }
    if (now - st.mtimeMs < this.opts.scrubIdleMs) return;

    const beforeMtimeMs = st.mtimeMs;
    const beforeSize = st.size;

    let raw: string;
    try {
      raw = await fsp.readFile(file, "utf8");
    } catch {
      return;
    }

    const outLines: string[] = [];
    let changed = false;
    for (const line of raw.split(/\r?\n/g)) {
      if (!line.trim()) {
        outLines.push(line);
        continue;
      }
      try {
        const obj = JSON.parse(line) as unknown;
        const cleaned = this.deleteScrubKeys(obj);
        const cleanedLine = JSON.stringify(cleaned);
        if (cleanedLine !== line) changed = true;
        outLines.push(cleanedLine);
      } catch {
        outLines.push(line);
      }
    }

    if (!changed) {
      this.lastScrubAt = now;
      this.scrubPending = false;
      return;
    }

    const tmp = `${file}.tmp`;
    try {
      await fsp.writeFile(tmp, outLines.join("\n"), "utf8");
      const latest = await fsp.stat(file);
      if (latest.mtimeMs !== beforeMtimeMs || latest.size !== beforeSize) {
        await safeUnlink(tmp);
        return;
      }
      await fsp.rename(tmp, file);
      this.lastScrubAt = now;
      this.scrubPending = false;
      try {
        const after = await fsp.stat(file);
        this.pos = after.size;
      } catch {
        this.pos = 0;
      }
    } catch {
      await safeUnlink(tmp);
    }
  }
}

function hashString(s: string): number {
  // stable-ish hash, not crypto
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await fsp.unlink(p);
  } catch {
    // ignore
  }
}
