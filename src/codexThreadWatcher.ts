import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import type { CodexThreadWatchState, EventKind, ProgressEventInput } from "./types.js";

export interface ThreadWatcherOptions {
  codexHome?: string;
  pollMs?: number;
  ingestEvent: (event: ProgressEventInput) => Promise<void>;
  onChange: () => void;
  onError: (message: string) => void;
}

export interface StartThreadWatchInput {
  threadId: string;
  threadName?: string;
  replay?: "none" | "recent" | "all" | boolean;
  includeTools?: boolean;
  includeLifecycle?: boolean;
  maxReplayEvents?: number;
}

interface WatchRuntime {
  state: CodexThreadWatchState;
  timer: NodeJS.Timeout | null;
  polling: boolean;
  leftover: string;
  toolCalls: Map<string, ToolCallSummary>;
  recentEventFingerprints: Map<string, true>;
}

interface ToolCallSummary {
  name: string;
  text: string;
  kind: EventKind;
}

interface ExtractedThreadEvent {
  text: string;
  kind: EventKind;
  createdAt: string;
  messageId?: string;
  metadata: Record<string, unknown>;
}

interface AgentMessageRecord {
  value: unknown;
  phase: unknown;
  itemType: string;
  messageId?: string;
}

export class CodexThreadWatcherManager {
  private readonly codexHome: string;
  private readonly sessionsRoot: string;
  private readonly pollMs: number;
  private readonly watchers = new Map<string, WatchRuntime>();

  constructor(private readonly options: ThreadWatcherOptions) {
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(process.env.USERPROFILE ?? "", ".codex");
    this.sessionsRoot = join(this.codexHome, "sessions");
    this.pollMs = options.pollMs ?? 1800;
  }

  getStates(): CodexThreadWatchState[] {
    return [...this.watchers.values()].map((watcher) => ({ ...watcher.state }));
  }

  async start(input: StartThreadWatchInput): Promise<CodexThreadWatchState> {
    const threadId = normalizeThreadId(input.threadId);
    if (!threadId) {
      throw new Error("threadId is required.");
    }
    for (const activeThreadId of [...this.watchers.keys()]) {
      this.stop(activeThreadId);
    }

    const replay = normalizeReplay(input.replay);
    const defaultMaxReplayEvents = replay === "none" ? 0 : 8;
    const maxReplayEvents = clampNumber(input.maxReplayEvents ?? defaultMaxReplayEvents, 0, 50);
    const state: CodexThreadWatchState = {
      threadId,
      status: "starting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastOffset: 0,
      emittedCount: 0,
      replay,
      includeTools: false,
      includeLifecycle: input.includeLifecycle ?? false,
      maxReplayEvents,
    };
    const runtime: WatchRuntime = {
      state,
      timer: null,
      polling: false,
      leftover: "",
      toolCalls: new Map(),
      recentEventFingerprints: new Map(),
    };
    this.watchers.set(threadId, runtime);
    this.options.onChange();

    try {
      state.filePath = await this.findThreadLog(threadId);
      await this.initializeWatcher(runtime);
      state.status = "watching";
      state.updatedAt = new Date().toISOString();
      runtime.timer = setInterval(() => {
        void this.poll(runtime);
      }, this.pollMs);
      this.options.onChange();
      return { ...state };
    } catch (error) {
      state.status = "error";
      state.error = error instanceof Error ? error.message : String(error);
      state.updatedAt = new Date().toISOString();
      this.options.onError(state.error);
      this.options.onChange();
      return { ...state };
    }
  }

  stop(threadId: string): CodexThreadWatchState | null {
    const id = normalizeThreadId(threadId);
    const runtime = this.watchers.get(id);
    if (!runtime) {
      return null;
    }
    if (runtime.timer) {
      clearInterval(runtime.timer);
      runtime.timer = null;
    }
    runtime.state.status = "stopped";
    runtime.state.updatedAt = new Date().toISOString();
    this.watchers.delete(id);
    this.options.onChange();
    return { ...runtime.state };
  }

  stopAll(): void {
    for (const threadId of [...this.watchers.keys()]) {
      this.stop(threadId);
    }
  }

