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


def match(request: Request, library: dict) -> Match:
    """The best catalogued shot for one request, precision first."""
    if request.dialogue:
        anchored = dialogue_anchor(library, request.dialogue)
        if anchored:
            top = anchored[0]
            return Match(shot=top, method="dialogue",
                         why=f'line at {top.start:.0f}s: "{request.dialogue[:48]}"')

    hits = catalog.search(library, f"{request.visual} {request.dialogue}",
                          character=request.character)
    if hits:
        return Match(shot=hits[0], method="description",
                     why=(f"visual+character match"
                          + (f" ({request.character})" if request.character else "")))

    return Match(method="none", why="koi match nahi — NEEDS VISUAL card")


def requests_from_beats(beats: list) -> list:
    """Turn a visual (genspark) script's shots into shot-requests."""
    out = []
    for b in beats:
        bn = b.get("beat") or 0
        for shot in (b.get("shots") or []):
            out.append(Request(
                beat=bn,
                visual=str(shot.get("visual") or ""),
                characters=catalog.list_entries(
                    shot.get("characters") or shot.get("people")),
                dialogue=str(shot.get("exact_dialogue")
                             or shot.get("dialogue") or "").strip()))
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


def plan(beats: list, library: dict) -> tuple:
    """(list of (Request, Match), PlanStats) for a whole script."""
    pairs, stats = [], PlanStats()
    for req in requests_from_beats(beats):
        m = match(req, library)
        pairs.append((req, m))
        stats.total += 1
        stats.by_method[m.method] = stats.by_method.get(m.method, 0) + 1
    return pairs, stats
