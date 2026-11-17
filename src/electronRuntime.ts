import { EventEmitter } from "node:events";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { analyzeAndPersist } from "./analysis.js";
import { readCodexThreadNameFromIndex } from "./codexThreadName.js";
import { CodexThreadWatcherManager, type StartThreadWatchInput } from "./codexThreadWatcher.js";
import { readJsonlTail } from "./jsonlTail.js";
import type { FloatingRendererSnapshot } from "./floatingRendererHealth.js";
import {
  analysisJsonlPath,
  audioOutputDir,
  avatarBridgeRoot,
  avatarRenderedDir,
  configDir,
  openJtalkRoot,
  projectRoot,
  threadProfilesPath,
  voicevoxCoreRoot,
} from "./paths.js";
import { normalizeForSpeech } from "./pronunciation.js";
import { splitSpeechSentences } from "./speechText.js";
import { VoicevoxWorkerClient, type VoicevoxSynthesisResult } from "./voicevoxWorker.js";
import { WavPlayer } from "./wavPlayer.js";
import {
  parseVoicevoxAcceleration,
  readVoicevoxSettings,
  writeVoicevoxSettings,
} from "./voicevoxSettings.js";
import type {
  AnalysisEvent,
  CodexThreadWatchState,
  EventKind,
  EventPriority,
  MouthFrame,
  MouthProfile,
  ProgressEventInput,
  ProgressEventRecord,
  RuntimeState,
  SpeechJob,
  VoicevoxAcceleration,
} from "./types.js";

const maxEvents = 200;
const avatarFrameCacheMs = 1_000;
const maxQueueItems = 40;
const threadPollMs = Number(process.env.THREAD_WATCH_POLL_MS ?? 250);
const speechSpeedFactor = Number(process.env.METAN_SPEECH_SPEED ?? 1);
const lipSyncFrameMs = Number(process.env.METAN_LIPSYNC_FRAME_MS ?? 45);
const lipSyncLeadMs = Number(process.env.METAN_LIPSYNC_LEAD_MS ?? 60);
const maxThreadProfiles = 60;
const threadProfileTitleScanBytes = 512 * 1024;
const staleDefaultThreadProfileNames = new Set(["Elinプレイ実況"]);

const mouthFrameFiles: Record<MouthFrame, string> = {
  closed: "metan_mouth_closed.png",
  small: "metan_mouth_small.png",
  open: "metan_mouth_open.png",
  momuu: "metan_mouth_momuu.png",
  ue: "metan_mouth_ue.png",
  i: "metan_mouth_i.png",
  mu: "metan_mouth_mu.png",
  triangle: "metan_mouth_triangle.png",
  yu: "metan_mouth_yu.png",
  o: "metan_mouth_o.png",
  perori: "metan_mouth_perori.png",
  niyari: "metan_mouth_niyari.png",
  v: "metan_mouth_v.png",
};

const mouthLayerByFrame: Record<MouthFrame, string> = {
  closed: "*ほほえみ",
  small: "*んー",
  open: "*わあー",
  momuu: "*もむー",
  ue: "*うえー",
  i: "*いー",
  mu: "*む",
  triangle: "*△",
  yu: "*ゆ",
  o: "*お",
  perori: "*ぺろり",
  niyari: "*にやり",
  v: "*▽",
};

const normalEyeLayer = "*目セット";
const blinkEyeLayer = "*目閉じ";
const mouthEyeCombinationDir = join(avatarBridgeRoot, "runtime", "combinations", "metan", "!口__!目");
const mouthEyeCombinationManifest = join(mouthEyeCombinationDir, "manifest.json");

export interface ThreadProfile {
  threadId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string;
}

interface SaveThreadProfileInput {
  threadId: string;
  threadName?: string;
}

interface PreparedSpeechChunk {
  text: string;
  audioFile: string;
  payload: VoicevoxSynthesisResult;
}

type PreparedSpeechChunkResult =
  | { ok: true; value: PreparedSpeechChunk }
  | { ok: false; error: unknown };

interface FloatingOverlayControlState {
  desiredVisible: boolean;
  running: boolean;
  lastSeenAt: string | null;
  lastStartedAt: string | null;
  lastActionAt: string | null;
  lastError: string | null;
}

export type ElectronRuntimeSnapshot = RuntimeState & {
  avatarFrames: Record<string, unknown>;
  overlay: Record<string, unknown>;
  server: Record<string, unknown>;
  threadWatchers: CodexThreadWatchState[];
};

export interface VoiceExportResult {
  path: string;
  bytes?: number;
  durationSeconds?: number;
  speaker?: string;
  styleId?: number;
}

function defaultAvatarLayers(): AnalysisEvent["layers"] {
  return {
    mouth: mouthLayerByFrame.closed,
    eyes: normalEyeLayer,
    brows: "*太眉ごきげん",
    faceColor: "*普通2",
    extras: [],
  };
}

export class ElectronRuntime extends EventEmitter {
  private voicevoxAcceleration: VoicevoxAcceleration = initialVoicevoxAcceleration();

