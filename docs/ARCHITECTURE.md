# Architecture Draft

## Recommended Shape

Use a small local server plus a desktop/web UI.

```text
Codex progress source
  -> adapter
  -> local event API
  -> queue
  -> analysis
  -> voice synthesis
  -> avatar state
  -> UI / overlay
```

## Components

### Event Server

- Accepts progress events.
- Stores raw events.
- Broadcasts to UI.
- Keeps audio queue serialized.

### Voice Worker

- Uses VOICEVOX Core.
- Runs as a warmed persistent JSONL worker during the UI server lifetime.
- Starts with Shikoku Metan normal `styleId=2`.
- Produces WAV and lip-sync timing under `outputs/audio/`.
- Plays WAV locally.

### Avatar Worker

- Reuses PSD assets from `voicevox-avatar-bridge`.
- Does not generate every expression combination.
- Caches layer parts and composes selected expression state.

### Analysis Worker

- Starts with deterministic rules.
- Calls Codexia Spark-style lightweight model when available.
- Writes every decision to JSONL for future training.

### UI

- Shows current line, history, queue, selected expression, and voice status.
- Has an overlay/avatar view suitable for RealPCtuber use.

## Codex Progress Capture

Treat direct Codex App progress access as an adapter, not the foundation.

Adapters:

1. `manual-post`: Codex or scripts post events to local API.
2. `file-tail`: watch a known JSONL/log file if Codex can write one.
3. `thread-api`: use direct Codex thread/progress API only if confirmed available.
4. `ui-observer`: OCR/browser automation fallback; avoid as primary path.

Current capture findings are in `docs/CODEX_PROGRESS_CAPTURE.md`.
