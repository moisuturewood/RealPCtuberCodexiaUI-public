import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

import type { LipSyncFrame, MouthProfile, VoicevoxAcceleration } from "./types.js";

export interface VoicevoxSynthesisRequest {
  text: string;
  styleId: number;
  output: string;
  speedFactor: number;
  lipSyncFrameMs: number;
  mouthProfile: MouthProfile;
  synthesisMode?: "audio-query" | "tts";
}

export interface VoicevoxSynthesisResult {
  ok: boolean;
  output?: string;
  bytes?: number;
  durationSeconds?: number;
  speedFactor?: number;
  lipSync?: LipSyncFrame[];
  styleId?: number;
  speaker?: string;
  style?: string;
  model?: string;
  synthesisMode?: string;
  error?: string;
}

interface PendingRequest {
  resolve: (payload: VoicevoxSynthesisResult) => void;
  reject: (error: Error) => void;
  onPlaybackStarted?: (payload: VoicevoxSynthesisResult) => void;
}

export class VoicevoxWorkerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private pending = new Map<string, PendingRequest>();
  private stderr = "";

  constructor(
    private readonly options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      coreRoot: string;
      openJtalkRoot: string;
      defaultStyleId: number;
      timeoutMs: number;
      acceleration: VoicevoxAcceleration;
    },
  ) {}

  getAcceleration(): VoicevoxAcceleration {
    return this.options.acceleration;
  }

  async setAcceleration(acceleration: VoicevoxAcceleration, restart = true): Promise<void> {
    if (this.options.acceleration === acceleration) {
      if (restart) {
        await this.warmup();
      }
      return;
    }
    this.options.acceleration = acceleration;
    if (restart) {
      this.stop();
      await this.warmup();
    }
  }

  async warmup(): Promise<void> {
    await this.ensureStarted();
  }

  async synthesize(request: VoicevoxSynthesisRequest): Promise<VoicevoxSynthesisResult> {
    return this.runSynthesis(request, false);
  }

  async synthesizeAndPlay(
    request: VoicevoxSynthesisRequest,
    onPlaybackStarted: (payload: VoicevoxSynthesisResult) => void,
  ): Promise<VoicevoxSynthesisResult> {
    return this.runSynthesis(request, true, onPlaybackStarted);
  }

  private async runSynthesis(
    request: VoicevoxSynthesisRequest,
    play: boolean,
    onPlaybackStarted?: (payload: VoicevoxSynthesisResult) => void,
  ): Promise<VoicevoxSynthesisResult> {
    await this.ensureStarted();
    const id = randomUUID();
    const payload = {
      id,
      play,
      text: request.text,
      styleId: request.styleId,
      output: request.output,
      speedFactor: request.speedFactor,
      lipSyncFrameMs: request.lipSyncFrameMs,
      mouthProfile: request.mouthProfile,
      synthesisMode: request.synthesisMode,
    };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`VOICEVOX worker timed out after ${this.options.timeoutMs}ms`));
      }, this.options.timeoutMs);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        onPlaybackStarted,
      });
      const line = `${JSON.stringify(payload)}\n`;
      if (!this.child?.stdin.write(line)) {
        this.child?.stdin.once("drain", () => undefined);
      }
    });
  }

  stop(): void {
    const child = this.child;
    if (!child) {
      return;
    }
    this.child = null;
    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;
    try {
      child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
    } catch {
      // The process is already stopping.
    }
    child.kill();
    const error = new Error("VOICEVOX worker was restarted.");
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async ensureStarted(): Promise<void> {
    if (this.readyPromise) {
      return this.readyPromise;
    }
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.start();
    return this.readyPromise;
  }

  private start(): void {
    this.stderr = "";
    const child = spawn("uv", [
      "run",
      "python",
      "tools/voicevox_worker.py",
      "--core-root",
      this.options.coreRoot,
      "--open-jtalk-root",
      this.options.openJtalkRoot,
      "--default-style-id",
      String(this.options.defaultStyleId),
      "--acceleration",
      this.options.acceleration,
      "--synthesis-mode",
      this.options.env.VOICEVOX_SYNTHESIS_MODE || "audio-query",
    ], {
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
      if (this.child !== child) {
        return;
      }
      this.handleExit(new Error(`VOICEVOX worker exited with code ${code}: ${this.stderr}`));
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
      this.resolveReady?.();
      this.resolveReady = null;
      this.rejectReady = null;
      return;
    }
    if (payload.type === "fatal") {
      this.handleExit(new Error(payload.error ?? "VOICEVOX worker failed to start."));
      return;
    }
    if (typeof payload.id !== "string") {
      return;
    }
    const pending = this.pending.get(payload.id);
    if (!pending) {
      return;
    }
    if (payload.type === "playback_started") {
      pending.onPlaybackStarted?.(payload as VoicevoxSynthesisResult);
      return;
    }
    this.pending.delete(payload.id);
    if (payload.ok) {
      pending.resolve(payload as VoicevoxSynthesisResult);
      return;
    }
    pending.reject(new Error(payload.error ?? "VOICEVOX worker failed."));
  }

  private handleExit(error: Error): void {
    this.rejectReady?.(error);
    this.resolveReady = null;
    this.rejectReady = null;
    this.readyPromise = null;
    this.child = null;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
