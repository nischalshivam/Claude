"""Read technical facts about a media file.

Prefers `ffprobe` (structured JSON). Falls back to parsing `ffmpeg -i` stderr,
because some ffmpeg installs ship without ffprobe — and a pre-flight check must
never fail just because one binary is missing.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from functools import lru_cache


class ProbeError(RuntimeError):
    pass


@lru_cache(maxsize=1)
def ffmpeg_bin() -> str | None:
    return shutil.which("ffmpeg")


@lru_cache(maxsize=1)
def ffprobe_bin() -> str | None:
    return shutil.which("ffprobe")


def require_ffmpeg() -> str:
    exe = ffmpeg_bin()
    if not exe:
        raise ProbeError("ffmpeg not found on PATH — install it and retry")
    return exe


@dataclass
class SubStream:
    index: int          # index *within the subtitle streams* (for -map 0:s:N)
    lang: str = ""
    codec: str = ""
    title: str = ""
    forced: bool = False


@dataclass
class MediaInfo:
    path: str
    duration: float = 0.0        # seconds
    width: int = 0
    height: int = 0
    fps: float = 0.0
    vcodec: str = ""
    acodec: str = ""
    has_audio: bool = False
    subs: list = field(default_factory=list)      # [SubStream]

    @property
    def resolution(self) -> str:
        return f"{self.width}x{self.height}" if self.width else "?"

    @property
    def is_hd(self) -> bool:
        return self.width >= 1280


def _run(cmd: list[str], timeout=180) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True,
                          errors="replace", timeout=timeout)


def _fraction(text: str) -> float:
    """'24000/1001' -> 23.976"""
    try:
        if "/" in text:
            a, b = text.split("/", 1)
            return float(a) / float(b) if float(b) else 0.0
        return float(text)
    except (ValueError, ZeroDivisionError):
        return 0.0


def _probe_with_ffprobe(path: str) -> MediaInfo:
    out = _run([ffprobe_bin(), "-v", "error", "-print_format", "json",
                "-show_format", "-show_streams", path])
    if out.returncode != 0:
        raise ProbeError(out.stderr.strip()[:300] or "ffprobe failed")
    data = json.loads(out.stdout or "{}")
    info = MediaInfo(path=path)
    info.duration = float(data.get("format", {}).get("duration") or 0)

    sub_n = 0
    for st in data.get("streams", []):
        kind = st.get("codec_type")
        if kind == "video" and not info.width:
            info.width = int(st.get("width") or 0)
            info.height = int(st.get("height") or 0)
            info.vcodec = st.get("codec_name", "")
            info.fps = _fraction(st.get("avg_frame_rate")
                                 or st.get("r_frame_rate") or "0")
            if not info.duration:
                info.duration = float(st.get("duration") or 0)
        elif kind == "audio" and not info.has_audio:
            info.has_audio = True
            info.acodec = st.get("codec_name", "")
        elif kind == "subtitle":
            tags = st.get("tags") or {}
            info.subs.append(SubStream(
                index=sub_n, lang=(tags.get("language") or "").lower(),
                codec=st.get("codec_name", ""), title=tags.get("title", ""),
                forced=bool((st.get("disposition") or {}).get("forced"))))
            sub_n += 1
    return info


_RE_DUR = re.compile(r"Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d+)")
_RE_VIDEO = re.compile(
    r"Stream #\d+:(\d+).*?:\s*Video:\s*([\w0-9]+).*?(\d{2,5})x(\d{2,5})")
_RE_FPS = re.compile(r"([\d.]+)\s+fps")
_RE_AUDIO = re.compile(r"Stream #\d+:\d+.*?:\s*Audio:\s*([\w0-9]+)")
_RE_SUB = re.compile(
    r"Stream #\d+:\d+(?:\((\w+)\))?.*?:\s*Subtitle:\s*([\w0-9]+)(.*)")


def _probe_with_ffmpeg(path: str) -> MediaInfo:
    """ffmpeg prints a full stream summary to stderr and exits non-zero."""
    out = _run([require_ffmpeg(), "-hide_banner", "-i", path])
    text = out.stderr or ""
    if "Invalid data" in text or "No such file" in text:
        raise ProbeError(f"cannot read {path}")
    info = MediaInfo(path=path)

    m = _RE_DUR.search(text)
    if m:
        h, mi, s, frac = m.groups()
        info.duration = (int(h) * 3600 + int(mi) * 60 + int(s)
                         + float("0." + frac))
    m = _RE_VIDEO.search(text)
    if m:
        _, info.vcodec, w, h = m.groups()
        info.width, info.height = int(w), int(h)
        line = text[m.start():m.end() + 120]
        f = _RE_FPS.search(line)
        if f:
            info.fps = float(f.group(1))
    m = _RE_AUDIO.search(text)
    if m:
        info.has_audio = True
        info.acodec = m.group(1)
    for i, sm in enumerate(_RE_SUB.finditer(text)):
        lang, codec, tail = sm.groups()
        info.subs.append(SubStream(index=i, lang=(lang or "").lower(),
                                   codec=codec,
                                   forced="forced" in (tail or "").lower()))
    if not info.duration and not info.width:
        raise ProbeError(f"could not parse media info for {path}")
    return info


def probe(path: str) -> MediaInfo:
    """Technical facts about a media file. Raises ProbeError on unreadable."""
    if ffprobe_bin():
        try:
            return _probe_with_ffprobe(path)
        except (ProbeError, json.JSONDecodeError, ValueError):
            pass                                   # fall through to the parser
    return _probe_with_ffmpeg(path)


def keyframes(path: str, start: float = 0.0, window: float = 60.0) -> list[float]:
    """Keyframe timestamps in [start, start+window]. Empty without ffprobe.

    Cutting on a keyframe is what makes a stream-copy clip start cleanly
    instead of with a smear of grey blocks.
    """
    if not ffprobe_bin():
        return []
    out = _run([ffprobe_bin(), "-v", "error",
                "-read_intervals", f"{max(0.0, start)}%+{window}",
                "-select_streams", "v:0", "-skip_frame", "nokey",
                "-show_entries", "frame=pts_time", "-of", "csv=p=0", path])
    times = []
    for line in out.stdout.splitlines():
        line = line.strip().rstrip(",")
        try:
            times.append(float(line))
        except ValueError:
            continue
    return sorted(times)
