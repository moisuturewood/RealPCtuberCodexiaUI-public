from __future__ import annotations

import argparse
import io
import json
import random
import time
import tkinter as tk
import tkinter.font as tkfont
from dataclasses import asdict, dataclass
from pathlib import Path
from tkinter import simpledialog
from urllib.error import URLError
from urllib.parse import urljoin
from urllib.request import urlopen

from PIL import Image, ImageDraw, ImageFont, ImageTk


PROJECT_ROOT = Path(__file__).resolve().parents[1]
STATE_PATH = PROJECT_ROOT / "config" / "floating-overlay-state.json"
SUBTITLE_BG = "#00ff7f"
SUBTITLE_TEXT_FILL = "#ee3f99"
SUBTITLE_TEXT_WHITE = "#ffffff"
SUBTITLE_TEXT_OUTER = "#df2f8d"
SUBTITLE_GRIP = SUBTITLE_BG
SUBTITLE_LAYOUT_VERSION = 5
SUBTITLE_DEFAULT_WIDTH = 1080
SUBTITLE_DEFAULT_HEIGHT = 260
SUBTITLE_DEFAULT_FONT_SIZE = 26
SUBTITLE_MIN_WIDTH = 260
SUBTITLE_MAX_WIDTH = 1800
SUBTITLE_MIN_HEIGHT = 130
SUBTITLE_MAX_HEIGHT = 520
SUBTITLE_WIDTH_STEP = 80
SUBTITLE_HEIGHT_STEP = 34
SUBTITLE_PADDING_X = 18
SUBTITLE_PADDING_Y = 24
FONT_PATH_CANDIDATES = [
    Path("C:/Windows/Fonts/HGRPP1.TTC"),
    Path("C:/Windows/Fonts/HGRSMP.TTF"),
    Path("C:/Windows/Fonts/UDDigiKyokashoN-B.ttc"),
    Path("C:/Windows/Fonts/YuGothB.ttc"),
    Path("C:/Windows/Fonts/meiryob.ttc"),
]
CUTE_FONT_CANDIDATES = [
    "HGP創英角ﾎﾟｯﾌﾟ体",
    "HG創英角ﾎﾟｯﾌﾟ体",
    "HG丸ｺﾞｼｯｸM-PRO",
    "UD デジタル 教科書体 NP",
    "Yu Gothic UI",
]


@dataclass
class OverlayState:
    avatar_x: int = 1040
    avatar_y: int = 100
    subtitle_x: int = 720
    subtitle_y: int = 760
    subtitle_width: int = SUBTITLE_DEFAULT_WIDTH
    subtitle_height: int = SUBTITLE_DEFAULT_HEIGHT
    subtitle_font_size: int = SUBTITLE_DEFAULT_FONT_SIZE
    subtitle_layout_version: int = SUBTITLE_LAYOUT_VERSION
    scale: float = 0.38
    topmost: bool = True
    subtitle_visible: bool = True


def load_state() -> OverlayState:
    if not STATE_PATH.exists():
        return OverlayState()
    data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    state = OverlayState()
    for key in asdict(state):
        if key in data:
            setattr(state, key, data[key])
    if data.get("subtitle_layout_version") != SUBTITLE_LAYOUT_VERSION:
        if state.subtitle_width <= 680:
            state.subtitle_width = SUBTITLE_DEFAULT_WIDTH
        state.subtitle_height = max(state.subtitle_height, SUBTITLE_DEFAULT_HEIGHT)
        state.subtitle_layout_version = SUBTITLE_LAYOUT_VERSION
    return state


def save_state(state: OverlayState) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(asdict(state), ensure_ascii=False, indent=2), encoding="utf-8")


