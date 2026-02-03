import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import fg from "fast-glob";

export type SessionsWatcherEvent =
  | { type: "log"; message: string }
  | { type: "file"; file: string }
  | { type: "message"; text: string; key: string; source: "codex_sessions"; initial?: boolean };

export type SessionsWatcherOptions = {
  pollIntervalMs: number;
  readLastOnStart: boolean;
  scrubTtsFields: boolean;
  scrubIdleMs: number;
  scrubMinIntervalMs: number;
  pattern: string;
  scrubKeys: string[];
};

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
  private pos = 0;
  private lastEmittedKey = "";
  private lastScrubAt = 0;
  private scrubPending = false;

  constructor(
    onEvent: (evt: SessionsWatcherEvent) => void,
    opts?: Partial<SessionsWatcherOptions>,
  ) {
    this.onEvent = onEvent;
    this.opts = {
      pollIntervalMs: 500,
      readLastOnStart: true,
      scrubTtsFields: true,
      scrubIdleMs: 1000,
      scrubMinIntervalMs: 2000,
      pattern: "**/rollout-*.jsonl",
      scrubKeys: DEFAULT_SCRUB_KEYS,
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

  private async findLatestRollout(): Promise<string | undefined> {
    const root = this.sessionsRoot();
    try {
      await fsp.access(root);
    } catch {
      return undefined;
    }
    const files = await fg(this.opts.pattern, {
      cwd: root,
      absolute: true,
      onlyFiles: true,
      dot: true,
      suppressErrors: true,
    });
    if (files.length === 0) return undefined;

    let best = files[0]!;
    let bestMtime = 0;
    for (const file of files) {
      try {
        const st = await fsp.stat(file);
        const m = st.mtimeMs || 0;
        if (m >= bestMtime) {
          bestMtime = m;
          best = file;
        }
      } catch {
        // ignore
      }
    }
    return best;
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

  private async primeLastMessage(file: string): Promise<void> {
    if (!this.opts.readLastOnStart) return;
    let last: { text: string; key: string } | undefined;
    try {
      const raw = await fsp.readFile(file, "utf8");
      for (const line of raw.split(/\r?\n/g)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as unknown;
          const res = this.extractAssistantText(obj);
          if (res) last = res;
        } catch {
          // ignore
        }
      }
    } catch {
      return;
    }
    if (last && last.key !== this.lastEmittedKey) {
      this.lastEmittedKey = last.key;
      this.onEvent({ type: "message", text: last.text, key: last.key, source: "codex_sessions", initial: true });
    }
  }

  private async tick(): Promise<void> {
    const latest = await this.findLatestRollout();
    if (!latest) return;

    if (latest !== this.currentFile) {
      this.currentFile = latest;
      this.onEvent({ type: "file", file: latest });
      await this.primeLastMessage(latest);
      if (this.opts.scrubTtsFields) {
        this.scrubPending = true;
        await this.maybeScrubFile(latest);
      }
      try {
        const st = await fsp.stat(latest);
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
        if (this.pos > size) this.pos = 0;
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

    const beforeMtimeNs = st.mtimeNs?.toString?.() ?? String(st.mtimeMs);
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
      const latestMtimeNs = latest.mtimeNs?.toString?.() ?? String(latest.mtimeMs);
      if (latestMtimeNs !== beforeMtimeNs || latest.size !== beforeSize) {
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
