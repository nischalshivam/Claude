"""Find, extract and parse subtitles into timed cues.

Order of preference:
  1. sidecar file next to the video   (Movie.en.srt, Movie.srt, Subs/2_English.srt)
  2. embedded track pulled with ffmpeg (only if ffmpeg is on PATH)

Supports .srt, .vtt and .ass/.ssa. Zero required dependencies.
"""
from __future__ import annotations

import glob
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass

from .naming import VIDEO_EXT

SUB_EXT = (".srt", ".vtt", ".ass", ".ssa")
_ENCODINGS = ("utf-8-sig", "utf-8", "cp1252", "latin-1")

# Language hints that mark a sidecar as English (or language-neutral)
_EN_HINT = re.compile(r"(?i)(^|[\.\-_ ])(en|eng|english)([\.\-_ ]|$)")
_FORCED = re.compile(r"(?i)(forced|sdh|cc|commentary|signs?[\.\-_ ]?songs?)")
_EN_WORDS = re.compile(r"(?i)\b(eng|english)\b")

# Formatting we strip out of cue text
_TAG_HTML = re.compile(r"<[^>]+>")
_TAG_ASS = re.compile(r"\{[^}]*\}")
_SOUND_FX = re.compile(r"[\(\[][^\)\]]{0,40}[\)\]]")        # (GUNSHOT) [MUSIC]
_SPEAKER = re.compile(r"^\s*[A-Z][A-Z' \.]{1,24}:\s*")      # WALTER: hello
_MUSIC = re.compile(r"[♪♫#]+")
_DASH_LEAD = re.compile(r"^\s*[-–—]\s*")

_SRT_TIME = re.compile(
    r"(\d{1,2}):(\d{2}):(\d{2})[,\.](\d{1,3})\s*-->\s*"
    r"(\d{1,2}):(\d{2}):(\d{2})[,\.](\d{1,3})")
_ASS_TIME = re.compile(r"(\d{1,2}):(\d{2}):(\d{2})[\.:](\d{1,2})")


@dataclass
class Cue:
    idx: int
    start_ms: int
    end_ms: int
    text: str            # cleaned, single line


def _read_text(path: str) -> str:
    with open(path, "rb") as fh:
        raw = fh.read()
    for enc in _ENCODINGS:
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def clean_line(s: str) -> str:
    """Strip markup, sound effects and speaker labels; collapse whitespace."""
    s = _TAG_HTML.sub(" ", s)
    s = _TAG_ASS.sub(" ", s)
    s = s.replace("\\N", " ").replace("\\n", " ")
    s = _MUSIC.sub(" ", s)
    s = _SOUND_FX.sub(" ", s)
    s = _DASH_LEAD.sub("", s)
    s = _SPEAKER.sub("", s)
    return re.sub(r"\s{2,}", " ", s).strip()


def _hms(h, m, s, frac) -> int:
    frac = (frac + "00")[:3]          # 1-3 digits -> milliseconds
    return ((int(h) * 60 + int(m)) * 60 + int(s)) * 1000 + int(frac)


def parse_srt(text: str) -> list[Cue]:
    cues, idx = [], 0
    for block in re.split(r"\r?\n\s*\r?\n", text):
        m = _SRT_TIME.search(block)
        if not m:
            continue
        start = _hms(*m.group(1, 2, 3, 4))
        end = _hms(*m.group(5, 6, 7, 8))
        body = block[m.end():].strip()
        body = " ".join(clean_line(l) for l in body.splitlines())
        body = re.sub(r"\s{2,}", " ", body).strip()
        if body:
            cues.append(Cue(idx, start, end, body))
            idx += 1
    return cues


