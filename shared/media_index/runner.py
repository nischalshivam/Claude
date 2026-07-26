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

from . import cutter, jobs as jobs_mod, term
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

    @property
    def ok(self) -> bool:
        return bool(self.clips or self.stills)


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


def build_scene(job, index: int, beat: dict, resolutions: list,
                log=lambda *a: None) -> SceneResult:
    """Cut every shot of one beat. Never raises — a bad scene is reported."""
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
    mine = [r for r in resolutions if r.beat == beat_no]

    for n, r in enumerate(mine, 1):
        if r.hit is None or r.status in ("not_found", "no_query"):
            continue
        if r.hit.confidence == "low":
            continue
        try:
            clip_path = os.path.join(scene_dir, f"clip_{n:02d}.mp4")
            cut = cutter.clip_for_hit(r.hit, clip_path,
                                      target_seconds=job.clip_seconds,
                                      height=job.height)
            res.clips.append(clip_path)
            res.source = r.hit.label
            res.confidence = r.hit.confidence

            # A still from the same moment. This is the images half of the
            # pipeline, and it is free once the clip has been located.
            for k in range(job.stills_per_scene):
                frac = (k + 1) / (job.stills_per_scene + 1)
                t = cut.start + cut.duration * frac
                still = os.path.join(scene_dir, f"image_{n:02d}_{k+1}.jpg")
                try:
                    cutter.extract_frame(r.hit.path, t, still, width=1920)
                    res.stills.append(still)
                except ProbeError:
                    pass
        except (ProbeError, ValueError, OSError) as exc:
            log(f"      scene {index}: shot {n} failed — {exc}")
            continue

    if res.clips:
        res.status = "cut"
    elif res.stills:
        res.status = "fallback"
        res.note = "no usable clip — stills only"
    else:
        res.status = "empty"
        weak = [r.status for r in mine]
        res.note = ("no dialogue match — needs visual search"
                    if not mine or set(weak) <= {"no_query", "not_found"}
                    else "matches were too weak to use")

    if res.narration:
        with open(os.path.join(scene_dir, "scene.txt"), "w",
                  encoding="utf-8") as f:
            f.write(res.narration)
    return res


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
            "assets": (
                [{"file": os.path.basename(p), "kind": "video",
                  "score": {"high": 1.0, "medium": 0.7}.get(s.confidence, 0.5)}
                 for p in s.clips]
                + [{"file": os.path.basename(p), "kind": "image",
                    "score": {"high": 0.9, "medium": 0.6}.get(s.confidence, 0.4)}
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
        for i, beat in enumerate(report.beats, 1):
            scene = build_scene(job, i, beat, report.resolutions, log)
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
