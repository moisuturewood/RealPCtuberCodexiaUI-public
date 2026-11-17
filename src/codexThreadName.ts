import { readFile } from "node:fs/promises";

import { codexSessionIndexPath } from "./paths.js";

export async function readCodexThreadNameFromIndex(threadId: string): Promise<string> {
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedThreadId) {
    return "";
  }
  try {
    const content = await readFile(codexSessionIndexPath, "utf8");
    const lines = content.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line) {
        continue;
      }
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(record) || normalizeThreadId(record.id) !== normalizedThreadId) {
        continue;
      }
      const name = typeof record.thread_name === "string" ? record.thread_name.trim() : "";
      if (name && name !== normalizedThreadId) {
        return name;
      }
    }
  } catch {
    // Older Codex builds may not have the session index; the JSONL fallback still works.
  }
  return "";
}

function normalizeThreadId(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/^codex:\/\/threads\//i, "") : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
