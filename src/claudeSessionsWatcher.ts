import * as fsp from "node:fs/promises";
import * as path from "node:path";

export type ClaudeWatcherEvent =
  | { type: "log"; message: string }
  | { type: "message"; text: string; key: string };

export type ClaudeWatcherOptions = {
  pollIntervalMs: number;
  workspaceRoot: string;
};

const TURN_DEBOUNCE_MS = 2500;

/**
 * Surveille la session Claude Code en cours (~/.claude/projects/<workspace>/*.jsonl)
 * et émet chaque nouveau texte de réponse de l'assistant. Ne rejoue jamais l'historique.
 */
export class ClaudeSessionsWatcher {
  private timer: NodeJS.Timeout | undefined;
  private currentFile: string | undefined;
  private pos = 0;
  private busy = false;
  private pending: { text: string; key: string }[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private readonly seenKeys = new Set<string>();
  private readonly startedAt = Date.now();

  constructor(
    private readonly onEvent: (evt: ClaudeWatcherEvent) => void,
    private readonly opts: ClaudeWatcherOptions,
  ) {}

  start(): void {
    this.stop();
    this.onEvent({ type: "log", message: "[claude] watcher démarré" });
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      this.tick()
        .catch(() => {})
        .finally(() => {
          this.busy = false;
        });
    }, this.opts.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.pending = [];
  }

  /** Regroupe les textes d'un même tour : émis en un seul message après un court silence. */
  private enqueue(text: string, key: string): void {
    this.pending.push({ text, key });
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      const items = this.pending;
      this.pending = [];
      if (items.length === 0) return;
      this.onEvent({
        type: "message",
        text: items.map((i) => i.text).join("\n\n"),
        key: items[items.length - 1].key,
      });
    }, TURN_DEBOUNCE_MS);
  }

  private projectDir(): string {
    const home = process.env.USERPROFILE || process.env.HOME || "";
    // Claude Code encode le chemin du projet en remplaçant tout caractère non alphanumérique par "-".
    const encoded = this.opts.workspaceRoot.replace(/[^a-zA-Z0-9]/g, "-");
    return path.join(home, ".claude", "projects", encoded);
  }

  private async findLatestFile(dir: string): Promise<{ file: string; birthMs: number } | undefined> {
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return undefined;
    }
    let best: { file: string; mtimeMs: number; birthMs: number } | undefined;
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dir, name);
      try {
        const st = await fsp.stat(file);
        if (!best || st.mtimeMs > best.mtimeMs) {
          best = { file, mtimeMs: st.mtimeMs, birthMs: st.birthtimeMs };
        }
      } catch {
        // ignore
      }
    }
    return best;
  }

  private extract(obj: any): { text: string; key: string } | undefined {
    if (!obj || obj.type !== "assistant" || obj.isSidechain) return undefined;
    // Ignore tout message antérieur au démarrage (historique recopié lors d'une reprise de session).
    const ts = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
    if (!Number.isNaN(ts) && ts < this.startedAt - 2000) return undefined;
    const msg = obj.message;
    if (!msg || msg.role !== "assistant") return undefined;
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text)
        .join("\n");
    }
    text = text.trim();
    if (!text) return undefined;
    return { text, key: String(obj.uuid || msg.id || text.slice(0, 64)) };
  }

  private async tick(): Promise<void> {
    if (!this.opts.workspaceRoot) return;
    const latest = await this.findLatestFile(this.projectDir());
    if (!latest) return;

    if (latest.file !== this.currentFile) {
      const isFirst = this.currentFile === undefined;
      this.currentFile = latest.file;
      // Fichier créé après le démarrage : nouvelle session, on lit depuis le début.
      // Sinon on se place à la fin pour ne pas rejouer l'historique.
      const isNewSession = latest.birthMs > this.startedAt - 1000 && !isFirst;
      if (isNewSession) {
        this.pos = 0;
      } else {
        this.pos = (await fsp.stat(latest.file)).size;
      }
      this.onEvent({ type: "log", message: `[claude] session suivie: ${path.basename(latest.file)}` });
      if (!isNewSession) return;
    }

    const fd = await fsp.open(this.currentFile, "r");
    try {
      const size = (await fd.stat()).size;
      if (this.pos > size) this.pos = size;
      if (size === this.pos) return;
      const buf = Buffer.alloc(size - this.pos);
      await fd.read(buf, 0, buf.length, this.pos);
      const raw = buf.toString("utf8");
      // Ne consommer que les lignes complètes (la dernière peut être en cours d'écriture).
      const lastNl = raw.lastIndexOf("\n");
      if (lastNl < 0) return;
      this.pos += Buffer.byteLength(raw.slice(0, lastNl + 1), "utf8");
      for (const line of raw.slice(0, lastNl).split(/\r?\n/g)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const res = this.extract(JSON.parse(trimmed));
          if (res && !this.seenKeys.has(res.key)) {
            this.seenKeys.add(res.key);
            this.enqueue(res.text, res.key);
          }
        } catch {
          // ignore
        }
      }
    } finally {
      await fd.close();
    }
  }
}
