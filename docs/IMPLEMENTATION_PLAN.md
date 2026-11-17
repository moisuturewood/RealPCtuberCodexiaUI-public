# MVP Implementation Plan

## Shape

- `pnpm` owns the TypeScript local server and browser UI.
- `uv` runs the Python VOICEVOX Core worker.
- `pixi` only orchestrates tasks.
- Avatar bridge and rendered PSD outputs are provided separately through `VOICEVOX_AVATAR_BRIDGE_ROOT`.

## MVP Flow

```text
POST /api/events
  -> validate progress event
  -> rule-based analysis
  -> append data/analysis/events.jsonl
  -> broadcast WebSocket snapshot
  -> serialize speech queue
  -> synthesize WAV with 四国めたん styleId=2
  -> PlaySync WAV
  -> UI mouth animation while speaking
```

## Current Boundaries

- PSD layers are not expanded into all combinations.
- Analysis is deterministic rules first; Spark/small-model selection is a later adapter.
- Codex App progress capture starts with cooperative `POST /api/events` until a stable direct progress API is confirmed.
