from __future__ import annotations

import argparse
from pathlib import Path
import sys
import winsound


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Play one WAV file in an isolated process.")
    parser.add_argument("wav", type=Path)
    args = parser.parse_args(argv)
    wav_path = args.wav.resolve()
    if not wav_path.is_file():
        raise FileNotFoundError(wav_path)

    print("ready", flush=True)
    winsound.PlaySound(str(wav_path), winsound.SND_FILENAME)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
