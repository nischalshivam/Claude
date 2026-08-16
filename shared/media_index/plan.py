"""Match a narration/visual script against the catalogue — Stage 2.

The catalogue (`catalog.py`) says what every shot of a film IS. This module
answers the other half: for each thing the script wants on screen, which
catalogued shot should play. It is the retrieval step a friend's brief calls
"for any point in the narration, locate and pull the exact right footage".

## The ladder, precision first

Each shot-request is answered by the strongest signal that fires, and the
answer carries *why* so a person can trust or overrule it:

  1. **dialogue anchor** — the request quotes a line, and a catalogued shot's
     own subtitle text contains it. This is the "money moment": the exact
     second a line was spoken, located to the shot. Strongest, because it is
     matched fact, not resemblance.
  2. **description + character** — no quotable line, so the request's visual
     sentence is matched against the shots' descriptions/tags, filtered to the
     named person. Strong on ordinary connective footage, where any good shot
     of the right character in the right moment is a right answer.
  3. **none → NEEDS VISUAL** — nothing cleared the bar. An honest gap the user
     fills, never a confident wrong guess. (This is the fail-closed rule that
     the whole project turns on: a card beats wrong footage.)

Nothing here decides a timestamp on its own or invents a shot; it only ranks
shots the catalogue already contains. Character *verification* against
reference photos (`cast.py`) is the layer that sits on top of a chosen shot.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from . import catalog

# A quoted line shorter than this is too common to anchor on — "I know",
# "Stop", "What?" match somewhere in almost every reel and would place a shot
# by coincidence. Longer lines are near-unique to their moment.
MIN_ANCHOR_CHARS = 12


@dataclass
class Request:
    """One thing the script wants on screen."""
    beat: int = 0
    visual: str = ""
    characters: list = field(default_factory=list)
    dialogue: str = ""            # a line the script says is spoken here
    source: str = ""              # which title/episode the shot belongs to
    scene_range: str = ""         # e.g. "40:00-45:00" — confines within source
    kind: str = "clip"            # clip (moving) | still (frozen frame)
    duration: float = 0.0         # duration_target_sec the script asked for

    @property
    def character(self) -> str:
        return self.characters[0] if self.characters else ""


@dataclass
class Match:
    """The chosen shot for a request, and the honest reason."""
    shot: object = None                 # a catalog.Shot, or None
    method: str = "none"                # dialogue | description | none
    why: str = ""

    @property
    def placed(self) -> bool:
        return self.shot is not None


def _norm(s: str) -> str:
    return re.sub(r"\s{2,}", " ", re.sub(r"[^a-z0-9 ]", " ", (s or "").lower())).strip()


def dialogue_anchor(library: dict, line: str, limit: int = 5) -> list:
    """Catalogued shots whose own subtitle text contains this line.

    The whole line need not match — a script quotes a fragment, the subtitle
    holds the surrounding sentence — so containment either way counts. Returned
    earliest-first, because a repeated line's first delivery is usually the one
    a script means.
    """
    q = _norm(line)
    if len(q) < MIN_ANCHOR_CHARS:
        return []
    hits = []
    for shot in library.values():
        d = _norm(shot.dialogue)
        if d and (q in d or d in q):
            hits.append(shot)
    return sorted(hits, key=lambda s: s.start)[:limit]


def _norm_ep(s: str) -> str:
    """A comparable episode key from either spelling: 'S04E01', 'Season 4
    Episode 1', 'Breaking Bad S04E01' all reduce to 's4e1'."""
    from . import subtitles
    key = subtitles.episode_key(s or "")
    return f"s{key[0]}e{key[1]}" if key else ""


def scoped(library: dict, source: str) -> dict:
    """Only the shots from the named episode/title. A single-scene essay must
    draw from ONE episode, and searching the whole series is exactly what
    scatters its shots across the wrong ones."""
    if not source:
        return library
    want = _norm_ep(source)
    if want:                                  # an episode marker: match by it
        return {k: s for k, s in library.items() if _norm_ep(s.source) == want}
    low = source.lower()                      # a title/name: substring match
    return {k: s for k, s in library.items() if low in s.source.lower()} or library


def _range_seconds(text: str) -> tuple:
    """('40:00-45:00' | '2400-2700') -> (2400.0, 2700.0), or () if unreadable."""
    m = re.search(r"(\d{1,2}:\d{2}(?::\d{2})?|\d+)\s*[-–]\s*"
                  r"(\d{1,2}:\d{2}(?::\d{2})?|\d+)", text or "")
    if not m:
        return ()

    def to_s(v):
        if ":" in v:
            parts = [int(p) for p in v.split(":")]
            return sum(p * 60 ** i for i, p in enumerate(reversed(parts)))
        return float(v)
    lo, hi = to_s(m.group(1)), to_s(m.group(2))
    return (lo, hi) if hi > lo else ()


def windowed(pool: dict, scene_range: str, pad: float = 30.0) -> dict:
    """Only shots overlapping the scene's time window (with a little padding).
    This is what pins a single scene inside an episode — the box-cutter scene
    is one five-minute stretch of a forty-seven-minute file."""
    span = _range_seconds(scene_range)
    if not span:
        return pool
    lo, hi = span[0] - pad, span[1] + pad
    inside = {k: s for k, s in pool.items() if s.end > lo and s.start < hi}
    return inside or pool                     # never strand a whole beat