  private readonly runtime: RuntimeState = {
    startedAt: new Date().toISOString(),
    events: [],
    speechQueue: [],
    currentSpeech: null,
    avatar: {
      character: "metan",
      speaking: false,
      mouthFrame: "closed",
      emotion: "focused",
      gesture: "idle",
      layers: defaultAvatarLayers(),
    },
    lastError: null,
  };

  private readonly overlayControl: FloatingOverlayControlState = {
    desiredVisible: true,
    running: false,
    lastSeenAt: null,
    lastStartedAt: null,
    lastActionAt: null,
    lastError: null,
  };

  private readonly voicevoxWorker = new VoicevoxWorkerClient({
    cwd: projectRoot,
    env: { ...process.env },
    coreRoot: voicevoxCoreRoot,
    openJtalkRoot,
    defaultStyleId: 2,
    timeoutMs: 180_000,
    acceleration: this.voicevoxAcceleration,
  });

  private readonly wavPlayer = new WavPlayer({
    cwd: projectRoot,
    env: { ...process.env },
  });
  private speechVolume = 100;
  private volumeUpdate: Promise<void> = Promise.resolve();

  private readonly threadWatcher = new CodexThreadWatcherManager({
    pollMs: threadPollMs,
    ingestEvent: async (event) => {
      if (this.shouldIngestThreadWatchEvent(event)) {
        await this.ingestProgressEvent(event);
      }
    },
    onChange: () => this.broadcastSnapshot(),
    onError: (message) => {
      this.runtime.lastError = message;
      this.broadcastSnapshot();
    },
  });

  private activeThreadId: string | null = null;
  private voiceWorkerRunning = false;
  private voiceExportPending = 0;
  private voiceExportTail: Promise<void> = Promise.resolve();
  private avatarFrameCache: { createdAt: number; value: Record<string, unknown> } | null = null;
  private floatingRendererHealth: FloatingRendererSnapshot | null = null;

  async initialize(): Promise<void> {
    await mkdir(audioOutputDir, { recursive: true });
    try {
      const data = JSON.parse(await readFile(join(configDir, "speech-volume.json"), "utf8")) as { volume?: unknown };
      if (typeof data.volume === "number" && Number.isInteger(data.volume) && data.volume >= 0 && data.volume <= 100) this.speechVolume = data.volume;
    } catch { /* Use the default when there is no valid saved volume. */ }
    const settings = await readVoicevoxSettings(this.voicevoxAcceleration);
    this.voicevoxAcceleration = settings.acceleration;
    await this.voicevoxWorker.setAcceleration(settings.acceleration, false);
    await this.ensureAvatarFrames();
    this.avatarFrameCache = null;
    await this.restoreRecentEvents();
    this.broadcastSnapshot();
    void this.voicevoxWorker.warmup().catch((error) => {
      this.runtime.lastError = error instanceof Error ? error.message : String(error);
      this.broadcastSnapshot();
    });
    this.volumeUpdate = this.wavPlayer.setVolume(this.speechVolume).catch((error) => {
      this.runtime.lastError = error instanceof Error ? error.message : String(error);
      this.broadcastSnapshot();
    });
  }

  getSpeechVolume(): { volume: number } {
    return { volume: this.speechVolume };
  }

