"""Running a build from the browser, without the browser waiting for it.

Everything the menu does in one long blocking run — pre-flight, cut the
footage, time it, render it — happens here on a thread, with a status a page
can ask about every second. Nothing new is decided: this calls exactly the
same functions the menu calls, in the same order, so a video built from the
form is the same video, byte for byte, as one built from `9`, `T`, `R`.

## Why a task and not a request

A pre-flight on a 55-beat script resolves every shot against the whole
library, and a build is forty minutes. Both are far past what a browser will
sit still for, and a page that dies at ninety seconds looks exactly like a
tool that crashed. So a request starts a task and gets an id back, and the
page asks how it is going.

## What is deliberately not here

No queue. One thing at a time, because two builds at once would fight over
ffmpeg and the disk and finish slower than one after the other — and because
"which of these two failed?" is a question nobody should have to answer.
"""
from __future__ import annotations

import os
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field

from . import jobs as jobs_mod

# How many log lines a task keeps. Enough to see what went wrong, bounded so
# a forty-minute render cannot grow without limit.
KEPT_LINES = 400


@dataclass
class Task:
    """One check or one build, and everything a page can ask about it."""
    id: str
    kind: str                       # "check" | "build"
    name: str = ""
    status: str = "running"         # running | done | failed | blocked
    stage: str = ""                 # the human line under the bar
    scenes_done: int = 0
    scenes_total: int = 0
    started: float = field(default_factory=time.time)
    finished: float = 0.0
    error: str = ""
    report: dict = field(default_factory=dict)      # a check's verdict
    out: str = ""
    video: str = ""
    lines: list = field(default_factory=list)

    @property
    def seconds(self) -> float:
        return (self.finished or time.time()) - self.started

    @property
    def percent(self) -> int:
        if self.status in ("done", "failed", "blocked"):
            return 100
        if not self.scenes_total:
            return 0
        return min(99, int(self.scenes_done * 100 / self.scenes_total))

    def as_dict(self) -> dict:
        return {"id": self.id, "kind": self.kind, "name": self.name,
                "status": self.status, "stage": self.stage,
                "scenes_done": self.scenes_done,
                "scenes_total": self.scenes_total,
                "percent": self.percent, "seconds": round(self.seconds, 1),
                "error": self.error, "report": self.report, "out": self.out,
                "video": self.video, "lines": self.lines[-40:]}


class Runner:
    """Every task this session has run, and the one that is running."""

    def __init__(self):
        self._tasks: dict = {}
        self._order: list = []
        self._lock = threading.Lock()
        self._busy = threading.Lock()

    def get(self, task_id: str):
        with self._lock:
            return self._tasks.get(task_id)

    def all(self) -> list:
        with self._lock:
            return [self._tasks[i].as_dict() for i in self._order
                    if i in self._tasks]

    def _new(self, kind: str, name: str) -> Task:
        task = Task(id=uuid.uuid4().hex[:12], kind=kind, name=name)
        with self._lock:
            self._tasks[task.id] = task
            self._order.append(task.id)
        return task

    def _log(self, task: Task):
        def write(*parts):
            text = " ".join(str(p) for p in parts).rstrip()
            if not text:
                return
            with self._lock:
                task.lines.append(text)
                del task.lines[:-KEPT_LINES]
            # The build's own log is the only thing that knows how far in it
            # is. Reading the count off it beats threading a progress
            # callback through five modules that have no other reason to
            # know a browser exists.
            stripped = text.strip()
            if stripped.startswith("scene ") and task.scenes_total:
                head = stripped.split()[1]
                if head.isdigit():
                    task.scenes_done = max(task.scenes_done, int(head))
            task.stage = text.strip()[:160]
        return write

    def start(self, kind: str, name: str, work) -> Task:
        """Run `work(task, log)` on a thread. One at a time."""
        task = self._new(kind, name)

        def run():
            log = self._log(task)
            with self._busy:
                outcome, error = "done", ""
                try:
                    work(task, log)
                    if task.status != "running":
                        outcome = task.status   # work reached its own verdict
                except Exception as exc:        # a task must never take the
                    outcome = "failed"          # server down with it
                    error = f"{type(exc).__name__}: {exc}"
                    log(error)
                    log(traceback.format_exc(limit=3))
                if error:
                    task.error = error
                task.finished = time.time()
                # Status changes last, and on purpose. The page stops asking
                # the moment it stops saying "running", so anything it will
                # want to read afterwards — the error, the elapsed time —
                # has to already be there when it looks.
                task.status = outcome

        threading.Thread(target=run, daemon=True).start()
        return task