class FloatingOverlay:
    def __init__(self, base_url: str, poll_ms: int) -> None:
        self.base_url = base_url.rstrip("/") + "/"
        self.poll_ms = max(100, poll_ms)
        self.transparent_color = "#00ff7f"
        self.state = load_state()
        self.snapshot: dict | None = None
        self.image_cache: dict[str, Image.Image] = {}
        self.current_url = ""
        self.current_scale = 0.0
        self.current_photo = None
        self.mouth_frame = "closed"
        self.blink_until = 0.0
        self.next_blink_at = time.monotonic() + random.uniform(2.0, 4.4)
        self.drag_start = None
        self.subtitle_drag_start = None
        self.subtitle_resize_start = None
        self.subtitle_text = "待機しています。"
        self.subtitle_photo = None
        self.subtitle_render_key = None
        self.overlay_visible = True

        self.root = tk.Tk()
        self.root.title("RealPCtuber Codexia Floating")
        self.root.overrideredirect(True)
        self.root.configure(bg=self.transparent_color)
        self.root.attributes("-transparentcolor", self.transparent_color)
        self.root.attributes("-topmost", self.state.topmost)

        self.canvas = tk.Canvas(self.root, bg=self.transparent_color, highlightthickness=0, bd=0)
        self.canvas.pack(fill="both", expand=True)
        self.canvas.bind("<ButtonPress-1>", self.start_drag)
        self.canvas.bind("<B1-Motion>", self.drag_avatar)
        self.canvas.bind("<ButtonRelease-1>", self.end_drag)
        self.canvas.bind("<MouseWheel>", self.scale_avatar)
        self.canvas.bind("<Button-3>", self.show_menu)

        self.subtitle = tk.Toplevel(self.root)
        self.subtitle.title("RealPCtuber Codexia Subtitle")
        self.subtitle.overrideredirect(True)
        self.subtitle.configure(bg=self.transparent_color)
        self.subtitle.attributes("-transparentcolor", self.transparent_color)
        self.subtitle.attributes("-topmost", self.state.topmost)
        self.subtitle.attributes("-alpha", 1.0)
        self.subtitle_font_family = pick_cute_font_family(self.root)
        self.subtitle_frame = tk.Frame(
            self.subtitle,
            bg=SUBTITLE_BG,
            highlightthickness=0,
            bd=0,
        )
        self.subtitle_frame.pack(fill="both", expand=True)
        self.subtitle_canvas = tk.Canvas(
            self.subtitle_frame,
            bg=SUBTITLE_BG,
            highlightthickness=0,
            bd=0,
            cursor="hand2",
        )
        self.subtitle_canvas.pack(fill="both", expand=True)
        self.resize_right = tk.Frame(self.subtitle_frame, bg=SUBTITLE_GRIP, width=5, cursor="size_we")
        self.resize_bottom = tk.Frame(self.subtitle_frame, bg=SUBTITLE_GRIP, height=5, cursor="size_ns")
        self.resize_corner = tk.Frame(self.subtitle_frame, bg=SUBTITLE_GRIP, width=18, height=18, cursor="size_nw_se")
        self.resize_right.place(relx=1.0, rely=0.0, relheight=1.0, anchor="ne")
        self.resize_bottom.place(relx=0.0, rely=1.0, relwidth=1.0, anchor="sw")
        self.resize_corner.place(relx=1.0, rely=1.0, anchor="se")
        self.subtitle_canvas.bind("<ButtonPress-1>", self.start_subtitle_drag)
        self.subtitle_canvas.bind("<B1-Motion>", self.drag_subtitle)
        self.subtitle_canvas.bind("<ButtonRelease-1>", self.end_drag)
        self.subtitle_canvas.bind("<Button-3>", self.show_subtitle_menu)
        self.subtitle_canvas.bind("<MouseWheel>", self.handle_subtitle_mousewheel)
        self.subtitle_frame.bind("<Button-3>", self.show_subtitle_menu)
        self.bind_subtitle_resize(self.resize_right, "e")
        self.bind_subtitle_resize(self.resize_bottom, "s")
        self.bind_subtitle_resize(self.resize_corner, "se")

        self.root.protocol("WM_DELETE_WINDOW", self.exit)
        self.apply_geometry()
        self.apply_subtitle_style()
        self.apply_subtitle_visibility()

    def run(self) -> None:
        self.poll_server()
        self.tick_avatar()
        self.root.mainloop()

    def poll_server(self) -> None:
        try:
            with urlopen(urljoin(self.base_url, "api/overlay-state?client=floating-overlay"), timeout=2.0) as response:
                self.snapshot = json.loads(response.read().decode("utf-8"))
                self.apply_server_visibility()
                self.set_subtitle_text(str(self.snapshot.get("text") or "待機しています。"))
        except (OSError, URLError, json.JSONDecodeError) as exc:
            self.set_subtitle_text(f"接続待機中: {exc}")
        self.root.after(self.poll_ms, self.poll_server)

    def apply_server_visibility(self) -> None:
        overlay = (self.snapshot or {}).get("overlay") or {}
        desired_visible = bool(overlay.get("desiredVisible", True))
        if desired_visible == self.overlay_visible:
            return
        self.overlay_visible = desired_visible
        if self.overlay_visible:
            self.root.deiconify()
        else:
            self.root.withdraw()
        self.apply_subtitle_visibility()

    def tick_avatar(self) -> None:
        now = time.monotonic()
        if now >= self.next_blink_at:
            self.blink_until = now + 0.16
            self.next_blink_at = now + random.uniform(2.2, 5.0)
        self.mouth_frame = self.resolve_mouth_frame()
        self.redraw_avatar()
        self.root.after(45, self.tick_avatar)

    def resolve_mouth_frame(self) -> str:
        if not self.is_speech_active():
            return "closed"
        speech = (self.snapshot or {}).get("currentSpeech") or {}
        lip_sync = speech.get("lipSync")
        started_at = parse_iso_ms(speech.get("startedAt"))
        if not started_at or not isinstance(lip_sync, list):
            return "open"
        lead_ms = int(((self.snapshot or {}).get("server") or {}).get("lipSyncLeadMs") or 60)
        elapsed_ms = max(0, int(time.time() * 1000) - started_at + lead_ms)
        frame = "closed"
        for item in lip_sync:
            if not isinstance(item, dict):
                continue
            at_ms = item.get("atMs")
            mouth = item.get("mouth")
            if not isinstance(at_ms, int) or not isinstance(mouth, str):
                continue
            if at_ms > elapsed_ms:
                break
            frame = mouth
        return frame

    def is_speech_active(self) -> bool:
        avatar = (self.snapshot or {}).get("avatar") or {}
        if not avatar.get("speaking"):
            return False
        speech = (self.snapshot or {}).get("currentSpeech") or {}
        end_ms = parse_iso_ms(speech.get("expectedEndedAt"))
        return end_ms is None or int(time.time() * 1000) <= end_ms + 80

    def current_avatar_url(self) -> str | None:
        frames = (self.snapshot or {}).get("avatarFrames") or {}
        speaking = self.is_speech_active()
        eye_frame = "blink" if time.monotonic() < self.blink_until else "normal"
        if speaking:
            mouth_eyes = frames.get("mouthEyes") or {}
            by_eye = mouth_eyes.get(self.mouth_frame) or {}
            return by_eye.get(eye_frame) or frames.get(self.mouth_frame) or frames.get("closed")
        mouth_eyes = frames.get("mouthEyes") or {}
        closed_eyes = mouth_eyes.get("closed") or {}
        if eye_frame == "blink":
            return closed_eyes.get("blink") or frames.get("blink") or frames.get("closed")
        return closed_eyes.get("normal") or frames.get("closed") or frames.get("idle")

    def redraw_avatar(self) -> None:
        url = self.current_avatar_url()
        if not url:
            return
        if url == self.current_url and self.state.scale == self.current_scale:
            return
        image = self.fetch_image(url)
        if image is None:
            return
        width = max(1, int(image.width * self.state.scale))
        height = max(1, int(image.height * self.state.scale))
        resized = image.resize((width, height), Image.Resampling.LANCZOS)
        display_image = self.chromakey_image(resized)
        self.current_photo = ImageTk.PhotoImage(display_image)
        self.canvas.configure(width=width, height=height)
        self.canvas.delete("all")
        self.canvas.create_image(0, 0, image=self.current_photo, anchor="nw")
        self.root.geometry(f"{width}x{height}+{self.state.avatar_x}+{self.state.avatar_y}")
        self.current_url = url
        self.current_scale = self.state.scale

    def fetch_image(self, relative_url: str) -> Image.Image | None:
        absolute_url = urljoin(self.base_url, relative_url.lstrip("/"))
        cached = self.image_cache.get(absolute_url)
        if cached is not None:
            return cached
        try:
            with urlopen(absolute_url, timeout=4.0) as response:
                image = Image.open(io.BytesIO(response.read())).convert("RGBA")
        except (OSError, URLError):
            return None
        self.image_cache[absolute_url] = image
        return image

    def chromakey_image(self, image: Image.Image) -> Image.Image:
        key = self.transparent_color.lstrip("#")
        key_rgb = tuple(int(key[index : index + 2], 16) for index in (0, 2, 4))
        rgba = image.convert("RGBA")
        alpha = rgba.getchannel("A")
        visible_mask = alpha.point(lambda value: 255 if value > 4 else 0)
        opaque = rgba.copy()
        opaque.putalpha(255)
        keyed = Image.new("RGBA", rgba.size, (*key_rgb, 255))
        keyed.paste(opaque, mask=visible_mask)
        return keyed

    def apply_geometry(self) -> None:
        self.root.geometry(f"+{self.state.avatar_x}+{self.state.avatar_y}")
        self.apply_subtitle_geometry()

    def apply_subtitle_geometry(self) -> None:
        self.state.subtitle_width = int(min(SUBTITLE_MAX_WIDTH, max(SUBTITLE_MIN_WIDTH, self.state.subtitle_width)))
        self.state.subtitle_height = int(min(SUBTITLE_MAX_HEIGHT, max(SUBTITLE_MIN_HEIGHT, self.state.subtitle_height)))
        self.subtitle.geometry(
            f"{self.state.subtitle_width}x{self.state.subtitle_height}+{self.state.subtitle_x}+{self.state.subtitle_y}",
        )
        self.subtitle_canvas.configure(width=self.state.subtitle_width, height=self.state.subtitle_height)
        self.apply_subtitle_style()

    def apply_subtitle_style(self) -> None:
        self.state.subtitle_font_size = int(min(34, max(11, self.state.subtitle_font_size)))
        self.redraw_subtitle_text()

    def set_subtitle_text(self, text: str) -> None:
        if text == self.subtitle_text and self.subtitle_canvas.find_withtag("subtitle_text"):
            return
        self.subtitle_text = text
        self.redraw_subtitle_text()

    def redraw_subtitle_text(self) -> None:
        render_key = (
            self.subtitle_text,
            self.state.subtitle_width,
            self.state.subtitle_height,
            self.state.subtitle_font_size,
        )
        if render_key == self.subtitle_render_key:
            return
        self.subtitle_canvas.delete("subtitle_text")
        image = render_subtitle_image(
            text=self.subtitle_text,
            width=self.state.subtitle_width,
            height=self.state.subtitle_height,
            font_size=self.state.subtitle_font_size,
        )
        self.subtitle_photo = ImageTk.PhotoImage(image)
        self.subtitle_canvas.create_image(0, 0, image=self.subtitle_photo, anchor="nw", tags="subtitle_text")
        self.subtitle_render_key = render_key

    def apply_subtitle_visibility(self) -> None:
        if self.overlay_visible and self.state.subtitle_visible:
            self.subtitle.deiconify()
        else:
            self.subtitle.withdraw()

    def start_drag(self, event) -> None:
        self.drag_start = (event.x_root, event.y_root, self.state.avatar_x, self.state.avatar_y)

    def drag_avatar(self, event) -> None:
        if not self.drag_start:
            return
        start_x, start_y, origin_x, origin_y = self.drag_start
        self.state.avatar_x = origin_x + (event.x_root - start_x)
        self.state.avatar_y = origin_y + (event.y_root - start_y)
        self.root.geometry(f"+{self.state.avatar_x}+{self.state.avatar_y}")

    def start_subtitle_drag(self, event) -> None:
        self.subtitle_drag_start = (event.x_root, event.y_root, self.state.subtitle_x, self.state.subtitle_y)

    def drag_subtitle(self, event) -> None:
        if not self.subtitle_drag_start:
            return
        start_x, start_y, origin_x, origin_y = self.subtitle_drag_start
        self.state.subtitle_x = origin_x + (event.x_root - start_x)
        self.state.subtitle_y = origin_y + (event.y_root - start_y)
        self.apply_subtitle_geometry()

    def end_drag(self, _event=None) -> None:
        self.drag_start = None
        self.subtitle_drag_start = None
        self.subtitle_resize_start = None
        save_state(self.state)

    def scale_avatar(self, event) -> None:
        factor = 1.08 if event.delta > 0 else 1 / 1.08
        self.state.scale = min(1.4, max(0.12, self.state.scale * factor))
        save_state(self.state)
        self.redraw_avatar()

    def show_menu(self, event) -> None:
        menu = tk.Menu(self.root, tearoff=0)
        menu.add_checkbutton(label="最前面に固定", onvalue=True, offvalue=False, variable=self.topmost_var(), command=self.toggle_topmost)
        menu.add_checkbutton(label="字幕を表示", onvalue=True, offvalue=False, variable=self.subtitle_visible_var(), command=self.toggle_subtitle)
        menu.add_command(label="字幕を編集", command=self.edit_subtitle)
        menu.add_command(label="改行幅を広げる", command=lambda: self.adjust_subtitle_width(SUBTITLE_WIDTH_STEP))
        menu.add_command(label="改行幅を狭める", command=lambda: self.adjust_subtitle_width(-SUBTITLE_WIDTH_STEP))
        menu.add_command(label="字幕サイズをリセット", command=self.reset_subtitle_box)
        menu.add_command(label="画像キャッシュを更新", command=self.reload_images)
        menu.add_separator()
        menu.add_command(label="大きさをリセット", command=self.reset_scale)
        menu.add_command(label="位置をリセット", command=self.reset_positions)
        menu.add_separator()
        menu.add_command(label="終了", command=self.exit)
        menu.tk_popup(event.x_root, event.y_root)

    def show_subtitle_menu(self, event) -> None:
        menu = tk.Menu(self.subtitle, tearoff=0)
        menu.add_command(label="字幕を編集", command=self.edit_subtitle)
        menu.add_command(label="文字を大きく", command=lambda: self.adjust_subtitle_font(1))
        menu.add_command(label="文字を小さく", command=lambda: self.adjust_subtitle_font(-1))
        menu.add_separator()
        menu.add_command(label="改行幅を広げる", command=lambda: self.adjust_subtitle_width(SUBTITLE_WIDTH_STEP))
        menu.add_command(label="改行幅を狭める", command=lambda: self.adjust_subtitle_width(-SUBTITLE_WIDTH_STEP))
        menu.add_command(label="一行寄りにする", command=self.expand_subtitle_width)
        menu.add_command(label="字幕の高さを広げる", command=lambda: self.adjust_subtitle_height(SUBTITLE_HEIGHT_STEP))
        menu.add_command(label="字幕の高さを狭める", command=lambda: self.adjust_subtitle_height(-SUBTITLE_HEIGHT_STEP))
        menu.add_separator()
        menu.add_command(label="字幕を表示/非表示", command=self.toggle_subtitle)
        menu.add_command(label="字幕位置をリセット", command=self.reset_subtitle_position)
        menu.add_command(label="字幕サイズをリセット", command=self.reset_subtitle_box)
        menu.add_separator()
        menu.add_command(label="終了", command=self.exit)
        menu.tk_popup(event.x_root, event.y_root)

    def bind_subtitle_resize(self, widget: tk.Widget, mode: str) -> None:
        widget.bind("<ButtonPress-1>", lambda event, resize_mode=mode: self.start_subtitle_resize(event, resize_mode))
        widget.bind("<B1-Motion>", self.resize_subtitle)
        widget.bind("<ButtonRelease-1>", self.end_drag)

    def start_subtitle_resize(self, event, mode: str) -> None:
        self.subtitle_resize_start = (
            event.x_root,
            event.y_root,
            self.state.subtitle_x,
            self.state.subtitle_y,
            self.state.subtitle_width,
            self.state.subtitle_height,
            mode,
        )

    def resize_subtitle(self, event) -> None:
        if not self.subtitle_resize_start:
            return
        start_x, start_y, origin_x, origin_y, origin_width, origin_height, mode = self.subtitle_resize_start
        dx = event.x_root - start_x
        dy = event.y_root - start_y
        if "e" in mode:
            self.state.subtitle_width = origin_width + dx
        if "s" in mode:
            self.state.subtitle_height = origin_height + dy
        self.state.subtitle_x = origin_x
        self.state.subtitle_y = origin_y
        self.apply_subtitle_geometry()

    def topmost_var(self) -> tk.BooleanVar:
        var = tk.BooleanVar(value=self.state.topmost)
        self._topmost_var = var
        return var

    def subtitle_visible_var(self) -> tk.BooleanVar:
        var = tk.BooleanVar(value=self.state.subtitle_visible)
        self._subtitle_visible_var = var
        return var

    def toggle_topmost(self) -> None:
        self.state.topmost = not self.state.topmost
        self.root.attributes("-topmost", self.state.topmost)
        self.subtitle.attributes("-topmost", self.state.topmost)
        save_state(self.state)

    def toggle_subtitle(self) -> None:
        self.state.subtitle_visible = not self.state.subtitle_visible
        self.apply_subtitle_visibility()
        save_state(self.state)

    def edit_subtitle(self) -> None:
        text = simpledialog.askstring("字幕", "表示する字幕", initialvalue=self.subtitle_text, parent=self.subtitle)
        if text is not None:
            self.set_subtitle_text(text)

    def handle_subtitle_mousewheel(self, event) -> None:
        direction = 1 if event.delta > 0 else -1
        if event.state & 0x0001:
            self.adjust_subtitle_width(direction * SUBTITLE_WIDTH_STEP)
            return
        if event.state & 0x0004:
            self.adjust_subtitle_height(direction * SUBTITLE_HEIGHT_STEP)
            return
        self.adjust_subtitle_font(direction)

    def adjust_subtitle_font(self, delta: int) -> None:
        self.state.subtitle_font_size = min(34, max(11, self.state.subtitle_font_size + delta))
        self.apply_subtitle_style()
        save_state(self.state)

    def adjust_subtitle_width(self, delta: int) -> None:
        self.state.subtitle_width = min(SUBTITLE_MAX_WIDTH, max(SUBTITLE_MIN_WIDTH, self.state.subtitle_width + delta))
        self.apply_subtitle_geometry()
        save_state(self.state)

    def adjust_subtitle_height(self, delta: int) -> None:
        self.state.subtitle_height = min(SUBTITLE_MAX_HEIGHT, max(SUBTITLE_MIN_HEIGHT, self.state.subtitle_height + delta))
        self.apply_subtitle_geometry()
        save_state(self.state)

    def expand_subtitle_width(self) -> None:
        self.state.subtitle_width = SUBTITLE_MAX_WIDTH
        self.apply_subtitle_geometry()
        save_state(self.state)

    def reload_images(self) -> None:
        self.image_cache.clear()
        self.current_url = ""
        self.redraw_avatar()

    def reset_scale(self) -> None:
        self.state.scale = 0.38
        self.current_scale = 0.0
        save_state(self.state)
        self.redraw_avatar()

    def reset_positions(self) -> None:
        self.state.avatar_x = 1040
        self.state.avatar_y = 100
        self.state.subtitle_x = 720
        self.state.subtitle_y = 760
        self.state.subtitle_width = SUBTITLE_DEFAULT_WIDTH
        self.state.subtitle_height = SUBTITLE_DEFAULT_HEIGHT
        self.state.subtitle_layout_version = SUBTITLE_LAYOUT_VERSION
        save_state(self.state)
        self.apply_geometry()

    def reset_subtitle_position(self) -> None:
        self.state.subtitle_x = 720
        self.state.subtitle_y = 760
        save_state(self.state)
        self.apply_geometry()

    def reset_subtitle_box(self) -> None:
        self.state.subtitle_width = SUBTITLE_DEFAULT_WIDTH
        self.state.subtitle_height = SUBTITLE_DEFAULT_HEIGHT
        self.state.subtitle_font_size = SUBTITLE_DEFAULT_FONT_SIZE
        self.state.subtitle_layout_version = SUBTITLE_LAYOUT_VERSION
        save_state(self.state)
        self.apply_subtitle_geometry()

    def exit(self) -> None:
        save_state(self.state)
        self.subtitle.destroy()
        self.root.destroy()


