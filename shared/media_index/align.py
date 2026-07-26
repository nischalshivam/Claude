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
# The axis is built from `duration_target_sec`, which is how long the CLIP
# should be, not how long the moment lasts on screen — a four second clip is
# routinely taken from a twenty second beat. So the ratio between script time
# and film time is genuinely large, and these bounds are here only to catch
# an absurdity, never to overrule what two anchors actually measured.
MIN_SCALE = 0.05
MAX_SCALE = 25.0
# The most of one episode a single run may be spread across.
#
# Two anchors measure the stretch between them, which is right when both are
# right and worse than useless when one is not. On the real script a beat
# about the AUDIENCE — Bryan Cranston's daughter fainting at a screening —
# carried a quote that matched somewhere far from the scene, and the pair
# fitted to x2.14: 103 shots spread over 20:47-37:11 for a sequence that
# runs 33:00-37:15. The video opened on Hank and Marie at home.
#
# A run gathers every shot an essay takes from one episode, which can be a
# few scenes, but not a sixth of an hour. Past this the anchors are not
# describing the same stretch of film and only the strongest is kept.
MAX_RUN_SPAN_S = 600.0
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
    def is_hook(self) -> bool:
        """Quoted before the moment it belongs to, to open the essay.

        The closing line of a scene placed at shot 1 told the tool the scene
        ends where it begins, and the whole sequence landed four minutes
        late. A hook still names a real moment, so it is worth cutting; it
        just says nothing about order.
        """
        return bool(self.data.get("hook"))

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
    """[(index_in_run, start_ms, end_ms, path, confidence)] sorted by time.

    Searched inside the episode the script named. Searching the whole show
    instead was catastrophic and quiet: a line from a run declared S04E01
    matched somewhere in S02E07, `align_run` cuts the entire run from the
    first anchor's file, and 41 of 52 scenes came out of the wrong episode —
    the finished sheet was full of a mariachi band from the opening of "Negro
    y Azul". Every number in the report looked healthy while it happened.
    """
    from . import subtitles
    key = subtitles.episode_key(run.season_episode or "")
    season, episode = key if key else (None, None)

    found = []
    for i, e in enumerate(run.entries):
        if not e.query or e.is_hook:
            continue
        hits = find(db_path, e.query, show=run.source or None,
                    season=season, episode=episode, limit=1, con=con)
        if not hits or hits[0].confidence == "low":
            continue
        h = hits[0]
        found.append((i, h.start_ms, h.end_ms, h.path, h.confidence))

    # When the episode was not declared, anchors may land in different files.
    # The run is cut from ONE file, so anchors from any other are not
    # measurements of this run — they are a different scene entirely.
    if found and (season is None or episode is None):
        home = found[0][3]
        found = [f for f in found if f[3] == home]

    # Anchors must increase in time as they increase in index. Dropping
    # backwards one at a time cascades: on the real script the famous closing
    # line was also quoted at beat 1 as an opener, and unwinding from there
    # took five anchors down to one. Seventy shots then hung off a single
    # point. Keeping the longest run that IS in order throws out the odd
    # misplaced line instead of everything after it.
    found.sort(key=lambda a: a[0])
    return _longest_increasing(_last_of_each_moment(found))


def _last_of_each_moment(anchors: list) -> list:
    """One anchor per moment, and when a line is quoted twice, the later one.

    Essays open by quoting the ending. On the real script "Well? Get back to
    work." — the closing line of the scene — is quoted at index 0 as a hook
    and again at 50 and 61 where it belongs. Keeping the first occurrence
    pinned the end of the scene to the start of the run and laid all seventy
    shots AFTER it, so the video opened on the cleanup that follows the
    killing instead of on the killing.

    The later index is also the safer one when the choice is a guess: it puts
    most of the run before the anchor, and a scene almost always builds
    towards the line worth quoting rather than away from it.
    """
    keep: dict = {}
    for a in anchors:
        keep[a[1]] = a          # later indices arrive last and win
    return sorted(keep.values(), key=lambda a: a[0])


def _longest_increasing(anchors: list) -> list:
    """The largest subset whose times increase with their index.

    Ties in time — the same line quoted at three different beats resolves to
    the same moment — cannot all be kept, since two shots cannot both be at
    the same instant and in order. Strictly increasing keeps one of them.
    """
    if not anchors:
        return []
    n = len(anchors)
    best = [1] * n
    prev = [-1] * n
    for i in range(n):
        for j in range(i):
            if anchors[j][1] < anchors[i][1] and best[j] + 1 > best[i]:
                best[i], prev[i] = best[j] + 1, j
    end = max(range(n), key=lambda i: (best[i], anchors[i][4] == "high"))
    out = []
    while end != -1:
        out.append(anchors[end])
        end = prev[end]
    return out[::-1]


# ---------------------------------------------------------------------------
# 3. lay the described moments along the real shots
# ---------------------------------------------------------------------------

