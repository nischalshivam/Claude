"""Run a queue of videos unattended.

Order of operations is the whole point:

    1. pre-flight EVERY job          (minutes, no rendering)
    2. render only the jobs that passed
    3. report

Queue 25 videos, go to sleep, and in the morning the ones that could be built
are built and the ones that could not are named, with the reason. A job that
fails never touches the ones behind it.

Output is written in the layout the existing editor tools already read:

    out/
      scene_001/
        clip_01.mp4      real footage, cut on shot boundaries
        image_01.jpg     a still from the same scene
        scene.txt        the narration for this beat
      scene_002/
      manifest.json      every asset with its score and provenance
      report.txt

Resuming is free: a scene whose folder already holds its assets is skipped, so
re-running after an interruption picks up where it stopped.
"""
from __future__ import annotations

import json
import os
import time
import traceback
from dataclasses import dataclass, field

from . import align, cutter, frames, jobs as jobs_mod, term
from .probe import ProbeError

MANIFEST = "manifest.json"


@dataclass
class SceneResult:
    index: int
    narration: str = ""
    clips: list = field(default_factory=list)
    stills: list = field(default_factory=list)
    status: str = "empty"        # cut | reused | fallback | empty
    note: str = ""
    source: str = ""
    confidence: str = ""
    # How each asset in this scene got its position. An interpolated shot is
    # a good guess — the scene's own chronology between two anchors — but it
    # is still a guess, and a manifest that does not distinguish the two
    # gives an editor no way to know which shots are worth checking.
    methods: dict = field(default_factory=dict)     # {"clip_01.mp4": "anchor"}

    @property
    def ok(self) -> bool:
        return bool(self.clips or self.stills)

    @property
    def anchored(self) -> int:
        return sum(1 for m in self.methods.values() if m == "anchor")

    @property
    def interpolated(self) -> int:
        return sum(1 for m in self.methods.values() if m == "interpolated")


@dataclass
class JobResult:
    job: jobs_mod.Job
    status: str = "pending"      # done | partial | skipped | failed
    scenes: list = field(default_factory=list)
    seconds: float = 0.0
    error: str = ""

    @property
    def clips(self) -> int:
        return sum(len(s.clips) for s in self.scenes)

    @property
    def stills(self) -> int:
        return sum(len(s.stills) for s in self.scenes)

    @property
    def gaps(self) -> int:
        return sum(1 for s in self.scenes if not s.ok)

    @property
    def icon(self) -> str:
        return {"done": term.sym("ok"), "partial": term.sym("warn"),
                "skipped": term.sym("skip"), "failed": term.sym("fail"),
                "pending": term.sym("pending")}[self.status]


def _scene_dir(job, index: int) -> str:
    return os.path.join(job.out, f"scene_{index:03d}")


def _already_built(scene_dir: str) -> tuple:
    """(clips, stills) already present, so a resumed run does not redo them."""
    if not os.path.isdir(scene_dir):
        return [], []
    names = sorted(os.listdir(scene_dir))
    clips = [os.path.join(scene_dir, n) for n in names
             if n.startswith("clip_") and n.lower().endswith(".mp4")]
    stills = [os.path.join(scene_dir, n) for n in names
              if n.startswith("image_") and n.lower().endswith((".jpg", ".png"))]
    return clips, stills


def _narration_for(beat: dict) -> str:
    return (beat.get("narration") or beat.get("Script Cue")
            or beat.get("script_cue") or "").strip()


# How far either side of a placement to look for still frames. A five second
# clip holds few distinct frames; a little air around it holds several.
STILL_WINDOW_S = 4.0


def _wants_still(shot: dict) -> bool:
    return str(shot.get("kind") or "").strip().lower() == "still"


def _still_count(shot: dict, default: int) -> int:
    try:
        return max(1, int(shot.get("count") or default))
    except (TypeError, ValueError):
        return default