def parse_ass(text: str) -> list[Cue]:
    cues, idx, fmt = [], 0, None
    for line in text.splitlines():
        if line.lower().startswith("format:") and fmt is None and "start" in line.lower():
            fmt = [f.strip().lower() for f in line.split(":", 1)[1].split(",")]
        if not line.lower().startswith("dialogue:"):
            continue
        fields = line.split(":", 1)[1].split(",", 9)
        if len(fields) < 10:
            continue
        try:
            si = fmt.index("start") if fmt and "start" in fmt else 1
            ei = fmt.index("end") if fmt and "end" in fmt else 2
            ms = _ASS_TIME.match(fields[si].strip())
            me = _ASS_TIME.match(fields[ei].strip())
            if not (ms and me):
                continue
            start = _hms(ms.group(1), ms.group(2), ms.group(3), ms.group(4) + "0")
            end = _hms(me.group(1), me.group(2), me.group(3), me.group(4) + "0")
        except (ValueError, IndexError):
            continue
        body = clean_line(fields[-1])
        if body:
            cues.append(Cue(idx, start, end, body))
            idx += 1
    return cues


def parse_file(path: str) -> list[Cue]:
    text = _read_text(path)
    ext = os.path.splitext(path)[1].lower()
    if ext in (".ass", ".ssa"):
        return parse_ass(text)
    if ext == ".vtt":
        text = re.sub(r"(?m)^WEBVTT.*$", "", text, count=1)
    return parse_srt(text)


_EP_MARK = re.compile(r"(?i)\bs(\d{1,2})\s*[\._\- ]?\s*e(\d{1,3})\b|\b(\d{1,2})x(\d{1,3})\b")


def _ep_key(name: str) -> tuple | None:
    m = _EP_MARK.search(name)
    if not m:
        return None
    if m.group(1):
        return int(m.group(1)), int(m.group(2))
    return int(m.group(3)), int(m.group(4))


# Unicode ranges that tell us what script the subtitles are actually in.
# Checking the TEXT beats trusting a language tag, which is routinely wrong or
# missing in scene releases — and a Hindi subtitle silently indexed against an
# English script produces zero matches with no explanation.
_SCRIPTS = [
    ("devanagari", (0x0900, 0x097F)),
    ("arabic", (0x0600, 0x06FF)),
    ("cyrillic", (0x0400, 0x04FF)),
    ("cjk", (0x4E00, 0x9FFF)),
    ("hangul", (0xAC00, 0xD7AF)),
    ("thai", (0x0E00, 0x0E7F)),
    ("hebrew", (0x0590, 0x05FF)),
]


def detect_script(cues, sample=400) -> str:
    """'latin' | 'devanagari' | 'cjk' | ... — based on the characters present."""
    text = " ".join(c.text for c in cues[:sample])
    letters = [ch for ch in text if ch.isalpha()]
    if not letters:
        return "unknown"
    counts = {name: 0 for name, _ in _SCRIPTS}
    latin = 0
    for ch in letters:
        o = ord(ch)
        if o < 0x0250:
            latin += 1
            continue
        for name, (lo, hi) in _SCRIPTS:
            if lo <= o <= hi:
                counts[name] += 1
                break
    best, n = max(counts.items(), key=lambda kv: kv[1])
    if n > len(letters) * 0.20:
        return best
    return "latin" if latin else "unknown"


def find_sidecar(video_path: str) -> str | None:
    """Best subtitle file sitting next to the video (English preferred).

    A shared `Subs/` folder in a season directory holds subs for *every*
    episode, so a bare glob there would hand episode 1's subtitles to every
    other episode. We only accept those when the episode marker agrees, or
    when the folder holds a single video.
    """
    stem = os.path.splitext(os.path.basename(video_path))[0]
    folder = os.path.dirname(video_path)
    want = _ep_key(stem)

    videos_here = [f for f in os.listdir(folder)
                   if f.lower().endswith(VIDEO_EXT)] if os.path.isdir(folder) else []
    solo = len(videos_here) <= 1

    def shared_ok(path: str) -> bool:
        if solo:
            return True
        name = os.path.basename(path)
        parent = os.path.basename(os.path.dirname(path))
        if stem.lower() in name.lower() or stem.lower() in parent.lower():
            return True
        got = _ep_key(name) or _ep_key(parent)
        return want is not None and got == want

    candidates = []
    for ext in SUB_EXT:
        # named after the video -> always trusted
        candidates += glob.glob(os.path.join(folder, glob.escape(stem) + "*" + ext))
        candidates += glob.glob(os.path.join(folder, glob.escape(stem), "*" + ext))
        # shared Subs/ folder -> only when it clearly belongs to this episode
        for p in glob.glob(os.path.join(folder, "[Ss]ubs*", "**", "*" + ext),
                           recursive=True):
            if shared_ok(p):
                candidates.append(p)

    seen, uniq = set(), []
    for c in candidates:
        if c not in seen and os.path.isfile(c):
            seen.add(c)
            uniq.append(c)
    if not uniq:
        return None

    def rank(p):
        name = os.path.basename(p)
        return (
            0 if _EN_HINT.search(name) else 1,   # English first
            1 if _FORCED.search(name) else 0,    # forced/SDH last
            0 if name.lower().endswith(".srt") else 1,
            -os.path.getsize(p),                 # richer file wins ties
        )

    return sorted(uniq, key=rank)[0]


