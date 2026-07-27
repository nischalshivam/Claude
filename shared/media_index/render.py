"""Turn a timeline into a finished video file.

Everything before this produces folders. Folders are not a video, and until
something plays end to end there is no way to judge the thing that is
actually being made — a contact sheet cannot tell you that a cut lands two
beats late, or that a still sits dead on screen for nine seconds.

The method is deliberately dull, because dull is what survives 150 shots:

  1. render every item to its own segment, all in one identical format
  2. concatenate the segments without re-encoding
  3. lay the narration over the result

The obvious alternative — one enormous ffmpeg filter graph with every clip
as an input — is faster and falls over. A 150-input command exceeds what
Windows will accept on a command line, one bad source kills the whole render
with no clue which, and there is nothing to resume from. Separate segments
cost one extra encode and buy a build that can be interrupted, restarted,
and diagnosed a shot at a time.

## Stills move

A still held for ten seconds is a slideshow, and a slideshow is the second
thing a viewer notices after identical durations. Every essay channel worth
copying puts a slow push or drift on a held frame, so these do too — with
the direction and speed varying per shot, seeded off the timeline so a
re-render is identical.

The image is scaled up before the move and back down after. Panning a
1920-wide still directly makes the pixel grid crawl, which is visible and
looks cheap; doing the motion at 3840 and resampling down does not.
"""
from __future__ import annotations

import json
import os
import random
import subprocess
import time
from dataclasses import dataclass, field

from .probe import ProbeError, probe, require_ffmpeg

WIDTH, HEIGHT = 1920, 1080
FPS = 30
# High enough that the concatenated master loses nothing worth having, and
# the final mux is a stream copy so this is the only encode that matters.
SEGMENT_CRF = 18
SEGMENT_PRESET = "veryfast"
# How far a still travels over its time on screen. Small on purpose: the
# move should be felt rather than seen.
ZOOM_RANGE = (1.06, 1.16)
WORK_DIR = "segments"


class RenderError(RuntimeError):
    pass


@dataclass
class RenderResult:
    path: str = ""
    segments: int = 0
    reused: int = 0
    failed: list = field(default_factory=list)     # [(file, reason)]
    seconds: float = 0.0
    duration: float = 0.0

    @property
    def ok(self) -> bool:
        return bool(self.path) and os.path.isfile(self.path)


def _run(cmd: list, timeout: int = 1800) -> None:
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as exc:
        raise RenderError(str(exc)) from exc
    if r.returncode != 0:
        tail = (r.stderr or b"")[-400:].decode("utf-8", "replace")
        raise RenderError(tail.strip() or f"ffmpeg exited {r.returncode}")


FIT = (f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=decrease,"
       f"pad={WIDTH}:{HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1")


def still_filter(duration: float, seed: int, motion: bool = True) -> str:
    """The move applied to a held frame.

    Direction and distance vary per shot so that twenty stills in a row do
    not all drift the same way — which would be a signature of its own,
    just a subtler one than identical durations.
    """
    frames = max(2, int(round(duration * FPS)))
    if not motion:
        return f"{FIT},fps={FPS}"
    rng = random.Random(f"still:{seed}")
    end = rng.uniform(*ZOOM_RANGE)
    # Half push in, half pull out.
    if rng.random() < 0.5:
        z = f"min(1+({end - 1:.4f})*on/{frames},{end:.4f})"
    else:
        z = f"max({end:.4f}-({end - 1:.4f})*on/{frames},1.0)"
    # Drift the centre a little as well, in one of four directions.
    dx, dy = rng.choice([(1, 0), (-1, 0), (0, 1), (0, -1)])
    px = f"(iw-iw/zoom)/2+{dx}*(iw-iw/zoom)/2*on/{frames}*0.35"
    py = f"(ih-ih/zoom)/2+{dy}*(ih-ih/zoom)/2*on/{frames}*0.35"
    return (f"scale={WIDTH * 2}:-2,"
            f"zoompan=z='{z}':x='{px}':y='{py}':d={frames}:"
            f"s={WIDTH}x{HEIGHT}:fps={FPS},setsar=1")


def render_item(item: dict, source_dir: str, out_path: str, seed: int,
                motion: bool = True) -> None:
    """One visual, encoded to the one format every segment shares."""
    name = item.get("file") or ""
    src = os.path.join(source_dir, name)
    if not os.path.isfile(src):
        raise RenderError(f"missing {name}")
    duration = max(0.1, float(item.get("duration") or 0))
    ff = require_ffmpeg()

    if str(item.get("kind")) == "video":
        cmd = [ff, "-y", "-v", "error", "-i", src, "-t", f"{duration:.3f}",
               "-vf", f"{FIT},fps={FPS}"]
    else:
        cmd = [ff, "-y", "-v", "error", "-loop", "1", "-i", src,
               "-t", f"{duration:.3f}",
               "-vf", still_filter(duration, seed, motion)]
    # No audio on a segment. The film's own sound under a narration track is
    # a mixing decision, and mixing it in here would bake it in permanently.
    cmd += ["-an", "-c:v", "libx264", "-crf", str(SEGMENT_CRF),
            "-preset", SEGMENT_PRESET, "-pix_fmt", "yuv420p",
            "-r", str(FPS), out_path]
    _run(cmd)


