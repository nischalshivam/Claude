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

from . import align, cutter, frames, jobs as jobs_mod, probe, term, verify
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
    # Where in the episode each asset was taken from. An editor asked to
    # lengthen a clip or replace a still needs to know where to go back to,
    # and a folder of clip_01.mp4 files says nothing about that.
    origins: dict = field(default_factory=dict)     # {"clip_01.mp4": 2013.4}
    # And WHICH episode it came from, per asset.
    #
    # A beat routinely draws from two episodes — the scene, and a flashback
    # it refers to — and the manifest used to label every asset in a scene
    # with whichever episode the FIRST one happened to come from. Six shots
    # of a real build were reported as Season 4 Episode 1 while sitting in
    # Season 3 Episode 13, which is exactly the kind of wrong label that
    # sends an investigation into the wrong file.
    sources: dict = field(default_factory=dict)     # {"clip_01.mp4": "S03E13.mp4"}

    @property
    def ok(self) -> bool:
        return bool(self.clips or self.stills)

    @property
    def anchored(self) -> int:
        return sum(1 for m in self.methods.values() if m == "anchor")

    @property
    def verified(self) -> int:
        """Assets whose picture was checked against the shot's description."""
        return sum(1 for m in self.methods.values() if m == "verified")

    @property
    def interpolated(self) -> int:
        return sum(1 for m in self.methods.values() if m == "interpolated")

    @property
    def filler(self) -> int:
        """Assets from the right episode but no particular moment of it.

        The one kind of asset the tool cannot justify, counted separately so
        it can never hide inside "interpolated" — an editor scanning the
        manifest should be able to find every one of them in a second."""
        return sum(1 for m in self.methods.values() if m == "filler")


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


# How far either side of a placement to look for still frames.
#
# Four seconds was too generous. Shots in an aligned run sit about three and a
# half seconds apart, so a window of four either side made every scan overlap
# both its neighbours almost completely — and neighbouring scenes then chose
# from the same pool of frames. The contact sheet showed the consequence: the
# same red-lit frame returning again and again down the page.
STILL_WINDOW_S = 1.5

# Every clip is cut this long whatever the timeline later uses, so that no
# planned duration can ever exceed the footage on disk. It must not be less
# than timeline.MAX_CLIP_S; a test asserts that they agree.
CLIP_HEADROOM_S = 6.0

# Two assets taken from within this much of the same moment of the same
# episode are the same picture, whatever the placement says.
#
# The last net, not the fix — placement is where the spreading is decided.
# But when placement went wrong it went wrong invisibly: 31 of the first 66
# pictures of a finished video came out of one six-second stretch, and
# nothing in the pipeline objected because each frame was, technically, a
# different frame. The perceptual de-duplicator missed them precisely
# because a hand moving through a shot makes every frame slightly different.
# Time cannot be argued with in the same way.
REPEAT_APART_S = 2.0
# How far a repeated shot may be moved to find footage nobody has used.
SHIFT_REACH_S = 45.0
# Filler is spread across the middle of an episode — never the titles, never
# the credits — and kept well apart so a beat with nothing does not become a
# beat with the same corridor four times.
FILLER_SPREAD = (0.10, 0.90)
FILLER_APART_S = 20.0


def _wants_still(shot: dict) -> bool:
    return str(shot.get("kind") or "").strip().lower() == "still"


def _still_count(shot: dict, default: int) -> int:
    try:
        return max(1, int(shot.get("count") or default))
    except (TypeError, ValueError):
        return default


_LENGTHS: dict = {}


def episode_length(path: str) -> float:
    """How long a video is, asked once per file. 0.0 if it cannot be read."""
    if path not in _LENGTHS:
        try:
            _LENGTHS[path] = float(probe.probe(path).duration or 0.0)
        except (ProbeError, OSError):
            _LENGTHS[path] = 0.0
    return _LENGTHS[path]


def _repeated(used: dict | None, path: str, at: float,
              apart: float = REPEAT_APART_S) -> bool:
    """Has this moment of this episode already been used in the video?"""
    if used is None:
        return False
    return any(abs(at - t) < apart for t in used.get(path, ()))


