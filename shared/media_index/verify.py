"""Check every placement against the picture, and fix the ones that are wrong.

Alignment places shots by *inference*: find a quoted line, then lay the rest
of the run along the scene in script order. On the real Breaking Bad script
that meant 13 of 287 assets rested on evidence and 274 were inherited from
them — and when a single anchor was wrong, all 274 were wrong with it. Three
different builds were ruined that way, each by a different bad anchor, and
each was patched with a new guard against that one shape of mistake.

Guards do not generalise. The next script brings a new shape.

What generalises is *looking*. Every shot in a scene breakdown carries a
written description of what should be on screen — "Gus, in the red hazmat
suit, ties the apron with quiet care" — and `visual.py` can score that
description against every sampled frame of the episode. So a placement no
longer has to be believed. It can be checked, and moved when it is wrong.

## Why the whole run is solved at once

The obvious version — take each shot, search near where alignment put it,
keep the best frame — fails in a specific and ugly way. Shots are decided
independently, so nothing stops six of them landing on the same striking
frame, or shot 40 landing before shot 12. A scene reassembled out of order
is worse than one that is merely offset, because an offset is one mistake and
a scramble is forty.

So the run is solved as one problem: choose a frame for every shot, in
increasing time order, maximising the total visual agreement. That is a
shortest-path over a grid of (shot x frame), and it has three properties that
matter more than the optimisation itself:

  * **order is structural.** Monotonicity is a constraint, not a hope.
  * **a shot with no visual signal is not stranded.** It cannot wander, so it
    settles between its neighbours — the same thing interpolation did, but
    now positioned by shots that were actually verified rather than by one
    anchor at the far end of the run.
  * **anchors are pinned, not trusted.** A line matched in the subtitles is a
    real millisecond and stays fixed. A line matched weakly is allowed to be
    outvoted by forty shots that all agree the scene is somewhere else.

Alignment is still used, as a gentle prior. It is a genuinely good guess
about pacing, and where the pictures say nothing it should win; it is just no
longer the only vote.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field

import numpy as np

from . import align, embed, visual

# How much the alignment prior is worth, in the same units as visual lift.
# Deliberately small. A shot 90 seconds from where alignment expected it pays
# this much — enough to settle a tie between two indistinguishable frames,
# nowhere near enough to overrule a description that genuinely matched.
PRIOR_WEIGHT = 0.5
PRIOR_TAU_S = 90.0
# An anchored shot may be nudged this far to land on a sampled frame, and no
# further: the subtitle timing is the ground truth it is standing on.
ANCHOR_TOLERANCE_S = 2.5
# The least a run may wander either side of where alignment put it, whatever
# its own length. A four-shot run claiming eighteen seconds would otherwise be
# confined to eighteen seconds, which is fewer sampled frames than it has
# shots — a window so tight it is a pin by another name.
MIN_REACH_S = 120.0
NEG = -1e9


def describe(shot: dict) -> str:
    """The sentence a frame is scored against.

    The visual line is the caption the model actually understands. Setting
    and characters are appended because they cost nothing — SigLIP reads 64
    tokens and these descriptions rarely reach 30 — and because a proper noun
    from a well-known show is sometimes recognised outright.

    `must_not_have` is deliberately ignored. It exists to keep reaction cams
    and fan art out of a web search, and every frame scored here already came
    out of the film.
    """
    parts = [str(shot.get("visual") or "").strip()]
    setting = str(shot.get("setting") or "").strip()
    if setting:
        parts.append(setting)
    chars = shot.get("characters") or []
    if isinstance(chars, (list, tuple)) and chars:
        parts.append(", ".join(str(c) for c in chars))
    return ". ".join(p for p in parts if p)


@dataclass
class Verdict:
    beat: int
    shot: int
    action: str = "unchecked"    # kept | moved | pinned | drifted | unchecked
    before_ms: int = 0
    after_ms: int = 0
    lift: float = 0.0
    # The best this description scored ANYWHERE in the episode, ignoring
    # order and ignoring where alignment expected it. Without this, a low
    # `lift` has two completely different meanings that look identical:
    # the model could not find the picture at all, or it found it and the
    # ordering constraint gave that frame to a neighbour. Those need
    # opposite fixes — better captions versus a looser solver — so a build
    # that cannot tell them apart cannot be acted on.
    best: float = 0.0
    # Whether, at that best frame, this description beats every OTHER
    # description in the run. `best` alone cannot answer that: the highest
    # of 1,400 scores is high even for a caption about nothing in the
    # episode, simply because it is the highest of 1,400. Asking instead
    # "does any other caption explain this frame better than mine does"
    # removes the chance entirely — it compares captions, not frames, so
    # the number of frames searched drops out of it.
    distinct: bool = False
    note: str = ""

    @property
    def moved_seconds(self) -> float:
        return abs(self.after_ms - self.before_ms) / 1000.0

    @property
    def lost_to_ordering(self) -> bool:
        """It could have been found, and the ordering took it away.

        Both halves are needed. `best` alone counts a caption that merely
        won a lottery over 1,400 frames; `distinct` alone counts a caption
        that beat its rivals at a frame none of them actually matched.
        Together they mean: there was a real frame for this shot, it was
        unambiguously this shot's, and something else got it.
        """
        return (self.distinct and self.best >= visual.LIFT_OK
                and self.lift < visual.LIFT_OK)


@dataclass
class Report:
    verdicts: list = field(default_factory=list)
    checked: int = 0
    moved: int = 0
    unmatched: int = 0
    findable: int = 0            # had a match somewhere in the episode
    lost_to_ordering: int = 0    # ...and did not keep it
    runs_without_index: list = field(default_factory=list)
    reason: str = ""             # why nothing was checked, if nothing was

    def summary(self) -> str:
        from . import term
        d = term.sym("dot")
        if self.reason:
            return f"  pictures not checked — {self.reason}"
        big = sum(1 for v in self.verdicts if v.action == "moved"
                  and v.moved_seconds >= 5.0)
        lines = [f"  {self.checked} shot(s) checked against the picture {d} "
                 f"{self.moved} moved ({big} by 5s or more) {d} "
                 f"{self.unmatched} with no matching frame"]
        if self.unmatched:
            # The one number that says WHICH fix is needed.
            lines.append(
                f"  of those {self.unmatched}, {self.lost_to_ordering} did "
                "have a match elsewhere in the episode and lost it to the "
                "ordering; " f"{self.unmatched - self.lost_to_ordering} "
                "matched nothing anywhere — those need better descriptions, "
                "not a looser solver")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# the solver
# ---------------------------------------------------------------------------

def lift_matrix(index: visual.VisualIndex, texts: list, backend) -> np.ndarray:
    """(shots x frames), each row in this episode's own lift units.

    Rows are normalised independently because raw similarity varies with the
    length and wording of a description far more than with whether it is
    right. Without this, one verbose shot would outbid every terse one and
    the solver would bend the whole run around it.
    """
    vecs = backend.encode_texts(texts)
    if not len(vecs) or not len(index):
        return np.zeros((len(texts), len(index)), dtype=np.float32)
    sims = np.asarray(vecs, dtype=np.float32) @ index.vecs.T
    med = np.median(sims, axis=1, keepdims=True)
    p95 = np.percentile(sims, 95, axis=1, keepdims=True)
    spread = np.maximum(p95 - med, 1e-6)
    out = (sims - med) / spread
    # A description that could not be encoded scores nothing, rather than
    # scoring noise that the solver would happily follow.
    dead = ~np.any(vecs, axis=1)
    out[dead, :] = 0.0
    return out.astype(np.float32)


def prior_matrix(times: np.ndarray, wanted_s: np.ndarray) -> np.ndarray:
    """A soft pull towards where alignment expected each shot."""
    d = (times[None, :] - wanted_s[:, None]) / PRIOR_TAU_S
    return (-PRIOR_WEIGHT * np.minimum(d * d, 9.0)).astype(np.float32)


def solve(score: np.ndarray, bounds: list) -> list:
    """Pick one frame per shot, strictly increasing in time, best total score.

    `bounds[i]` is None, or an inclusive (lo, hi) range of frame indices that
    shot i is pinned inside. Returns one frame index per shot.

    O(shots x frames): the prefix maximum of the previous row is accumulated
    rather than re-searched, so a 147-shot script against a 1,400-frame
    episode is a fifth of a second, not four minutes.
    """
    n, N = score.shape
    if n == 0 or N == 0 or n > N:
        return []

    def masked(i):
        row = score[i].astype(np.float64).copy()
        b = bounds[i] if i < len(bounds) else None
        if b is not None:
            lo, hi = b
            if lo > hi or lo >= N or hi < 0:
                return row              # an impossible pin is no pin at all
            keep = np.zeros(N, dtype=bool)
            keep[max(0, lo):min(N, hi + 1)] = True
            row[~keep] = NEG
        return row

    back = np.zeros((n, N), dtype=np.int32)
    prev = masked(0)
    for i in range(1, n):
        run_max = np.maximum.accumulate(prev)
        fresh = np.empty(N, dtype=bool)
        fresh[0] = True
        fresh[1:] = run_max[1:] > run_max[:-1]
        arg = np.where(fresh, np.arange(N), 0)
        arg = np.maximum.accumulate(arg)

        shifted = np.full(N, NEG)
        shifted[1:] = run_max[:-1]
        back[i, 1:] = arg[:-1]
        cur = masked(i) + shifted
        cur[:i] = NEG                   # no room for i predecessors before this
        prev = cur

    end = int(np.argmax(prev))
    if prev[end] <= NEG / 2:
        return []                       # no legal assignment exists
    path = [0] * n
    path[n - 1] = end
    for i in range(n - 1, 0, -1):
        path[i - 1] = int(back[i, path[i]])
    return path


# ---------------------------------------------------------------------------
# applying it to a build
# ---------------------------------------------------------------------------

def _distinct_at_best(score: np.ndarray) -> np.ndarray:
    """Per shot: at its own best frame, does it beat every other caption?

    Rows are already z-like — each is measured against its own episode-wide
    spread — so a column compares captions fairly. A shot that wins its own
    best frame is one the model can genuinely tell apart from the rest of
    the script; a shot that loses it was never distinguishable, however high
    its raw score happened to be.

    A run of one or two shots has nothing to compare against, so nothing is
    claimed for it.
    """
    n = score.shape[0] if score.size else 0
    if n < 3:
        return np.zeros(n, dtype=bool)
    peak = score.argmax(axis=1)
    mine = score[np.arange(n), peak]
    best_any = score[:, peak].max(axis=0)
    return mine >= best_any - 1e-6


def _bounds_for_window(times: np.ndarray, window) -> tuple:
    """Frame indices covering a stretch of the episode, or None for all of it."""
    if not window:
        return None
    lo = int(np.searchsorted(times, window[0], side="left"))
    hi = int(np.searchsorted(times, window[1], side="right")) - 1
    if hi < lo:
        return None                 # the window fell outside the footage
    return lo, hi


def _bounds_for_anchor(times: np.ndarray, at_s: float) -> tuple:
    lo = int(np.searchsorted(times, at_s - ANCHOR_TOLERANCE_S, side="left"))
    hi = int(np.searchsorted(times, at_s + ANCHOR_TOLERANCE_S, side="right")) - 1
    if hi < lo:                          # no sampled frame that close
        nearest = int(np.argmin(np.abs(times - at_s)))
        return nearest, nearest
    return lo, hi


def verify_run(index: visual.VisualIndex, run, placements: list, backend,
               log=lambda *a: None) -> list:
    """Re-place one run using the pictures. Mutates `placements` in place.

    Hook shots take no part. A hook quotes a line out of sequence — that is
    what makes it a hook — so including one would either break the ordering
    constraint outright or drag every shot around it to keep the order legal.
    It is already sitting on a real, matched line, and it stays there.
    """
    ordered = [i for i, e in enumerate(run.entries) if not e.is_hook]
    out = [Verdict(beat=p.beat, shot=p.shot, action="pinned",
                   before_ms=p.start_ms, after_ms=p.start_ms,
                   note="a hook quote — left on the line it matched")
           for p in placements]
    if not ordered:
        return out

    texts = [describe(run.entries[i].data) for i in ordered]
    if not any(texts):
        for i in ordered:
            out[i] = Verdict(beat=placements[i].beat, shot=placements[i].shot,
                             note="no description to check against")
        return out

    score = lift_matrix(index, texts, backend)
    wanted = np.array([placements[i].start_ms / 1000.0 for i in ordered],
                      dtype=np.float32)
    # An anchor answers WHICH STRETCH of the episode. The pictures answer
    # WHICH FRAME inside it. Neither is allowed to do the other's job, and
    # two builds went wrong by letting one of them try.
    #
    # A soft prior let the anchor decide frames: 19 of 91 shots kept a match
    # they had found, because the pull towards one extrapolated point beat
    # the picture that actually matched. Removing it entirely was worse. With
    # 91 shots that must fall in increasing time order and a weak per-shot
    # signal, the best path is simply to spread them evenly over everything
    # available — so a run belonging to a six-minute scene at 30 minutes was
    # laid across the whole 47-minute episode, starting at 56 seconds.
    #
    # So the anchor gives a hard window and no vote inside it. A run may
    # wander by at most its own planned length from where alignment put it,
    # which cannot reach another sequence and cannot pin a single frame.
    grounded = sum(1 for i in ordered if placements[i].method == "anchor")
    total = score
    window = None
    if grounded:
        lo = min(wanted) if len(wanted) else 0.0
        hi = max(wanted) if len(wanted) else 0.0
        reach = max(hi - lo, MIN_REACH_S)
        window = (lo - reach, hi + reach)
        log(f"      {run.label}: held inside {window[0]:.0f}s-{window[1]:.0f}s "
            "by its quoted line; the pictures choose the frames within it")

    inside = _bounds_for_window(index.times, window) if window else None
    # Two different things, and conflating them cost a whole build: `bounds`
    # is where the solver may look, `held` is whether the shot is standing on
    # a quoted line. Once the window started filling `bounds` for every shot,
    # "has bounds" stopped meaning "is an anchor" — and every shot in the run
    # was treated as pinned and never moved at all.
    bounds, held = [], []
    for i in ordered:
        p = placements[i]
        anchor = p.method == "anchor" and p.confidence in ("high", "medium")
        held.append(anchor)
        # An anchor's pin is tighter than the window and wins.
        bounds.append(_bounds_for_anchor(index.times, p.start_ms / 1000.0)
                      if anchor else inside)

    path = solve(total, bounds)
    if not path and any(held):
        # The pins themselves are out of order, which no assignment can
        # satisfy. That is worth knowing: it means two quoted lines disagree
        # about which way this run runs. Solve it on the pictures alone.
        log(f"      {run.label}: the quoted lines contradict each other on "
            "order — deciding on the pictures alone")
        path = solve(total, [inside] * len(ordered))
        held = [False] * len(ordered)
    if not path:
        log(f"      {run.label}: too few frames indexed to re-place "
            f"{len(ordered)} shot(s) — left as aligned")
        for i in ordered:
            out[i] = Verdict(beat=placements[i].beat, shot=placements[i].shot,
                             note="not enough indexed frames")
        return out

    reachable = score.max(axis=1) if score.size else np.zeros(len(ordered))
    own_best = _distinct_at_best(score)
    solid = any(float(score[k, path[k]]) >= visual.LIFT_STRONG
                for k in range(len(ordered)))
    for k, i in enumerate(ordered):
        p = placements[i]
        f = path[k]
        lift = float(score[k, f])
        best = float(reachable[k])
        before = p.start_ms
        after = int(index.times[f] * 1000)
        duration = max(500, p.end_ms - p.start_ms)

        if held[k]:
            v = Verdict(beat=p.beat, shot=p.shot, action="pinned",
                        before_ms=before, after_ms=before, lift=lift,
                        best=best, distinct=bool(own_best[k]))
            v.note = ("held on its quoted line; the picture "
                      + ("agrees" if lift >= visual.LIFT_OK else "says little"))
            out[i] = v
            continue

        p.start_ms = after
        p.end_ms = after + duration
        if lift >= visual.LIFT_OK:
            p.method = "verified"
        elif grounded or solid:
            # Something in this run IS fixed — a quoted line, or a picture
            # that matched outright — so the shots between are positioned by
            # it, which is what interpolation has always meant.
            p.method = "interpolated"
        else:
            # Nothing in this run is fixed by anything. Cutting here would
            # be inventing a position, so it stays unplaced and is reported.
            p.method = "none"
        p.confidence = ("high" if lift >= visual.LIFT_STRONG
                        else "medium" if lift >= visual.LIFT_OK else "low")
        v = Verdict(beat=p.beat, shot=p.shot, before_ms=before,
                    after_ms=after, lift=lift, best=best,
                    distinct=bool(own_best[k]))
        if lift >= visual.LIFT_OK:
            v.action = "moved" if abs(after - before) >= 1000 else "kept"
            p.note = f"the picture matches this description (lift {lift:.1f})"
            if v.action == "moved":
                p.note += f", {v.moved_seconds:.0f}s from where the script implied"
        else:
            v.action = "drifted"
            p.note = ("no frame in this episode matches this description — "
                      "placed in order between the shots that did")
        out[i] = v
    return out


def apply(db_path: str, beats: list, placements: list,
          log=lambda *a: None) -> Report:
    """Check and correct a whole script's placements. Never raises.

    A missing model, a missing picture index, a single unreadable episode:
    all of them leave the build exactly as alignment produced it and say so.
    Verification improves a result; it must never be the reason there isn't
    one.
    """
    report = Report()
    # A backend already in hand beats any guess about what is installed —
    # a caller holding one model open across a queue of videos, or a test
    # standing in for it, has answered the question by having it.
    if embed.loaded() is None:
        ok, why = embed.available()
        if not ok:
            report.reason = why
            return report

    from .library import connect
    by_key = {(p.beat, p.shot): p for p in placements}
    con = connect(db_path)
    try:
        backend = embed.load(log=log)
    except embed.EmbedError as exc:
        con.close()
        report.reason = str(exc).splitlines()[0]
        return report

    try:
        cache: dict = {}
        for run in align.runs(beats):
            mine = [by_key.get((e.beat, e.shot)) for e in run.entries]
            mine = [p for p in mine if p is not None]
            if len(mine) != len(run.entries) or not mine:
                continue
            path = next((p.path for p in mine if p.path), "")
            if not path:
                continue
            if path not in cache:
                cache[path] = visual.load(con, db_path, path)
            index = cache[path]
            if index is None:
                name = os.path.basename(path)
                if name not in report.runs_without_index:
                    report.runs_without_index.append(name)
                continue
            verdicts = verify_run(index, run, mine, backend, log=log)
            report.verdicts += verdicts
            for v in verdicts:
                if v.action in ("kept", "moved", "pinned", "drifted"):
                    report.checked += 1
                if v.action == "moved":
                    report.moved += 1
                if v.action == "drifted":
                    report.unmatched += 1
                    if v.lost_to_ordering:
                        report.lost_to_ordering += 1
                if v.distinct:
                    report.findable += 1
            _log_run(run, verdicts, log)
        if report.runs_without_index and not report.checked:
            report.reason = ("no picture index yet for "
                             + ", ".join(report.runs_without_index[:3])
                             + " — run 'Look at the footage' first")
    finally:
        con.close()
    return report


def _log_run(run, verdicts: list, log) -> None:
    matched = sum(1 for v in verdicts if v.lift >= visual.LIFT_OK)
    findable = sum(1 for v in verdicts if v.distinct)
    moved = [v for v in verdicts if v.action == "moved"]
    log(f"      {run.label}: {matched}/{len(verdicts)} shot(s) found in the "
        f"picture, {len(moved)} moved"
        + (f" ({findable} had a match somewhere, so "
           f"{findable - matched} lost theirs to the ordering)"
           if findable > matched else ""))
    for v in sorted(moved, key=lambda x: -x.moved_seconds)[:3]:
        log(f"        shot {v.shot}: {v.before_ms/1000:.0f}s -> "
            f"{v.after_ms/1000:.0f}s (lift {v.lift:.1f})")
