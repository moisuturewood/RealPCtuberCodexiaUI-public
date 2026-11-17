import { execFile } from "node:child_process";
import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import { join } from "node:path";

/** Local JSONL, with an active file and two bounded rotated files. */
export class RendererDiagnostics {
  private tail: Promise<void> = Promise.resolve();
  readonly path: string;

  constructor(private readonly directory: string, private readonly maxBytes = 1024 * 1024) {
    this.path = join(directory, "events.jsonl");
  }

  record(event: Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify({ schemaVersion: 1, timestamp: new Date().toISOString(), ...event })}\n`;
    const task = this.tail.catch(() => undefined).then(async () => {
      await mkdir(this.directory, { recursive: true });
      const size = await stat(this.path).then(file => file.size, error => {
        if (error.code === "ENOENT") return 0;
        throw error;
      });
      if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) {
        await unlink(`${this.path}.2`).catch(ignoreMissing);
        await rename(`${this.path}.1`, `${this.path}.2`).catch(ignoreMissing);
        await rename(this.path, `${this.path}.1`);
      }
      await appendFile(this.path, line, "utf8");
    });
    this.tail = task;
    return task;
  }
}

function ignoreMissing(error: NodeJS.ErrnoException): void {
  if (error.code !== "ENOENT") throw error;
}

export function rendererMemorySummary(): Record<string, number> {
  const memory = process.memoryUsage();
  return { physicalTotalBytes: totalmem(), physicalAvailableBytes: freemem(), mainRssBytes: memory.rss, mainHeapUsedBytes: memory.heapUsed };
}

/** Taken only on faults, asynchronously; no resident monitoring process. */
export function windowsCommitMemory(): Promise<Record<string, number>> {
  if (process.platform !== "win32") return Promise.resolve({});
  const command = "$m=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction Stop; @{committedBytes=[double]$m.CommittedBytes;commitLimitBytes=[double]$m.CommitLimit;nonpagedPoolBytes=[double]$m.PoolNonpagedBytes}|ConvertTo-Json -Compress";
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      windowsHide: true, timeout: 8000, maxBuffer: 32 * 1024, encoding: "utf8",
    }, (error, stdout) => {
      if (error) { reject(error); return; }
      try {
        const parsed = JSON.parse(stdout);
        const values: Record<string, number> = {};
        for (const key of ["committedBytes", "commitLimitBytes", "nonpagedPoolBytes"]) {
          if (typeof parsed[key] === "number" && Number.isFinite(parsed[key])) values[key] = parsed[key];
        }
        resolve(values);
      } catch (parseError) { reject(parseError); }
    });
  });
}