  async setSpeechVolume(value: unknown): Promise<{ volume: number }> {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) throw new Error("音量は0から100の整数で指定してください。");
    const update = this.volumeUpdate.catch(() => undefined).then(async () => {
      await this.wavPlayer.setVolume(value);
      this.speechVolume = value;
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "speech-volume.json"), `${JSON.stringify({ volume: value }, null, 2)}\n`, "utf8");
    });
    this.volumeUpdate = update;
    await update;
    return { volume: value };
  }

  dispose(): void {
    this.threadWatcher.stopAll();
    this.wavPlayer.dispose();
    this.voicevoxWorker.stop();
  }

  getSnapshot(): ElectronRuntimeSnapshot {
    return {
      ...this.runtime,
      threadWatchers: this.threadWatcher.getStates(),
      avatarFrames: this.getAvatarFrameUrls(),
      overlay: this.buildFloatingOverlayStatus(),
      server: this.buildServerInfo(),
    };
  }

  async setVoicevoxAcceleration(value: unknown): Promise<{ acceleration: VoicevoxAcceleration }> {
    if (this.runtime.currentSpeech || this.voiceWorkerRunning || this.voiceExportPending > 0) {
      throw new Error("読み上げ完了後にCPU/GPUを切り替えてください。");
    }
    const acceleration = parseVoicevoxAcceleration(value);
    const previous = this.voicevoxAcceleration;
    try {
      await this.voicevoxWorker.setAcceleration(acceleration);
    } catch (error) {
      await this.voicevoxWorker.setAcceleration(previous).catch(() => undefined);
      throw error;
    }
    this.voicevoxAcceleration = acceleration;
    await writeVoicevoxSettings({ acceleration });
    this.runtime.lastError = null;
    this.broadcastSnapshot();
    return { acceleration };
  }

  async synthesizeVoiceExport(text: string): Promise<VoiceExportResult> {
    const normalized = text.trim();
    if (!normalized) throw new Error("音声化するテキストが空です。");
    if (normalized.length > 4_000) throw new Error("音声化するテキストは4000文字以内にしてください。");

    this.voiceExportPending += 1;
    const task = this.voiceExportTail.then(() => this.synthesizeVoiceExportNow(normalized));
    this.voiceExportTail = task.then(() => undefined, () => undefined);
    try {
      return await task;
    } finally {
      this.voiceExportPending -= 1;
    }
  }

  async postEvent(input: ProgressEventInput): Promise<{
    event: ProgressEventRecord;
    analysis: AnalysisEvent;
    speechJob: SpeechJob;
  }> {
    return this.ingestProgressEvent(input);
  }

  async startThreadWatch(input: StartThreadWatchInput): Promise<{
    watcher: CodexThreadWatchState;
    profile: ThreadProfile | null;
  }> {
    this.prepareThreadSpeechSwitch(input.threadId);
    const watcher = await this.threadWatcher.start({
      ...input,
      replay: "none",
      includeTools: false,
      includeLifecycle: false,
      maxReplayEvents: 0,
    });
    const profile = watcher.status === "error" ? null : await this.upsertThreadProfile(input, watcher.filePath);
    this.broadcastSnapshot();
    return { watcher, profile };
  }

  stopThreadWatch(threadId: string): { watcher: CodexThreadWatchState | null } {
    const watcher = this.threadWatcher.stop(threadId);
    if (this.activeThreadId === normalizeCodexThreadId(threadId)) {
      this.activeThreadId = null;
    }
    this.broadcastSnapshot();
    return { watcher };
  }

  async getThreadProfiles(): Promise<{ profiles: ThreadProfile[] }> {
    const profiles = await this.readThreadProfiles();
    return { profiles: await Promise.all(profiles.map(async (profile) => {
      if (!isReplaceableThreadProfileName(profile.name, profile.threadId)) return profile;
      const name = await readCodexThreadNameFromIndex(profile.threadId);
      return name ? { ...profile, name } : profile;
    })) };
  }

  async saveThreadProfile(input: SaveThreadProfileInput): Promise<{ profile: ThreadProfile }> {
    const profile = await this.upsertManualThreadProfile(input);
    this.broadcastSnapshot();
    return { profile };
  }

  setFloatingOverlayStatus(input: Partial<Pick<FloatingOverlayControlState, "desiredVisible" | "running" | "lastError">>): {
    overlay: Record<string, unknown>;
  } {
    if (typeof input.desiredVisible === "boolean") {
      this.overlayControl.desiredVisible = input.desiredVisible;
      this.overlayControl.lastActionAt = new Date().toISOString();
    }
    if (typeof input.running === "boolean") {
      this.overlayControl.running = input.running;
      this.overlayControl.lastSeenAt = input.running ? new Date().toISOString() : this.overlayControl.lastSeenAt;
      if (input.running) {
        this.overlayControl.lastStartedAt ??= new Date().toISOString();
      }
    }
    if (input.lastError !== undefined) {
      this.overlayControl.lastError = input.lastError;
    }
    this.broadcastSnapshot();
    return { overlay: this.buildFloatingOverlayStatus() };
  }

  setFloatingRendererHealth(health: FloatingRendererSnapshot): void {
    this.floatingRendererHealth = health;
    this.broadcastSnapshot();
  }

  markFloatingOverlaySeen(): void {
    if (!this.overlayControl.running) {
      this.overlayControl.running = true;
    }
    this.overlayControl.lastSeenAt = new Date().toISOString();
    this.overlayControl.lastError = null;
  }

  private async ingestProgressEvent(
    input: ProgressEventInput,
  ): Promise<{ event: ProgressEventRecord; analysis: AnalysisEvent; speechJob: SpeechJob }> {
    const event: ProgressEventRecord = {
      id: randomUUID(),
      source: input.source,
      kind: input.kind,
      text: input.text.trim(),
      priority: input.priority ?? "normal",
      createdAt: input.createdAt ?? new Date().toISOString(),
      threadId: input.threadId,
      metadata: input.metadata,
    };

    const analysis = await analyzeAndPersist(event);
    this.runtime.events.unshift(event);
    this.runtime.events = this.runtime.events.slice(0, maxEvents);
    this.runtime.avatar.emotion = analysis.emotion;
    this.runtime.avatar.gesture = analysis.gesture;
    this.runtime.avatar.layers = analysis.layers;

    const job: SpeechJob = {
      id: randomUUID(),
      eventId: event.id,
      threadId: event.threadId,
      text: event.text,
      status: "queued",
      styleId: 2,
      analysis,
      enqueuedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.runtime.speechQueue.push(job);
    this.trimQueue();
    this.broadcastSnapshot();
    void this.processVoiceQueue();

    return { event, analysis, speechJob: job };
  }

  private prepareThreadSpeechSwitch(threadId: string): void {
    const nextThreadId = normalizeCodexThreadId(threadId);
    const nextThreadUri = codexThreadUri(nextThreadId);
    this.activeThreadId = nextThreadId;

    const currentThreadId = this.runtime.currentSpeech?.threadId ?? this.runtime.currentSpeech?.analysis.threadId;
    if (currentThreadId && normalizeCodexThreadId(currentThreadId) !== nextThreadId) {
      this.voicevoxWorker.stop();
      this.wavPlayer.stop();
      this.runtime.currentSpeech = null;
      this.runtime.avatar.speaking = false;
      this.runtime.avatar.mouthFrame = "closed";
      this.runtime.avatar.layers = defaultAvatarLayers();
    }

    this.runtime.speechQueue = this.runtime.speechQueue.filter((job) => job.threadId === nextThreadUri);
    this.runtime.events = this.runtime.events.filter((event) => event.threadId === nextThreadUri);
    this.broadcastSnapshot();
  }

  private shouldIngestThreadWatchEvent(event: ProgressEventInput): boolean {
    if (!this.activeThreadId) {
      return true;
    }
    return normalizeCodexThreadId(event.threadId ?? "") === this.activeThreadId;
  }

  private async processVoiceQueue(): Promise<void> {
    if (this.voiceWorkerRunning) {
      return;
    }
    this.voiceWorkerRunning = true;
    try {
      while (true) {
        const job = this.runtime.speechQueue.find((item) => item.status === "queued" && this.isSpeechJobForActiveThread(item));
        if (!job) {
          return;
        }
        try {
          await this.synthesizeAndPlay(job);
        } catch (error) {
          if (!this.runtime.speechQueue.includes(job) || !this.isSpeechJobForActiveThread(job)) {
            this.runtime.currentSpeech = null;
            this.runtime.avatar.speaking = false;
            this.runtime.avatar.mouthFrame = "closed";
            this.runtime.avatar.layers = defaultAvatarLayers();
            this.broadcastSnapshot();
            continue;
          }
          job.status = "error";
          job.error = error instanceof Error ? error.message : String(error);
          job.updatedAt = new Date().toISOString();
          this.runtime.lastError = job.error;
          this.runtime.avatar.speaking = false;
          this.runtime.avatar.mouthFrame = "closed";
          this.runtime.avatar.layers = defaultAvatarLayers();
          this.runtime.currentSpeech = null;
          this.broadcastSnapshot();
        } finally {
          this.trimQueue();
        }
      }
    } finally {
      this.voiceWorkerRunning = false;
    }
  }

  private async synthesizeAndPlay(job: SpeechJob): Promise<void> {
    if (!this.isSpeechJobForActiveThread(job)) {
      job.status = "done";
      job.updatedAt = new Date().toISOString();
      return;
    }
    job.status = "synthesizing";
    job.updatedAt = new Date().toISOString();
    this.broadcastSnapshot();

    const sentences = splitSpeechSentences(job.text);
    if (sentences.length === 0) {
      job.status = "done";
      job.updatedAt = new Date().toISOString();
      this.broadcastSnapshot();
      return;
    }

    const mouthProfile = mouthProfileForAnalysis(job.analysis);
    job.mouthProfile = mouthProfile;
    const prepareChunk = async (text: string, index: number): Promise<PreparedSpeechChunk> => {
      const audioFile = join(
        audioOutputDir,
        `${Date.now()}-${job.id}-${String(index + 1).padStart(2, "0")}.wav`,
      );
      const payload = await this.voicevoxWorker.synthesize({
        text: normalizeForSpeech(text),
        styleId: 2,
        output: audioFile,
        speedFactor: speechSpeedFactor,
        lipSyncFrameMs,
        mouthProfile,
        synthesisMode: "audio-query",
      });
      if (!payload.ok) {
        throw new Error(payload.error ?? "VOICEVOX worker failed.");
      }
      return { text, audioFile, payload };
    };
    const settleChunk = (promise: Promise<PreparedSpeechChunk>): Promise<PreparedSpeechChunkResult> =>
      promise.then(
        (value) => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error }),
      );
    const markSpeechStarted = (chunk: PreparedSpeechChunk): void => {
      const { audioFile, payload, text } = chunk;
      const audioDurationMs = payload.durationSeconds
        ? Math.max(1, Math.round(payload.durationSeconds * 1000))
        : undefined;
      job.audioPath = audioFile;
      job.audioUrl = pathToFileURL(audioFile).href;
      job.audioDurationMs = audioDurationMs;
      job.lipSync = payload.lipSync;
      const speakingStartedAt = new Date();
      const expectedEndedAt = audioDurationMs ? new Date(speakingStartedAt.getTime() + audioDurationMs).toISOString() : undefined;
      job.expectedEndedAt = expectedEndedAt;
      job.status = "speaking";
      job.updatedAt = speakingStartedAt.toISOString();
      this.runtime.currentSpeech = {
        jobId: job.id,
        eventId: job.eventId,
        threadId: job.threadId,
        text,
        startedAt: speakingStartedAt.toISOString(),
        expectedEndedAt,
        audioUrl: job.audioUrl,
        audioDurationMs,
        lipSync: job.lipSync,
        mouthProfile: job.mouthProfile,
        analysis: job.analysis,
      };
      this.runtime.avatar.speaking = true;
      this.runtime.avatar.mouthFrame = "open";
      this.runtime.avatar.emotion = job.analysis.emotion;
      this.runtime.avatar.gesture = job.analysis.gesture;
      this.runtime.avatar.layers = job.analysis.layers;
      this.runtime.lastError = null;
      this.broadcastSnapshot();
    };

    const [firstPrepared] = await Promise.all([
      prepareChunk(sentences[0]!, 0),
      this.wavPlayer.refreshOutput(),
    ]);
    let prepared = firstPrepared;
    for (let index = 0; index < sentences.length; index += 1) {
      if (!this.isSpeechJobForActiveThread(job)) {
        break;
      }
      const current = prepared;
      const nextIndex = index + 1;
      let nextPreparedResult: Promise<PreparedSpeechChunkResult> | undefined;
      const playback = this.wavPlayer.play(current.audioFile, current.payload.durationSeconds ?? 0, () => {
        markSpeechStarted(current);
        if (nextIndex < sentences.length && this.isSpeechJobForActiveThread(job)) {
          nextPreparedResult = settleChunk(prepareChunk(sentences[nextIndex]!, nextIndex));
        }
      });
      await playback;
      if (!this.isSpeechJobForActiveThread(job)) {
        break;
      }
      if (nextIndex < sentences.length) {
        const next = await (nextPreparedResult ?? settleChunk(prepareChunk(sentences[nextIndex]!, nextIndex)));
        if (!next.ok) {
          throw next.error;
        }
        prepared = next.value;
      }
    }

    if (!this.isSpeechJobForActiveThread(job)) {
      job.status = "done";
      job.updatedAt = new Date().toISOString();
      this.runtime.currentSpeech = null;
      this.runtime.avatar.speaking = false;
      this.runtime.avatar.mouthFrame = "closed";
      this.runtime.avatar.layers = defaultAvatarLayers();
      this.broadcastSnapshot();
      return;
    }
    job.status = "done";
    job.updatedAt = new Date().toISOString();
    this.runtime.avatar.speaking = false;
    this.runtime.avatar.mouthFrame = "closed";
    this.runtime.avatar.layers = defaultAvatarLayers();
    this.runtime.currentSpeech = null;
    this.broadcastSnapshot();
  }

  private async synthesizeVoiceExportNow(text: string): Promise<VoiceExportResult> {
    const speechText = normalizeForSpeech(text).trim();
    if (!speechText) throw new Error("読み上げ可能なテキストがありません。");
    const audioFile = join(audioOutputDir, `${Date.now()}-mobile-${randomUUID()}.wav`);
    const payload = await this.voicevoxWorker.synthesize({
      text: speechText,
      styleId: 2,
      output: audioFile,
      speedFactor: speechSpeedFactor,
      lipSyncFrameMs,
      mouthProfile: "neutral",
      synthesisMode: "audio-query",
    });
    if (!payload.ok) throw new Error(payload.error ?? "VOICEVOX worker failed.");
    return {
      path: audioFile,
      bytes: payload.bytes,
      durationSeconds: payload.durationSeconds,
      speaker: payload.speaker,
      styleId: payload.styleId,
    };
  }

  private isSpeechJobForActiveThread(job: SpeechJob): boolean {
    if (!this.activeThreadId || !job.threadId) {
      return true;
    }
    return normalizeCodexThreadId(job.threadId) === this.activeThreadId;
  }

  private async ensureAvatarFrames(): Promise<void> {
    const required = [
      "metan_mouth_closed.png",
      "metan_mouth_small.png",
      "metan_mouth_open.png",
      "metan_blink.png",
    ];
    const missing = required.some((file) => !existsSync(join(avatarRenderedDir, file)));
    if (missing) {
      await runProcess("uv", ["run", "python", "tools/render_extra_avatar_frames.py"], {
        cwd: projectRoot,
        env: process.env,
        timeoutMs: 180_000,
      });
    }
    if (!existsSync(mouthEyeCombinationManifest)) {
      await runProcess("uv", [
        "run",
        "python",
        "-m",
        "voicevox_avatar_bridge",
        "export-combinations",
        "--character",
        "metan",
        "--group",
        "!口",
        "--group",
        "!目",
      ], {
        cwd: avatarBridgeRoot,
        env: {
          ...process.env,
          PYTHONPATH: join(avatarBridgeRoot, "src"),
        },
        timeoutMs: 180_000,
      });
    }
  }

  private trimQueue(): void {
    if (this.runtime.speechQueue.length <= maxQueueItems) {
      return;
    }
    const active = this.runtime.speechQueue.filter((job) => job.status !== "done" && job.status !== "error");
    const finished = this.runtime.speechQueue
      .filter((job) => job.status === "done" || job.status === "error")
      .slice(-maxQueueItems + active.length);
    this.runtime.speechQueue = [...finished, ...active];
  }

  private async restoreRecentEvents(): Promise<void> {
    if (!existsSync(analysisJsonlPath)) {
      return;
    }
    const lines = await readJsonlTail(analysisJsonlPath, maxEvents);
    const restored: ProgressEventRecord[] = [];
    let latestAnalysis: AnalysisEvent | null = null;
    for (let index = 0; index < lines.length; index += 1) {
      let record: unknown;
      try {
        record = JSON.parse(lines[index]!);
      } catch {
        continue;
      }
      if (!isRecord(record)) {
        continue;
      }
      const analysis = record as Partial<AnalysisEvent>;
      if (typeof analysis.text !== "string" || analysis.text.trim() === "") {
        continue;
      }
      latestAnalysis = analysis as AnalysisEvent;
      restored.push({
        id: `restored-${index}-${String(analysis.timestamp ?? "")}`,
        source: typeof analysis.source === "string" ? analysis.source : "analysis-history",
        kind: eventKindFromAnalysis(analysis),
        text: analysis.text,
        priority: "normal",
        createdAt: typeof analysis.timestamp === "string" ? analysis.timestamp : this.runtime.startedAt,
        threadId: typeof analysis.threadId === "string" ? analysis.threadId : undefined,
        metadata: { restored: true, adapter: "analysis-jsonl" },
      });
    }
    this.runtime.events = restored.reverse();
    if (latestAnalysis?.emotion) {
      this.runtime.avatar.emotion = latestAnalysis.emotion;
    }
    if (latestAnalysis?.gesture) {
      this.runtime.avatar.gesture = latestAnalysis.gesture;
    }
    if (latestAnalysis?.layers) {
      this.runtime.avatar.layers = latestAnalysis.layers;
    }
  }

  private buildFloatingOverlayStatus(): Record<string, unknown> {
    return {
      renderers: this.floatingRendererHealth,
      desiredVisible: this.overlayControl.desiredVisible,
      running: this.overlayControl.running,
      lastSeenAt: this.overlayControl.lastSeenAt,
      lastStartedAt: this.overlayControl.lastStartedAt,
      lastActionAt: this.overlayControl.lastActionAt,
      lastError: this.overlayControl.lastError,
    };
  }

  private getAvatarFrameUrls(): Record<string, unknown> {
    const now = Date.now();
    const age = this.avatarFrameCache ? now - this.avatarFrameCache.createdAt : -1;
    if (!this.avatarFrameCache || age < 0 || age >= avatarFrameCacheMs) {
      this.avatarFrameCache = { createdAt: now, value: this.buildAvatarFrameUrls() };
    }
    return this.avatarFrameCache.value;
  }

  private buildAvatarFrameUrls(): Record<string, unknown> {
    const mouthFrames = Object.fromEntries(
      Object.entries(mouthFrameFiles).map(([frame, file]) => [
        frame,
        cacheBustedFileUrl(existsSync(join(avatarRenderedDir, file)) ? join(avatarRenderedDir, file) : join(avatarRenderedDir, mouthFrameFiles.closed)),
      ]),
    ) as Record<MouthFrame, string>;
    const mouthEyes = this.buildMouthEyeFrameUrls();
    return {
      idle: mouthEyes.closed?.normal ?? mouthFrames.closed ?? cacheBustedFileUrl(join(avatarRenderedDir, "metan.png")),
      ...mouthFrames,
      blink: mouthEyes.closed?.blink ?? cacheBustedFileUrl(join(avatarRenderedDir, "metan_blink.png")),
      mouthEyes,
    };
  }

  private buildMouthEyeFrameUrls(): Record<string, Record<string, string>> {
    if (!existsSync(mouthEyeCombinationManifest)) {
      return {};
    }
    try {
      const manifest = JSON.parse(readFileSync(mouthEyeCombinationManifest, "utf8")) as {
        files?: Array<{ fileName?: string; layers?: Record<string, string> }>;
      };
      const urls: Record<string, Record<string, string>> = {};
      for (const item of manifest.files ?? []) {
        if (!item.fileName || !item.layers) {
          continue;
        }
        const mouth = mouthFrameFromLayer(item.layers["!口"]);
        const eye = eyeFrameFromLayer(item.layers["!目"]);
        if (!mouth || !eye) {
          continue;
        }
        urls[mouth] ??= {};
        urls[mouth][eye] = cacheBustedFileUrl(join(mouthEyeCombinationDir, item.fileName));
      }
      return urls;
    } catch {
      return {};
    }
  }

  private buildServerInfo(): Record<string, unknown> {
    return {
      mode: "electron-ipc",
      threadPollMs,
      speechSpeedFactor,
      lipSyncFrameMs,
      lipSyncLeadMs,
      voiceWorkerMode: "persistent",
      voicevoxAcceleration: this.voicevoxAcceleration,
      avatarBridgeRoot,
      voicevoxCoreRoot,
      openJtalkRoot,
    };
  }

  private broadcastSnapshot(): void {
    this.emit("snapshot", this.getSnapshot());
  }

  private async readThreadProfiles(): Promise<ThreadProfile[]> {
    try {
      const content = await readFile(threadProfilesPath, "utf8");
      const parsed = JSON.parse(content) as { profiles?: unknown };
      if (!Array.isArray(parsed.profiles)) {
        return [];
      }
      return parsed.profiles
        .map(sanitizeThreadProfile)
        .filter((profile): profile is ThreadProfile => Boolean(profile))
        .sort(compareThreadProfiles)
        .slice(0, maxThreadProfiles);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async upsertThreadProfile(input: StartThreadWatchInput, sessionLogPath?: string): Promise<ThreadProfile> {
    const threadId = normalizeCodexThreadId(input.threadId);
    const now = new Date().toISOString();
    const profiles = await this.readThreadProfiles();
    const existing = profiles.find((profile) => profile.threadId === threadId);
    const requestedName = normalizeThreadProfileName(input.threadName);
    const inferredName = await inferThreadProfileName(sessionLogPath, threadId);
    const profile: ThreadProfile = {
      threadId,
      name: chooseThreadProfileName({
        requestedName,
        existingName: existing?.name ?? "",
        inferredName,
        threadId,
      }),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      lastUsedAt: now,
    };
    const nextProfiles = [profile, ...profiles.filter((item) => item.threadId !== threadId)]
      .sort(compareThreadProfiles)
      .slice(0, maxThreadProfiles);
    await this.writeThreadProfiles(nextProfiles);
    return profile;
  }

  private async upsertManualThreadProfile(input: SaveThreadProfileInput): Promise<ThreadProfile> {
    const threadId = normalizeCodexThreadId(input.threadId);
    const requestedName = normalizeThreadProfileName(input.threadName);
    if (!threadId) {
      throw new Error("threadId is required.");
    }
    if (!requestedName) {
      throw new Error("threadName is required.");
    }
    const now = new Date().toISOString();
    const profiles = await this.readThreadProfiles();
    const existing = profiles.find((profile) => profile.threadId === threadId);
    const profile: ThreadProfile = {
      threadId,
      name: requestedName,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt || now,
    };
    const nextProfiles = [profile, ...profiles.filter((item) => item.threadId !== threadId)]
      .sort(compareThreadProfiles)
      .slice(0, maxThreadProfiles);
    await this.writeThreadProfiles(nextProfiles);
    return profile;
  }

  private async writeThreadProfiles(profiles: ThreadProfile[]): Promise<void> {
    await mkdir(configDir, { recursive: true });
    await writeFile(threadProfilesPath, `${JSON.stringify({ profiles }, null, 2)}\n`, "utf8");
  }
}

function initialVoicevoxAcceleration(): VoicevoxAcceleration {
  try {
    return parseVoicevoxAcceleration(process.env.VOICEVOX_ACCELERATION ?? "auto");
  } catch {
    return "auto";
  }
}

function mouthProfileForAnalysis(analysis: AnalysisEvent): MouthProfile {
  switch (analysis.emotion) {
    case "error":
    case "warning":
    case "trouble":
      return "negative";
    case "success":
    case "surprise":
    case "happy":
    case "fun":
    case "smile":
      return "expressive";
    default:
      return "neutral";
  }
}

function eventKindFromAnalysis(analysis: Partial<AnalysisEvent>): EventKind {
  switch (analysis.emotion) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "success":
      return "success";
    default:
      return "progress";
  }
}