def build_scene(job, index: int, beat: dict, placements: list,
                seen: list | None = None, log=lambda *a: None) -> SceneResult:
    """Cut every shot of one beat. Never raises — a bad scene is reported.

    Driven by alignment rather than by dialogue matches alone. On a real
    scene breakdown only 7% of shots quote a line — the famous scenes are
    the quiet ones — so cutting only what matched dialogue threw away 92% of
    the script and the queue produced almost nothing. Alignment places the
    silent shots along the scene between the few that did match.
    """
    res = SceneResult(index=index, narration=_narration_for(beat))
    scene_dir = _scene_dir(job, index)
    os.makedirs(scene_dir, exist_ok=True)

    clips, stills = _already_built(scene_dir)
    if clips or stills:
        res.clips, res.stills = clips, stills
        res.status = "reused"
        res.note = "already built — resumed"
        return res

    beat_no = beat.get("beat", index)
    shots = beat.get("shots") or []
    mine = [p for p in placements if p.beat == beat_no]
    unplaced = 0

    for p in mine:
        n = p.shot
        shot = shots[n - 1] if 0 < n <= len(shots) else {}
        if not p.ok or not p.path:
            unplaced += 1
            continue
        start = p.start_ms / 1000.0
        end = max(start + 1.0, p.end_ms / 1000.0)
        res.source = res.source or os.path.basename(p.path)
        # The weakest placement in the scene, not the last one seen: a scene
        # is only as trustworthy as its least certain shot.
        rank = {"high": 3, "medium": 2, "low": 1}
        if not res.confidence or rank.get(p.confidence, 0) < rank.get(res.confidence, 0):
            res.confidence = p.confidence

        try:
            if not _wants_still(shot):
                clip_path = os.path.join(scene_dir, f"clip_{n:02d}.mp4")
                cutter.cut_clip(p.path, start, min(end, start + job.clip_seconds),
                                clip_path, height=job.height)
                res.clips.append(clip_path)
                res.methods[os.path.basename(clip_path)] = p.method

            want = _still_count(shot, job.stills_per_scene)
            got = _stills_for(p.path, start, end, scene_dir, n, want, seen, log)
            res.stills += got
            for g in got:
                res.methods[os.path.basename(g)] = p.method
        except (ProbeError, ValueError, OSError) as exc:
            log(f"      scene {index}: shot {n} failed — {exc}")
            continue

    if res.clips or res.stills:
        res.status = "cut" if res.clips else "fallback"
        if unplaced:
            res.note = f"{unplaced} shot(s) could not be placed"
        elif not res.clips:
            res.note = "stills only"
    else:
        res.status = "empty"
        res.note = ("nothing in this beat could be placed — no quoted line "
                    "anywhere near it")

    if res.narration:
        with open(os.path.join(scene_dir, "scene.txt"), "w",
                  encoding="utf-8") as f:
            f.write(res.narration)
    return res


def _stills_for(path: str, start: float, end: float, scene_dir: str,
                shot_no: int, want: int, seen: list | None,
                log=lambda *a: None) -> list:
    """Sharp, distinct frames from around a placement.

    Sampling at fixed fractions of the clip was cheaper and wrong: it lands on
    motion blur, on the black frame between two shots, and on five views of
    one static moment. These are scored and de-duplicated against every still
    already taken for this video.
    """
    lo = max(0.0, start - STILL_WINDOW_S)
    hi = end + STILL_WINDOW_S
    try:
        cands = frames.scan(path, lo, hi)
    except ProbeError as exc:
        log(f"      still scan failed — {exc}")
        return []
    best = frames.pick(cands, want, exclude=seen)
    out = []
    for k, c in enumerate(best, 1):
        still = os.path.join(scene_dir, f"image_{shot_no:02d}_{k}.jpg")
        try:
            cutter.extract_frame(path, c.time, still, width=1920)
            out.append(still)
            if seen is not None:
                seen.append((c.phash, c.colour))
        except ProbeError:
            pass
    return out


def _asset_score(scene, path: str, ceiling: float) -> float:
    """How much an editor should trust this asset.

    A shot anchored on a quoted line is on that line to the millisecond. A
    shot interpolated along the scene is in the right place to within a shot
    or two. Flattening both to one number would hide the difference at the
    only moment it can still be checked cheaply.
    """
    method = scene.methods.get(os.path.basename(path), "unknown")
    base = {"high": 1.0, "medium": 0.7}.get(scene.confidence, 0.5)
    return round(ceiling * base * (1.0 if method == "anchor" else 0.75), 3)


def write_manifest(job, result: JobResult) -> str:
    """The contract the editor tools read: assets, scores, provenance."""
    payload = {
        "video": job.name,
        "generated_at": int(time.time()),
        "clip_seconds": job.clip_seconds,
        "scenes": [{
            "scene": s.index,
            "narration": s.narration,
            "status": s.status,
            "note": s.note,
            "source": s.source,
            "confidence": s.confidence,
            "anchored": s.anchored,
            "interpolated": s.interpolated,
            "assets": (
                [{"file": os.path.basename(p), "kind": "video",
                  "placed_by": s.methods.get(os.path.basename(p), "unknown"),
                  "score": _asset_score(s, p, 1.0)}
                 for p in s.clips]
                + [{"file": os.path.basename(p), "kind": "image",
                    "placed_by": s.methods.get(os.path.basename(p), "unknown"),
                    "score": _asset_score(s, p, 0.9)}
                   for p in s.stills]),
        } for s in result.scenes],
    }
    path = os.path.join(job.out, MANIFEST)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    return path


