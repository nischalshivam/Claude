"""Media probing via ffprobe (bundled bin/ like tool #1, or PATH), PIL fallback for images."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass

TICKS = 10_000_000


def _exe(name: str) -> str | None:
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for cand in (os.path.join(here, "bin", name + ".exe"),
                 os.path.join(here, "bin", name)):
        if os.path.isfile(cand):
            return cand
    return shutil.which(name)


@dataclass
class MediaInfo:
    kind: str                 # video | image | audio
    duration_ticks: int = 0   # 0 for images
    width: int = 0
    height: int = 0
    fps_num: int = 30
    fps_den: int = 1
    bit_rate: int = 0
    sample_rate: int = 44100
    channels: int = 2
    audio_bit_rate: int = 128000
    has_audio: bool = False
    total_frames: int = 0


IMAGE_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".gif", ".tif", ".tiff"}
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".wma"}


def kind_of(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext in IMAGE_EXT:
        return "image"
    if ext in AUDIO_EXT:
        return "audio"
    return "video"


def probe(path: str) -> MediaInfo:
    kind = kind_of(path)
    info = MediaInfo(kind=kind)
    ffprobe = _exe("ffprobe")
    if ffprobe:
        try:
            out = subprocess.run(
                [ffprobe, "-v", "quiet", "-print_format", "json",
                 "-show_format", "-show_streams", path],
                capture_output=True, text=True, timeout=60).stdout
            data = json.loads(out or "{}")
            fmt = data.get("format", {})
            dur = float(fmt.get("duration") or 0)
            info.bit_rate = int(float(fmt.get("bit_rate") or 0))
            for s in data.get("streams", []):
                if s.get("codec_type") == "video":
                    info.width = int(s.get("width") or 0)
                    info.height = int(s.get("height") or 0)
                    fr = s.get("avg_frame_rate") or s.get("r_frame_rate") or "30/1"
                    try:
                        num, den = fr.split("/")
                        if int(den) and int(num):
                            info.fps_num, info.fps_den = int(num), int(den)
                    except ValueError:
                        pass
                    nb = s.get("nb_frames")
                    if nb and str(nb).isdigit():
                        info.total_frames = int(nb)
                elif s.get("codec_type") == "audio":
                    info.has_audio = True
                    info.sample_rate = int(s.get("sample_rate") or 44100)
                    info.channels = int(s.get("channels") or 2)
                    info.audio_bit_rate = int(float(s.get("bit_rate") or 128000))
            if kind != "image":
                info.duration_ticks = int(round(dur * TICKS))
            if not info.total_frames and info.duration_ticks and info.fps_den:
                info.total_frames = int(dur * info.fps_num / info.fps_den)
            if info.width:
                return info
            if kind == "audio" and info.duration_ticks:
                return info
        except Exception:
            pass
    # Fallbacks without ffprobe
    if kind == "image":
        try:
            from PIL import Image
            with Image.open(path) as im:
                info.width, info.height = im.size
            return info
        except Exception:
            info.width, info.height = 1920, 1080
            return info
    raise RuntimeError(
        f"Could not probe {path!r}. ffprobe is required for video/audio — "
        "run setup.bat (it installs ffmpeg into bin/) or add ffprobe to PATH.")


def make_thumbnail(path: str, out_png: str, kind: str, seek_sec: float = 0.5) -> bool:
    """Small PNG thumbnail like Filmora writes next to media.json. Optional."""
    ffmpeg = _exe("ffmpeg")
    try:
        if kind == "audio":
            return False
        if ffmpeg:
            cmd = [ffmpeg, "-y", "-v", "quiet"]
            if kind == "video":
                cmd += ["-ss", str(seek_sec)]
            cmd += ["-i", path, "-frames:v", "1",
                    "-vf", "scale=192:-2", out_png]
            subprocess.run(cmd, capture_output=True, timeout=60)
            return os.path.isfile(out_png)
        if kind == "image":
            from PIL import Image
            with Image.open(path) as im:
                im.thumbnail((192, 192))
                im.convert("RGB").save(out_png, "PNG")
            return True
    except Exception:
        pass
    return False


def audio_duration_secs(path: str) -> float:
    return probe(path).duration_ticks / TICKS