function cacheBustedFileUrl(filePath: string): string {
  const version = existsSync(filePath) ? statSync(filePath).mtimeMs.toFixed(0) : "missing";
  return `${pathToFileURL(filePath).href}?v=${version}`;
}

function mouthFrameFromLayer(layer: string | undefined): MouthFrame | null {
  if (!layer) {
    return null;
  }
  const entry = Object.entries(mouthLayerByFrame).find(([, layerName]) => layerName === layer);
  return (entry?.[0] as MouthFrame | undefined) ?? null;
}

function eyeFrameFromLayer(layer: string | undefined): "normal" | "blink" | null {
  if (layer === normalEyeLayer) {
    return "normal";
  }
  if (layer === blinkEyeLayer) {
    return "blink";
  }
  return null;
}

async function inferThreadProfileName(sessionLogPath: string | undefined, threadId: string): Promise<string> {
  const indexedName = await readCodexThreadNameFromIndex(threadId);
  if (indexedName) {
    return compactThreadProfileTitle(indexedName);
  }
  if (!sessionLogPath) {
    return "";
  }
  try {
    const content = await readFileHead(sessionLogPath, threadProfileTitleScanBytes);
    let firstUserMessage = "";
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const explicitTitle = extractExplicitThreadTitle(record);
      if (explicitTitle && explicitTitle !== threadId) {
        return compactThreadProfileTitle(explicitTitle);
      }
      const userMessage = extractUserMessageText(record);
      if (userMessage && isLikelyUserPrompt(userMessage)) {
        firstUserMessage ||= userMessage;
        const inferredTitle = buildThreadTitleFromUserMessage(userMessage);
        if (inferredTitle) {
          return inferredTitle;
        }
      }
    }
    return buildThreadTitleFromUserMessage(firstUserMessage);
  } catch {
    return "";
  }
}

