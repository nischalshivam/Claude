"""Place shots that have no dialogue, by walking the scene in order.

Dialogue matching solves the easy case. It does not solve the case that
matters most for a scene breakdown, because the best scenes are often the
quiet ones — measured on a real 71-beat script about the Breaking Bad box
cutter scene, **92% of shots had no dialogue at all**. The scene is famous
precisely because nobody speaks.

But that script has a property worth everything: within a stretch of beats
drawn from one episode, the beats follow the scene **in order**. Gus walks in,
takes off his jacket, rolls his sleeves, steps into the suit, ties the apron,
picks up the box cutter. That is the scene's own chronology, written down.

So the shots do not need to be searched for individually. They need to be
*laid along* the scene:

  1. find the few lines that DO match — they are anchors with exact times
  2. detect every shot boundary between the anchors
  3. walk the described moments and the real shots together, in order

One line of dialogue at each end of a scene is enough to place everything
between them. That is what turns 7% coverage into most of the script.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from . import cutter
from .probe import ProbeError, probe
from .search import find

# A run shorter than this is not worth aligning — individual search is fine.
MIN_RUN = 2
# How far beyond the outermost anchor a scene is assumed to extend, when there
# is nothing else to go on.
EDGE_PAD_S = 45.0
# Two placements closer than this are the same moment; spread them apart.
MIN_SEPARATION_S = 1.5
# Snapping to a shot boundary only helps when one is actually nearby. Scene
# detection misses low-contrast cuts, and dragging a placement 15 s to reach
# the next surviving boundary is worse than trusting the interpolation.
MAX_SNAP_S = 8.0


@dataclass
class Entry:
    beat: int
    shot: int
    data: dict

    @property
    def query(self) -> str:
        return ((self.data.get("exact_dialogue") or "").strip()
                or (self.data.get("nearest_dialogue") or "").strip())

    @property
    def target_seconds(self) -> float:
        try:
            return float(self.data.get("duration_target_sec") or 4.0)
        except (TypeError, ValueError):
            return 4.0


@dataclass
class Run:
    source: str
    season_episode: str
    entries: list = field(default_factory=list)

    @property
    def label(self) -> str:
        return f"{self.source} {self.season_episode}"


@dataclass
class Placement:
    beat: int
    shot: int
    path: str = ""
    start_ms: int = 0
    end_ms: int = 0
    method: str = "none"      # anchor | interpolated | none
    confidence: str = "low"   # high | medium | low
    note: str = ""

    @property
    def ok(self) -> bool:
        return self.method != "none"

    @property
    def timecode(self) -> str:
        s, ms = divmod(self.start_ms, 1000)
        m, s = divmod(s, 60)
        h, m = divmod(m, 60)
        return f"{h:d}:{m:02d}:{s:02d}.{ms:03d}"


# ---------------------------------------------------------------------------
# 1. group consecutive shots that come from the same episode
# ---------------------------------------------------------------------------

def runs(beats: list) -> list[Run]:
    """All shots from one episode form one run through it, in script order.

    Grouping only CONSECUTIVE shots looks more conservative and is much
    worse. An essay cuts away constantly — main scene, a flashback, back to
    the main scene — and on a real 106-shot script that produced 36 runs,
    twenty-three of them a single shot long. A lone silent shot has no anchor
    and cannot be placed at all, so the cutaways were not merely fragmenting
    the walk through the scene, they were deleting shots from the video.

    Gathered by episode instead, those same 106 shots form a handful of runs,
    and the seventy from the box-cutter episode become one walk with seven
    anchors spread through it. Returning to an episode later is safe: shots
    are only ever interpolated BETWEEN the anchors either side of them, so a
    second visit with its own anchor is placed on its own terms.
    """
    order: list = []
    by_key: dict = {}
    for b in beats:
        beat_no = b.get("beat")
        for i, shot in enumerate(b.get("shots") or [], 1):
            src = (shot.get("source") or "").strip()
            se = str(shot.get("season_episode") or "unknown").strip()
            key = (src, se)
            run = by_key.get(key)
            if run is None:
                run = by_key[key] = Run(source=src, season_episode=se)
                order.append(run)
            run.entries.append(Entry(beat=beat_no, shot=i, data=shot))
    return order


# ---------------------------------------------------------------------------
# 2. anchors — the handful of lines that really do match
# ---------------------------------------------------------------------------

def anchors_for(db_path: str, run: Run, con=None) -> list[tuple]:
    """[(index_in_run, start_ms, end_ms, path, confidence)] sorted by time."""
    found = []
    for i, e in enumerate(run.entries):
        if not e.query:
            continue
        hits = find(db_path, e.query, show=run.source or None, limit=1, con=con)
        if not hits or hits[0].confidence == "low":
            continue
        h = hits[0]
        found.append((i, h.start_ms, h.end_ms, h.path, h.confidence))

    # Anchors must increase in time as they increase in index; a pair that
    # crosses means one of them matched the wrong moment, so drop the weaker.
    found.sort(key=lambda a: a[0])
    clean = []
    for a in found:
        while clean and a[1] <= clean[-1][1]:
            if clean[-1][4] == "high" and a[4] != "high":
                a = None
                break
            clean.pop()
        if a:
            clean.append(a)
    return clean


# ---------------------------------------------------------------------------
# 3. lay the described moments along the real shots
# ---------------------------------------------------------------------------

def _span(run: Run, anchors: list, duration: float) -> tuple:
    """The stretch of the episode this run is assumed to cover."""
    first_i, first_t = anchors[0][0], anchors[0][1]
    last_i, last_t = anchors[-1][0], anchors[-1][2]
    n = len(run.entries)

    if len(anchors) >= 2 and last_i > first_i:
        per_entry = (last_t - first_t) / max(1, (last_i - first_i))
    else:
        per_entry = EDGE_PAD_S * 1000 / max(1, n)

    start = first_t - per_entry * first_i
    end = last_t + per_entry * (n - 1 - last_i)
    start = max(0.0, start - 2000)
    end = min(duration * 1000 if duration else end + 2000, end + 2000)
    return start, end


def _interpolate(index: int, anchors: list, span: tuple) -> float:
    """Estimated time for an entry, from the anchors around it."""
    lo_i, lo_t = -1, span[0]
    hi_i, hi_t = None, span[1]
    for i, s, e, _p, _c in anchors:
        if i <= index:
            lo_i, lo_t = i, s
        elif hi_i is None:
            hi_i, hi_t = i, s
    if hi_i is None:
        hi_i = len(anchors) and max(a[0] for a in anchors) + 1 or index + 1
        hi_i = max(hi_i, index + 1)
    if hi_i == lo_i:
        return lo_t
    frac = (index - lo_i) / (hi_i - lo_i)
    return lo_t + frac * (hi_t - lo_t)


def align_run(db_path: str, run: Run, con=None, log=lambda *a: None) -> list[Placement]:
    """Place every entry of one run along its scene."""
    out = [Placement(beat=e.beat, shot=e.shot) for e in run.entries]
    anchors = anchors_for(db_path, run, con=con)
    if not anchors:
        for p in out:
            p.note = "no anchor line in this run — cannot place it"
        return out

    path = anchors[0][3]
    try:
        duration = probe(path).duration
    except ProbeError:
        duration = 0.0
    span = _span(run, anchors, duration)
    log(f"    {run.label}: {len(run.entries)} shot(s), {len(anchors)} anchor(s), "
        f"span {span[0]/1000:.0f}s-{span[1]/1000:.0f}s")

    try:
        boundaries = cutter.detect_shots(path, span[0] / 1000, span[1] / 1000)
    except ProbeError as exc:
        boundaries = []
        log(f"      shot detection unavailable ({exc})")

    anchor_at = {a[0]: a for a in anchors}
    used: list[float] = []

    for i, e in enumerate(run.entries):
        p = out[i]
        p.path = path
        if i in anchor_at:
            _, s_ms, e_ms, _p, conf = anchor_at[i]
            p.start_ms, p.end_ms = s_ms, e_ms
            p.method, p.confidence = "anchor", conf
            p.note = "matched on dialogue"
            used.append(s_ms / 1000)
            continue

        want = _interpolate(i, anchors, span) / 1000.0
        # snap to the nearest shot boundary that is not already spoken for
        candidates = [b for b in boundaries
                      if all(abs(b - u) > MIN_SEPARATION_S for u in used)]
        p.method = "interpolated"
        nearest = min(candidates, key=lambda b: abs(b - want)) if candidates else None
        if nearest is not None and abs(nearest - want) <= MAX_SNAP_S:
            chosen = nearest
            p.confidence = "medium"
            p.note = (f"placed between anchors, snapped to a shot "
                      f"{abs(chosen - want):.1f}s away")
        else:
            # No boundary close enough. Detection misses low-contrast cuts, so
            # the estimate is the better answer than a distant boundary.
            chosen = want
            p.confidence = "low"
            p.note = "placed between anchors, no shot boundary nearby"
        used.append(chosen)
        p.start_ms = int(max(0.0, chosen) * 1000)
        p.end_ms = int(p.start_ms + e.target_seconds * 1000)

    return out


def placeable(db_path: str, beats: list, con=None) -> tuple:
    """(placeable, total) shots, without decoding a single frame.

    The gate has to answer "can this be built?" before anything renders, and
    the honest answer changed when alignment arrived. Counting only shots that
    match dialogue said 7/106 on a real script and blocked it — while the
    builder, given the chance, places most of those 106, because a run needs
    one quoted line to carry all the silent shots around it.

    Anchors are database lookups. Shot detection is not, so it is left to the
    build; the difference it makes is where inside a second a clip starts, not
    whether the shot can be placed at all.
    """
    own = None
    if con is None:
        from .library import connect
        own = con = connect(db_path)
    try:
        placed = total = 0
        for run in runs(beats):
            n = len(run.entries)
            total += n
            anchors = anchors_for(db_path, run, con=con)
            if not anchors:
                continue
            # A run too short to align is only as good as its own anchors.
            placed += n if n >= MIN_RUN else len(anchors)
        return placed, total
    finally:
        if own is not None:
            own.close()


def align(db_path: str, beats: list, log=lambda *a: None) -> list[Placement]:
    """Align every run in a script. Runs too short to align are left alone."""
    from .library import connect
    con = connect(db_path)
    try:
        placements = []
        for run in runs(beats):
            if len(run.entries) < MIN_RUN:
                placements += [Placement(beat=e.beat, shot=e.shot,
                                         note="run too short to align")
                               for e in run.entries]
                continue
            placements += align_run(db_path, run, con=con, log=log)
        return placements
    finally:
        con.close()


def summarise(placements: list[Placement]) -> str:
    from . import term
    anchored = sum(1 for p in placements if p.method == "anchor")
    interp = sum(1 for p in placements if p.method == "interpolated")
    none = sum(1 for p in placements if p.method == "none")
    total = len(placements) or 1
    return (f"  {anchored} anchored on dialogue "
            f"{term.sym('dot')} {interp} placed along the scene "
            f"{term.sym('dot')} {none} unplaced "
            f"({(anchored + interp) / total:.0%} usable)")