  private async initializeWatcher(runtime: WatchRuntime): Promise<void> {
    const filePath = runtime.state.filePath;
    if (!filePath) {
      throw new Error("Thread log path was not resolved.");
    }
    const fileStat = await stat(filePath);
    if (runtime.state.replay === "none") {
      runtime.state.lastOffset = fileStat.size;
      return;
    }

    const content = await readFile(filePath, "utf8");
    const events = this.extractEvents(content.split(/\r?\n/).filter(Boolean), runtime);
    const selected =
      runtime.state.replay === "all"
        ? events
        : runtime.state.maxReplayEvents > 0
          ? events.slice(-runtime.state.maxReplayEvents)
          : [];
    for (const event of selected) {
      await this.emitExtractedEvent(runtime, event, true);
    }
    runtime.state.lastOffset = fileStat.size;
  }

  private async poll(runtime: WatchRuntime): Promise<void> {
    if (runtime.state.status !== "watching" || !runtime.state.filePath || runtime.polling) {
      return;
    }
    runtime.polling = true;
    try {
      const fileStat = await stat(runtime.state.filePath);
      if (!this.isRuntimeActive(runtime)) {
        return;
      }
      if (fileStat.size < runtime.state.lastOffset) {
        runtime.state.lastOffset = 0;
        runtime.leftover = "";
      }
      if (fileStat.size === runtime.state.lastOffset) {
        return;
      }
      const chunk = await readRange(runtime.state.filePath, runtime.state.lastOffset, fileStat.size);
      if (!this.isRuntimeActive(runtime)) {
        return;
      }
      runtime.state.lastOffset = fileStat.size;
      const merged = runtime.leftover + chunk;
      const lines = merged.split(/\r?\n/);
      runtime.leftover = lines.pop() ?? "";
      const events = this.extractEvents(lines.filter(Boolean), runtime);
      for (const event of events) {
        if (!this.isRuntimeActive(runtime)) {
          return;
        }
        await this.emitExtractedEvent(runtime, event, false);
      }
    } catch (error) {
      runtime.state.status = "error";
      runtime.state.error = error instanceof Error ? error.message : String(error);
      runtime.state.updatedAt = new Date().toISOString();
      if (runtime.timer) {
        clearInterval(runtime.timer);
        runtime.timer = null;
      }
      this.options.onError(runtime.state.error);
      this.options.onChange();
    } finally {
      runtime.polling = false;
    }
  }

  private extractEvents(lines: string[], runtime: WatchRuntime): ExtractedThreadEvent[] {
    const events: ExtractedThreadEvent[] = [];
    for (const line of lines) {
      let record: any;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const createdAt = typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString();
      const agentMessage = extractAgentMessageRecord(record);
      if (agentMessage) {
        const phase = normalizeAgentMessagePhase(agentMessage.phase);
        if (!phase) {
          continue;
        }
        const text = normalizeAgentMessage(agentMessage.value, phase);
        if (text) {
          events.push({
            text,
            kind: "progress",
            createdAt,
            messageId: agentMessage.messageId,
            metadata: { adapter: "codex-session-jsonl", itemType: agentMessage.itemType, phase },
          });
        }
        continue;
      }
      if (record.type === "event_msg" && record.payload?.type === "task_started" && runtime.state.includeLifecycle) {
        events.push({
          text: "Codexの作業を開始しました。",
          kind: "system",
          createdAt,
          metadata: { adapter: "codex-session-jsonl", itemType: "task_started" },
        });
        continue;
      }
      if (record.type === "event_msg" && record.payload?.type === "task_complete" && runtime.state.includeLifecycle) {
        events.push({
          text: "Codexの作業が完了しました。",
          kind: "success",
          createdAt,
          metadata: { adapter: "codex-session-jsonl", itemType: "task_complete" },
        });
        continue;
      }
      if (record.type !== "response_item" || !runtime.state.includeTools) {
        continue;
      }
      const payload = record.payload;
      if (payload?.type === "function_call" || payload?.type === "custom_tool_call" || payload?.type === "tool_search_call") {
        const summary = summarizeToolCall(payload);
        if (summary && typeof payload.call_id === "string") {
          runtime.toolCalls.set(payload.call_id, summary);
        }
        continue;
      }
      if (payload?.type === "function_call_output" || payload?.type === "custom_tool_call_output" || payload?.type === "tool_search_output") {
        const summary = runtime.toolCalls.get(payload.call_id);
        if (summary) {
          events.push({
            text: summary.text,
            kind: summary.kind,
            createdAt,
            metadata: {
              adapter: "codex-session-jsonl",
              itemType: payload.type,
              toolName: summary.name,
              callId: payload.call_id,
            },
          });
          runtime.toolCalls.delete(payload.call_id);
        }
      }
    }
    return dedupeAdjacent(events);
  }

