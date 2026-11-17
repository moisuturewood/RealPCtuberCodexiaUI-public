import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, join, normalize } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

import { analyzeAndPersist } from "./analysis.js";
import { readCodexThreadNameFromIndex } from "./codexThreadName.js";
import { CodexThreadWatcherManager, type StartThreadWatchInput } from "./codexThreadWatcher.js";
import {
  avatarBridgeRoot,
  avatarRenderedDir,
  audioOutputDir,
  configDir,
  analysisJsonlPath,
  openJtalkRoot,
  projectRoot,
  publicDir,
  scriptsDir,
  threadProfilesPath,
  voicevoxCoreRoot,
} from "./paths.js";
import { normalizeForSpeech } from "./pronunciation.js";
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

const port = Number(process.env.PORT ?? 48731);
const maxEvents = 200;
const maxQueueItems = 40;
const threadPollMs = Number(process.env.THREAD_WATCH_POLL_MS ?? 250);
const speechSpeedFactor = Number(process.env.METAN_SPEECH_SPEED ?? 1);
const lipSyncFrameMs = Number(process.env.METAN_LIPSYNC_FRAME_MS ?? 45);
const lipSyncLeadMs = Number(process.env.METAN_LIPSYNC_LEAD_MS ?? 60);
const eventKinds: EventKind[] = ["progress", "summary", "warning", "error", "success", "system"];
const priorities: EventPriority[] = ["low", "normal", "high", "interrupt"];
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

interface ThreadProfile {
  threadId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string;
}

