"""Decide how much timeline time each scene gets, synced to the narration audio.

Modes:
  whisper    — transcribe the full narration with faster-whisper (offline, free),
               then place scene boundaries where the script words actually occur.
  weighted   — no transcription: split the audio duration proportionally to each
               scene's narration word count. Surprisingly good for steady VO reads.
  per-scene  — user provides one audio file per scene (scene_001.mp3 …);
               each scene lasts exactly as long as its audio file.
  fixed      — no audio at all: every scene gets a fixed duration (preview mode).
"""
from __future__ import annotations

import difflib
import glob
import os
import re

from filmora.probe import audio_duration_secs

TICKS = 10_000_000


def _norm_words(text: str) -> list[str]:
    return re.findall(r"[\w']+", text.lower())


def weighted_windows(scenes, total_secs: float) -> list[tuple[int, int]]:
    counts = [s.word_count for s in scenes]
    total_words = sum(counts)
    windows, t = [], 0.0
    for c in counts:
        dur = total_secs * c / total_words
        windows.append((int(t * TICKS), int((t + dur) * TICKS)))
        t += dur
    b, _ = windows[-1]
    windows[-1] = (b, int(total_secs * TICKS))
    return windows


def fixed_windows(scenes, secs_per_scene: float) -> list[tuple[int, int]]:
    return [(int(i * secs_per_scene * TICKS), int((i + 1) * secs_per_scene * TICKS))
            for i in range(len(scenes))]


def per_scene_windows(scenes, audio_dir: str, log=print) -> list[tuple[int, int]]:
    windows, t = [], 0
    for s in scenes:
        matches = sorted(glob.glob(os.path.join(audio_dir, f"scene_{s.index:03d}.*")))
        if not matches:
            raise FileNotFoundError(
                f"No audio for scene {s.index} (expected scene_{s.index:03d}.mp3/.wav in {audio_dir})")
        dur = int(audio_duration_secs(matches[0]) * TICKS)
        windows.append((t, t + dur))
        t += dur
    return windows


def whisper_windows(scenes, audio_path: str, model_size: str = "base",
                    language: str | None = None, log=print) -> list[tuple[int, int]]:
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        log("  faster-whisper not installed -> falling back to 'weighted' alignment.")
        log("  (pip install faster-whisper  to enable precise alignment)")
        return weighted_windows(scenes, audio_duration_secs(audio_path))

    total_secs = audio_duration_secs(audio_path)
    log(f"  transcribing narration with Whisper ({model_size}) — first run downloads the model…")
    try:
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        segments, info = model.transcribe(audio_path, word_timestamps=True, language=language)
        words = []  # (word, start_sec)
        for seg in segments:
            for w in seg.words or []:
                words.append((w.word.strip().lower(), w.start))
    except Exception as exc:
        log(f"  WARNING: Whisper failed ({type(exc).__name__}: {exc}) "
            "-> falling back to 'weighted' alignment.")
        return weighted_windows(scenes, total_secs)
    if not words:
        log("  WARNING: transcription produced no words -> weighted fallback.")
        return weighted_windows(scenes, total_secs)
    log(f"  transcript: {len(words)} words, language={info.language}")

    t_words = [re.sub(r"[^\w']+", "", w) for w, _ in words]
    counts = [s.word_count for s in scenes]
    total_script = sum(counts)

    boundaries = [0.0]
    cum = 0
    for c in counts[:-1]:
        cum += c
        est = int(round(cum * len(words) / total_script))  # estimated transcript index
        est = max(1, min(len(words) - 1, est))
        # refine: the next scene's opening words should match here
        nxt_idx = len(boundaries)  # index of the scene that starts at this boundary
        opening = _norm_words(scenes[nxt_idx].narration)[:6]
        best_i, best_r = est, -1.0
        if opening:
            lo, hi = max(0, est - 20), min(len(words) - 1, est + 20)
            for i in range(lo, hi + 1):
                window = t_words[i:i + len(opening)]
                r = difflib.SequenceMatcher(None, opening, window).ratio()
                if r > best_r:
                    best_r, best_i = r, i
            if best_r < 0.3:
                best_i = est  # no confident match; keep proportional estimate
        boundaries.append(words[best_i][1])
    boundaries.append(total_secs)

    # enforce monotonic, minimum 1.5s per scene
    for i in range(1, len(boundaries)):
        boundaries[i] = max(boundaries[i], boundaries[i - 1] + 1.5)
    boundaries[-1] = total_secs

    return [(int(boundaries[i] * TICKS), int(boundaries[i + 1] * TICKS))
            for i in range(len(scenes))]


def compute_windows(scenes, mode: str, audio: str | None, scene_audio_dir: str | None,
                    fixed_secs: float, whisper_model: str, language: str | None,
                    log=print) -> list[tuple[int, int]]:
    if mode == "per-scene":
        return per_scene_windows(scenes, scene_audio_dir, log)
    if mode == "fixed" or not audio:
        if mode != "fixed":
            log("  no --audio given -> fixed scene durations (preview mode).")
        return fixed_windows(scenes, fixed_secs)
    if mode == "whisper":
        return whisper_windows(scenes, audio, whisper_model, language, log)
    return weighted_windows(scenes, audio_duration_secs(audio))
