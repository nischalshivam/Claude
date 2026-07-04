"""Narration timing.

Best case: faster-whisper gives every word's timestamp (offline, CPU).
Fallback (no whisper / model unavailable): word-count weighting refined by
snapping scene boundaries to real SILENCE gaps in the audio — proven to fix
the "text ahead of voice" problem on real narration.
"""
from __future__ import annotations

import re
import subprocess


def duration(path: str) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                          "format=duration", "-of", "csv=p=0", path],
                         capture_output=True, text=True).stdout.strip()
    return float(out or 0)


def silence_gaps(path: str, noise_db=-27, min_d=0.15, max_t=None):
    """[(start, end), ...] silent stretches of the narration."""
    cmd = ["ffmpeg", "-hide_banner", "-i", path]
    if max_t:
        cmd += ["-t", str(max_t)]
    cmd += ["-af", f"silencedetect=noise={noise_db}dB:d={min_d}", "-f", "null", "-"]
    out = subprocess.run(cmd, capture_output=True, text=True).stderr
    starts = [float(m) for m in re.findall(r"silence_start: ([0-9.]+)", out)]
    ends = [float(m) for m in re.findall(r"silence_end: ([0-9.]+)", out)]
    return list(zip(starts, ends[:len(starts)]))


def try_whisper_words(audio: str, model_size: str, language, log=print):
    """[(word, start, end)] or None if whisper unavailable."""
    try:
        from faster_whisper import WhisperModel
        log(f"  whisper ({model_size}) transcribing narration ...")
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        segs, info = model.transcribe(audio, word_timestamps=True,
                                      language=language)
        words = []
        for seg in segs:
            for w in seg.words or []:
                words.append((w.word.strip(), w.start, w.end))
        log(f"  whisper: {len(words)} words ({info.language})")
        return words or None
    except Exception as exc:
        log(f"  whisper unavailable ({type(exc).__name__}) -> silence-snap sync")
        return None


def scene_windows(scenes, audio: str, model_size="base", language=None,
                  log=print):
    """Per-scene (start, end) seconds + optional per-word times.

    scenes: objects with .narration (text). Returns (windows, words|None).
    """
    total = duration(audio)
    counts = [max(1, len(s.narration.split())) for s in scenes]
    total_words = sum(counts)

    words = try_whisper_words(audio, model_size, language, log)
    if words:
        # boundary = end time of the last word belonging to each scene
        bounds, acc = [0.0], 0
        for c in counts[:-1]:
            acc += c
            idx = min(len(words) - 1, round(acc * len(words) / total_words))
            bounds.append(words[idx][1])
        bounds.append(total)
    else:
        # weighted split, then snap each boundary to the nearest silence gap
        gaps = silence_gaps(audio)
        centers = [(a + b) / 2 for a, b in gaps]
        bounds, t = [0.0], 0.0
        for c in counts[:-1]:
            t += total * c / total_words
            near = min(centers, key=lambda g: abs(g - t), default=t)
            bounds.append(near if abs(near - t) <= 1.4 else t)
        bounds.append(total)
    # monotonic + min scene length guard
    for i in range(1, len(bounds)):
        bounds[i] = max(bounds[i], bounds[i - 1] + 1.2)
    bounds[-1] = total
    windows = [(bounds[i], bounds[i + 1]) for i in range(len(scenes))]
    return windows, words


def word_time(words, scene_window, scene_text, word_index):
    """Absolute time when the scene's Nth word is spoken (interpolated when
    whisper words are unavailable)."""
    w0, w1 = scene_window
    n = max(1, len(scene_text.split()))
    return w0 + (w1 - w0) * (word_index / n)
