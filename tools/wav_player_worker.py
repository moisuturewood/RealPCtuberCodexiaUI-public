from __future__ import annotations

import ctypes
import audioop
from ctypes import wintypes
import json
from pathlib import Path
import sys
import threading
import wave


CALLBACK_EVENT = 0x00050000
INFINITE = 0xFFFFFFFF
MMSYSERR_NOERROR = 0
WAIT_OBJECT_0 = 0
WAVE_FORMAT_PCM = 1
WAVE_MAPPER = 0xFFFFFFFF
WHDR_DONE = 0x00000001

DWORD_PTR = ctypes.c_size_t
HWAVEOUT = wintypes.HANDLE


class WAVEFORMATEX(ctypes.Structure):
    _fields_ = [
        ("wFormatTag", wintypes.WORD),
        ("nChannels", wintypes.WORD),
        ("nSamplesPerSec", wintypes.DWORD),
        ("nAvgBytesPerSec", wintypes.DWORD),
        ("nBlockAlign", wintypes.WORD),
        ("wBitsPerSample", wintypes.WORD),
        ("cbSize", wintypes.WORD),
    ]


class WAVEHDR(ctypes.Structure):
    _fields_ = [
        ("lpData", ctypes.c_void_p),
        ("dwBufferLength", wintypes.DWORD),
        ("dwBytesRecorded", wintypes.DWORD),
        ("dwUser", DWORD_PTR),
        ("dwFlags", wintypes.DWORD),
        ("dwLoops", wintypes.DWORD),
        ("lpNext", ctypes.c_void_p),
        ("reserved", DWORD_PTR),
    ]


kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
winmm = ctypes.WinDLL("winmm")

kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL
kernel32.CreateEventW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
kernel32.CreateEventW.restype = wintypes.HANDLE
kernel32.ResetEvent.argtypes = [wintypes.HANDLE]
kernel32.ResetEvent.restype = wintypes.BOOL
kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
kernel32.WaitForSingleObject.restype = wintypes.DWORD

winmm.waveOutClose.argtypes = [HWAVEOUT]
winmm.waveOutClose.restype = wintypes.UINT
winmm.waveOutGetErrorTextW.argtypes = [wintypes.UINT, wintypes.LPWSTR, wintypes.UINT]
winmm.waveOutGetErrorTextW.restype = wintypes.UINT
winmm.waveOutOpen.argtypes = [
    ctypes.POINTER(HWAVEOUT),
    wintypes.UINT,
    ctypes.POINTER(WAVEFORMATEX),
    DWORD_PTR,
    DWORD_PTR,
    wintypes.DWORD,
]
winmm.waveOutOpen.restype = wintypes.UINT
winmm.waveOutPrepareHeader.argtypes = [HWAVEOUT, ctypes.POINTER(WAVEHDR), wintypes.UINT]
winmm.waveOutPrepareHeader.restype = wintypes.UINT
winmm.waveOutReset.argtypes = [HWAVEOUT]
winmm.waveOutReset.restype = wintypes.UINT
winmm.waveOutUnprepareHeader.argtypes = [HWAVEOUT, ctypes.POINTER(WAVEHDR), wintypes.UINT]
winmm.waveOutUnprepareHeader.restype = wintypes.UINT
winmm.waveOutWrite.argtypes = [HWAVEOUT, ctypes.POINTER(WAVEHDR), wintypes.UINT]
winmm.waveOutWrite.restype = wintypes.UINT


emit_lock = threading.Lock()


def emit(payload: dict) -> None:
    with emit_lock:
        print(json.dumps(payload, ensure_ascii=False), flush=True)


def mm_error_text(code: int) -> str:
    buffer = ctypes.create_unicode_buffer(256)
    if winmm.waveOutGetErrorTextW(code, buffer, len(buffer)) == MMSYSERR_NOERROR:
        return buffer.value
    return f"MMRESULT {code}"


def require_mm_success(code: int, operation: str) -> None:
    if code != MMSYSERR_NOERROR:
        raise RuntimeError(f"{operation} failed: {mm_error_text(code)}")