def run_job(job, report, log=print) -> JobResult:
    """Build one video's footage. Isolated: never propagates an exception."""
    t0 = time.time()
    result = JobResult(job=job)
    try:
        os.makedirs(job.out, exist_ok=True)
        # Placed once for the whole script: a run of shots from one episode
        # is laid along that scene together, which is what lets the silent
        # ones inherit a position from the few that quote a line.
        placements = align.align(job.db, report.beats, log=log)
        log("  " + align.summarise(placements))
        seen: list = []          # every still already taken, for de-duplication
        for i, beat in enumerate(report.beats, 1):
            scene = build_scene(job, i, beat, placements, seen, log)
            result.scenes.append(scene)
            mark = {"cut": "·", "reused": "=", "fallback": "~", "empty": "!"}
            log(f"    scene {i:03d} {mark[scene.status]} "
                f"{len(scene.clips)} clip(s), {len(scene.stills)} still(s)"
                + (f"   {scene.note}" if scene.note else ""))
        write_manifest(job, result)
        result.status = "done" if result.gaps == 0 else "partial"
    except Exception as exc:                    # one job must never kill the queue
        result.status = "failed"
        result.error = f"{type(exc).__name__}: {exc}"
        log(f"    FAILED: {result.error}")
        log(traceback.format_exc(limit=3))
    result.seconds = time.time() - t0
    return result


def run_queue(job_file: str, log=print, dry_run=False,
              allow_gaps=True) -> list[JobResult]:
    """Pre-flight everything, then build what passed."""
    queue = jobs_mod.load_jobs(job_file)
    log(f"{len(queue)} job(s) queued from {os.path.basename(job_file)}")

    reports = jobs_mod.preflight_all(queue, log=lambda m: log("  " + str(m)))
    log(jobs_mod.format_reports(reports))
    if dry_run:
        return [JobResult(job=r.job, status="skipped") for r in reports]

    results = []
    runnable = {id(r) for r in reports
                if r.status == "READY" or (allow_gaps and r.status == "GAPS")}
    log(f"\nBUILDING {len(runnable)} of {len(reports)} job(s)\n")

    for i, rep in enumerate(reports, 1):
        if id(rep) not in runnable:
            log(f"[{i}/{len(reports)}] ⏭  skipping {rep.job.name!r} — "
                + "; ".join(c.name for c in rep.failures() if c.fatal))
            results.append(JobResult(job=rep.job, status="skipped",
                                     error="; ".join(
                                         f"{c.name}: {c.detail}"
                                         for c in rep.failures() if c.fatal)))
            continue
        log(f"[{i}/{len(reports)}] building {rep.job.name!r} "
            f"({len(rep.beats)} beats)")
        results.append(run_job(rep.job, rep, log))

    log(format_results(results))
    _write_queue_report(job_file, reports, results)
    return results


def format_results(results: list[JobResult]) -> str:
    lines = ["", "RESULTS", ""]
    width = max((len(r.job.name) for r in results), default=10)
    for i, r in enumerate(results, 1):
        if r.status == "skipped":
            lines.append(f"  {r.icon} {i:>2}. {r.job.name:<{width}}  skipped — "
                         f"{r.error[:70]}")
            continue
        lines.append(f"  {r.icon} {i:>2}. {r.job.name:<{width}}  "
                     f"{len(r.scenes)} scenes {term.sym('dot')} {r.clips} clips "
                     f"{term.sym('dot')} {r.stills} stills "
                     f"{term.sym('dot')} {r.seconds:.0f}s"
                     + (f" {term.sym('dot')} {r.gaps} gap(s)" if r.gaps else "")
                     + (f" {term.sym('dot')} {r.error}" if r.error else ""))
    done = sum(1 for r in results if r.status == "done")
    partial = sum(1 for r in results if r.status == "partial")
    failed = sum(1 for r in results if r.status == "failed")
    skipped = sum(1 for r in results if r.status == "skipped")
    d = term.sym("dot")
    lines += ["", f"  {done} complete {d} {partial} with gaps {d} "
                  f"{failed} failed {d} {skipped} skipped"]
    return "\n".join(lines)


def _write_queue_report(job_file: str, reports, results) -> None:
    out = os.path.splitext(job_file)[0] + "_report.json"
    payload = []
    for rep, res in zip(reports, results):
        payload.append({
            "name": rep.job.name,
            "preflight": rep.status,
            "checks": [{"name": c.name, "ok": c.ok, "detail": c.detail,
                        "fatal": c.fatal} for c in rep.checks],
            "shots_total": rep.shots_total,
            "shots_resolved": rep.shots_resolved,
            "result": res.status,
            "clips": res.clips, "stills": res.stills, "gaps": res.gaps,
            "seconds": round(res.seconds, 1), "error": res.error,
            "out": rep.job.out,
        })
    try:
        with open(out, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
    except OSError:
        pass
