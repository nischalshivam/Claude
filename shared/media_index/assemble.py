"""Stage 3: turn a matched shot-list into a finished video.

`plan.py` decided which catalogued moment plays under each beat. This cuts
those moments out of the source episodes and hands them to the tool's existing
timeline + render pipeline — the same one that paces a beat's cuts, alternates
clips and stills, varies durations so it doesn't tick like a metronome, and
lays the narration audio over the whole thing.

The bridge is a **manifest**: one scene per beat, each carrying the assets
(cut clips and stills) that beat may show. Producing that manifest from the
plan is the whole job here; everything after it — pacing, rendering, audio —
is machinery that already existed and is reused unchanged.

Cutting reads the real episode files, so the cut step runs where the footage
lives. The manifest-building is pure and injectable, so it is tested with
neither ffmpeg nor a video.
"""
from __future__ import annotations

import json
import os
from collections import defaultdict

from . import plan as plan_mod

# A clip is cut a little longer than the script's target so the timeline,
# which decides the real on-screen duration, always has footage to show and
# never has to freeze a too-short clip.
CLIP_PAD_S = 3.0
MIN_CLIP_S = 5.0
STILL_WIDTH = 1920


def _grab_clip(cut_clip, source_file, start, want_s, out):
    """Cut [start, start+want_s] of the source into `out`. Returns True/ok."""
    try:
        cut_clip(source_file, start, start + want_s, out)
        return True
    except Exception:
        return False


def build_manifest(beats: list, library: dict, out_dir: str, scope: str = "",
                   cut_clip=None, extract_frame=None,
                   log=lambda *a: None) -> dict:
    """Cut every matched shot and return the manifest the timeline consumes.

    `cut_clip(path, start, end, out)` and `extract_frame(path, t, out, width)`
    are injected (default to the real ffmpeg ones) so this is testable offline.
    Assets land in `out_dir/scene_NNN/`, exactly where `render` looks for them.
    """
    if cut_clip is None or extract_frame is None:
        from .cutter import cut_clip as _cc, extract_frame as _ef
        cut_clip = cut_clip or _cc
        extract_frame = extract_frame or _ef

    pairs, stats = plan_mod.plan(beats, library, scope=scope)
    log(f"  {stats.summary()}")

    by_beat = defaultdict(list)
    for req, m in pairs:
        by_beat[req.beat].append((req, m))

    scenes = []
    cut, skipped = 0, 0
    for beat in beats:
        bn = beat.get("beat") or 0
        scene_dir = os.path.join(out_dir, f"scene_{bn:03d}")
        os.makedirs(scene_dir, exist_ok=True)
        assets = []
        for idx, (req, m) in enumerate(by_beat.get(bn, [])):
            if not m.placed:
                skipped += 1
                continue
            shot = m.shot
            if req.kind == "still":
                name = f"still_{idx:02d}.jpg"
                mid = (shot.start + shot.end) / 2.0
                ok = False
                try:
                    extract_frame(shot.file, mid, os.path.join(scene_dir, name),
                                  STILL_WIDTH)
                    ok = True
                except Exception:
                    ok = False
                kind = "image"
            else:
                name = f"clip_{idx:02d}.mp4"
                want = max(MIN_CLIP_S, (req.duration or 0) + CLIP_PAD_S)
                ok = _grab_clip(cut_clip, shot.file, shot.start, want,
                                os.path.join(scene_dir, name))
                kind = "video"
            if not ok:
                skipped += 1
                continue
            assets.append({
                "file": name, "kind": kind, "source": shot.source,
                "source_start": round(shot.start, 2),
                "placed_by": m.method, "confidence": m.why[:60]})
            cut += 1
        scenes.append({
            "scene": bn, "narration": beat.get("narration", ""),
            "assets": assets})
        if bn % 5 == 0 or bn == (beats[-1].get("beat") if beats else 0):
            log(f"      scene {bn}: {len(assets)} asset(s) cut")

    manifest = {"video": _title(beats), "scenes": scenes,
                "cut": cut, "skipped": skipped}
    with open(os.path.join(out_dir, "manifest.json"), "w",
              encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    log(f"  {cut} shots cut, {skipped} skipped  →  {out_dir}")
    return manifest


def _title(beats: list) -> str:
    for b in beats:
        for s in (b.get("shots") or []):
            if s.get("source"):
                return str(s["source"])
    return "video"


def make_video(script_beats: list, library: dict, audio: str, out_dir: str,
               total_seconds: float = 0.0, scope: str = "", pace: str = "normal",
               clean: str = "", log=lambda *a: None) -> str:
    """Whole of Stage 3: cut the shots, time them to the voiceover, render.

    Returns the finished mp4 path. Reuses `timeline` (pacing), `narration`
    (aligning each beat to the second its line is actually spoken) and `render`
    (cut→concat→audio) unchanged; only the manifest in between is new.

    `clean` is the full narration text. It matters because a genspark script
    covers only the visual beats — maybe a third of what is spoken — so the
    beats have to be located inside the FULL narration first, then that
    narration aligned to the audio. Without it (or without a transcriber) the
    timing falls back to an even-read estimate, which still renders but drifts
    wherever the narrator paused.
    """
    from . import timeline, render, narration, probe
    os.makedirs(out_dir, exist_ok=True)

    if not total_seconds and os.path.isfile(audio):
        try:
            total_seconds = probe.probe(audio).duration
        except Exception:
            total_seconds = 0.0

    log("  cutting matched shots...")
    build_manifest(script_beats, library, out_dir, scope=scope, log=log)
    manifest = timeline.load_manifest(out_dir)

    # Word-sync: place each beat where its line is actually spoken. Graceful —
    # no transcriber or a failed listen just leaves `spans` None and the
    # timeline uses its even-read estimate.
    spans = None
    log("  voiceover ke saath timing align kar rahe hain...")
    try:
        heard = narration.align_audio(script_beats, audio,
                                      total_seconds=total_seconds, clean=clean,
                                      log=log)
        log(heard.summary())
        if heard.ok:
            spans = heard.spans
    except Exception as exc:
        log(f"      alignment skip ({exc}) — even-read estimate use hoga")

    tl = timeline.plan(script_beats, manifest, total_seconds=total_seconds,
                       audio=audio, pace=pace, spans=spans)
    timeline.write(tl, out_dir)
    log(tl.summary())

    log("  rendering final video...")
    res = render.render_folder(out_dir, audio=audio, log=log)
    log(render.describe(res))
    return os.path.join(out_dir, "video.mp4")
