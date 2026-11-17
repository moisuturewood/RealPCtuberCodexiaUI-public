# Codex Progress Capture Feasibility

Checked on 2026-06-27 JST with `codex-cli 0.135.0` and the freshly fetched Codex manual.

## Summary

Use `POST /api/events` for cooperative/manual events and `POST /api/thread-watch` for local Codex desktop thread narration.

No stable external API was confirmed for reading arbitrary existing Codex desktop `codex://threads/...` progress rows directly from an independent local process. The documented `codex://threads/...` form is a desktop deep link that opens a thread, not a content or progress-log API.

This project now implements a local-session adapter instead: the UI server finds the matching Codex session JSONL under `$CODEX_HOME\sessions` or `%USERPROFILE%\.codex\sessions`, extracts Codex commentary rows, and forwards them to the same VOICEVOX queue as normal events. This avoids OCR and desktop scraping while keeping the UI server independent from assistant-only thread tools.

## Confirmed Options

### 1. Manual Post Adapter

Status: implemented.

Codex, a helper script, or another local process can send short progress events to:

```text
POST http://127.0.0.1:48731/api/events
```

This keeps the RealPCtuber process independent from the main Codex work and avoids fragile UI scraping.

### 2. Local Codex Session JSONL Adapter

Status: implemented.

The server can watch an existing local Codex desktop thread by threadId:

```text
POST http://127.0.0.1:48731/api/thread-watch
```

Example body:

```json
{
  "threadId": "00000000-0000-0000-0000-000000000000",
  "replay": "recent",
  "includeTools": false,
  "includeLifecycle": false,
  "maxReplayEvents": 6
}
```

Captured rows:

- Commentary/progress text from `event_msg.agent_message` with `phase: "commentary"`.
- Optional task start and task completion markers when `includeLifecycle` is true.
- Optional short, safe summaries for supported tool completions when `includeTools` is true.

Boundary:

- This watches local Codex session JSONL files only.
- It does not call private assistant-only thread tools.
- It does not read hidden reasoning or large tool outputs aloud.
- By default it replays recent commentary text and skips command/tool summaries.
- It does not summarize commentary text; commentary is whitespace-normalized and forwarded as-is.
- A cloud-only or not-yet-synced thread cannot be narrated until its session JSONL exists locally.

### 3. `codex app-server` Adapter

Status: feasible later, not the MVP foundation.

The Codex manual documents `codex app-server` as the rich-client integration surface. It can stream turn notifications such as `item/started`, `item/completed`, `item/agentMessage/delta`, and tool progress after a client starts a thread/turn through the app-server protocol.

Boundary:

- This is best for a future Codex App Server style integrated client.
- It does not by itself prove a stable way to attach to and read every progress row from an arbitrary already-open desktop thread.
- WebSocket transport is documented as experimental/unsupported; keep it localhost-only and authenticated if used.

### 4. `codex exec --json` Adapter

Status: feasible for noninteractive Codex runs.

`codex exec --json` streams JSONL events to stdout, including thread, turn, item, and error events. This is useful if a future workflow launches a helper Codex task specifically for RealPCtuber capture.

Boundary:

- It is not a direct capture method for the currently visible Codex desktop app thread.
- It is better treated as a separate adapter for scripted/background runs.

### 5. Current Codex App Thread Tools

Status: not a standalone UI integration surface.

This Codex session exposes thread-management tools to the assistant, including reading thread summaries. Those tools are useful for agent coordination inside Codex, but they are not a public local HTTP/WebSocket API that this independent UI process can call by itself.

## Recommendation

Keep these production routes:

```text
Codex progress text / local session JSONL
  -> POST /api/events or POST /api/thread-watch
  -> local WebSocket UI
  -> serialized VOICEVOX queue
  -> avatar/subtitle sync
```

Future adapters should be added in this order:

1. `manual-post`
2. `local-session-jsonl`
3. `codex-exec-json`
4. `app-server-turn`
5. `ui-observer` only as a last resort

OCR or desktop UI scraping should remain a fallback because it is brittle and can distract from the main Codex task.
