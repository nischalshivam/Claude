"""Detect (and correct) subtitle drift against the actual audio.

A downloaded .srt is very often timed for a *different release* — another cut,
another framerate, with or without a distributor intro. It then runs a few
seconds early or late, and every clip we cut lands next to the line instead of
on it. Worst of all it fails silently: the index looks perfectly healthy.

How it works, without any ML:

  1. `ffmpeg silencedetect` gives us where the audio is speaking.
  2. The subtitle cues give us where the audio *should* be speaking.
  3. Slide one against the other and keep the offset with the best agreement.

Both timelines are rasterised into bins and packed into Python big integers, so
one candidate offset is a single shift + AND + popcount. That makes a full
search fast enough in pure Python — no numpy needed.

Framerate conversion (23.976 vs 25 fps) shows up as *stretch* rather than
shift, so a handful of standard ratios are searched alongside the offset.
"""
from __future__ import annotations

import math
import re
import subprocess
from dataclasses import dataclass

from .probe import ProbeError, pick_audio, probe, require_ffmpeg

# Common framerate conversions. A wrong-framerate subtitle drifts steadily —
# perfect at the start, minutes out by the end.
SCALES = {
    1.0: "none",
    25.0 / 24.0: "24→25 fps",
    24.0 / 25.0: "25→24 fps",
    25.0 / 23.976: "23.976→25 fps",
    23.976 / 25.0: "25→23.976 fps",
    24.0 / 23.976: "23.976→24 fps",
    23.976 / 24.0: "24→23.976 fps",
    30.0 / 29.97: "29.97→30 fps",
    29.97 / 30.0: "30→29.97 fps",
}

COARSE_BIN_MS = 500
FINE_BIN_MS = 50
DEFAULT_RANGE_MS = 120_000        # subtitles are rarely more than 2 min out

_RE_SIL_START = re.compile(r"silence_start:\s*(-?[\d.]+)")
_RE_SIL_END = re.compile(r"silence_end:\s*(-?[\d.]+)")


@dataclass
class SyncResult:
    offset_ms: int = 0            # ADD this to every cue time
    scale: float = 1.0            # MULTIPLY every cue time by this (before offset)
    scale_name: str = "none"
    score: float = 0.0            # 0..1 agreement at the winning offset
    prominence: float = 0.0       # how far the peak stands above every rival
    confidence: str = "unknown"   # high | medium | low | unknown
    method: str = "silencedetect"
    note: str = ""

    @property
    def in_sync(self) -> bool:
        return abs(self.offset_ms) < 250 and self.scale == 1.0

    def describe(self) -> str:
        if self.confidence == "unknown":
            return f"sync not checked ({self.note})"
        if self.in_sync:
            return f"in sync (score {self.score:.2f}, {self.confidence})"
        bits = [f"{self.offset_ms:+d} ms"]
        if self.scale != 1.0:
            bits.append(self.scale_name)
        return (f"drift {' · '.join(bits)} "
                f"(score {self.score:.2f}, prom {self.prominence:.2f}, "
                f"{self.confidence})")


# ---------------------------------------------------------------------------
# 1. where the audio is actually speaking
# ---------------------------------------------------------------------------

def speech_intervals(video_path: str, noise_db=-30, min_silence=0.30,
                     max_seconds: float | None = None,
                     timeout=1800) -> tuple[list, float]:
    """[(start_s, end_s)] of non-silent audio, plus the duration analysed."""
    info = probe(video_path)
    if not info.has_audio:
        raise ProbeError("file has no audio track")
    duration = info.duration or 0.0
    limit = min(duration, max_seconds) if max_seconds else duration

    cmd = [require_ffmpeg(), "-hide_banner", "-nostats"]
    if max_seconds:
        cmd += ["-t", str(max_seconds)]
    cmd += ["-i", video_path, "-map", f"0:a:{pick_audio(info)}",
            "-ac", "1", "-ar", "8000",                 # cheap: mono, low rate
            "-af", f"silencedetect=noise={noise_db}dB:d={min_silence}",
            "-f", "null", "-"]
    out = subprocess.run(cmd, capture_output=True, text=True,
                         errors="replace", timeout=timeout)
    text = out.stderr or ""

    silences, open_start = [], None
    for line in text.splitlines():
        m = _RE_SIL_START.search(line)
        if m:
            open_start = max(0.0, float(m.group(1)))
            continue
        m = _RE_SIL_END.search(line)
        if m and open_start is not None:
            silences.append((open_start, float(m.group(1))))
            open_start = None
    if open_start is not None:
        silences.append((open_start, limit or open_start))

    # invert silence -> speech
    speech, cursor = [], 0.0
    for a, b in silences:
        if a > cursor:
            speech.append((cursor, a))
        cursor = max(cursor, b)
    if limit and cursor < limit:
        speech.append((cursor, limit))
    return speech, (limit or (speech[-1][1] if speech else 0.0))


# ---------------------------------------------------------------------------
# 2. rasterise both timelines into bitsets
# ---------------------------------------------------------------------------