  private async emitExtractedEvent(runtime: WatchRuntime, event: ExtractedThreadEvent, replayed: boolean): Promise<void> {
    if (!this.isRuntimeRegistered(runtime)) {
      return;
    }
    const fingerprint = event.messageId
      ? `message\u0000${event.messageId}`
      : `${event.createdAt}\u0000${event.kind}\u0000${event.text}`;
    if (runtime.recentEventFingerprints.has(fingerprint)) {
      return;
    }
    rememberEventFingerprint(runtime.recentEventFingerprints, fingerprint);
    await this.options.ingestEvent({
      threadId: `codex://threads/${runtime.state.threadId}`,
      source: "codex-thread-watch",
      kind: event.kind,
      text: event.text,
      priority: "normal",
      createdAt: event.createdAt,
      metadata: {
        ...event.metadata,
        replayed,
        filePath: runtime.state.filePath,
      },
    });
    runtime.state.emittedCount += 1;
    runtime.state.lastEventAt = event.createdAt;
    runtime.state.updatedAt = new Date().toISOString();
    this.options.onChange();
  }

  private isRuntimeActive(runtime: WatchRuntime): boolean {
    return this.isRuntimeRegistered(runtime) && runtime.state.status === "watching";
  }

  private isRuntimeRegistered(runtime: WatchRuntime): boolean {
    return this.watchers.get(runtime.state.threadId) === runtime;
  }

  private async findThreadLog(threadId: string): Promise<string> {
    const matches = await findFilesByName(this.sessionsRoot, threadId);
    if (matches.length === 0) {
      throw new Error(`Codex session JSONL was not found for thread ${threadId}.`);
    }
    matches.sort((a, b) => basename(b).localeCompare(basename(a)));
    return matches[0]!;
  }
}

function rememberEventFingerprint(fingerprints: Map<string, true>, fingerprint: string): void {
  fingerprints.set(fingerprint, true);
  while (fingerprints.size > 500) {
    const oldest = fingerprints.keys().next().value;
    if (typeof oldest !== "string") {
      return;
    }
    fingerprints.delete(oldest);
  }
}

async function findFilesByName(root: string, needle: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(needle)) {
        result.push(fullPath);
      }
    }
  }
  await walk(root);
  return result;
}

function readRange(filePath: string, start: number, end: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath, {
      start,
      end: Math.max(start, end - 1),
    });
    stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function summarizeToolCall(payload: any): ToolCallSummary | null {
  const name = String(payload.name ?? payload.tool_name ?? payload.type ?? "tool");
  if (payload.type === "custom_tool_call") {
    return { name, text: "ファイル変更を適用しました。", kind: "progress" };
  }
  if (payload.type === "tool_search_call") {
    return { name: "tool_search", text: "Codexの追加ツールを探しました。", kind: "progress" };
  }
  if (name === "read_thread") {
    return { name, text: "スレッドを読み込みました。", kind: "progress" };
  }
  if (name === "exec_command") {
    return { name, text: "コマンドを実行しました。", kind: "progress" };
  }
  if (name === "write_stdin") {
    return { name, text: "実行中のコマンド出力を確認しました。", kind: "progress" };
  }
  if (name === "view_image") {
    return { name, text: "画像を確認しました。", kind: "progress" };
  }
  if (name === "update_plan") {
    return { name, text: "作業計画を更新しました。", kind: "progress" };
  }
  if (name === "multi_tool_use.parallel") {
    const uses = parseParallelToolUses(payload.arguments);
    if (uses.length > 0 && uses.every((toolName) => toolName.endsWith(".exec_command"))) {
      return { name, text: `${uses.length}件のコマンドを実行しました。`, kind: "progress" };
    }
    return {
      name,
      text: uses.length > 0 ? `${uses.length}件の操作を並列で実行しました。` : "複数の確認を並列で実行しました。",
      kind: "progress",
    };
  }
  if (name.includes("playwright")) {
    return { name, text: "ブラウザ表示を確認しました。", kind: "progress" };
  }
  return null;
}

