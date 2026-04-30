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
      cmd:
        | "playPause"
        | "stop"
        | "toggleMute"
        | "openOptions"
        | "openTranslation"
        | "openFile"
        | "translationClosed";
      path?: string;
    };

type RpcRequest = { id: string; method: string; params?: unknown };
type RpcResponse = { id: string; ok: boolean; result?: unknown; error?: string };
type RpcEvent = { type: "event"; event: BackendEvent };

type PendingRequest = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timeout?: NodeJS.Timeout;
};

export class PythonBackendClient implements vscode.Disposable {
  private proc: cp.ChildProcessWithoutNullStreams | undefined;
  private pending = new Map<string, PendingRequest>();
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
    const trimmedPythonPath = pythonPath.trim();
    const expectsExplicitPython =
      trimmedPythonPath.includes("\\") ||
      trimmedPythonPath.includes("/") ||
      (process.platform === "win32" && trimmedPythonPath.includes(":")) ||
      trimmedPythonPath.toLowerCase().endsWith(".exe");

    const script = path.join(extensionPath, "python", "codex_audio_backend.py");
    this.proc = cp.spawn(pythonPath, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        CODEXAUDIO_EXPECTED_PYTHON: expectsExplicitPython ? trimmedPythonPath : "",
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
        if (p.timeout) clearTimeout(p.timeout);
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
    const pid = this.proc.pid;
    try {
      if (process.platform === "win32" && typeof pid === "number" && pid > 0) {
        try {
          cp.spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
        } catch {
          // ignore
        }
      } else {
        this.proc.kill();
      }
    } catch {
      // ignore
    }
    this.proc = undefined;
    for (const p of this.pending.values()) {
      if (p.timeout) clearTimeout(p.timeout);
    }
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
      const timeout = setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        entry.reject(new Error(`Timeout backend (${method})`));
      }, 15000);
      this.pending.set(id, {
        resolve: resolve as unknown as (v: unknown) => void,
        reject,
        timeout,
      });
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
      if (p.timeout) clearTimeout(p.timeout);
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