def _bits_from_intervals(intervals, bin_ms: int, n_bins: int) -> int:
    """Pack [(start_s, end_s)] into an integer, one bit per bin."""
    bits = 0
    for a, b in intervals:
        i0 = max(0, int(a * 1000) // bin_ms)
        i1 = min(n_bins - 1, int(b * 1000) // bin_ms)
        if i1 < i0:
            continue
        width = i1 - i0 + 1
        bits |= ((1 << width) - 1) << i0
    return bits


def _bits_from_cues(cues, bin_ms: int, n_bins: int,
                    scale=1.0, shift_ms=0) -> int:
    ivals = [(((c.start_ms * scale) + shift_ms) / 1000.0,
              ((c.end_ms * scale) + shift_ms) / 1000.0) for c in cues]
    return _bits_from_intervals(ivals, bin_ms, n_bins)


def _agreement(a_bits: int, b_bits: int, a_pop: int, b_pop: int) -> float:
    """Cosine similarity of two binary vectors."""
    if not a_pop or not b_pop:
        return 0.0
    return (a_bits & b_bits).bit_count() / math.sqrt(a_pop * b_pop)


GUARD_MS = 2000        # a rival peak this close to the winner is the same peak


def _scan(a_bits, a_pop, cues, bin_ms, n_bins, scale, lo_ms, hi_ms, step_ms):
    """Best (score, offset_ms, prominence) over a range.

    `prominence` is the gap between the winning offset and the best rival
    that is not simply the shoulder of the same peak. It answers the question
    that actually matters — "is this offset clearly better than every other
    one?" — which a z-score over the whole range does not, because almost
    every offset is equally bad and that inflates the spread.
    """
    base = _bits_from_cues(cues, bin_ms, n_bins + 2 * (abs(lo_ms) // bin_ms + 2),
                           scale=scale)
    b_pop = base.bit_count()
    scores = []
    for off_ms in range(lo_ms, hi_ms + 1, step_ms):
        shift = off_ms // bin_ms
        moved = (base << shift) if shift >= 0 else (base >> -shift)
        scores.append((_agreement(a_bits, moved, a_pop, b_pop), off_ms))
    if not scores:
        return 0.0, 0, 0.0
    best_score, best_off = max(scores)
    rivals = [s for s, o in scores if abs(o - best_off) > GUARD_MS]
    runner_up = max(rivals) if rivals else 0.0
    return best_score, best_off, best_score - runner_up


# ---------------------------------------------------------------------------
# 3. the detector
# ---------------------------------------------------------------------------

def detect(video_path: str, cues, search_ms=DEFAULT_RANGE_MS,
           try_framerates=True, max_seconds: float | None = None,
           log=lambda *a: None) -> SyncResult:
    """Compare `cues` against the audio of `video_path`."""
    if not cues:
        return SyncResult(confidence="unknown", note="no cues")
    try:
        speech, analysed = speech_intervals(video_path, max_seconds=max_seconds)
    except (ProbeError, subprocess.SubprocessError, OSError) as exc:
        return SyncResult(confidence="unknown", note=str(exc)[:120])
    if not speech or analysed <= 0:
        return SyncResult(confidence="unknown", note="no speech detected")

    n_coarse = int(analysed * 1000) // COARSE_BIN_MS + 2
    a_coarse = _bits_from_intervals(speech, COARSE_BIN_MS, n_coarse)
    a_pop = a_coarse.bit_count()
    if a_pop == 0:
        return SyncResult(confidence="unknown", note="audio is entirely silent")

    # coarse pass, optionally over several framerate ratios
    candidates = SCALES if try_framerates else {1.0: "none"}
    best = (0.0, 0, 0.0, 1.0)
    for scale in candidates:
        score, off, prom = _scan(a_coarse, a_pop, cues, COARSE_BIN_MS, n_coarse,
                                 scale, -search_ms, search_ms, COARSE_BIN_MS)
        log(f"  scale {scale:.5f}: score {score:.3f} @ {off:+d} ms")
        if score > best[0]:
            best = (score, off, prom, scale)
    score, off, prom, scale = best

    # fine pass around the coarse winner
    n_fine = int(analysed * 1000) // FINE_BIN_MS + 2
    a_fine = _bits_from_intervals(speech, FINE_BIN_MS, n_fine)
    a_pop_f = a_fine.bit_count()
    f_score, f_off, _ = _scan(a_fine, a_pop_f, cues, FINE_BIN_MS, n_fine,
                              scale, off - COARSE_BIN_MS, off + COARSE_BIN_MS,
                              FINE_BIN_MS)
    if f_score >= score * 0.9:
        score, off = f_score, f_off

    res = SyncResult(offset_ms=int(off), scale=scale,
                     scale_name=SCALES.get(scale, "none"),
                     score=round(score, 4), prominence=round(prom, 4))
    # Trust the answer when the winning offset clearly beats every rival, or
    # when the raw agreement is so high it cannot be coincidence.
    if (score >= 0.50 and prom >= 0.12) or score >= 0.80:
        res.confidence = "high"
    elif score >= 0.35 and prom >= 0.05:
        res.confidence = "medium"
    else:
        res.confidence = "low"
        res.note = "no clear peak — subtitles may belong to another release"
    return res


def apply(cues, offset_ms: int, scale: float = 1.0):
    """Return cues with the correction applied (never mutates the input)."""
    if offset_ms == 0 and scale == 1.0:
        return cues
    out = []
    for c in cues:
        moved = type(c)(idx=c.idx,
                        start_ms=max(0, int(c.start_ms * scale) + offset_ms),
                        end_ms=max(0, int(c.end_ms * scale) + offset_ms),
                        text=c.text)
        out.append(moved)
    return out
