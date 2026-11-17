from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

from voicevox_synth import (
    ACCELERATION,
    SYNTHESIS_MODES,
    VoicevoxRuntime,
    build_lip_sync_timeline,
    find_model_for_style,
    speed_up_wav,
    wav_duration_seconds,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Persistent JSONL worker for local VOICEVOX Core synthesis.")
    parser.add_argument(
        "--core-root",
        type=Path,
        default=Path(os.environ.get("VOICEVOX_CORE_ROOT", Path.home() / "AppData/Local/VOICEVOX/Core")),
    )
    parser.add_argument(
        "--open-jtalk-root",
        type=Path,
        default=Path(os.environ.get("OPENJTALK_ROOT", Path.home() / "AppData/Local/VOICEVOX/OpenJTalkDic")),
    )
    parser.add_argument("--default-style-id", type=int, default=2)
    parser.add_argument("--acceleration", choices=sorted(ACCELERATION), default="auto")
    parser.add_argument("--synthesis-mode", choices=SYNTHESIS_MODES, default="audio-query")
    return parser


class Worker:
    def __init__(
        self,
        core_root: Path,
        open_jtalk_root: Path,
        acceleration: str,
        default_style_id: int,
        synthesis_mode: str,
    ) -> None:
        self.core_root = core_root
        self.open_jtalk_root = open_jtalk_root
        self.synthesis_mode = synthesis_mode
        self.runtime = VoicevoxRuntime(core_root, open_jtalk_root, acceleration)
        self.loaded_models: set[Path] = set()
        self.style_metadata: dict[int, tuple[Path, str, str]] = {}
        self.runtime.initialize()
        self.ensure_style_loaded(default_style_id)

    def ensure_style_loaded(self, style_id: int) -> tuple[Path, str, str]:
        if style_id in self.style_metadata:
            return self.style_metadata[style_id]
        model_path, speaker_name, style_name = find_model_for_style(self.core_root, style_id)
        if model_path not in self.loaded_models:
            self.runtime.load_model(model_path)
            self.loaded_models.add(model_path)
        metadata = (model_path, speaker_name, style_name)
        self.style_metadata[style_id] = metadata
        return metadata

    def synthesize(self, request: dict) -> dict:
        request_id = str(request.get("id") or "")
        text = str(request.get("text") or "")
        output = Path(str(request.get("output") or ""))
        style_id = int(request.get("styleId") or 2)
        speed_factor = float(request.get("speedFactor") or 1.0)
        frame_ms = int(request.get("lipSyncFrameMs") or 45)
        mouth_profile = str(request.get("mouthProfile") or "neutral")
        synthesis_mode = str(request.get("synthesisMode") or self.synthesis_mode)
        if synthesis_mode not in SYNTHESIS_MODES:
            raise ValueError(f"synthesisMode must be one of: {', '.join(SYNTHESIS_MODES)}")
        if not request_id:
            raise ValueError("id is required.")
        if not text:
            raise ValueError("text is required.")
        if not output:
            raise ValueError("output is required.")

        model_path, speaker_name, style_name = self.ensure_style_loaded(style_id)
        wav = self.runtime.synthesize(text, style_id, synthesis_mode)
        wav = speed_up_wav(wav, speed_factor)
        duration_seconds = wav_duration_seconds(wav)
        lip_sync = build_lip_sync_timeline(wav, text, frame_ms=frame_ms, mouth_profile=mouth_profile)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(wav)
        return {
            "id": request_id,
            "ok": True,
            "output": str(output),
            "bytes": len(wav),
            "durationSeconds": duration_seconds,
            "speedFactor": speed_factor,
            "synthesisMode": synthesis_mode,
            "mouthProfile": mouth_profile,
            "lipSync": lip_sync,
            "styleId": style_id,
            "speaker": speaker_name,
            "style": style_name,
            "model": str(model_path),
        }

    def close(self) -> None:
        self.runtime.close()


def write(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def start_wav_player(wav_path: Path) -> subprocess.Popen[str]:
    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    player_script = Path(__file__).with_name("wav_player.py")
    player = subprocess.Popen(
        [sys.executable, str(player_script), str(wav_path)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        creationflags=creation_flags,
    )
    ready = player.stdout.readline().strip() if player.stdout else ""
    if ready != "ready":
        _, stderr = player.communicate(timeout=2)
        raise RuntimeError(stderr.strip() or "WAV player failed before playback.")
    return player


def wait_for_wav_player(player: subprocess.Popen[str], duration_seconds: float) -> None:
    try:
        _, stderr = player.communicate(timeout=max(3.0, duration_seconds + 3.0))
    except subprocess.TimeoutExpired as exc:
        player.kill()
        player.communicate()
        raise RuntimeError("WAV playback timed out and was stopped.") from exc
    if player.returncode != 0:
        raise RuntimeError(stderr.strip() or f"WAV player exited with code {player.returncode}.")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    worker: Worker | None = None
    try:
        worker = Worker(args.core_root, args.open_jtalk_root, args.acceleration, args.default_style_id, args.synthesis_mode)
        write({
            "type": "ready",
            "ok": True,
            "defaultStyleId": args.default_style_id,
            "acceleration": args.acceleration,
            "synthesisMode": args.synthesis_mode,
        })
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
                if request.get("type") == "shutdown":
                    write({"type": "shutdown", "ok": True})
                    return 0
                result = worker.synthesize(request)
                if request.get("play"):
                    player = start_wav_player(Path(result["output"]))
                    write({"type": "playback_started", **result})
                    wait_for_wav_player(player, float(result.get("durationSeconds") or 0.05))
                    write({"type": "done", **result})
                else:
                    write(result)
            except Exception as exc:
                request_id = ""
                try:
                    request_id = str(request.get("id") or "")
                except Exception:
                    request_id = ""
                write({"id": request_id, "ok": False, "error": str(exc)})
    except Exception as exc:
        write({"type": "fatal", "ok": False, "error": str(exc)})
        return 1
    finally:
        if worker:
            worker.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
