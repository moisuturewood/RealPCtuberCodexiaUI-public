import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { FloatingRendererHealth, ManualFloatingRecovery, type FloatingDiagnosticEvent } from "../src/floatingRendererHealth.js";
import { RendererDiagnostics } from "../src/rendererDiagnostics.js";
import { projectRoot } from "../src/paths.js";

function healthFixture() {
  const events: FloatingDiagnosticEvent[] = [];
  const tracker = new FloatingRendererHealth({ onChange: () => undefined, onDiagnostic: event => events.push(event) });
  return { tracker, events };
}

test("a crash records the previous renderer and cannot remain healthy", () => {
  const { tracker, events } = healthFixture();
  tracker.loading("avatar");
  tracker.ready("avatar", 123, tracker.version("avatar"));
  const lastReady = tracker.snapshot().avatar.lastReadyAt;
  tracker.stopped("avatar", "oom", -536870904);
  assert.equal(tracker.snapshot().avatar.status, "stopped");
  assert.equal(tracker.snapshot().avatar.pid, 0);
  assert.equal(tracker.snapshot().avatar.reason, "oom");
  assert.deepEqual(events[0], { kind: "renderer-process-gone", role: "avatar", rendererPid: 123, lastReadyAt: lastReady, reason: "oom", exitCode: -536870904 });
  assert.equal(tracker.snapshot().subtitle.status, "closed");
});

test("late page-ready results cannot overwrite a crash or a newer window", () => {
  const { tracker } = healthFixture();
  tracker.loading("avatar");
  const stale = tracker.version("avatar");
  tracker.stopped("avatar", "crashed", 1);
  assert.equal(tracker.ready("avatar", 123, stale), false);
  tracker.recovering("avatar");
  tracker.loading("avatar");
  assert.equal(tracker.ready("avatar", 123, stale), false);
  assert.equal(tracker.ready("avatar", 456, tracker.version("avatar")), true);
  assert.equal(tracker.snapshot().avatar.pid, 456);
});

test("manual recovery clears its rendering error and preserves intentional hidden roles", () => {
  const { tracker, events } = healthFixture();
  tracker.setEnabled("avatar", false);
  tracker.setEnabled("subtitle", false);
  tracker.stopped("avatar", "crashed", 1);
  tracker.recovering("avatar");
  tracker.loading("avatar");
  assert.equal(tracker.snapshot().avatar.status, "recovering");
  tracker.ready("avatar", 456, tracker.version("avatar"));
  assert.equal(tracker.snapshot().avatar.reason, null);
  assert.equal(tracker.snapshot().avatar.enabled, false);
  assert.equal(tracker.snapshot().subtitle.enabled, false);
  assert.equal(events.at(-1)?.kind, "manual-recovery-completed");
  const copy = tracker.snapshot();
  copy.avatar.status = "stopped";
  assert.equal(tracker.snapshot().avatar.status, "ready");
});

test("stopping a renderer does not request recovery", async () => {
  const { tracker, events } = healthFixture();
  tracker.stopped("avatar", "killed", 1);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(tracker.snapshot().avatar.status, "stopped");
  assert.equal(events.some(event => event.kind.startsWith("manual-recovery")), false);
});

test("simultaneous recovery requests share one task and failures remain retryable", async () => {
  const recovery = new ManualFloatingRecovery();
  let calls = 0;
  let finish!: () => void;
  const operation = () => { calls += 1; return new Promise<void>(resolve => { finish = resolve; }); };
  const first = recovery.run(operation);
  const second = recovery.run(operation);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish();
  await Promise.all([first, second]);
  await assert.rejects(recovery.run(async () => { throw new Error("cannot load"); }), /cannot load/);
  await recovery.run(async () => { calls += 1; });
  assert.equal(calls, 2);
});

test("diagnostic writes stay valid and retain only three log files", async (t) => {
  const root = resolve(projectRoot, "work");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "renderer-log-test-"));
  assert.ok(resolve(directory).startsWith(root + sep));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = new RendererDiagnostics(directory, 240);
  await Promise.all(Array.from({ length: 30 }, (_, index) => log.record({ kind: "renderer-process-gone", role: "avatar", reason: "oom", index })));
  const files = await readdir(directory);
  assert.deepEqual(files.sort(), ["events.jsonl", "events.jsonl.1", "events.jsonl.2"]);
  for (const file of files) {
    const content = await readFile(join(directory, file), "utf8");
    assert.ok(Buffer.byteLength(content) <= 240);
    for (const line of content.trim().split("\n")) assert.equal(JSON.parse(line).schemaVersion, 1);
  }
  const latest = (await readFile(log.path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(latest.at(-1).index, 29);
});
