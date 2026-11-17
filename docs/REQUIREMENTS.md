# Requirements

## Product

RealPCtuber Codexia UI is a local Windows companion UI for Codexia work logs.
It turns progress text into synchronized subtitles, VOICEVOX speech, Shikoku Metan avatar expressions, and lightweight gestures.

## Primary Use Case

Codexia plays Elin and emits progress logs.
Metan reads those logs aloud, shows them as subtitles, and reacts with expressions.

## Non-Goals For MVP

- Do not build a marketing page.
- Do not require cloud services.
- Do not rely on fragile OCR as the main integration path.
- Do not pre-render every PSD layer combination.
- Do not block the main Codex task while audio/avatar work runs.

## MVP Features

- Local HTTP event ingestion.
- WebSocket UI updates.
- Event history and speech queue.
- VOICEVOX synthesis for Shikoku Metan normal voice, `styleId=2`.
- PSD-based avatar mouth sync.
- Emotion/action analysis record saved as JSONL.
- Codex progress capture feasibility report.

## Later Features

- More Metan voice styles.
- Amehare Hau second commentator mode.
- Gesture presets and partial body motion.
- Audio-volume-based mouth sync.
- Small emotion classifier or LoRA-trained selector.
- Direct Codex thread adapter if an API becomes available.