def _free_moment(used: dict | None, path: str, at: float,
                 reach: float = SHIFT_REACH_S) -> float | None:
    """The nearest second of this episode nobody has used yet.

    Refusing a repeated shot outright was the first version and it emptied
    seven scenes of a real build — the repetition became holes, and the
    holes became stills sitting on screen for half a minute. These
    placements are interpolated guesses to begin with; moving one a few
    seconds costs nothing anybody can measure and keeps the scene.
    """
    if not _repeated(used, path, at):
        return at
    step = REPEAT_APART_S
    d = step
    while d <= reach:
        for cand in (at + d, at - d):
            if cand >= 0 and not _repeated(used, path, cand):
                return cand
        d += step
    return None


def _filler_moment(used: dict | None, path: str, duration: float,
                   k: int, window: tuple | None = None) -> float | None:
    """Somewhere in this episode nobody has been yet, for a shot with no
    placement at all.

    Three runs of a real script carried no quoted line and matched no
    picture, so 198 seconds of an eleven-minute video had nothing to show
    and the shots around those holes were stretched to cover them. The
    script still names the episode, and footage from the right episode is
    what an editor reaches for when the exact frame cannot be found. It is
    marked as filler everywhere it appears — this is the one place the tool
    shows something it cannot justify, and it says so.

    The golden ratio spreads successive calls across the episode instead of
    clustering them, without needing any state beyond a counter.
    """
    if duration <= 0:
        return None
    lo, hi = FILLER_SPREAD[0] * duration, FILLER_SPREAD[1] * duration
    if window and window[1] > window[0]:
        # The stretch of the episode this run actually occupies. Filler stays
        # inside it. Scattered across the whole episode instead, a video
        # about one four-minute scene pulled eighty-one shots from the whole
        # forty-seven minutes of it — which is why the footage looked
        # unrelated: it was.
        #
        # Clamped to the same bounds as the spread, never past them. A window
        # that reaches the titles is a window that puts "Previously on" under
        # a sentence about a killing.
        lo = max(lo, min(window[0], hi - 8.0))
        hi = min(hi, max(window[1], lo + 8.0))
        if hi - lo < 8.0:
            lo, hi = (FILLER_SPREAD[0] * duration,
                      FILLER_SPREAD[1] * duration)
    # Near where the video already is in this episode, not anywhere in it.
    #
    # Scattered across the whole film, filler found the title cards — a real
    # build put "Produced by" and "Written by" on screen — and characters the
    # narration has never mentioned. The essay is somewhere specific at that
    # moment, every other shot from this episode says where, and footage from
    # the same part of the story is the only kind that can pass unnoticed.
    seen = sorted(used.get(path, ())) if used else []
    if seen:
        near = seen[len(seen) // 2]
        for step in range(1, 60):
            for at in (near + step * FILLER_APART_S, near - step * FILLER_APART_S):
                if lo <= at <= hi and not _repeated(used, path, at,
                                                    apart=FILLER_APART_S):
                    return at
    for i in range(96):
        frac = ((k + i) * 0.618033988749895) % 1.0
        at = lo + frac * (hi - lo)
        if not _repeated(used, path, at, apart=FILLER_APART_S):
            return at
    return None


def _mark_used(used: dict | None, path: str, at: float) -> None:
    if used is not None:
        used.setdefault(path, []).append(at)


def _filler_for(episode: str, used: dict | None, log,
                window: tuple | None = None) -> tuple:
    """(seconds, path) somewhere in the episode a beat names, or (None, '')."""
    if not episode or not os.path.isfile(episode):
        return None, ""
    try:
        length = probe.probe(episode).duration
    except (ProbeError, OSError):
        return None, ""
    taken = len(used.get(episode, ())) if used else 0
    return (_filler_moment(used, episode, float(length or 0.0), taken, window),
            episode)


def build_scene(job, index: int, beat: dict, placements: list,
                seen: list | None = None, log=lambda *a: None,
                used: dict | None = None, episode: str = "",
                window: tuple | None = None) -> SceneResult:
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
    repeats = 0

    filled = 0
    for p in mine:
        n = p.shot
        shot = shots[n - 1] if 0 < n <= len(shots) else {}
        wanted = p.end_ms - p.start_ms
        if not p.ok or not p.path:
            # No line, no picture — but the script named the episode, and
            # showing the right episode beats showing nothing at all.
            at, path = _filler_for(episode, used, log, window)
            if at is None:
                unplaced += 1
                continue
            p = align.Placement(beat=p.beat, shot=p.shot, path=path,
                                start_ms=int(at * 1000),
                                end_ms=int(at * 1000) + max(4000, wanted),
                                method="filler", confidence="low")
            filled += 1
        moved = _free_moment(used, p.path, p.start_ms / 1000.0)
        if moved is None:
            # Everything within reach is already on screen somewhere.
            repeats += 1
            continue
        # An episode has an end, and a placement can walk off it. Two shots
        # of a real build were cut at 2918s and 3488s of a 2848-second
        # episode: ffmpeg wrote a file with no video in it, both segments
        # failed to render, and the video came out eleven seconds short.
        # Cheaper to notice here than to discover it during the render.
        length = episode_length(p.path)
        if length and moved >= length - 1.0:
            log(f"      scene {index}: shot {n} is past the end of "
                f"{os.path.basename(p.path)} ({moved:.0f}s of {length:.0f}s)")
            unplaced += 1
            continue
        start = moved
        end = start + max(1.0, wanted / 1000.0)
        res.source = res.source or os.path.basename(p.path)
        # The weakest placement in the scene, not the last one seen: a scene
        # is only as trustworthy as its least certain shot.
        rank = {"high": 3, "medium": 2, "low": 1}
        if not res.confidence or rank.get(p.confidence, 0) < rank.get(res.confidence, 0):
            res.confidence = p.confidence

        try:
            if not _wants_still(shot):
                clip_path = os.path.join(scene_dir, f"clip_{n:02d}.mp4")
                # Cut the LONGEST the timeline could ever ask for, not the
                # nominal clip length. These two disagreed: clips were cut
                # at 4.0s and the timeline planned up to 6.0s, so 42 clips
                # of a real build were asked to run longer than the footage
                # that existed. ffmpeg cannot invent frames, so each one
                # came out short, and 34 seconds vanished from an
                # eleven-minute video — silently, and cumulatively, until
                # the picture finished 45 seconds ahead of the voice.
                #
                # This is raw material. How much of it is used is the
                # timeline's decision, made later and changeable without
                # re-cutting anything.
                headroom = max(job.clip_seconds, CLIP_HEADROOM_S)
                cutter.cut_clip(p.path, start, min(end, start + headroom),
                                clip_path, height=job.height)
                res.clips.append(clip_path)
                res.methods[os.path.basename(clip_path)] = p.method
                res.origins[os.path.basename(clip_path)] = round(start, 2)
                res.sources[os.path.basename(clip_path)] = os.path.basename(p.path)
                _mark_used(used, p.path, start)

            want = _still_count(shot, job.stills_per_scene)
            got = _stills_for(p.path, start, end, scene_dir, n, want, seen, log,
                              used)
            for still, at in got:
                res.stills.append(still)
                res.methods[os.path.basename(still)] = p.method
                res.origins[os.path.basename(still)] = round(at, 2)
                res.sources[os.path.basename(still)] = os.path.basename(p.path)
                _mark_used(used, p.path, at)
        except (ProbeError, ValueError, OSError) as exc:
            log(f"      scene {index}: shot {n} failed — {exc}")
            continue

    if res.clips or res.stills:
        res.status = "cut" if res.clips else "fallback"
        if filled:
            res.note = (f"{filled} shot(s) filled from this episode — no line "
                        "and no picture matched them")
        elif unplaced:
            res.note = f"{unplaced} shot(s) could not be placed"
        elif repeats:
            res.note = (f"{repeats} shot(s) skipped — already on screen "
                        "earlier in this video")
        elif not res.clips:
            res.note = "stills only"
    elif repeats:
        res.status = "empty"
        res.note = (f"every shot here ({repeats}) was already on screen "
                    "earlier in this video")
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
                log=lambda *a: None, used: dict | None = None) -> list:
    """Sharp, distinct frames from around a placement.

    Sampling at fixed fractions of the clip was cheaper and wrong: it lands on
    motion blur, on the black frame between two shots, and on five views of
    one static moment. These are scored and de-duplicated against every still
    already taken for this video.

    Returns [(path, seconds_into_the_episode)]. The time travels with the
    file because it cannot be recovered afterwards, and an editor asked to
    swap one still for a better one has to know where to look.
    """
    # The window widens with the number of stills wanted, and so does the
    # minimum gap between them. A fixed 1.5s window asked for two frames out
    # of eight seconds of a static two-hander, and the de-duplicator quite
    # correctly found the two best — which were the same picture, because in
    # eight seconds of that shot nothing moves. On the last build 75 of 103
    # still-shots produced a pair, and side by side on the contact sheet many
    # of those pairs are plainly one image printed twice.
    reach = STILL_WINDOW_S * max(1, want)
    lo = max(0.0, start - reach)
    hi = end + reach
    try:
        cands = frames.scan(path, lo, hi)
    except ProbeError as exc:
        log(f"      still scan failed — {exc}")
        return []
    gap = max(frames.MIN_GAP_S, (hi - lo) / (want * 2.0)) if want > 1 else \
        frames.MIN_GAP_S
    # A frame from a moment already on screen is the same picture however
    # different its pixels happen to be — and in a moving shot they always
    # are, which is why the perceptual test alone let a six-second stretch
    # supply thirty-one pictures.
    cands = [c for c in cands
             if not _repeated(used, path, c.time)]
    best = frames.pick(cands, want, min_gap=gap, exclude=seen)
    out = []
    for k, c in enumerate(best, 1):
        still = os.path.join(scene_dir, f"image_{shot_no:02d}_{k}.jpg")
        try:
            cutter.extract_frame(path, c.time, still, width=1920)
            out.append((still, c.time))
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
    # "verified" sits with "anchor" on purpose. One was located by a line that
    # is provably spoken there; the other by a picture that provably matches
    # the description. Both were checked against the film. Interpolation was
    # not, and the gap between "checked" and "inferred" is the only thing in
    # this manifest an editor cannot recover by looking.
    weight = 1.0 if method in ("anchor", "verified") else 0.75
    return round(ceiling * base * weight, 3)


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
            "verified": s.verified,
            "interpolated": s.interpolated,
            "filler": s.filler,
            "assets": (
                [{"file": os.path.basename(p), "kind": "video",
                  "placed_by": s.methods.get(os.path.basename(p), "unknown"),
                  "source_start": s.origins.get(os.path.basename(p)),
                  "source": s.sources.get(os.path.basename(p), s.source),
                  "score": _asset_score(s, p, 1.0)}
                 for p in s.clips]
                + [{"file": os.path.basename(p), "kind": "image",
                    "placed_by": s.methods.get(os.path.basename(p), "unknown"),
                    "source_start": s.origins.get(os.path.basename(p)),
                    "source": s.sources.get(os.path.basename(p), s.source),
                    "score": _asset_score(s, p, 0.9)}
                   for p in s.stills]),
        } for s in result.scenes],
    }
    path = os.path.join(job.out, MANIFEST)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    return path


