import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { ElectronRuntime } from "./electronRuntime.js";

const port = Number(process.env.CODEXIA_VOICE_EXPORT_PORT ?? 48732);
const bridgeConfigPath = process.env.CODEXIA_THREAD_BRIDGE_CONFIG ?? "";
const maxRequestBytes = 32 * 1024;

export async function startVoiceExportServer(runtime: ElectronRuntime): Promise<Server> {
  const server = createServer(async (request, response) => {
    try {
      if (!(await isAuthorized(request))) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }

      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true, speaker: "四国めたん", styleId: 2 });
        return;
      }
      if (request.method === "POST" && url.pathname === "/synthesize") {
        const body = await readJson(request);
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) {
          sendJson(response, 400, { error: "text_required" });
          return;
        }
        if (text.length > 4_000) {
          sendJson(response, 400, { error: "text_too_long" });
          return;
        }
        const result = await runtime.synthesizeVoiceExport(text);
        sendJson(response, 200, { ok: true, ...result });
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, 500, {
        error: "voice_export_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  console.log(`Codexia voice export listening on http://127.0.0.1:${port}`);
  return server;
}

async function isAuthorized(request: IncomingMessage): Promise<boolean> {
  if (!bridgeConfigPath) return false;
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  let expected = "";
  try {
    const config = JSON.parse(await readFile(bridgeConfigPath, "utf8")) as { Token?: unknown };
    expected = typeof config.Token === "string" ? config.Token : "";
  } catch {
    return false;
  }
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(supplied, "utf8");
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxRequestBytes) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_json");
  return value as Record<string, unknown>;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}