interface FloatingOverlayControlState {
  desiredVisible: boolean;
  lastSeenAt: string | null;
  lastStartedAt: string | null;
  lastActionAt: string | null;
  lastError: string | null;
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

const runtime: RuntimeState = {
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

let voiceWorkerRunning = false;
let activeThreadId: string | null = null;
let voicevoxAcceleration = initialVoicevoxAcceleration();
const floatingOverlayControl: FloatingOverlayControlState = {
  desiredVisible: true,
  lastSeenAt: null,
  lastStartedAt: null,
  lastActionAt: null,
  lastError: null,
};
const voicevoxWorker = new VoicevoxWorkerClient({
  cwd: projectRoot,
  env: { ...process.env },
  coreRoot: voicevoxCoreRoot,
  openJtalkRoot,
  defaultStyleId: 2,
  timeoutMs: 180_000,
  acceleration: voicevoxAcceleration,
});
const wavPlayer = new WavPlayer({
  cwd: projectRoot,
  env: { ...process.env },
});

process.once("exit", () => {
  wavPlayer.stop();
  voicevoxWorker.stop();
});

const threadWatcher = new CodexThreadWatcherManager({
  pollMs: threadPollMs,
  ingestEvent: async (event) => {
    if (shouldIngestThreadWatchEvent(event)) {
      await ingestProgressEvent(event);
    }
  },
  onChange: broadcastSnapshot,
  onError: (message) => {
    runtime.lastError = message;
  },
});

await mkdir(audioOutputDir, { recursive: true });
const voicevoxSettings = await readVoicevoxSettings(voicevoxAcceleration);
voicevoxAcceleration = voicevoxSettings.acceleration;
await voicevoxWorker.setAcceleration(voicevoxAcceleration, false);
await ensureAvatarFrames();
await restoreRecentEvents();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (request.method === "GET" && url.pathname === "/api/events") {
      sendJson(response, 200, { events: runtime.events });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      sendJson(response, 200, buildSnapshot());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/overlay-state") {
      if (url.searchParams.get("client") === "floating-overlay") {
        markFloatingOverlaySeen();
      }
      sendJson(response, 200, buildOverlaySnapshot());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/floating-overlay") {
      sendJson(response, 200, { overlay: buildFloatingOverlayStatus() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/thread-watch") {
      sendJson(response, 200, { watchers: threadWatcher.getStates() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/thread-profiles") {
      sendJson(response, 200, { profiles: await readThreadProfiles() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/thread-name") {
      const body = await readJson(request);
      const threadId = body && typeof body === "object" && "threadId" in body && typeof body.threadId === "string" ? body.threadId : "";
      sendJson(response, 200, { name: await readCodexThreadNameFromIndex(threadId) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/thread-profiles") {
      await handleSaveThreadProfile(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/events") {
      await handlePostEvent(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/thread-watch") {
      await handleStartThreadWatch(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/thread-watch/stop") {
      await handleStopThreadWatch(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/floating-overlay") {
      await handleFloatingOverlayAction(await readJson(request), response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/voicevox-settings") {
      await handleVoicevoxSettings(await readJson(request), response);
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/avatar/")) {
      serveSafeFile(response, avatarRenderedDir, url.pathname.slice("/avatar/".length));
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/avatar-combinations/")) {
      serveSafeFile(response, mouthEyeCombinationDir, url.pathname.slice("/avatar-combinations/".length));
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/audio/")) {
      serveSafeFile(response, audioOutputDir, url.pathname.slice("/audio/".length));
      return;
    }
    if (request.method === "GET") {
      serveStatic(response, url.pathname);
      return;
    }
    sendJson(response, 405, { error: "method_not_allowed" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof BadRequestError) {
      sendJson(response, 400, { error: "bad_request", message });
      return;
    }
    runtime.lastError = message;
    broadcastSnapshot();
    sendJson(response, 500, { error: "internal_error", message });
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "snapshot", payload: buildSnapshot() }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`RealPCtuber Codexia UI listening on http://127.0.0.1:${port}`);
});

void voicevoxWorker.warmup().catch((error) => {
  runtime.lastError = error instanceof Error ? error.message : String(error);
  broadcastSnapshot();
});

async function handlePostEvent(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const input = validateProgressEvent(await readJson(request));
  const result = await ingestProgressEvent(input);
  sendJson(response, 201, result);
}

async function handleStartThreadWatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const input = validateStartThreadWatch(await readJson(request));
  prepareThreadSpeechSwitch(input.threadId);
  const watcher = await threadWatcher.start({
    ...input,
    replay: "none",
    includeTools: false,
    includeLifecycle: false,
    maxReplayEvents: 0,
  });
  const profile = watcher.status === "error" ? null : await upsertThreadProfile(input, watcher.filePath);
  sendJson(response, watcher.status === "error" ? 404 : 201, { watcher, profile });
}

async function handleSaveThreadProfile(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const input = validateSaveThreadProfile(await readJson(request));
  const profile = await upsertManualThreadProfile(input);
  broadcastSnapshot();
  sendJson(response, 200, { profile });
}

async function handleVoicevoxSettings(value: unknown, response: ServerResponse): Promise<void> {
  if (runtime.currentSpeech || voiceWorkerRunning) {
    throw new BadRequestError("読み上げ完了後にCPU/GPUを切り替えてください。");
  }
  const acceleration = parseVoicevoxAcceleration(
    typeof value === "object" && value !== null ? (value as { acceleration?: unknown }).acceleration : undefined,
  );
  const previous = voicevoxAcceleration;
  try {
    await voicevoxWorker.setAcceleration(acceleration);
  } catch (error) {
    await voicevoxWorker.setAcceleration(previous).catch(() => undefined);
    throw error;
  }
  voicevoxAcceleration = acceleration;
  await writeVoicevoxSettings({ acceleration });
  runtime.lastError = null;
  broadcastSnapshot();
  sendJson(response, 200, { acceleration });
}

async function handleStopThreadWatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const { threadId } = validateStopThreadWatch(await readJson(request));
  const watcher = threadWatcher.stop(threadId);
  if (activeThreadId === normalizeCodexThreadId(threadId)) {
    activeThreadId = null;
  }
  sendJson(response, 200, { watcher });
}

async function handleFloatingOverlayAction(value: unknown, response: ServerResponse): Promise<void> {
  const { action } = validateFloatingOverlayAction(value);
  floatingOverlayControl.lastActionAt = new Date().toISOString();
  floatingOverlayControl.lastError = null;
  if (action === "hide") {
    floatingOverlayControl.desiredVisible = false;
  } else if (action === "show") {
    floatingOverlayControl.desiredVisible = true;
    if (!isFloatingOverlayRunning()) {
      await startFloatingOverlayDetached();
    }
  } else if (action === "toggle") {
    if (floatingOverlayControl.desiredVisible && isFloatingOverlayRunning()) {
      floatingOverlayControl.desiredVisible = false;
    } else {
      floatingOverlayControl.desiredVisible = true;
      if (!isFloatingOverlayRunning()) {
        await startFloatingOverlayDetached();
      }
    }
  } else if (action === "start") {
    floatingOverlayControl.desiredVisible = true;
    await startFloatingOverlayDetached();
  }
  const overlay = buildFloatingOverlayStatus();
  broadcastSnapshot();
  sendJson(response, 200, { overlay });
}

async function startFloatingOverlayDetached(): Promise<void> {
  try {
    await runProcess("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(scriptsDir, "start-floating-overlay.ps1"),
      "-StartDetached",
      "-NoServerStart",
    ], {
      cwd: projectRoot,
      env: process.env,
      timeoutMs: 20_000,
    });
    floatingOverlayControl.lastStartedAt = new Date().toISOString();
  } catch (error) {
    floatingOverlayControl.lastError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

function validateFloatingOverlayAction(value: unknown): { action: "show" | "hide" | "toggle" | "start" } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestError("JSON object is required.");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["action"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new BadRequestError(`Unknown property: ${key}`);
    }
  }
  if (record.action !== "show" && record.action !== "hide" && record.action !== "toggle" && record.action !== "start") {
    throw new BadRequestError("action must be show, hide, toggle, or start.");
  }
  return { action: record.action };
}

async function ingestProgressEvent(
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
  runtime.events.unshift(event);
  runtime.events = runtime.events.slice(0, maxEvents);
  runtime.avatar.emotion = analysis.emotion;
  runtime.avatar.gesture = analysis.gesture;
  runtime.avatar.layers = analysis.layers;

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
  runtime.speechQueue.push(job);
  trimQueue();
  broadcastSnapshot();
  void processVoiceQueue();

  return { event, analysis, speechJob: job };
}

function prepareThreadSpeechSwitch(threadId: string): void {
  const nextThreadId = normalizeCodexThreadId(threadId);
  const nextThreadUri = codexThreadUri(nextThreadId);
  activeThreadId = nextThreadId;

  const currentThreadId = runtime.currentSpeech?.threadId ?? runtime.currentSpeech?.analysis.threadId;
  if (currentThreadId && normalizeCodexThreadId(currentThreadId) !== nextThreadId) {
    voicevoxWorker.stop();
    wavPlayer.stop();
    runtime.currentSpeech = null;
    runtime.avatar.speaking = false;
    runtime.avatar.mouthFrame = "closed";
    runtime.avatar.layers = defaultAvatarLayers();
  }

  runtime.speechQueue = runtime.speechQueue.filter((job) => job.threadId === nextThreadUri);
  runtime.events = runtime.events.filter((event) => event.threadId === nextThreadUri);
  broadcastSnapshot();
}

function shouldIngestThreadWatchEvent(event: ProgressEventInput): boolean {
  if (!activeThreadId) {
    return true;
  }
  return normalizeCodexThreadId(event.threadId ?? "") === activeThreadId;
}

function validateProgressEvent(value: unknown): ProgressEventInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestError("JSON object is required.");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["threadId", "source", "kind", "text", "priority", "createdAt", "metadata"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new BadRequestError(`Unknown property: ${key}`);
    }
  }
  if (typeof record.source !== "string" || record.source.trim() === "") {
    throw new BadRequestError("source is required.");
  }
  if (typeof record.kind !== "string" || !eventKinds.includes(record.kind as EventKind)) {
    throw new BadRequestError(`kind must be one of: ${eventKinds.join(", ")}`);
  }
  if (typeof record.text !== "string" || record.text.trim() === "") {
    throw new BadRequestError("text is required.");
  }
  if (record.text.length > 1200) {
    throw new BadRequestError("text must be 1200 characters or less.");
  }
  if (record.priority !== undefined && (typeof record.priority !== "string" || !priorities.includes(record.priority as EventPriority))) {
    throw new BadRequestError(`priority must be one of: ${priorities.join(", ")}`);
  }
  if (record.threadId !== undefined && typeof record.threadId !== "string") {
    throw new BadRequestError("threadId must be a string.");
  }
  if (record.createdAt !== undefined && typeof record.createdAt !== "string") {
    throw new BadRequestError("createdAt must be a string.");
  }
  if (record.metadata !== undefined && (!record.metadata || typeof record.metadata !== "object" || Array.isArray(record.metadata))) {
    throw new BadRequestError("metadata must be an object.");
  }
  return record as unknown as ProgressEventInput;
}

function validateStartThreadWatch(value: unknown): StartThreadWatchInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestError("JSON object is required.");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["threadId", "threadName", "replay", "includeTools", "includeLifecycle", "maxReplayEvents"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new BadRequestError(`Unknown property: ${key}`);
    }
  }
  if (typeof record.threadId !== "string" || record.threadId.trim() === "") {
    throw new BadRequestError("threadId is required.");
  }
  if (record.threadName !== undefined && typeof record.threadName !== "string") {
    throw new BadRequestError("threadName must be a string.");
  }
  if (typeof record.threadName === "string" && record.threadName.length > 120) {
    throw new BadRequestError("threadName must be 120 characters or less.");
  }
  if (
    record.replay !== undefined &&
    typeof record.replay !== "boolean" &&
    (typeof record.replay !== "string" || !["none", "recent", "all"].includes(record.replay))
  ) {
    throw new BadRequestError("replay must be none, recent, all, true, or false.");
  }
  if (record.includeTools !== undefined && typeof record.includeTools !== "boolean") {
    throw new BadRequestError("includeTools must be a boolean.");
  }
  if (record.includeLifecycle !== undefined && typeof record.includeLifecycle !== "boolean") {
    throw new BadRequestError("includeLifecycle must be a boolean.");
  }
  if (record.maxReplayEvents !== undefined && typeof record.maxReplayEvents !== "number") {
    throw new BadRequestError("maxReplayEvents must be a number.");
  }
  return record as unknown as StartThreadWatchInput;
}

function validateStopThreadWatch(value: unknown): { threadId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestError("JSON object is required.");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["threadId"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new BadRequestError(`Unknown property: ${key}`);
    }
  }
  if (typeof record.threadId !== "string" || record.threadId.trim() === "") {
    throw new BadRequestError("threadId is required.");
  }
  return { threadId: record.threadId };
}

function validateSaveThreadProfile(value: unknown): { threadId: string; threadName: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestError("JSON object is required.");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["threadId", "threadName"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new BadRequestError(`Unknown property: ${key}`);
    }
  }
  if (typeof record.threadId !== "string" || record.threadId.trim() === "") {
    throw new BadRequestError("threadId is required.");
  }
  if (typeof record.threadName !== "string" || record.threadName.trim() === "") {
    throw new BadRequestError("threadName is required.");
  }
  if (record.threadName.length > 120) {
    throw new BadRequestError("threadName must be 120 characters or less.");
  }
  return { threadId: record.threadId, threadName: record.threadName };
}

async function readThreadProfiles(): Promise<ThreadProfile[]> {
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

async function upsertThreadProfile(input: StartThreadWatchInput, sessionLogPath?: string): Promise<ThreadProfile> {
  const threadId = normalizeProfileThreadId(input.threadId);
  const now = new Date().toISOString();
  const profiles = await readThreadProfiles();
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
  await writeThreadProfiles(nextProfiles);
  return profile;
}

async function upsertManualThreadProfile(input: { threadId: string; threadName: string }): Promise<ThreadProfile> {
  const threadId = normalizeProfileThreadId(input.threadId);
  const requestedName = normalizeThreadProfileName(input.threadName);
  if (!threadId) {
    throw new BadRequestError("threadId is required.");
  }
  if (!requestedName) {
    throw new BadRequestError("threadName is required.");
  }
  const now = new Date().toISOString();
  const profiles = await readThreadProfiles();
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
  await writeThreadProfiles(nextProfiles);
  return profile;
}

async function writeThreadProfiles(profiles: ThreadProfile[]): Promise<void> {
  await mkdir(configDir, { recursive: true });
  await writeFile(threadProfilesPath, `${JSON.stringify({ profiles }, null, 2)}\n`, "utf8");
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
  return !name || normalizeProfileThreadId(name) === threadId || staleDefaultThreadProfileNames.has(name);
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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.threadId !== "string" || record.threadId.trim() === "") {
    return null;
  }
  const threadId = normalizeProfileThreadId(record.threadId);
  const now = new Date().toISOString();
  return {
    threadId,
    name: normalizeThreadProfileName(record.name) || threadId,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : now,
    lastUsedAt: typeof record.lastUsedAt === "string" ? record.lastUsedAt : now,
  };
}

function compareThreadProfiles(a: ThreadProfile, b: ThreadProfile): number {
  return b.lastUsedAt.localeCompare(a.lastUsedAt);
}

function normalizeProfileThreadId(value: string): string {
  return normalizeCodexThreadId(value);
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

async function processVoiceQueue(): Promise<void> {
  if (voiceWorkerRunning) {
    return;
  }
  voiceWorkerRunning = true;
  try {
    while (true) {
      const job = runtime.speechQueue.find((item) => item.status === "queued" && isSpeechJobForActiveThread(item));
      if (!job) {
        return;
      }
      try {
        await synthesizeAndPlay(job);
      } catch (error) {
        if (!runtime.speechQueue.includes(job) || !isSpeechJobForActiveThread(job)) {
          runtime.currentSpeech = null;
          runtime.avatar.speaking = false;
          runtime.avatar.mouthFrame = "closed";
          runtime.avatar.layers = defaultAvatarLayers();
          broadcastSnapshot();
          continue;
        }
        job.status = "error";
        job.error = error instanceof Error ? error.message : String(error);
        job.updatedAt = new Date().toISOString();
        runtime.lastError = job.error;
        runtime.avatar.speaking = false;
        runtime.avatar.mouthFrame = "closed";
        runtime.avatar.layers = defaultAvatarLayers();
        runtime.currentSpeech = null;
        broadcastSnapshot();
      } finally {
        trimQueue();
      }
    }
  } finally {
    voiceWorkerRunning = false;
  }
}

async function synthesizeAndPlay(job: SpeechJob): Promise<void> {
  if (!isSpeechJobForActiveThread(job)) {
    job.status = "done";
    job.updatedAt = new Date().toISOString();
    return;
  }
  job.status = "synthesizing";
  job.updatedAt = new Date().toISOString();
  broadcastSnapshot();

  const audioFile = join(audioOutputDir, `${Date.now()}-${job.id}.wav`);
  const speechText = normalizeForSpeech(job.text);
  const mouthProfile = mouthProfileForAnalysis(job.analysis);
  job.mouthProfile = mouthProfile;
  let audioDurationMs: number | undefined;
  const applySynthesisPayload = (payload: VoicevoxSynthesisResult): void => {
    audioDurationMs = payload.durationSeconds ? Math.max(1, Math.round(payload.durationSeconds * 1000)) : undefined;
    job.audioPath = audioFile;
    job.audioUrl = `/audio/${basename(audioFile)}`;
    job.audioDurationMs = audioDurationMs;
    job.lipSync = payload.lipSync;
  };

  let speechStarted = false;
  const markSpeechStarted = (payload: VoicevoxSynthesisResult): void => {
    if (speechStarted) {
      return;
    }
    applySynthesisPayload(payload);
    speechStarted = true;
    const speakingStartedAt = new Date();
    const expectedEndedAt = audioDurationMs ? new Date(speakingStartedAt.getTime() + audioDurationMs).toISOString() : undefined;
    job.expectedEndedAt = expectedEndedAt;
    job.status = "speaking";
    job.updatedAt = speakingStartedAt.toISOString();
    runtime.currentSpeech = {
      jobId: job.id,
      eventId: job.eventId,
      threadId: job.threadId,
      text: job.text,
      startedAt: speakingStartedAt.toISOString(),
      expectedEndedAt,
      audioUrl: job.audioUrl,
      audioDurationMs,
      lipSync: job.lipSync,
      mouthProfile: job.mouthProfile,
      analysis: job.analysis,
    };
    runtime.avatar.speaking = true;
    runtime.avatar.mouthFrame = "open";
    runtime.avatar.emotion = job.analysis.emotion;
    runtime.avatar.gesture = job.analysis.gesture;
    runtime.avatar.layers = job.analysis.layers;
    runtime.lastError = null;
    broadcastSnapshot();
  };

  const [payload] = await Promise.all([
    voicevoxWorker.synthesize({
      text: speechText,
      styleId: 2,
      output: audioFile,
      speedFactor: speechSpeedFactor,
      lipSyncFrameMs,
      mouthProfile,
    }),
    wavPlayer.refreshOutput(),
  ]);

  if (!payload.ok) {
    throw new Error(payload.error ?? "VOICEVOX worker failed.");
  }
  applySynthesisPayload(payload);
  await wavPlayer.play(audioFile, payload.durationSeconds ?? 0, () => markSpeechStarted(payload));
  if (!isSpeechJobForActiveThread(job)) {
    job.status = "done";
    job.updatedAt = new Date().toISOString();
    runtime.currentSpeech = null;
    runtime.avatar.speaking = false;
    runtime.avatar.mouthFrame = "closed";
    runtime.avatar.layers = defaultAvatarLayers();
    broadcastSnapshot();
    return;
  }
  job.status = "done";
  job.updatedAt = new Date().toISOString();
  runtime.avatar.speaking = false;
  runtime.avatar.mouthFrame = "closed";
  runtime.avatar.layers = defaultAvatarLayers();
  runtime.currentSpeech = null;
  broadcastSnapshot();
}

function isSpeechJobForActiveThread(job: SpeechJob): boolean {
  if (!activeThreadId || !job.threadId) {
    return true;
  }
  return normalizeCodexThreadId(job.threadId) === activeThreadId;
}

function mouthProfileForAnalysis(analysis: AnalysisEvent): MouthProfile {
  switch (analysis.emotion) {
    case "error":
    case "warning":
    case "trouble":
      return "negative";
    case "success":
    case "surprise":
    case "smile":
    case "shy_flirty":
    case "happy":
    case "fun":
      return "expressive";
    default:
      return "neutral";
  }
}

async function ensureAvatarFrames(): Promise<void> {
  const required = ["metan.png", "metan_mouth_closed.png", "metan_mouth_open.png", "metan_blink.png"];
  const missing = required.filter((file) => !existsSync(join(avatarRenderedDir, file)));
  if (missing.length > 0) {
    await runProcess("uv", ["run", "python", "-m", "voicevox_avatar_bridge", "render-avatar", "--character", "metan", "--json"], {
      cwd: avatarBridgeRoot,
      env: {
        ...process.env,
        PYTHONPATH: join(avatarBridgeRoot, "src"),
      },
      timeoutMs: 180_000,
    });
  }

  const missingMouthFrames = Object.values(mouthFrameFiles).filter((file) => !existsSync(join(avatarRenderedDir, file)));
  if (missingMouthFrames.length > 0) {
    await runProcess("uv", [
      "run",
      "python",
      join(projectRoot, "tools", "render_extra_avatar_frames.py"),
      "--character",
      "metan",
      "--json",
    ], {
      cwd: avatarBridgeRoot,
      env: {
        ...process.env,
        PYTHONPATH: join(avatarBridgeRoot, "src"),
      },
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

function trimQueue(): void {
  if (runtime.speechQueue.length <= maxQueueItems) {
    return;
  }
  const active = runtime.speechQueue.filter((job) => job.status !== "done" && job.status !== "error");
  const finished = runtime.speechQueue.filter((job) => job.status === "done" || job.status === "error").slice(-maxQueueItems + active.length);
  runtime.speechQueue = [...finished, ...active];
}

async function restoreRecentEvents(): Promise<void> {
  if (!existsSync(analysisJsonlPath)) {
    return;
  }
  const lines = (await readFile(analysisJsonlPath, "utf8")).split(/\r?\n/).filter(Boolean).slice(-maxEvents);
  const restored: ProgressEventRecord[] = [];
  let latestAnalysis: AnalysisEvent | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    let record: unknown;
    try {
      record = JSON.parse(lines[index]!);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
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
      createdAt: typeof analysis.timestamp === "string" ? analysis.timestamp : runtime.startedAt,
      threadId: typeof analysis.threadId === "string" ? analysis.threadId : undefined,
      metadata: { restored: true, adapter: "analysis-jsonl" },
    });
  }
  runtime.events = restored.reverse();
  if (latestAnalysis?.emotion) {
    runtime.avatar.emotion = latestAnalysis.emotion;
  }
  if (latestAnalysis?.gesture) {
    runtime.avatar.gesture = latestAnalysis.gesture;
  }
  if (latestAnalysis?.layers) {
    runtime.avatar.layers = latestAnalysis.layers;
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

function buildSnapshot(): RuntimeState & {
  avatarFrames: Record<string, unknown>;
  overlay: Record<string, unknown>;
  server: Record<string, unknown>;
  threadWatchers: CodexThreadWatchState[];
} {
  return {
    ...runtime,
    threadWatchers: threadWatcher.getStates(),
    avatarFrames: buildAvatarFrameUrls(),
    overlay: buildFloatingOverlayStatus(),
    server: buildServerInfo(),
  };
}

function buildOverlaySnapshot(): Record<string, unknown> {
  const current = runtime.currentSpeech;
  const latest = runtime.events[0];
  return {
    startedAt: runtime.startedAt,
    text: current?.text || latest?.text || "待機しています。",
    currentSpeech: current
      ? {
          text: current.text,
          startedAt: current.startedAt,
          expectedEndedAt: current.expectedEndedAt,
          audioDurationMs: current.audioDurationMs,
          lipSync: current.lipSync,
          mouthProfile: current.mouthProfile,
        }
      : null,
    avatar: runtime.avatar,
    avatarFrames: buildAvatarFrameUrls(),
    overlay: buildFloatingOverlayStatus(),
    server: buildServerInfo(),
    lastError: runtime.lastError,
  };
}

function markFloatingOverlaySeen(): void {
  floatingOverlayControl.lastSeenAt = new Date().toISOString();
  floatingOverlayControl.lastError = null;
}

function buildFloatingOverlayStatus(): Record<string, unknown> {
  return {
    desiredVisible: floatingOverlayControl.desiredVisible,
    running: isFloatingOverlayRunning(),
    lastSeenAt: floatingOverlayControl.lastSeenAt,
    lastStartedAt: floatingOverlayControl.lastStartedAt,
    lastActionAt: floatingOverlayControl.lastActionAt,
    lastError: floatingOverlayControl.lastError,
  };
}

function isFloatingOverlayRunning(): boolean {
  if (!floatingOverlayControl.lastSeenAt) {
    return false;
  }
  const lastSeenMs = Date.parse(floatingOverlayControl.lastSeenAt);
  return Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs < 3500;
}

function buildAvatarFrameUrls(): Record<string, unknown> {
  const mouthFrames = Object.fromEntries(
    Object.entries(mouthFrameFiles).map(([frame, file]) => [
      frame,
      cacheBustedAvatarUrl(existsSync(join(avatarRenderedDir, file)) ? file : mouthFrameFiles.closed),
    ]),
  ) as Record<MouthFrame, string>;
  const mouthEyes = buildMouthEyeFrameUrls();
  return {
    idle: mouthEyes.closed?.normal ?? mouthFrames.closed ?? cacheBustedAvatarUrl("metan.png"),
    ...mouthFrames,
    blink: mouthEyes.closed?.blink ?? cacheBustedAvatarUrl("metan_blink.png"),
    mouthEyes,
  };
}

function buildServerInfo(): Record<string, unknown> {
  return {
    port,
    threadPollMs,
    speechSpeedFactor,
    lipSyncFrameMs,
    lipSyncLeadMs,
    voiceWorkerMode: "persistent",
    voicevoxAcceleration,
    avatarBridgeRoot,
    voicevoxCoreRoot,
    openJtalkRoot,
  };
}

function initialVoicevoxAcceleration(): VoicevoxAcceleration {
  try {
    return parseVoicevoxAcceleration(process.env.VOICEVOX_ACCELERATION ?? "auto");
  } catch {
    return "auto";
  }
}

function buildMouthEyeFrameUrls(): Record<string, Record<string, string>> {
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
      urls[mouth][eye] = cacheBustedCombinationUrl(item.fileName);
    }
    return urls;
  } catch {
    return {};
  }
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

function cacheBustedAvatarUrl(file: string): string {
  const fullPath = join(avatarRenderedDir, file);
  const version = existsSync(fullPath) ? statSync(fullPath).mtimeMs.toFixed(0) : "missing";
  return `/avatar/${encodeURIComponent(file)}?v=${version}`;
}

function cacheBustedCombinationUrl(file: string): string {
  const fullPath = join(mouthEyeCombinationDir, file);
  const version = existsSync(fullPath) ? statSync(fullPath).mtimeMs.toFixed(0) : "missing";
  return `/avatar-combinations/${encodeURIComponent(file)}?v=${version}`;
}

function broadcastSnapshot(): void {
  const message = JSON.stringify({ type: "snapshot", payload: buildSnapshot() });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 64 * 1024) {
      throw new BadRequestError("request body is too large.");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadRequestError("invalid JSON.");
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload, null, 2));
}

function serveStatic(response: ServerResponse, pathname: string): void {
  const file = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  serveSafeFile(response, publicDir, file);
}

function serveSafeFile(response: ServerResponse, root: string, requestedFile: string): void {
  let decodedFile = requestedFile;
  try {
    decodedFile = decodeURIComponent(requestedFile);
  } catch {
    sendJson(response, 400, { error: "bad_path" });
    return;
  }
  const cleanName = decodedFile.replaceAll("\\", "/");
  if (cleanName.includes("/") || cleanName.includes("..") || cleanName.trim() === "") {
    sendJson(response, 400, { error: "bad_path" });
    return;
  }
  const filePath = normalize(join(root, cleanName));
  if (!filePath.startsWith(normalize(root)) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    sendJson(response, 404, { error: "not_found" });
    return;
  }
  response.writeHead(200, {
    "content-type": contentType(filePath),
    "cache-control": filePath.includes("public") ? "no-store" : "public, max-age=3600",
  });
  createReadStream(filePath).pipe(response);
}

function contentType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".png":
      return "image/png";
    case ".wav":
      return "audio/wav";
    default:
      return "application/octet-stream";
  }
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

class BadRequestError extends Error {}
