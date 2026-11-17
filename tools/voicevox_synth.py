from __future__ import annotations

import argparse
import ctypes
import io
import json
import os
from pathlib import Path
import sys
import time
import wave
import zipfile
from array import array


VOICEVOX_RESULT_OK = 0
ACCELERATION = {"auto": 0, "cpu": 1, "gpu": 2}
SYNTHESIS_MODES = ("audio-query", "tts")


class VoicevoxLoadOnnxruntimeOptions(ctypes.Structure):
    _fields_ = [("filename", ctypes.c_char_p)]


class VoicevoxInitializeOptions(ctypes.Structure):
    _fields_ = [("acceleration_mode", ctypes.c_int32), ("cpu_num_threads", ctypes.c_uint16)]


class VoicevoxTtsOptions(ctypes.Structure):
    _fields_ = [("enable_interrogative_upspeak", ctypes.c_bool)]


class VoicevoxSynthesisOptions(ctypes.Structure):
    _fields_ = [("enable_interrogative_upspeak", ctypes.c_bool)]


class VoicevoxRuntime:
    def __init__(self, core_root: Path, open_jtalk_root: Path, acceleration: str) -> None:
        self.core_root = core_root
        self.open_jtalk_root = open_jtalk_root
        self.acceleration = acceleration
        self._dll_dirs: list[object] = []
        self._onnxruntime = ctypes.c_void_p()
        self._open_jtalk = ctypes.c_void_p()
        self._synthesizer = ctypes.c_void_p()

        self._prepare_dll_search()
        self.core = ctypes.CDLL(str(self.core_root / "bin" / "voicevox_core.dll"))
        self._bind_api()

    def _prepare_dll_search(self) -> None:
        for candidate in [
            self.core_root / "bin",
            self.core_root / "additional_libraries",
            self.core_root / "onnxruntime" / "lib",
            self.core_root / "c_api" / "lib",
        ]:
            if candidate.exists() and hasattr(os, "add_dll_directory"):
                self._dll_dirs.append(os.add_dll_directory(str(candidate)))

    def _bind_api(self) -> None:
        self.core.voicevox_make_default_load_onnxruntime_options.restype = VoicevoxLoadOnnxruntimeOptions
        self.core.voicevox_onnxruntime_load_once.argtypes = [
            VoicevoxLoadOnnxruntimeOptions,
            ctypes.POINTER(ctypes.c_void_p),
        ]
        self.core.voicevox_onnxruntime_load_once.restype = ctypes.c_int32
        self.core.voicevox_open_jtalk_rc_new.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
        self.core.voicevox_open_jtalk_rc_new.restype = ctypes.c_int32
        self.core.voicevox_open_jtalk_rc_delete.argtypes = [ctypes.c_void_p]
        self.core.voicevox_open_jtalk_rc_delete.restype = None
        self.core.voicevox_make_default_initialize_options.restype = VoicevoxInitializeOptions
        self.core.voicevox_synthesizer_new.argtypes = [
            ctypes.c_void_p,
            ctypes.c_void_p,
            VoicevoxInitializeOptions,
            ctypes.POINTER(ctypes.c_void_p),
        ]
        self.core.voicevox_synthesizer_new.restype = ctypes.c_int32
        self.core.voicevox_synthesizer_delete.argtypes = [ctypes.c_void_p]
        self.core.voicevox_synthesizer_delete.restype = None
        self.core.voicevox_voice_model_file_open.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
        self.core.voicevox_voice_model_file_open.restype = ctypes.c_int32
        self.core.voicevox_voice_model_file_delete.argtypes = [ctypes.c_void_p]
        self.core.voicevox_voice_model_file_delete.restype = None
        self.core.voicevox_synthesizer_load_voice_model.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        self.core.voicevox_synthesizer_load_voice_model.restype = ctypes.c_int32
        self.core.voicevox_make_default_tts_options.restype = VoicevoxTtsOptions
        self.core.voicevox_make_default_synthesis_options.restype = VoicevoxSynthesisOptions
        self.core.voicevox_synthesizer_create_accent_phrases.argtypes = [
            ctypes.c_void_p,
            ctypes.c_char_p,
            ctypes.c_uint32,
            ctypes.POINTER(ctypes.c_char_p),
        ]
        self.core.voicevox_synthesizer_create_accent_phrases.restype = ctypes.c_int32
        self.core.voicevox_audio_query_create_from_accent_phrases.argtypes = [
            ctypes.c_char_p,
            ctypes.POINTER(ctypes.c_char_p),
        ]
        self.core.voicevox_audio_query_create_from_accent_phrases.restype = ctypes.c_int32
        self.core.voicevox_synthesizer_synthesis.argtypes = [
            ctypes.c_void_p,
            ctypes.c_char_p,
            ctypes.c_uint32,
            VoicevoxSynthesisOptions,
            ctypes.POINTER(ctypes.c_size_t),
            ctypes.POINTER(ctypes.POINTER(ctypes.c_uint8)),
        ]
        self.core.voicevox_synthesizer_synthesis.restype = ctypes.c_int32
        self.core.voicevox_synthesizer_tts.argtypes = [
            ctypes.c_void_p,
            ctypes.c_char_p,
            ctypes.c_uint32,
            VoicevoxTtsOptions,
            ctypes.POINTER(ctypes.c_size_t),
            ctypes.POINTER(ctypes.POINTER(ctypes.c_uint8)),
        ]
        self.core.voicevox_synthesizer_tts.restype = ctypes.c_int32
        self.core.voicevox_wav_free.argtypes = [ctypes.POINTER(ctypes.c_uint8)]
        self.core.voicevox_wav_free.restype = None
        self.core.voicevox_json_free.argtypes = [ctypes.c_char_p]
        self.core.voicevox_json_free.restype = None
        self.core.voicevox_error_result_to_message.argtypes = [ctypes.c_int32]
        self.core.voicevox_error_result_to_message.restype = ctypes.c_char_p

    def initialize(self) -> None:
        onnx_path = self.core_root / "bin" / "voicevox_onnxruntime.dll"
        options = self.core.voicevox_make_default_load_onnxruntime_options()
        onnx_path_bytes = str(onnx_path).encode("utf-8")
        options.filename = onnx_path_bytes
        self._ensure_ok(
            self.core.voicevox_onnxruntime_load_once(options, ctypes.byref(self._onnxruntime)),
            "voicevox_onnxruntime_load_once",
        )

        dict_path = resolve_open_jtalk_dict(self.open_jtalk_root)
        self._ensure_ok(
            self.core.voicevox_open_jtalk_rc_new(str(dict_path).encode("utf-8"), ctypes.byref(self._open_jtalk)),
            f"voicevox_open_jtalk_rc_new({dict_path})",
        )

        init_options = self.core.voicevox_make_default_initialize_options()
        init_options.acceleration_mode = ACCELERATION[self.acceleration]
        init_options.cpu_num_threads = max(1, min((os.cpu_count() or 2) - 1, 65535))
        self._ensure_ok(
            self.core.voicevox_synthesizer_new(
                self._onnxruntime,
                self._open_jtalk,
                init_options,
                ctypes.byref(self._synthesizer),
            ),
            "voicevox_synthesizer_new",
        )

    def load_model(self, model_path: Path) -> None:
        model = ctypes.c_void_p()
        try:
            self._ensure_ok(
                self.core.voicevox_voice_model_file_open(str(model_path).encode("utf-8"), ctypes.byref(model)),
                f"voicevox_voice_model_file_open({model_path.name})",
            )
            self._ensure_ok(
                self.core.voicevox_synthesizer_load_voice_model(self._synthesizer, model),
                f"voicevox_synthesizer_load_voice_model({model_path.name})",
            )
        finally:
            if model:
                self.core.voicevox_voice_model_file_delete(model)

    def synthesize(self, text: str, style_id: int, mode: str = "audio-query") -> bytes:
        if mode == "tts":
            return self.synthesize_tts(text, style_id)
        if mode == "audio-query":
            return self.synthesize_from_audio_query(text, style_id)
        raise ValueError(f"Unknown synthesis mode: {mode}")

    def synthesize_tts(self, text: str, style_id: int) -> bytes:
        output_length = ctypes.c_size_t()
        output_wav = ctypes.POINTER(ctypes.c_uint8)()
        options = self.core.voicevox_make_default_tts_options()
        options.enable_interrogative_upspeak = True
        try:
            self._ensure_ok(
                self.core.voicevox_synthesizer_tts(
                    self._synthesizer,
                    text.encode("utf-8"),
                    style_id,
                    options,
                    ctypes.byref(output_length),
                    ctypes.byref(output_wav),
                ),
                f"voicevox_synthesizer_tts(style={style_id})",
            )
            return ctypes.string_at(output_wav, output_length.value)
        finally:
            if output_wav:
                self.core.voicevox_wav_free(output_wav)

    def synthesize_from_audio_query(self, text: str, style_id: int) -> bytes:
        accent_phrases_json = ctypes.c_char_p()
        audio_query_json = ctypes.c_char_p()
        try:
            self._ensure_ok(
                self.core.voicevox_synthesizer_create_accent_phrases(
                    self._synthesizer,
                    text.encode("utf-8"),
                    style_id,
                    ctypes.byref(accent_phrases_json),
                ),
                f"voicevox_synthesizer_create_accent_phrases(style={style_id})",
            )
            self._ensure_ok(
                self.core.voicevox_audio_query_create_from_accent_phrases(
                    accent_phrases_json,
                    ctypes.byref(audio_query_json),
                ),
                "voicevox_audio_query_create_from_accent_phrases",
            )
            return self.synthesize_audio_query_json(audio_query_json, style_id)
        finally:
            if audio_query_json:
                self.core.voicevox_json_free(audio_query_json)
            if accent_phrases_json:
                self.core.voicevox_json_free(accent_phrases_json)

    def synthesize_audio_query_json(self, audio_query_json: ctypes.c_char_p, style_id: int) -> bytes:
        output_length = ctypes.c_size_t()
        output_wav = ctypes.POINTER(ctypes.c_uint8)()
        options = self.core.voicevox_make_default_synthesis_options()
        options.enable_interrogative_upspeak = True
        try:
            self._ensure_ok(
                self.core.voicevox_synthesizer_synthesis(
                    self._synthesizer,
                    audio_query_json,
                    style_id,
                    options,
                    ctypes.byref(output_length),
                    ctypes.byref(output_wav),
                ),
                f"voicevox_synthesizer_synthesis(style={style_id})",
            )
            return ctypes.string_at(output_wav, output_length.value)
        finally:
            if output_wav:
                self.core.voicevox_wav_free(output_wav)

    def close(self) -> None:
        if self._synthesizer:
            self.core.voicevox_synthesizer_delete(self._synthesizer)
            self._synthesizer = ctypes.c_void_p()
        if self._open_jtalk:
            self.core.voicevox_open_jtalk_rc_delete(self._open_jtalk)
            self._open_jtalk = ctypes.c_void_p()

    def _ensure_ok(self, result: int, operation: str) -> None:
        if result == VOICEVOX_RESULT_OK:
            return
        message_ptr = self.core.voicevox_error_result_to_message(result)
        detail = message_ptr.decode("utf-8", errors="replace") if message_ptr else ""
        raise RuntimeError(f"{operation} failed with code {result}: {detail}")