def job_from(spec: dict, db: str) -> jobs_mod.Job:
    """A form's answers as the Job every other module already understands."""
    return jobs_mod.Job(
        name=(spec.get("name") or "video").strip(),
        script=os.path.abspath(spec.get("script") or ""),
        audio=os.path.abspath(spec["audio"]) if spec.get("audio") else "",
        out=os.path.abspath(spec.get("out") or "output"),
        db=os.path.abspath(spec.get("db") or db),
        clip_seconds=float(spec.get("clip_seconds") or 4.0),
        stills_per_scene=int(spec.get("stills") or 2),
        extras={k: v for k, v in spec.items()
                if k in ("pace", "quality", "captions", "preset", "after",
                         "transitions", "filters", "animation", "title")})


def report_dict(rep) -> dict:
    """A pre-flight as the Check panel draws it.

    The order is the order it is read in: the verdict, then what was
    checked, then the scenes that will be guesses — which is the one part
    someone can still do something about, by fixing the script.
    """
    weak = [r for r in rep.resolutions if r.status in ("weak", "no_query")]
    return {
        "verdict": rep.status,                  # READY | GAPS | BLOCKED
        "beats": len(rep.beats),
        "shots": rep.shots_total,
        "placeable": rep.placeable,
        "resolved": rep.shots_resolved,
        "percent": int(round(rep.placeable_fraction * 100)),
        "narration_seconds": round(rep.narration_seconds, 1),
        "checks": [{"name": c.name, "ok": c.ok, "detail": c.detail,
                    "fatal": c.fatal} for c in rep.checks],
        "weak_scenes": sorted({r.beat for r in weak if getattr(r, "beat", None)}),
        "episodes": sorted({r.title for r in rep.requirements}),
    }


def check(runner: Runner, spec: dict, db: str) -> Task:
    """Everything that can be known before a single frame is cut."""
    job = job_from(spec, db)

    def work(task, log):
        log(f"checking {job.name!r}")
        rep = jobs_mod.preflight(job, log=log)
        task.report = report_dict(rep)
        task.out = job.out
        task.status = "blocked" if rep.status == "BLOCKED" else "done"
        task.stage = f"{rep.status} · {task.report['percent']}% shots placeable"
        log(task.stage)

    return runner.start("check", job.name, work)


def build(runner: Runner, spec: dict, db: str) -> Task:
    """Pre-flight, cut the footage, time it, and — if asked — render it.

    The same three steps as `9`, `T`, `R`, and in that order for the same
    reason: re-timing is seconds and re-cutting is an hour, so the timing is
    written as its own file rather than baked into the footage.
    """
    from . import narration, probe, render, runner as runner_mod, timeline

    job = job_from(spec, db)
    to_editor = (spec.get("after") or "editor") != "export"

    def work(task, log):
        task.out = job.out
        log(f"pre-flight for {job.name!r}")
        rep = jobs_mod.preflight(job, log=log)
        task.report = report_dict(rep)
        if rep.status == "BLOCKED":
            task.status = "blocked"
            task.stage = "blocked — " + "; ".join(
                c.name for c in rep.failures() if c.fatal)
            log(task.stage)
            return
        task.scenes_total = len(rep.beats)
        task.stage = f"{len(rep.beats)} scenes — cutting footage"
        log(task.stage)

        result = runner_mod.run_job(job, rep, log=log)
        if result.status == "failed":
            task.status = "failed"
            task.error = result.error
            return
        task.scenes_done = task.scenes_total

        # --- timing -------------------------------------------------------
        task.stage = "timing it against the narration"
        log(task.stage)
        manifest = timeline.load_manifest(job.out)
        total, spans = 0.0, None
        if job.audio and os.path.isfile(job.audio):
            try:
                total = probe.probe(job.audio).duration
            except probe.ProbeError as exc:
                log(f"could not read the narration — {exc}")
            heard = narration.align_audio(rep.beats, job.audio,
                                          total_seconds=total, log=log)
            log(heard.summary())
            if heard.ok:
                spans = heard.spans
        tl = timeline.plan(rep.beats, manifest, total_seconds=total,
                           pace=str(job.extras.get("pace") or "normal"),
                           spans=spans,
                           audio=job.audio if job.audio else "")
        timeline.write(tl, job.out)
        log(tl.summary())

        if to_editor:
            task.stage = "ready to edit"
            log(task.stage)
            return

        # --- render -------------------------------------------------------
        task.stage = "rendering"
        log(task.stage)
        res = render.render_folder(job.out, audio=job.audio, log=log)
        log(render.describe(res))
        if not res.ok:
            task.status = "failed"
            task.error = "; ".join(f"{w}: {why}" for w, why in res.failed[:3]) \
                or "the render produced no file"
            return
        task.video = res.path
        task.stage = f"done — {os.path.basename(res.path)}"

    return runner.start("build", job.name, work)
