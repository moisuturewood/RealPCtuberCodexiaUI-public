# RealPCtuber Codexia UI

A Windows desktop app that reads Codex progress aloud with VOICEVOX:四国めたん and synchronizes captions, facial expressions, and a 2D avatar.

## Features

- Watches one selected local Codex conversation and reads new commentary as it arrives.
- Uses VOICEVOX Core for sentence-based audio synthesis and serial WAV playback.
- Shows a floating avatar and captions with lip-sync, blink, and expression frames.
- Saves thread profiles locally and supports CPU or GPU inference selection.

## Requirements

- Windows 10 or later
- Node.js and pnpm
- Python 3.11+ and uv
- pixi
- A separately installed VOICEVOX Core package, voice model, and Open JTalk dictionary
- The separately obtained avatar bridge and its licensed source assets

This repository does not include VOICEVOX Core binaries, voice models, Open JTalk dictionaries, PSD files, or rendered avatar images.

## Configure local assets

Set these environment variables to paths on your machine before launching the app:

```powershell
$env:VOICEVOX_CORE_ROOT = "C:\path\to\VoicevoxCore"
$env:OPENJTALK_ROOT = "C:\path\to\OpenJTalkDic"
$env:VOICEVOX_AVATAR_BRIDGE_ROOT = "C:\path\to\voicevox-avatar-bridge"
```

The avatar bridge must provide the original licensed PSD assets and rendered frames expected by the app. Obtain those assets from their creators and follow their terms; this project does not redistribute them. An optional mobile voice-export bridge can be configured with `CODEXIA_THREAD_BRIDGE_CONFIG`.

## Run

```powershell
pnpm install
pixi run dev
```

The Electron app uses local IPC for its main UI and floating windows. The legacy HTTP server is available for browser testing with `pixi run server`.

## Development checks

```powershell
pnpm check
pnpm electron:build
pnpm test:optimization
pnpm test:renderers
uv run python -m unittest discover -s tests -p test_wav_volume.py
```

## Credits and third-party terms

- Voice credit: `VOICEVOX:四国めたん`. The app displays this credit in its main UI. Voice and character artwork have separate terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- The application source code is licensed under MIT. That license does not cover third-party voices, models, PSDs, or images.