def parse_iso_ms(value: object) -> int | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        normalized = value.replace("Z", "+00:00")
        from datetime import datetime

        return int(datetime.fromisoformat(normalized).timestamp() * 1000)
    except ValueError:
        return None


def render_subtitle_image(text: str, width: int, height: int, font_size: int) -> Image.Image:
    width = max(1, width)
    height = max(1, height)
    font = load_subtitle_font(font_size)
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    white_width = max(2, round(font_size * 0.14))
    outer_ring_width = max(9, round(font_size * 0.34))
    outer_width = white_width + outer_ring_width
    stroke_margin = outer_width
    max_text_width = max(20, width - (SUBTITLE_PADDING_X * 2) - (stroke_margin * 2))
    lines = wrap_text(text, font, max_text_width)
    sample_height = measure_text_with_stroke(draw, "あいうえお漢字Aygy", font, outer_width)[1]
    line_height = max(round(font_size * 2.35), sample_height + round(font_size * 0.9))
    x = SUBTITLE_PADDING_X + stroke_margin
    y = SUBTITLE_PADDING_Y + stroke_margin
    for line in lines:
        line_box_height = measure_text_with_stroke(draw, line, font, outer_width)[1]
        if y + line_box_height > height:
            break
        draw.text(
            (x, y),
            line,
            font=font,
            fill=SUBTITLE_TEXT_OUTER,
            stroke_width=outer_width,
            stroke_fill=SUBTITLE_TEXT_OUTER,
        )
        draw.text(
            (x, y),
            line,
            font=font,
            fill=SUBTITLE_TEXT_WHITE,
            stroke_width=white_width,
            stroke_fill=SUBTITLE_TEXT_WHITE,
        )
        draw.text((x, y), line, font=font, fill=SUBTITLE_TEXT_FILL)
        y += line_height
    return image