function chooseThreadProfileName(input: {
  requestedName: string;
  existingName: string;
  inferredName: string;
  threadId: string;
}): string {
  if (input.requestedName && !isReplaceableThreadProfileName(input.requestedName, input.threadId)) {
    return input.requestedName;
  }
  if (input.existingName && !isReplaceableThreadProfileName(input.existingName, input.threadId)) {
    return input.existingName;
  }
  if (
    input.inferredName &&
    (!input.requestedName ||
      isReplaceableThreadProfileName(input.requestedName, input.threadId) ||
      staleDefaultThreadProfileNames.has(input.requestedName) ||
      (input.requestedName === input.existingName && isReplaceableThreadProfileName(input.existingName, input.threadId)))
  ) {
    return input.inferredName;
  }
  return input.requestedName || input.inferredName || input.existingName || input.threadId;
}

function isReplaceableThreadProfileName(name: string, threadId: string): boolean {
  return !name || normalizeCodexThreadId(name) === threadId || staleDefaultThreadProfileNames.has(name);
}

function readFileHead(filePath: string, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath, { start: 0, end: Math.max(0, maxBytes - 1) });
    stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function extractExplicitThreadTitle(record: unknown): string {
  if (!isRecord(record)) {
    return "";
  }
  const payload = isRecord(record.payload) ? record.payload : record;
  for (const key of ["title", "threadTitle", "thread_title", "conversationTitle", "conversation_title"]) {
    const value = payload[key];
    if (typeof value === "string") {
      const title = normalizeThreadProfileName(value);
      if (title) {
        return title;
      }
    }
  }
  return "";
}

