export type EventKind = "progress" | "summary" | "warning" | "error" | "success" | "system";
export type EventPriority = "low" | "normal" | "high" | "interrupt";
export type SpeechStatus = "queued" | "synthesizing" | "speaking" | "done" | "error";
export type ThreadWatchStatus = "starting" | "watching" | "stopped" | "error";
export type MouthProfile = "neutral" | "expressive" | "negative";
export type VoicevoxAcceleration = "auto" | "cpu" | "gpu";
export type MouthFrame =
  | "closed"
  | "small"
  | "open"
  | "momuu"
  | "ue"
  | "i"
  | "mu"
  | "triangle"
  | "yu"
  | "o"
  | "perori"
  | "niyari"
  | "v";

export interface LipSyncFrame {
  atMs: number;
  mouth: MouthFrame;
}

export interface ProgressEventInput {
  threadId?: string;
  source: string;
  kind: EventKind;
  text: string;
  priority?: EventPriority;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ProgressEventRecord extends ProgressEventInput {
  id: string;
  priority: EventPriority;
  createdAt: string;
}

export interface AnalysisEvent {
  schemaVersion: 1;
  timestamp: string;
  threadId?: string;
  source?: string;
  text: string;
  analysisProvider: "rules";
  analysisModel: "rules-v0";
  emotion:
    | "neutral"
    | "success"
    | "trouble"
    | "error"
    | "surprise"
    | "smile"
    | "shy_flirty"
    | "happy"
    | "fun"
    | "focused"
    | "warning"
    | "waiting";
  emotionIntensity: number;
  stance: string;
  gesture: string;
  voice: {
    speaker: "四国めたん";
    styleId: 2;
    speedScale: number;
    pitchScale: number;
    intonationScale: number;
  };
  layers: {
    mouth: string;
    eyes: string;
    brows: string;
    faceColor: string;
    extras: string[];
  };
  reason: string;
  userCorrection: null | Record<string, unknown>;
}

export interface SpeechJob {
  id: string;
  eventId: string;
  threadId?: string;
  text: string;
  status: SpeechStatus;
  styleId: 2;
  analysis: AnalysisEvent;
  enqueuedAt: string;
  updatedAt: string;
  audioPath?: string;
  audioUrl?: string;
  audioDurationMs?: number;
  expectedEndedAt?: string;
  lipSync?: LipSyncFrame[];
  mouthProfile?: MouthProfile;
  error?: string;
}

export interface AvatarState {
  character: "metan";
  speaking: boolean;
  mouthFrame: MouthFrame;
  emotion: AnalysisEvent["emotion"];
  gesture: string;
  layers: AnalysisEvent["layers"] | null;
}

export interface CurrentSpeech {
  jobId: string;
  eventId: string;
  threadId?: string;
  text: string;
  startedAt: string;
  expectedEndedAt?: string;
  audioUrl?: string;
  audioDurationMs?: number;
  lipSync?: LipSyncFrame[];
  mouthProfile?: MouthProfile;
  analysis: AnalysisEvent;
}

export interface CodexThreadWatchState {
  threadId: string;
  status: ThreadWatchStatus;
  startedAt: string;
  updatedAt: string;
  filePath?: string;
  lastOffset: number;
  emittedCount: number;
  lastEventAt?: string;
  replay: "none" | "recent" | "all";
  includeTools: boolean;
  includeLifecycle: boolean;
  maxReplayEvents: number;
  error?: string;
}

export interface RuntimeState {
  startedAt: string;
  events: ProgressEventRecord[];
  speechQueue: SpeechJob[];
  currentSpeech: CurrentSpeech | null;
  avatar: AvatarState;
  lastError: string | null;
}