def read_pcm_wav(path: Path) -> tuple[WAVEFORMATEX, bytes]:
    with wave.open(str(path), "rb") as wav_file:
        if wav_file.getcomptype() != "NONE":
            raise ValueError(f"Compressed WAV is not supported: {wav_file.getcomptype()}")
        channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        sample_rate = wav_file.getframerate()
        frame_count = wav_file.getnframes()
        frames = wav_file.readframes(frame_count)
    if channels < 1 or channels > 2:
        raise ValueError(f"Unsupported channel count: {channels}")
    if sample_width not in {1, 2, 3, 4}:
        raise ValueError(f"Unsupported sample width: {sample_width}")
    if not frames:
        raise ValueError("WAV contains no audio frames")
    block_align = channels * sample_width
    wave_format = WAVEFORMATEX(
        WAVE_FORMAT_PCM,
        channels,
        sample_rate,
        sample_rate * block_align,
        block_align,
        sample_width * 8,
        0,
    )
    return wave_format, frames


def scale_pcm(frames: bytes, sample_width: int, volume: int) -> bytes:
    if volume == 100:
        return frames
    if sample_width == 1:
        return audioop.bias(audioop.mul(audioop.bias(frames, 1, -128), 1, volume / 100), 1, 128)
    return audioop.mul(frames, sample_width, volume / 100)