def axis(run: Run) -> list:
    """Where each shot sits along the scene, in seconds, per the script.

    The script states a duration for every shot. Laid end to end those give
    the scene's own shape — which shot is a third of the way in, which is near
    the end — and that is far better information than assuming every shot
    takes an equal share of some invented window.

    Assuming otherwise was a real failure, not a theoretical one. With one
    anchor the old code spread the run across a fixed 45 seconds however many
    shots there were, so seventy shots whose stated durations add to 254
    seconds were packed into 54 — one shot every 0.77 s. Every one of them
    landed in the same corner of the episode, and the contact sheet came back
    as the same red-lit frame over and over.
    """
    out, t = [], 0.0
    for e in run.entries:
        d = max(0.5, e.target_seconds)
        out.append(t + d / 2.0)
        t += d
    return out


def fit(run: Run, anchors: list) -> tuple:
    """(scale, offset) mapping the script's axis onto real episode time.

    One anchor pins the axis without stretching it — the axis is then the
    only statement about pacing there is, and it is a far better one than a
    fixed window. Two or more anchors measure the stretch directly, and that
    measurement wins: they are real times from the real episode, while the
    axis is only the shape between them.
    """
    ax = axis(run)
    if len(anchors) < 2:
        i, start = anchors[0][0], anchors[0][1]
        return 1.0, start - ax[i] * 1000.0

    first, last = anchors[0], anchors[-1]
    span_axis = ax[last[0]] - ax[first[0]]
    span_time = (last[1] - first[1]) / 1000.0
    scale = span_time / span_axis if span_axis > 0.01 else 1.0
    if not (MIN_SCALE <= scale <= MAX_SCALE):
        scale = 1.0
    return scale, first[1] - ax[first[0]] * scale * 1000.0


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

    ax = axis(run)
    scale, offset = fit(run, anchors)
    times = [(a * scale * 1000.0 + offset) for a in ax]
    if len(anchors) > 1 and (max(times) - min(times)) / 1000.0 > MAX_RUN_SPAN_S:
        keep = max(anchors, key=lambda a: (a[4] == "high", a[0]))
        log(f"      two lines put this run across "
            f"{(max(times) - min(times)) / 60000:.0f} minutes of the episode, "
            "which is more than one sequence — so one of them is wrong and "
            "only the clearest is used")
        anchors = [keep]
        scale, offset = fit(run, anchors)
        times = [(a * scale * 1000.0 + offset) for a in ax]
    lo = max(0.0, min(times) - 2000)
    hi = max(times) + 2000
    if duration:
        hi = min(hi, duration * 1000)
    log(f"    {run.label}: {len(run.entries)} shot(s), {len(anchors)} anchor(s), "
        f"span {lo/1000:.0f}s-{hi/1000:.0f}s "
        f"(script says {ax[-1] + run.entries[-1].target_seconds / 2:.0f}s, "
        f"x{scale:.2f})")
    if len(anchors) < 2 and len(run.entries) >= 4:
        # One anchor fixes WHERE the run sits but not which way it runs. If
        # the script put that line at the wrong end, every shot lands on the
        # wrong side of it — which is how seventy shots of a killing came
        # back as the cleanup that follows it.
        at = anchors[0][0]
        log(f"      only one line matched, at shot {at + 1} of "
            f"{len(run.entries)}. Everything else is placed relative to it, "
            "so if that line is not really there, none of them are. A second "
            "quoted line anywhere else in this run would fix that.")

    try:
        boundaries = cutter.detect_shots(path, lo / 1000, hi / 1000)
    except ProbeError as exc:
        boundaries = []
        log(f"      shot detection unavailable ({exc})")

    # Snapping helps only when a boundary is genuinely near. With shots this
    # close together a distant one belongs to a neighbour, so the reach is
    # never more than half the gap to the next placement.
    spacing = (hi - lo) / 1000.0 / max(1, len(run.entries))
    snap_limit = min(MAX_SNAP_S, max(0.5, spacing / 2.0))

    anchor_at = {a[0]: a for a in anchors}
    used: list[float] = []

    for i, e in enumerate(run.entries):
        p = out[i]
        p.path = path
        if e.is_hook and e.query:
            # Cut it where the line really is, but it took no part in
            # deciding where anything else goes.
            hits = find(db_path, e.query, show=run.source or None,
                        limit=1, con=con)
            if hits and hits[0].confidence != "low":
                h = hits[0]
                p.start_ms, p.end_ms = h.start_ms, h.end_ms
                p.method, p.confidence = "anchor", h.confidence
                p.note = "matched on a hook quote — not used for ordering"
                continue
        if i in anchor_at:
            _, s_ms, e_ms, _p, conf = anchor_at[i]
            p.start_ms, p.end_ms = s_ms, e_ms
            p.method, p.confidence = "anchor", conf
            p.note = "matched on dialogue"
            used.append(s_ms / 1000)
            continue

        want = max(0.0, times[i] / 1000.0)
        # snap to the nearest shot boundary that is not already spoken for
        candidates = [b for b in boundaries
                      if all(abs(b - u) > MIN_SEPARATION_S for u in used)]
        p.method = "interpolated"
        nearest = min(candidates, key=lambda b: abs(b - want)) if candidates else None
        if nearest is not None and abs(nearest - want) <= snap_limit:
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
