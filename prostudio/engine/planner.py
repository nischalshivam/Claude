"""The editor brain — scenes + QC'd media + timing -> a concrete shot plan.

Rules (from the user's manual-editing workflow + competitor analysis):
  - video clips carry the story: 2-5s each, placed first in every scene
  - images fill the remaining narration time: 3-7s, ALWAYS with motion
  - best-scored media first; repeats only when a scene is starved (with a
    different motion so it doesn't look repeated)
  - J/L cuts: visual boundaries lead/lag the audio boundary by ~0.4s
    (alternating), like a human editor
  - every item gets a text zone from subject analysis (negative space)
"""
from __future__ import annotations

import glob
import os
import random
import re
import subprocess
import tempfile
from dataclasses import dataclass, field

from .qc import IMAGE_EXT, VIDEO_EXT, MediaScore, qc_scene_media

_FRAME_CACHE = os.path.join(tempfile.gettempdir(), "prostudio_frames")


def _clip_fill_frames(clip_path, n):
    """Extract N stills from DIFFERENT moments of a clip → distinct Ken Burns
    shots (used when a scene is starved of images, instead of repeating a clip)."""
    from .audio_sync import duration
    os.makedirs(_FRAME_CACHE, exist_ok=True)
    d = max(1.0, duration(clip_path))
    base = os.path.splitext(os.path.basename(clip_path))[0]
    tag = str(abs(hash(clip_path)) % 100000)
    outs = []
    for i in range(n):
        ts = d * (i + 0.5) / n
        out = os.path.join(_FRAME_CACHE, f"{base}_{tag}_{i}.jpg")
        if not os.path.isfile(out):
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{ts:.2f}",
                            "-i", clip_path, "-frames:v", "1", "-q:v", "2", out],
                           capture_output=True)
        if os.path.isfile(out):
            outs.append(MediaScore(path=out, kind="image", ok=True))
    return outs


@dataclass
class Scene:
    index: int
    dir: str
    narration: str = ""
    mood: str = "neutral"
    videos: list = field(default_factory=list)   # MediaScore
    images: list = field(default_factory=list)
    rejected: list = field(default_factory=list)


@dataclass
class Shot:
    path: str
    kind: str                # image | video
    t0: float
    t1: float
    scene_i: int
    mood: str = "neutral"
    zoom_in: bool = True
    punch_in: bool = False   # organic mid-shot push
    drift_seed: int = 0
    faces: list = field(default_factory=list)   # face boxes for text-zone veto
    transition: str | None = None   # into the NEXT shot

    @property
    def secs(self):
        return self.t1 - self.t0


def _natkey(p):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", p)]


def read_scenes(scenes_dir: str, log=print) -> list:
    dirs = sorted((d for d in glob.glob(os.path.join(scenes_dir, "scene_*"))
                   if os.path.isdir(d)), key=_natkey)
    if not dirs:
        raise FileNotFoundError(f"no scene_* folders in {scenes_dir}")
    from .script_nlp import scene_mood
    scenes, seen = [], []
    total_rej = 0
    for i, d in enumerate(dirs):
        s = Scene(index=i, dir=d)
        files = sorted(
            (f for f in glob.glob(os.path.join(d, "*"))
             if f.lower().endswith(IMAGE_EXT + VIDEO_EXT)), key=_natkey)
        s.videos, s.images, s.rejected = qc_scene_media(files, seen, log)
        total_rej += len(s.rejected)
        txt = os.path.join(d, "scene.txt")
        if os.path.isfile(txt):
            raw = open(txt, encoding="utf-8", errors="replace").read()
            m = re.search(r"NARRATION\s*/?\s*TEXT\s*:\s*(.+)", raw,
                          re.S | re.I)
            body = m.group(1) if m else raw
            body = body.strip().strip('“”"').strip()
            s.narration = " ".join(body.split())
        s.mood = scene_mood(s.narration)
        scenes.append(s)
    log(f"  scenes: {len(scenes)}, media rejected by QC: {total_rej}")
    return scenes


def plan_shots(scenes, windows, rng: random.Random, log=print,
               clip_min=2.0, clip_max=5.0, img_min=2.6, img_max=7.0,
               jl_offset=0.4):
    shots = []
    for si, (scene, (w0, w1)) in enumerate(zip(scenes, windows)):
        # J/L cut: shift the visual boundary off the audio boundary
        v0 = max(0.0, w0 - jl_offset) if (si % 2 == 1 and si > 0) else w0
        v1 = w1
        span = v1 - v0
        pool_v = list(scene.videos)
        pool_i = list(scene.images)
        # budget clips first (they carry the story)
        t = v0
        scene_shots = []
        for v in pool_v:
            if v1 - t < clip_min:
                break
            d = min(clip_max, max(clip_min, span * 0.45), v1 - t)
            scene_shots.append(Shot(v.path, "video", t, t + d, si, scene.mood))
            t += d
        # images fill the rest — each UNIQUE image is used once; we prefer
        # longer holds (strong Ken Burns covers it) over repeating a visual,
        # and only repeat when a scene genuinely lacks media (evenly, minimal).
        import math
        remaining = v1 - t
        imgs = list(pool_i)                       # unique real images, best-first
        if remaining >= img_min:
            max_hold, target = 8.5, 5.5
            need_min = max(1, math.ceil(remaining / max_hold))
            n_pref = max(1, round(remaining / target))
            # top up a media-starved scene with distinct frames from its clip
            # (never repeat the same visual)
            if len(imgs) < max(need_min, n_pref) and scene.videos:
                short = max(need_min, n_pref) - len(imgs)
                imgs += _clip_fill_frames(scene.videos[0].path, min(short, 4))
            if not imgs:
                imgs = list(pool_v)               # last resort
            n = min(len(imgs), max(need_min, n_pref)) if imgs else 0
            seq = imgs[:n]                         # unique only, NO repeats
            if not seq:
                if scene_shots:
                    scene_shots[-1].t1 = v1       # nothing to fill with: hold
                shots_span = None
            else:
                share = remaining / len(seq)
                for k, m in enumerate(seq):
                    d = share if k < len(seq) - 1 else (v1 - t)
                    scene_shots.append(Shot(m.path, m.kind, t, t + d, si,
                                            scene.mood))
                    t += d
        elif remaining > 0 and scene_shots:
            scene_shots[-1].t1 = v1
        # per-shot flavour: alternating zoom, occasional punch-in, drift seed,
        # detected faces (so text can be placed in negative space later)
        from .subjects import detect_faces
        for j, sh in enumerate(scene_shots):
            sh.zoom_in = (j + si) % 2 == 0
            sh.punch_in = rng.random() < 0.22 and sh.secs > 3.0
            sh.drift_seed = rng.randrange(1000)
            sh.faces = detect_faces(sh.path, sh.kind)
        shots.extend(scene_shots)

    # transitions: within-scene soft, scene-boundary strong (format decides look)
    for a, b in zip(shots, shots[1:]):
        a.transition = "scene" if b.scene_i != a.scene_i else "soft"
    return shots