def load_subtitle_font(font_size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for font_path in FONT_PATH_CANDIDATES:
        if font_path.exists():
            try:
                return ImageFont.truetype(str(font_path), font_size)
            except OSError:
                continue
    return ImageFont.load_default()


def wrap_text(text: str, font: ImageFont.ImageFont, max_width: int) -> list[str]:
    draw = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    lines: list[str] = []
    for paragraph in text.splitlines() or [""]:
        current = ""
        for char in paragraph:
            candidate = current + char
            if current and measure_text(draw, candidate, font)[0] > max_width:
                lines.append(current)
                current = char
            else:
                current = candidate
        lines.append(current)
    return lines or [""]


def measure_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont) -> tuple[int, int]:
    bbox = draw.textbbox((0, 0), text or " ", font=font)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def measure_text_with_stroke(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.ImageFont,
    stroke_width: int,
) -> tuple[int, int]:
    bbox = draw.textbbox((0, 0), text or " ", font=font, stroke_width=stroke_width)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def pick_cute_font_family(root: tk.Tk) -> str:
    available = set(tkfont.families(root=root))
    for family in CUTE_FONT_CANDIDATES:
        if family in available:
            return family
    return "Yu Gothic UI"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Show a floating RealPCtuber avatar synced to the UI server.")
    parser.add_argument("--base-url", default="http://127.0.0.1:48731")
    parser.add_argument("--poll-ms", type=int, default=250)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    FloatingOverlay(args.base_url, args.poll_ms).run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