def _concat(segments: list, out_path: str, work: str) -> None:
    """Join segments without re-encoding them."""
    listing = os.path.join(work, "segments.txt")
    with open(listing, "w", encoding="utf-8") as f:
        for seg in segments:
            # ffmpeg's concat parser takes single quotes literally, so a
            # path containing one has to escape it. Windows paths rarely do;
            # a show called "Bob's Burgers" does.
            safe = os.path.abspath(seg).replace("'", "'\\''")
            f.write(f"file '{safe}'\n")
    _run([require_ffmpeg(), "-y", "-v", "error", "-f", "concat", "-safe", "0",
          "-i", listing, "-c", "copy", out_path])


def _add_audio(video: str, audio: str, out_path: str) -> None:
    """Lay the narration over the picture, copying the video through."""
    _run([require_ffmpeg(), "-y", "-v", "error", "-i", video, "-i", audio,
          "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
          "-c:a", "aac", "-b:a", "192k", "-shortest", out_path])


def render(timeline: dict, out_path: str, source_dir: str = "",
           audio: str = "", motion: bool = True, resume: bool = True,
           log=lambda *a: None) -> RenderResult:
    """Build the finished file. Never raises — a bad shot is reported.

    Resuming is free and matters: this is the slow step, and a queue of six
    videos overnight must not lose four hours to one interrupted render.
    """
    res = RenderResult()
    t0 = time.time()
    source_dir = source_dir or os.path.dirname(os.path.abspath(out_path))
    work = os.path.join(source_dir, WORK_DIR)
    os.makedirs(work, exist_ok=True)

    items = [(s, i) for s in (timeline.get("scenes") or [])
             for i in (s.get("items") or [])]
    if not items:
        res.failed.append(("timeline", "no items to render"))
        return res

    log(f"  rendering {len(items)} segment(s) at {WIDTH}x{HEIGHT}")
    segments = []
    for n, (scene, item) in enumerate(items, 1):
        seg = os.path.join(work, f"seg_{n:04d}.mp4")
        scene_dir = os.path.join(source_dir, f"scene_{scene.get('scene'):03d}")
        if resume and os.path.isfile(seg) and os.path.getsize(seg) > 1024:
            segments.append(seg)
            res.reused += 1
            continue
        try:
            render_item(item, scene_dir, seg, seed=n, motion=motion)
            segments.append(seg)
            res.segments += 1
        except (RenderError, ProbeError, ValueError) as exc:
            res.failed.append((item.get("file", "?"), str(exc)[:160]))
            log(f"      segment {n} failed — {exc}")
        if n % 25 == 0:
            log(f"      {n}/{len(items)}  ({time.time() - t0:.0f}s)")

    if not segments:
        res.failed.append(("render", "every segment failed"))
        return res

    silent = os.path.join(work, "picture.mp4")
    log(f"  joining {len(segments)} segment(s)")
    try:
        _concat(segments, silent, work)
    except RenderError as exc:
        res.failed.append(("concat", str(exc)[:200]))
        return res

    final = out_path
    if audio and os.path.isfile(audio):
        log("  laying the narration over it")
        try:
            _add_audio(silent, audio, final)
        except RenderError as exc:
            res.failed.append(("audio", str(exc)[:200]))
            final = silent
    else:
        os.replace(silent, final)
        if audio:
            res.failed.append(("audio", f"not found: {audio}"))

    res.path = final if os.path.isfile(final) else ""
    try:
        res.duration = probe(res.path).duration if res.path else 0.0
    except ProbeError:
        res.duration = 0.0
    res.seconds = time.time() - t0
    return res


def render_folder(out_dir: str, out_name: str = "video.mp4",
                  audio: str = "", motion: bool = True, resume: bool = True,
                  log=lambda *a: None) -> RenderResult:
    """Render the timeline.json sitting in a built folder."""
    path = os.path.join(out_dir, "timeline.json")
    if not os.path.isfile(path):
        res = RenderResult()
        res.failed.append(("timeline.json",
                           "not found — plan the timing first"))
        return res
    with open(path, "r", encoding="utf-8-sig") as f:
        timeline = json.load(f)
    audio = audio or timeline.get("audio") or ""
    return render(timeline, os.path.join(out_dir, out_name),
                  source_dir=out_dir, audio=audio, motion=motion,
                  resume=resume, log=log)


def describe(res: RenderResult) -> str:
    from . import term
    d = term.sym("dot")
    if not res.ok:
        why = "; ".join(f"{a}: {b}" for a, b in res.failed[:3])
        return f"  nothing was written — {why or 'unknown'}"
    return (f"  {os.path.basename(res.path)} {d} "
            f"{res.duration / 60:.1f} min {d} "
            f"{res.segments} rendered, {res.reused} reused {d} "
            f"{res.seconds / 60:.0f} min"
            + (f" {d} {len(res.failed)} shot(s) failed" if res.failed else ""))