def match(request: Request, library: dict, scope: str = "") -> Match:
    """The best catalogued shot for one request, precision first.

    `scope` (or the request's own `source`) confines the search to one
    episode/title before ranking — the single biggest accuracy lever on a
    series, because it stops a box-cutter line from matching the word
    "box cutter" three episodes away.
    """
    pool = scoped(library, scope or request.source)
    if not pool:                              # scope named nothing we have
        pool = library
    if request.scene_range:                   # confine to the scene's window
        pool = windowed(pool, request.scene_range)

    if request.dialogue:
        anchored = dialogue_anchor(pool, request.dialogue)
        if anchored:
            top = anchored[0]
            return Match(shot=top, method="dialogue",
                         why=f'line at {top.start:.0f}s: "{request.dialogue[:48]}"')

    hits = catalog.search(pool, f"{request.visual} {request.dialogue}",
                          character=request.character)
    if hits:
        where = hits[0].source
        return Match(shot=hits[0], method="description",
                     why=(f"visual+character match"
                          + (f" ({request.character})" if request.character else "")
                          + (f" in {where}" if scope or request.source else "")))

    return Match(method="none", why="koi match nahi — NEEDS VISUAL card")


def requests_from_beats(beats: list) -> list:
    """Turn a visual (genspark) script's shots into shot-requests.

    A genspark run marks its `scene_range` on the FIRST shot only; the rest of
    the run belongs to the same scene but carries no range, so on its own each
    of those shots would scope to the whole episode and drift. The range is
    carried forward across shots of the same source until a new range appears
    (a new scene) or the source changes (a new episode) — so every shot of a
    scene is pinned to that scene's window, not just its opening frame.
    """
    out = []
    cur_source, cur_range = "", ""
    for b in beats:
        bn = b.get("beat") or 0
        for shot in (b.get("shots") or []):
            src = str(shot.get("season_episode")
                      or shot.get("source") or "").strip()
            rng = str(shot.get("scene_range") or "").strip()
            if src != cur_source:             # new episode: forget the window
                cur_source, cur_range = src, ""
            if rng:                           # new scene: adopt its window
                cur_range = rng
            out.append(Request(
                beat=bn,
                visual=str(shot.get("visual") or ""),
                characters=catalog.list_entries(
                    shot.get("characters") or shot.get("people")),
                dialogue=str(shot.get("exact_dialogue")
                             or shot.get("dialogue") or "").strip(),
                source=src,
                scene_range=rng or cur_range,
                kind=str(shot.get("kind") or "clip").strip().lower(),
                duration=float(shot.get("duration_target_sec") or 0) or 0.0))
    return out


@dataclass
class PlanStats:
    total: int = 0
    by_method: dict = field(default_factory=dict)

    @property
    def placed(self) -> int:
        return sum(v for k, v in self.by_method.items() if k != "none")

    @property
    def coverage(self) -> float:
        return self.placed / self.total if self.total else 0.0

    def summary(self) -> str:
        parts = ", ".join(f"{k}: {v}" for k, v in sorted(self.by_method.items()))
        return (f"{self.placed}/{self.total} shots placed "
                f"({self.coverage * 100:.0f}%) — {parts}")


def known_names(library: dict) -> list:
    """Every character name the catalogue knows, longest first so 'Walter
    White' is tried before 'Walt' when scanning a sentence."""
    names = {c for shot in library.values() for c in shot.characters}
    return sorted(names, key=lambda n: -len(n))


def requests_from_text(text: str, names: list | None = None) -> list:
    """Turn a plain narration script into shot-requests, one per sentence.

    A clean narration is prose about meaning, but a good essay's narration is
    also highly visual — "He steps into a red hazmat suit", "he picks up a box
    cutter" — so each sentence is a fair query for the footage that should sit
    under it. Any catalogue character named in the sentence becomes its
    character filter, which is what turns "he kills Victor" into a search that
    actually prefers Victor's shots.
    """
    names = names or []
    sentences = re.split(r"(?<=[.!?])\s+", (text or "").replace("\n", " "))
    out = []
    for i, s in enumerate(sentences, 1):
        s = s.strip()
        if len(s) < 12:                       # skip stubs and headers
            continue
        low = s.lower()
        found = [n for n in names if n.lower() in low
                 or n.split()[0].lower() in low.split()]
        out.append(Request(beat=i, visual=s, characters=found[:3]))
    return out


def plan(source, library: dict, scope: str = "") -> tuple:
    """(list of (Request, Match), PlanStats) for a whole script.

    `source` may be parsed genspark beats (a list of beat dicts) or a plain
    narration string — the retrieval is the same either way. `scope` confines
    the WHOLE script to one episode/title, which is what a single-scene essay
    (e.g. the box-cutter scene, all of it in S04E01) needs.
    """
    if isinstance(source, str):
        reqs = requests_from_text(source, known_names(library))
    else:
        reqs = requests_from_beats(source)
    pairs, stats = [], PlanStats()
    for req in reqs:
        m = match(req, library, scope=scope)
        pairs.append((req, m))
        stats.total += 1
        stats.by_method[m.method] = stats.by_method.get(m.method, 0) + 1
    return pairs, stats
