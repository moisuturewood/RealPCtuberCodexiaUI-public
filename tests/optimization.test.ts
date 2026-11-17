import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import test from "node:test";

import { ElectronRuntime } from "../src/electronRuntime.js";
import { readJsonlTail } from "../src/jsonlTail.js";
import { projectRoot } from "../src/paths.js";

async function fixture(t: { after: (callback: () => Promise<void>) => void }): Promise<string> {
  const root = resolve(projectRoot, "work");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "optimization-test-"));
  assert.ok(resolve(dir).startsWith(root + sep));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "history.jsonl");
}

test("tail preserves UTF-8, CRLF, blank lines, and unterminated final records", async (t) => {
  const file = await fixture(t);
  const cases = [
    "",
    "一件だけ",
    "\n\r\n",
    "古い記録\r\n\r\nめたん🌸\r\n\r\n最後の文",
    Array.from({ length: 12 }, (_, index) => JSON.stringify({ index, text: "めたん🌸".repeat(14000) })).join("\n") + "\n",
    "古い記録\n" + "\r\n".repeat(70000) + "最後の文\n",
  ];
  for (const content of cases) {
    await writeFile(file, content, "utf8");
    for (const count of [1, 3, 200]) {
      assert.deepEqual(await readJsonlTail(file, count), content.split(/\r?\n/).filter(Boolean).slice(-count));
    }
  }
});

test("restoring 200 records reads a bounded tail of a large history", async (t) => {
  const file = await fixture(t);
  const recent = Array.from({ length: 250 }, (_, index) => JSON.stringify({ index, text: "めたんの字幕🌸".repeat(15) }));
  await writeFile(file, `${"{\"old\":true}\n".repeat(300000)}${recent.join("\n")}\n`, "utf8");
  const probe = await open(file, "r");
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const original = prototype.read;
  let bytesRead = 0;
  const mocked = t.mock.method(prototype, "read", async function (this: unknown, ...args: unknown[]) {
    const result = await original.apply(this, args);
    bytesRead += result.bytesRead;
    return result;
  });
  try {
    assert.deepEqual(await readJsonlTail(file, 200), recent.slice(-200));
    assert.ok(bytesRead <= 2 * 64 * 1024, `unexpectedly read ${bytesRead} bytes`);
  } finally {
    mocked.mock.restore();
  }
});

test("tail validates limits and propagates missing-file errors", async (t) => {
  const file = await fixture(t);
  assert.deepEqual(await readJsonlTail(file, 0), []);
  await assert.rejects(readJsonlTail(file, -1), RangeError);
  await assert.rejects(readJsonlTail(file, 1.5), RangeError);
  await assert.rejects(readJsonlTail(file, 1), { code: "ENOENT" });
});

test("image cache expires without freezing live runtime state", (t) => {
  let now = 10000;
  t.mock.method(Date, "now", () => now);
  const runtime = new ElectronRuntime();
  const first = runtime.getSnapshot();
  now += 999;
  (runtime as unknown as { runtime: { lastError: string | null } }).runtime.lastError = "changed";
  const cached = runtime.getSnapshot();
  assert.equal(cached.avatarFrames, first.avatarFrames);
  assert.equal(cached.lastError, "changed");
  now += 1;
  const refreshed = runtime.getSnapshot();
  assert.notEqual(refreshed.avatarFrames, first.avatarFrames);
  assert.deepEqual(refreshed.avatarFrames, first.avatarFrames);
  now -= 5000;
  assert.notEqual(runtime.getSnapshot().avatarFrames, refreshed.avatarFrames);
});