function extractUserMessageText(record: unknown): string {
  if (!isRecord(record) || !isRecord(record.payload)) {
    return "";
  }
  const payload = record.payload;
  if (record.type === "event_msg" && payload.type === "user_message" && typeof payload.message === "string") {
    return payload.message;
  }
  if (record.type === "response_item" && payload.type === "message" && payload.role === "user") {
    return extractContentText(payload.content);
  }
  return "";
}

function extractContentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (isRecord(item) && typeof item.text === "string") {
        return item.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function isLikelyUserPrompt(value: string): boolean {
  const text = value.trim();
  return (
    text !== "" &&
    !text.startsWith("# AGENTS.md instructions") &&
    !text.includes("<INSTRUCTIONS>") &&
    !text.includes("<environment_context>")
  );
}

function buildThreadTitleFromUserMessage(value: string): string {
  const source = value.trim();
  if (!source) {
    return "";
  }
  const subject = extractPromptPathSubject(source);
  let title = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !looksLikePromptPathLine(line))
    .join(" ");
  title = title
    .replace(/何か質問.*$/u, "")
    .replace(/お願いします.*$/u, "")
    .replace(/頼む.*$/u, "")
    .replace(/^を読んで/u, "")
    .replace(/を読んで/u, " ")
    .replace(/してほしい/gu, "")
    .replace(/してください/gu, "")
    .replace(/して下さい/gu, "")
    .replace(/新ui/giu, "新UI")
    .replace(/を実装/gu, "実装")
    .replace(/[。！？].*$/u, "")
    .replace(/[「」"`]/gu, "")
    .trim();
  const joined = subject && title && !title.includes(subject) ? `${subject} ${title}` : title || subject;
  return compactThreadProfileTitle(joined);
}

function extractPromptPathSubject(value: string): string {
  const match = value.match(/\/?[A-Za-z]:[\\/][^\s]+/u);
  if (!match) {
    return "";
  }
  const segments = match[0].replace(/\\/g, "/").split("/").filter(Boolean);
  const codexiaIndex = segments.findIndex((segment) => segment.toLowerCase() === "codexia");
  if (codexiaIndex >= 0 && segments[codexiaIndex + 1]) {
    return segments[codexiaIndex + 1]!;
  }
  const docsIndex = segments.findIndex((segment) => segment.toLowerCase() === "docs");
  if (docsIndex > 0) {
    return segments[docsIndex - 1]!;
  }
  return "";
}

function looksLikePromptPathLine(value: string): boolean {
  return /\/?[A-Za-z]:[\\/]/u.test(value) || /\.(md|txt|json|jsonl)$/iu.test(value);
}

function compactThreadProfileTitle(value: string): string {
  const normalized = normalizeThreadProfileName(value).replace(/\s*[:：]\s*$/u, "");
  const chars = [...normalized];
  if (chars.length <= 64) {
    return normalized;
  }
  return `${chars.slice(0, 63).join("")}…`;
}

function sanitizeThreadProfile(value: unknown): ThreadProfile | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.threadId !== "string" || value.threadId.trim() === "") {
    return null;
  }
  const threadId = normalizeCodexThreadId(value.threadId);
  const now = new Date().toISOString();
  return {
    threadId,
    name: normalizeThreadProfileName(value.name) || threadId,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
    lastUsedAt: typeof value.lastUsedAt === "string" ? value.lastUsedAt : now,
  };
}

function compareThreadProfiles(a: ThreadProfile, b: ThreadProfile): number {
  return b.lastUsedAt.localeCompare(a.lastUsedAt);
}

function normalizeCodexThreadId(value: string): string {
  return value.replace(/^codex:\/\/threads\//, "").trim();
}

function codexThreadUri(threadId: string): string {
  return `codex://threads/${normalizeCodexThreadId(threadId)}`;
}

function normalizeThreadProfileName(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+/g, " ").trim();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; onStdout?: (chunk: string) => void },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      options.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} exited with code ${code}: ${stderr || stdout}`));
    });
  });
}