def has_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


# Subtitles stored as IMAGES. ffmpeg cannot turn these into text at all —
# BluRay rips very often carry nothing else, so this must be detected and
# reported rather than producing a mysteriously empty index.
BITMAP_CODECS = {"hdmv_pgs_subtitle", "pgssub", "dvd_subtitle", "dvdsub",
                 "dvb_subtitle", "xsub"}


def _rank_sub_stream(st) -> tuple:
    """Sort key: English first, real text before bitmaps, forced/SDH last."""
    en = st.lang.startswith("en") or bool(_EN_WORDS.search(st.title or ""))
    bitmap = st.codec.lower() in BITMAP_CODECS
    forced = st.forced or bool(_FORCED.search(st.title or ""))
    return (0 if not bitmap else 1, 0 if en else 1, 1 if forced else 0, st.index)


def extract_embedded(video_path: str) -> tuple[str, list[Cue]] | None:
    """Pull the best text subtitle track out of the container.

    Tries every text track in preference order, because the first choice can
    still decode to nothing (an empty or malformed track is common). Bitmap
    tracks are skipped — they would need OCR, which is a different problem.
    """
    if not has_ffmpeg():
        return None
    try:
        from .probe import probe as _probe          # has an ffprobe-free path
        info = _probe(video_path)
    except Exception:
        return None

    usable = [s for s in info.subs if s.codec.lower() not in BITMAP_CODECS]
    if not usable:
        return None
    usable.sort(key=_rank_sub_stream)

    for st in usable[:4]:
        out = os.path.join(tempfile.gettempdir(),
                           f"_mi_{abs(hash(video_path))}_{st.index}.srt")
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-v", "error", "-i", video_path,
                 "-map", f"0:s:{st.index}", "-c:s", "srt", out],
                capture_output=True, timeout=600)
        except (OSError, subprocess.SubprocessError):
            continue
        cues = []
        if os.path.exists(out) and os.path.getsize(out) > 0:
            cues = parse_file(out)
        try:
            os.remove(out)
        except OSError:
            pass
        if cues:
            return ("embedded", cues)
    return None


def bitmap_only(video_path: str) -> bool:
    """True when the file has subtitles but all of them are images."""
    try:
        from .probe import probe as _probe
        info = _probe(video_path)
    except Exception:
        return False
    return bool(info.subs) and all(
        s.codec.lower() in BITMAP_CODECS for s in info.subs)


def load_for_video(video_path: str) -> tuple[str, str, list[Cue]]:
    """Return (source_kind, source_path, cues).

    source_kind is "sidecar" | "embedded" | "bitmap_only" | "none". The
    bitmap_only case matters: the file DOES have subtitles, they just cannot
    be read as text, and saying "no subtitles found" would send the user
    hunting for a problem that is really "download an .srt for this file".
    """
    side = find_sidecar(video_path)
    if side:
        cues = parse_file(side)
        if cues:
            return "sidecar", side, cues
    emb = extract_embedded(video_path)
    if emb:
        return "embedded", video_path, emb[1]
    if bitmap_only(video_path):
        return "bitmap_only", "", []
    return "none", "", []