function parseArguments(value: unknown): Record<string, any> {
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function parseParallelToolUses(value: unknown): string[] {
  const parsed = parseArguments(value);
  if (!Array.isArray(parsed.tool_uses)) {
    return [];
  }
  return parsed.tool_uses
    .map((item) => (item && typeof item === "object" ? String(item.recipient_name ?? "") : ""))
    .filter(Boolean);
}

function normalizeSpeechText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+/g, " ").trim();
}

function extractAgentMessageRecord(record: any): AgentMessageRecord | null {
  if (record?.type === "event_msg" && record.payload?.type === "agent_message") {
    return {
      value: record.payload.message,
      phase: record.payload.phase,
      itemType: "agent_message",
      messageId: stringOrUndefined(record.payload.id),
    };
  }

  const completedItem = record?.type === "event_msg" && record.payload?.type === "item_completed" ? record.payload.item : null;
  if (isAgentMessageItem(completedItem)) {
    return {
      value: readMessageContent(completedItem.content ?? completedItem.message ?? completedItem.text),
      phase: completedItem.phase,
      itemType: "agent_message_item_completed",
      messageId: stringOrUndefined(completedItem.id),
    };
  }

  const responseItem = record?.type === "response_item" ? record.payload : null;
  if (responseItem?.type === "message" && responseItem.role === "assistant") {
    return {
      value: readMessageContent(responseItem.content ?? responseItem.message ?? responseItem.text),
      phase: responseItem.phase,
      itemType: "assistant_message",
      messageId: stringOrUndefined(responseItem.id),
    };
  }

  return null;
}

function isAgentMessageItem(value: any): boolean {
  return typeof value?.type === "string" && value.type.replace(/[^a-z]/giu, "").toLowerCase() === "agentmessage";
}

function readMessageContent(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  return value
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (!item || typeof item !== "object") {
        return "";
      }
      const candidate = item as Record<string, unknown>;
      return typeof candidate.text === "string" ? candidate.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function normalizeAgentMessagePhase(value: unknown): "commentary" | "final_answer" | null {
  if (value === "commentary") {
    return "commentary";
  }
  if (value === "final" || value === "final_answer") {
    return "final_answer";
  }
  return null;
}

function normalizeAgentMessage(value: unknown, phase: "commentary" | "final_answer"): string {
  if (typeof value !== "string") {
    return "";
  }
  if (phase === "commentary") {
    return normalizeSpeechText(value);
  }
  const visibleResult = value
    .replace(/<oai-mem-citation>[\s\S]*?(?:<\/oai-mem-citation>|$)/giu, " ")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/^::[^\r\n]*$/gmu, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1");
  return normalizeSpeechText(visibleResult);
}

function normalizeThreadId(value: string): string {
  return value.replace(/^codex:\/\/threads\//, "").trim();
}

function normalizeReplay(value: StartThreadWatchInput["replay"]): "none" | "recent" | "all" {
  if (value === true) {
    return "recent";
  }
  if (value === undefined) {
    return "none";
  }
  if (value === false) {
    return "none";
  }
  return value;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function dedupeAdjacent(events: ExtractedThreadEvent[]): ExtractedThreadEvent[] {
  const result: ExtractedThreadEvent[] = [];
  for (const event of events) {
    const previous = result.at(-1);
    if (previous && previous.text === event.text && previous.kind === event.kind) {
      continue;
    }
    result.push(event);
  }
  return result;
}
