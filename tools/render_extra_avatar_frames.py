from __future__ import annotations

import argparse
import json

from voicevox_avatar_bridge.paths import load_defaults
from voicevox_avatar_bridge.render_assets import ensure_rendered_avatar_frames


METAN_MOUTH_LAYERS = {
    "mouth_momuu": "*もむー",
    "mouth_small": "*んー",
    "mouth_ue": "*うえー",
    "mouth_i": "*いー",
    "mouth_mu": "*む",
    "mouth_triangle": "*△",
    "mouth_yu": "*ゆ",
    "mouth_o": "*お",
    "mouth_perori": "*ぺろり",
    "mouth_niyari": "*にやり",
    "mouth_v": "*▽",
    "mouth_closed": "*ほほえみ",
    "mouth_open": "*わあー",
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Render extra avatar frames used by the UI server.")
    parser.add_argument("--character", choices=["metan"], default="metan")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--json", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    defaults = load_defaults()
    frame_config = {
        "margin": 12,
        "variants": {
            frame_name: [{"group": "!口", "layer": layer_name}]
            for frame_name, layer_name in METAN_MOUTH_LAYERS.items()
        },
    }
    paths = ensure_rendered_avatar_frames(
        args.character,
        defaults["assets"][args.character],
        frame_config=frame_config,
        force=args.force,
        strict=True,
    )
    payload = {
        "character": args.character,
        "frames": {
            frame_name: {"path": str(path), "bytes": path.stat().st_size}
            for frame_name, path in paths.items()
        },
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
