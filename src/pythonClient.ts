import * as cp from "node:child_process";
import * as path from "node:path";
import * as readline from "node:readline";
import * as vscode from "vscode";

export type BackendEvent =
  | { type: "log"; message: string }
  | { type: "started" }
  | { type: "finished" }
  | { type: "error"; message: string }
  | { type: "backend_exit"; code: number | null; signal: string | null }
  | {
      type: "ui_cmd";
      cmd: "playPause" | "stop" | "toggleMute" | "openOptions" | "openTranslation" | "openFile";
      path?: string;
    };

type RpcRequest = { id: string; method: string; params?: unknown };
type RpcResponse = { id: string; ok: boolean; result?: unknown; error?: string };
type RpcEvent = { type: "event"; event: BackendEvent };

export class PythonBackendClient implements vscode.Disposable {
  private proc: cp.ChildProcessWithoutNullStreams | undefined;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly onEventCb: (evt: BackendEvent) => void;

  constructor(onEvent: (evt: BackendEvent) => void) {
    this.onEventCb = onEvent;
  }

  dispose(): void {
    this.stop();
    for (const d of this.disposables) d.dispose();
  }

  start(pythonPath: string, extensionPath: string): void {
    this.stop();
    if (!pythonPath || !pythonPath.trim()) {
      throw new Error("Chemin Python vide.");
    }
    const script = path.join(extensionPath, "python", "codex_audio_backend.py");
    this.proc = cp.spawn(pythonPath, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.onLine(line));
    this.proc.stderr.on("data", (buf) => {
      const msg = String(buf || "").trim();
      if (msg) this.onEventCb({ type: "log", message: `[py] ${msg}` });
    });

    const cleanup = (code: number | null, signal: string | null, message?: string): void => {
      if (message) this.onEventCb({ type: "log", message });
      this.onEventCb({ type: "backend_exit", code, signal });
      for (const [id, p] of this.pending.entries()) {
        p.reject(new Error(`Python backend exited (id=${id})`));
      }
      this.pending.clear();
      rl.close();
      this.proc = undefined;
    };

    this.proc.on("error", (err) => {
      cleanup(null, null, `[py] spawn error: ${String(err)}`);
      this.onEventCb({ type: "error", message: `Backend Python introuvable ou invalide: ${String(err)}` });
    });

    this.proc.on("exit", (code, signal) => {
      cleanup(code ?? null, signal ?? null, `[py] exit code=${code} signal=${signal ?? ""}`);
    });
  }

  stop(): void {
    if (!this.proc) return;
    try {
      this.proc.kill();
    } catch {
      // ignore
    }
    this.proc = undefined;
    this.pending.clear();
  }

  isRunning(): boolean {
    return !!this.proc;
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.proc || !this.proc.stdin.writable) throw new Error("Python backend non démarré.");
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const req: RpcRequest = { id, method, params };
    const payload = JSON.stringify(req);
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as unknown as (v: unknown) => void, reject });
    });
    this.proc.stdin.write(payload + "\n");
    return p;
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.onEventCb({ type: "log", message: `[py] ${trimmed}` });
      return;
    }

    if (isRpcResponse(msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || "Erreur backend Python"));
      return;
    }

    if (isRpcEvent(msg)) {
      this.onEventCb(msg.event);
      return;
    }
  }
}

function isRpcResponse(v: unknown): v is RpcResponse {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.ok === "boolean";
}

function isRpcEvent(v: unknown): v is RpcEvent {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return o.type === "event" && typeof o.event === "object" && o.event !== null;
}