class WaveOutPlayer:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._playback_id = ""
        self._stop_event: threading.Event | None = None
        self._wave_handle: HWAVEOUT | None = None
        self._event_handle = None
        self._format_key: tuple[int, int, int] | None = None
        self._volume = 100

    def set_volume(self, volume: int) -> None:
        if not isinstance(volume, int) or isinstance(volume, bool) or not 0 <= volume <= 100:
            raise ValueError("volume must be an integer from 0 to 100")
        with self._lock:
            self._volume = volume

    def warmup(self) -> None:
        block_align = 2
        wave_format = WAVEFORMATEX(
            WAVE_FORMAT_PCM,
            1,
            24000,
            24000 * block_align,
            block_align,
            16,
            0,
        )
        with self._lock:
            self._ensure_device_locked(wave_format)

    def close(self) -> None:
        self.stop()
        with self._lock:
            self._close_device_locked()

    def refresh(self) -> str:
        stopped_id = self.stop()
        with self._lock:
            self._close_device_locked()
        self.warmup()
        return stopped_id

    def play(self, playback_id: str, wav_path: Path) -> str:
        stopped_id = self.stop()
        stop_event = threading.Event()
        thread = threading.Thread(
            target=self._play,
            args=(playback_id, wav_path, stop_event),
            name=f"codexia-wav-{playback_id}",
            daemon=True,
        )
        with self._lock:
            self._playback_id = playback_id
            self._stop_event = stop_event
            self._thread = thread
        thread.start()
        return stopped_id

    def stop(self) -> str:
        with self._lock:
            thread = self._thread
            playback_id = self._playback_id
            stop_event = self._stop_event
            wave_handle = self._wave_handle
            if not thread:
                return ""
            if stop_event:
                stop_event.set()
            reset_result = winmm.waveOutReset(wave_handle) if wave_handle else MMSYSERR_NOERROR
        thread.join(timeout=5)
        if thread.is_alive():
            raise RuntimeError(f"Timed out while stopping WAV playback: {playback_id}")
        require_mm_success(reset_result, "waveOutReset")
        return playback_id

    def _play(self, playback_id: str, wav_path: Path, stop_event: threading.Event) -> None:
        current_thread = threading.current_thread()
        header = WAVEHDR()
        header_prepared = False
        outcome: dict | None = None
        try:
            wave_format, frames = read_pcm_wav(wav_path)
            with self._lock:
                volume = self._volume
            frames = scale_pcm(frames, int(wave_format.wBitsPerSample) // 8, volume)
            audio_buffer = ctypes.create_string_buffer(frames, len(frames))
            header.lpData = ctypes.cast(audio_buffer, ctypes.c_void_p)
            header.dwBufferLength = len(frames)

            with self._lock:
                if self._thread is not current_thread or stop_event.is_set():
                    return
                self._ensure_device_locked(wave_format)
                wave_handle = self._wave_handle
                event_handle = self._event_handle
                if not wave_handle or not event_handle:
                    raise RuntimeError("WAV output device is not available")
                require_mm_success(
                    winmm.waveOutPrepareHeader(wave_handle, ctypes.byref(header), ctypes.sizeof(header)),
                    "waveOutPrepareHeader",
                )
                header_prepared = True
                if not kernel32.ResetEvent(event_handle):
                    raise ctypes.WinError(ctypes.get_last_error())
                require_mm_success(
                    winmm.waveOutWrite(wave_handle, ctypes.byref(header), ctypes.sizeof(header)),
                    "waveOutWrite",
                )
            emit({"type": "started", "id": playback_id, "ok": True})

            while not (header.dwFlags & WHDR_DONE):
                wait_result = kernel32.WaitForSingleObject(event_handle, INFINITE)
                if wait_result != WAIT_OBJECT_0:
                    raise RuntimeError(f"WaitForSingleObject failed: {wait_result}")
            if not stop_event.is_set():
                outcome = {"type": "finished", "id": playback_id, "ok": True}
        except Exception as error:
            if not stop_event.is_set():
                outcome = {
                    "type": "error",
                    "id": playback_id,
                    "ok": False,
                    "error": str(error),
                }
        finally:
            with self._lock:
                wave_handle = self._wave_handle
                if wave_handle and header_prepared:
                    if not (header.dwFlags & WHDR_DONE):
                        winmm.waveOutReset(wave_handle)
                    winmm.waveOutUnprepareHeader(wave_handle, ctypes.byref(header), ctypes.sizeof(header))
                if self._thread is current_thread:
                    self._thread = None
                    self._playback_id = ""
                    self._stop_event = None
        if outcome:
            emit(outcome)

    def _ensure_device_locked(self, wave_format: WAVEFORMATEX) -> None:
        format_key = (
            int(wave_format.nChannels),
            int(wave_format.nSamplesPerSec),
            int(wave_format.wBitsPerSample),
        )
        if self._wave_handle and self._event_handle and self._format_key == format_key:
            return
        self._close_device_locked()
        event_handle = kernel32.CreateEventW(None, False, False, None)
        if not event_handle:
            raise ctypes.WinError(ctypes.get_last_error())
        wave_handle = HWAVEOUT()
        try:
            require_mm_success(
                winmm.waveOutOpen(
                    ctypes.byref(wave_handle),
                    WAVE_MAPPER,
                    ctypes.byref(wave_format),
                    DWORD_PTR(event_handle),
                    DWORD_PTR(0),
                    CALLBACK_EVENT,
                ),
                "waveOutOpen",
            )
        except Exception:
            if wave_handle:
                winmm.waveOutClose(wave_handle)
            kernel32.CloseHandle(event_handle)
            raise
        self._wave_handle = wave_handle
        self._event_handle = event_handle
        self._format_key = format_key

    def _close_device_locked(self) -> None:
        wave_handle = self._wave_handle
        event_handle = self._event_handle
        self._wave_handle = None
        self._event_handle = None
        self._format_key = None
        try:
            if wave_handle:
                require_mm_success(winmm.waveOutClose(wave_handle), "waveOutClose")
        finally:
            if event_handle:
                kernel32.CloseHandle(event_handle)


def main() -> int:
    player = WaveOutPlayer()
    player.warmup()
    emit({"type": "ready", "ok": True})
    try:
        for raw_line in sys.stdin:
            line = raw_line.strip()
            if not line:
                continue
            command: dict = {}
            try:
                command = json.loads(line)
                command_type = str(command.get("type") or "")
                command_id = str(command.get("id") or "")
                if command_type == "shutdown":
                    return 0
                if command_type == "volume":
                    player.set_volume(command.get("volume"))
                    emit({"type": "volume", "id": command_id, "ok": True})
                    continue
                if command_type == "stop":
                    stopped_id = player.stop()
                    emit({"type": "stopped", "id": stopped_id or command_id, "ok": True})
                    continue
                if command_type == "refresh":
                    if not command_id:
                        raise ValueError("id is required")
                    stopped_id = player.refresh()
                    if stopped_id:
                        emit({"type": "stopped", "id": stopped_id, "ok": True})
                    emit({"type": "refreshed", "id": command_id, "ok": True})
                    continue
                if command_type != "play":
                    raise ValueError(f"Unknown command type: {command_type}")
                if not command_id:
                    raise ValueError("id is required")

                wav_path = Path(str(command.get("path") or "")).resolve()
                if not wav_path.is_file():
                    raise FileNotFoundError(wav_path)
                stopped_id = player.play(command_id, wav_path)
                if stopped_id:
                    emit({"type": "stopped", "id": stopped_id, "ok": True})
            except Exception as error:
                emit(
                    {
                        "type": "error",
                        "id": str(command.get("id") or "") if isinstance(command, dict) else "",
                        "ok": False,
                        "error": str(error),
                    }
                )
    finally:
        player.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