def resolve_open_jtalk_dict(root: Path) -> Path:
    if (root / "char.bin").exists():
        return root
    for child in sorted(root.iterdir()):
        if child.is_dir() and (child / "char.bin").exists():
            return child
    raise FileNotFoundError(f"OpenJTalk char.bin was not found under {root}")


def find_model_for_style(core_root: Path, style_id: int) -> tuple[Path, str, str]:
    model_root = core_root / "models" / "vvms"
    for model_path in sorted(model_root.glob("*.vvm")):
        try:
            payload = read_metas(model_path)
        except Exception:
            continue
        speakers = payload.get("speakers", []) if isinstance(payload, dict) else payload
        if not isinstance(speakers, list):
            continue
        for speaker in speakers:
            if not isinstance(speaker, dict):
                continue
            for style in speaker.get("styles", []):
                if isinstance(style, dict) and int(style.get("id", -1)) == style_id:
                    return model_path, str(speaker.get("name") or ""), str(style.get("name") or "")
    raise FileNotFoundError(f"VOICEVOX styleId={style_id} was not found in {model_root}")


def read_metas(model_path: Path) -> object:
    with zipfile.ZipFile(model_path) as archive:
        for name in archive.namelist():
            if name.endswith("metas.json"):
                return json.loads(archive.read(name).decode("utf-8"))
    raise KeyError(f"metas.json was not found in {model_path}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Synthesize a WAV file with local VOICEVOX Core.")
    parser.add_argument("--text", required=True)
    parser.add_argument("--style-id", type=int, default=2)
    parser.add_argument("--output", required=True, type=Path)
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
    parser.add_argument("--acceleration", choices=sorted(ACCELERATION), default="auto")
    parser.add_argument("--speed-factor", type=float, default=1.0)
    parser.add_argument("--mouth-profile", choices=["neutral", "expressive", "negative"], default="neutral")
    parser.add_argument(
        "--synthesis-mode",
        choices=SYNTHESIS_MODES,
        default=os.environ.get("VOICEVOX_SYNTHESIS_MODE", "audio-query"),
    )
    parser.add_argument("--benchmark-runs", type=int, default=0)
    parser.add_argument("--json", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        model_path, speaker_name, style_name = find_model_for_style(args.core_root, args.style_id)
        runtime = VoicevoxRuntime(args.core_root, args.open_jtalk_root, args.acceleration)
        try:
            runtime.initialize()
            runtime.load_model(model_path)
            benchmark = benchmark_synthesis(runtime, args.text, args.style_id, args.benchmark_runs)
            wav = runtime.synthesize(args.text, args.style_id, args.synthesis_mode)
        finally:
            runtime.close()
        wav = speed_up_wav(wav, args.speed_factor)
        duration_seconds = wav_duration_seconds(wav)
        lip_sync = build_lip_sync_timeline(wav, args.text, mouth_profile=args.mouth_profile)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(wav)
        emit(
            {
                "ok": True,
                "output": str(args.output),
                "bytes": len(wav),
                "durationSeconds": duration_seconds,
                "speedFactor": args.speed_factor,
                "mouthProfile": args.mouth_profile,
                "synthesisMode": args.synthesis_mode,
                "benchmark": benchmark,
                "lipSync": lip_sync,
                "styleId": args.style_id,
                "speaker": speaker_name,
                "style": style_name,
                "model": str(model_path),
            },
            args.json,
        )
        return 0
    except Exception as exc:
        emit({"ok": False, "error": str(exc)}, args.json)
        return 1


def benchmark_synthesis(
    runtime: VoicevoxRuntime,
    text: str,
    style_id: int,
    runs: int,
) -> dict[str, dict[str, float]] | None:
    if runs <= 0:
        return None
    results: dict[str, dict[str, float]] = {}
    for mode in SYNTHESIS_MODES:
        timings: list[float] = []
        runtime.synthesize(text, style_id, mode)
        for _ in range(runs):
            started = time.perf_counter()
            runtime.synthesize(text, style_id, mode)
            timings.append((time.perf_counter() - started) * 1000)
        results[mode] = {
            "runs": float(runs),
            "minMs": min(timings),
            "maxMs": max(timings),
            "avgMs": sum(timings) / len(timings),
        }
    return results


def speed_up_wav(wav_bytes: bytes, speed_factor: float) -> bytes:
    if speed_factor <= 1.0:
        return wav_bytes
    with wave.open(io.BytesIO(wav_bytes), "rb") as source:
        params = source.getparams()
        frames = source.readframes(source.getnframes())
    output = io.BytesIO()
    with wave.open(output, "wb") as target:
        target.setnchannels(params.nchannels)
        target.setsampwidth(params.sampwidth)
        target.setframerate(max(1, int(params.framerate * speed_factor)))
        target.writeframes(frames)
    return output.getvalue()


def wav_duration_seconds(wav_bytes: bytes) -> float:
    with wave.open(io.BytesIO(wav_bytes), "rb") as source:
        return source.getnframes() / float(source.getframerate())


def build_lip_sync_timeline(
    wav_bytes: bytes,
    text: str = "",
    frame_ms: int = 45,
    mouth_profile: str = "neutral",
) -> list[dict[str, int | str]]:
    with wave.open(io.BytesIO(wav_bytes), "rb") as source:
        channels = source.getnchannels()
        sample_width = source.getsampwidth()
        framerate = source.getframerate()
        frame_count = source.getnframes()
        frames = source.readframes(frame_count)

    if sample_width != 2 or framerate <= 0 or channels <= 0 or not frames:
        return []

    samples = array("h")
    samples.frombytes(frames)
    if sys.byteorder != "little":
        samples.byteswap()

    samples_per_window = max(1, int(framerate * frame_ms / 1000) * channels)
    windows: list[tuple[int, float]] = []
    max_rms = 1.0
    for start in range(0, len(samples), samples_per_window):
        chunk = samples[start : start + samples_per_window]
        if not chunk:
            continue
        rms = (sum(sample * sample for sample in chunk) / len(chunk)) ** 0.5
        max_rms = max(max_rms, rms)
        windows.append((start, rms))

    hints = build_mouth_hints(text)
    timeline: list[dict[str, int | str]] = []
    previous = ""
    last_change_ms = -999
    for window_index, (start, rms) in enumerate(windows):
        ratio = rms / max_rms
        hint = hints[min(len(hints) - 1, int(window_index / max(1, len(windows) - 1) * max(0, len(hints) - 1)))] if hints else None
        mouth = choose_mouth_frame(ratio, hint, window_index, mouth_profile)
        at_ms = round(start / channels / framerate * 1000)
        enough_hold = at_ms - last_change_ms >= 90
        if mouth != previous and (enough_hold or mouth == "closed" or previous == "closed"):
            timeline.append({"atMs": at_ms, "mouth": mouth})
            previous = mouth
            last_change_ms = at_ms

    if not timeline or timeline[0]["atMs"] != 0:
        timeline.insert(0, {"atMs": 0, "mouth": "closed"})
    return timeline


def build_mouth_hints(text: str) -> list[str]:
    hints: list[str] = []
    for char in text:
        if char in "、。,.!?！？… \t\r\n":
            hints.append("closed")
        elif char in "あかがさざただなはばぱまゃやらわぁアカガサザタダナハバパマャヤラワァ":
            hints.append("open")
        elif char in "いきぎしじちぢにひびぴみりぃイキギシジチヂニヒビピミリィ":
            hints.append("i")
        elif char in "うくぐすずつづぬふぶぷむゅゆるぅヴウクグスズツヅヌフブプムュユルゥ":
            hints.append("yu")
        elif char in "えけげせぜてでねへべぺめれぇエケゲセゼテデネヘベペメレェ":
            hints.append("ue")
        elif char in "おこごそぞとどのほぼぽもょよろをぉオコゴソゾトドノホボポモョヨロヲォ":
            hints.append("o")
        elif char in "んン":
            hints.append("small")
    return hints


def choose_mouth_frame(ratio: float, hint: str | None, index: int, mouth_profile: str = "neutral") -> str:
    if mouth_profile == "negative":
        return choose_negative_mouth_frame(ratio, hint, index)
    if mouth_profile == "expressive":
        return choose_expressive_mouth_frame(ratio, hint, index)
    return choose_neutral_mouth_frame(ratio, hint, index)


def choose_neutral_mouth_frame(ratio: float, hint: str | None, index: int) -> str:
    return choose_basic_mouth_frame(ratio, hint, index)


def choose_expressive_mouth_frame(ratio: float, hint: str | None, index: int) -> str:
    return choose_basic_mouth_frame(ratio, hint, index, openness_bias=0.06)


def choose_negative_mouth_frame(ratio: float, hint: str | None, index: int) -> str:
    return choose_basic_mouth_frame(ratio, hint, index, openness_bias=-0.02)


def choose_basic_mouth_frame(
    ratio: float,
    hint: str | None,
    index: int,
    openness_bias: float = 0.0,
) -> str:
    basic_hint = basic_neutral_mouth_hint(hint)
    if basic_hint == "closed" or ratio < 0.045:
        return "closed"
    effective = min(1.0, max(0.0, ratio + openness_bias))
    phase = (index // 2) % 4

    if effective < 0.18:
        return "v"
    if basic_hint == "o":
        return "o" if effective >= 0.26 or phase in {1, 2} else "v"
    if basic_hint == "open":
        if effective >= 0.62:
            return "open"
        if effective >= 0.34:
            return "o" if phase in {1, 2} else "v"
        return "v"
    if effective >= 0.78:
        return "open" if phase in {1, 2} else "o"
    if effective >= 0.42:
        return "o" if phase in {1, 2} else "v"
    return "v"


def neutral_hint(hint: str | None) -> str | None:
    if hint == "ue":
        return "i"
    if hint in {"open", "i", "yu", "o", "small", "mu"}:
        return hint
    return None


def basic_neutral_mouth_hint(hint: str | None) -> str:
    if hint == "closed":
        return "closed"
    if hint in {"o", "yu"}:
        return "o"
    if hint == "open":
        return "open"
    return "v"


def emit(payload: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        print(payload)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