# How far past the shots a run DID place its filler may sit. A run whose
# anchors cover ninety seconds is describing a sequence, not a whole episode.
RUN_SPAN_PAD_S = 120.0


def _spans_by_beat(beats: list, placements: list) -> dict:
    """{beat: (lo, hi)} — the stretch each run's placed shots actually cover.

    The strongest statement about where a run belongs is not a model's
    opinion; it is the shots of that same run which were already placed on
    real evidence. A run with four anchors between 31 and 36 minutes is
    describing that sequence, and its unplaced shots belong beside them —
    not spread across the episode by a golden-ratio walk that has never
    heard of the scene.

    This is what was missing. Every other guard reasoned about one shot at a
    time; a run knows more than any of its shots do.
    """
    out: dict = {}
    by_key = {(p.beat, p.shot): p for p in placements}
    for run in align.runs(beats):
        real = []
        for entry in run.entries:
            p = by_key.get((entry.beat, entry.shot))
            if p is not None and p.ok and p.path:
                real.append((p.start_ms / 1000.0, p.end_ms / 1000.0))
        if not real:
            continue
        lo = min(a for a, _b in real) - RUN_SPAN_PAD_S
        hi = max(b for _a, b in real) + RUN_SPAN_PAD_S
        for entry in run.entries:
            out[entry.beat] = (max(0.0, lo), hi)
    return out


