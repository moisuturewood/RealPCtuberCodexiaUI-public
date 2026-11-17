import { mkdir, readFile, writeFile } from "node:fs/promises";

import { configDir, voicevoxSettingsPath } from "./paths.js";
import type { VoicevoxAcceleration } from "./types.js";

export interface VoicevoxSettings {
  acceleration: VoicevoxAcceleration;
}

export function parseVoicevoxAcceleration(value: unknown): VoicevoxAcceleration {
  if (value === "auto" || value === "cpu" || value === "gpu") {
    return value;
  }
  throw new Error("acceleration must be auto, cpu, or gpu.");
}

export async function readVoicevoxSettings(fallback: VoicevoxAcceleration): Promise<VoicevoxSettings> {
  try {
    const parsed = JSON.parse(await readFile(voicevoxSettingsPath, "utf8")) as { acceleration?: unknown };
    return { acceleration: parseVoicevoxAcceleration(parsed.acceleration) };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { acceleration: fallback };
    }
    return { acceleration: fallback };
  }
}

export async function writeVoicevoxSettings(settings: VoicevoxSettings): Promise<void> {
  await mkdir(configDir, { recursive: true });
  await writeFile(voicevoxSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
