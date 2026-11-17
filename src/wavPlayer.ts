import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const startupTimeoutMs = 15_000;
const outputRefreshTimeoutMs = 10_000;
interface ActivePlayback {
  id: string;
  onStarted: () => void;
  resolve: () => void;
  reject: (error: Error) => void;
  started: boolean;
}

interface OutputRefreshRequest {
  id: string;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

export class WavPlayer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private playback: ActivePlayback | null = null;
  private outputRefresh: OutputRefreshRequest | null = null;
  private readonly volumeRequests = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private stderr = "";
  private disposed = false;

  constructor(private readonly options: { cwd: string; env: NodeJS.ProcessEnv }) {}

  async warmup(): Promise<void> {
    await this.ensureStarted();
  }

  async setVolume(volume: number): Promise<void> {
    if (!Number.isInteger(volume) || volume < 0 || volume > 100) throw new Error("Volume must be between 0 and 100.");
    await this.ensureStarted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.volumeRequests.set(id, { resolve, reject });
      this.write({ type: "volume", id, volume });
    });
  }

  async refreshOutput(): Promise<void> {
    await this.ensureStarted();
    if (this.outputRefresh) {
      return this.outputRefresh.promise;
    }
    const id = randomUUID();
    let resolveRequest!: () => void;
    let rejectRequest!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const request: OutputRefreshRequest = {
      id,
      promise,
      resolve: resolveRequest,
      reject: rejectRequest,
      timer: null,
    };
    request.timer = setTimeout(() => {
      this.finishOutputRefresh(request, new Error("WAV output refresh timed out."));
    }, outputRefreshTimeoutMs);
    this.outputRefresh = request;
    this.write({ type: "refresh", id });
    return promise;
  }

  async play(wavPath: string, _durationSeconds: number, onStarted: () => void): Promise<void> {
    this.stop();
    await this.ensureStarted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.playback = {
        id,
        onStarted,
        resolve,
        reject,
        started: false,
      };
      this.write({ type: "play", id, path: wavPath });
    });
  }

  stop(): void {
    const playback = this.playback;
    if (!playback) {
      return;
    }
    this.finishPlayback(playback, new Error("WAV playback was stopped."));
    this.write({ type: "stop", id: playback.id });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stop();
    for (const request of this.volumeRequests.values()) request.reject(new Error("WAV player was disposed."));
    this.volumeRequests.clear();
    const outputRefresh = this.outputRefresh;
    if (outputRefresh) {
      this.finishOutputRefresh(outputRefresh, new Error("WAV player was disposed."));
    }
    const child = this.child;
    this.child = null;
    this.rejectStartup(new Error("WAV player was disposed."));
    if (!child) {
      return;
    }
    try {
      child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      child.stdin.end();
    } catch {
      child.kill();
      return;
    }
    const killTimer = setTimeout(() => {
      if (!child.killed) {
        child.kill();
      }
    }, 1_000);
    killTimer.unref();
  }

  private async ensureStarted(): Promise<void> {
    if (this.disposed) {
      throw new Error("WAV player was disposed.");
    }
    if (this.readyPromise) {
      return this.readyPromise;
    }
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.readyTimer = setTimeout(() => {
      this.handleExit(new Error("WAV player startup timed out."));
    }, startupTimeoutMs);
    this.start();
    return this.readyPromise;
  }

  private start(): void {
    this.stderr = "";
    const child = spawn("uv", ["run", "python", "tools/wav_player_worker.py"], {
      cwd: this.options.cwd,
      env: this.options.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const reader = createInterface({ input: child.stdout });
    reader.on("line", (line) => this.handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });
    child.on("error", (error) => {
      if (this.child === child) {
        this.handleExit(error);
      }
    });
    child.on("close", (code) => {
      if (this.child === child) {
        this.handleExit(new Error(`WAV player exited with code ${code}: ${this.stderr}`));
      }
    });
  }

  private handleLine(line: string): void {
    let payload: any;
    try {
      payload = JSON.parse(line);
    } catch {
      return;
    }
    if (payload.type === "ready" && payload.ok) {
      if (this.readyTimer) {
        clearTimeout(this.readyTimer);
        this.readyTimer = null;
      }
      this.resolveReady?.();
      this.resolveReady = null;
      this.rejectReady = null;
      return;
    }
    const volumeRequest = this.volumeRequests.get(payload.id);
    if (volumeRequest) {
      this.volumeRequests.delete(payload.id);
      if (payload.ok === false || payload.type === "error") volumeRequest.reject(new Error(payload.error ?? "WAV volume failed."));
      else volumeRequest.resolve();
      return;
    }
    const outputRefresh = this.outputRefresh;
    if (outputRefresh && payload.id === outputRefresh.id) {
      if (payload.type === "error" || payload.ok === false) {
        this.finishOutputRefresh(outputRefresh, new Error(payload.error ?? "WAV output refresh failed."));
        return;
      }
      if (payload.type === "refreshed") {
        this.finishOutputRefresh(outputRefresh);
      }
      return;
    }
    const playback = this.playback;
    if (!playback || payload.id !== playback.id) {
      return;
    }
    if (payload.type === "error" || payload.ok === false) {
      this.finishPlayback(playback, new Error(payload.error ?? "WAV playback failed."));
      return;
    }
    if (payload.type === "finished") {
      if (!playback.started) {
        this.finishPlayback(playback, new Error("WAV playback finished before it started."));
        return;
      }
      this.finishPlayback(playback);
      return;
    }
    if (payload.type === "stopped") {
      this.finishPlayback(playback, new Error("WAV playback was stopped."));
      return;
    }
    if (payload.type !== "started" || playback.started) {
      return;
    }
    playback.started = true;
    try {
      playback.onStarted();
    } catch (error) {
      this.finishPlayback(playback, error instanceof Error ? error : new Error(String(error)));
      this.write({ type: "stop", id: playback.id });
      return;
    }
  }

  private finishPlayback(playback: ActivePlayback, error?: Error): void {
    if (this.playback !== playback) {
      return;
    }
    this.playback = null;
    if (error) {
      playback.reject(error);
    } else {
      playback.resolve();
    }
  }

  private finishOutputRefresh(request: OutputRefreshRequest, error?: Error): void {
    if (this.outputRefresh !== request) {
      return;
    }
    this.outputRefresh = null;
    if (request.timer) {
      clearTimeout(request.timer);
      request.timer = null;
    }
    if (error) {
      request.reject(error);
    } else {
      request.resolve();
    }
  }

  private write(payload: Record<string, unknown>): void {
    if (!this.child || this.child.killed) {
      return;
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private rejectStartup(error: Error): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    this.rejectReady?.(error);
    this.resolveReady = null;
    this.rejectReady = null;
    this.readyPromise = null;
  }

  private handleExit(error: Error): void {
    for (const request of this.volumeRequests.values()) request.reject(error);
    this.volumeRequests.clear();
    const playback = this.playback;
    if (playback) {
      this.finishPlayback(playback, error);
    }
    const outputRefresh = this.outputRefresh;
    if (outputRefresh) {
      this.finishOutputRefresh(outputRefresh, error);
    }
    const child = this.child;
    this.child = null;
    if (child && !child.killed) {
      child.kill();
    }
    this.rejectStartup(error);
  }
}