def _episodes_by_beat(db_path: str, beats: list) -> dict:
    """{beat number: episode file} for every run in the script.

    Never raises: an episode the library cannot resolve simply has no
    filler, which is the behaviour this replaced.
    """
    out: dict = {}
    try:
        for run in align.runs(beats):
            path = align.episode_file(db_path, run)
            if not path:
                continue
            for entry in run.entries:
                out.setdefault(entry.beat, path)
    except Exception:
        return out

    # A beat can name no episode at all. Six shots of a real script were
    # press portraits — Vince Gilligan, an actor at a premiere, rows of
    # cinema seats — which live nowhere in a library of episodes, so those
    # beats had nothing and the video had a hole where the narration was
    # talking about the writers' room. The neighbouring beats know which
    # episode the essay is in at that point, and that is the right answer
    # for a held face under a line about the making of it.
    order = [b.get("beat") for b in beats if b.get("beat") is not None]
    last = ""
    for beat_no in order:                      # carry forward
        last = out.get(beat_no) or last
        if last:
            out.setdefault(beat_no, last)
    last = ""
    for beat_no in reversed(order):            # then back, for the opening
        last = out.get(beat_no) or last
        if last:
            out.setdefault(beat_no, last)
    return out


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
        # Alignment says where a shot probably is. This says whether the
        # picture there is the one the script asked for, and moves it when it
        # is not. Without the model installed it reports why and changes
        # nothing — a build never depends on it.
        checked = verify.apply(job.db, report.beats, placements, log=log)
        log(checked.summary())
        seen: list = []          # every still already taken, for de-duplication
        used: dict = {}          # and every moment of every episode used
        # Which episode each beat belongs to, whether or not anything in it
        # could be placed. A beat nobody could place still names its episode,
        # and that is enough to show the right show rather than nothing.
        owns = _episodes_by_beat(job.db, report.beats)
        # Shots dialogue could not place used to fall straight through to
        # filler. Now the picture index is asked where the description
        # actually happens — which is the only thing that works on a scene
        # nobody speaks in, and those are the scenes worth making videos
        # about. Runs after verify so it only sees what is genuinely homeless.
        # Which stretch of its episode each run happens in. Asked of the
        # whole run at once rather than shot by shot: twenty descriptions
        # from one scene agreeing a little is worth far more than one of
        # them being confident, and on a scene nobody speaks in it is the
        # only signal there is.
        windows = verify.locate_runs(job.db, report.beats, log=log)
        verify.place_by_picture(job.db, report.beats, placements,
                                episodes=owns, windows=windows, log=log)
        # A run's own placed shots outrank any model's opinion about where it
        # belongs — they are measurements, and the window is a guess. Worked
        # out after place_by_picture so it sees everything that got placed.
        found = _spans_by_beat(report.beats, placements)
        for beat_no, span in found.items():
            windows[beat_no] = span
        if found:
            log(f"    {len(set(found.values()))} run(s) bounded by their own "
                "placed shots; filler stays inside those")
        for i, beat in enumerate(report.beats, 1):
            scene = build_scene(job, i, beat, placements, seen, log, used,
                                owns.get(beat.get("beat", i), ""),
                                window=windows.get(beat.get("beat", i)))
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
