"""Times a person states, which outrank everything the tool can guess.

Every other module in this package is an argument about evidence: a quoted
line is exact, a picture match is a measurement against a noise floor, a
window is twenty weak agreements added up. All of that exists because nobody
had told the tool where the scene was.

Somebody usually knows. The person making the video has watched the episode;
the model that wrote the script has read a hundred summaries of it. "The box
cutter scene is 29:30 to 33:40 of S04E01" is one line to type and it is
worth more than the entire visual index, because it is not a guess at all.

Measured on the build this module was written for:

    Breaking Bad S04E01: 85 shot(s), no quoted line at all
    Breaking Bad S04E01: only 2 of 84 shot(s) beat what an unrelated caption
                         scores here — that is chance, not a match
    Breaking Bad S04E01: the picture has no opinion about where this run
                         happens

Eighty-five shots — the entire first half of an eleven-minute video — with
no dialogue to anchor to, no picture the model could place, and no opinion
about which four minutes of a forty-seven minute episode they came from.
There was nothing left for the tool to be clever with. One typed line
removes the whole problem.

Two ways in, because the two suit different moments:

  - **In the script.** A shot may state `at`, and a run may state
    `scene_range`. The model writing the visual script fills these in, and
    they travel with the script forever.
  - **Typed into New Video.** One small box, a line per scene:

        S04E01 29:30-33:40
        Breaking Bad S03E13 30:05

    Nothing to edit, nothing to regenerate, and it is the fastest way to
    rescue a script that is already written.

A stated time is never checked, never scored, and never overruled.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from . import align, subtitles
from .library import normalize

# A stated moment with no end is a point, not a range. The run around it
# still needs room, so the point is opened out by this much either side —
# comfortably more than any single scene, and far less than an episode.
POINT_PAD_S = 90.0


def parse_timecode(text) -> float | None:
    """Seconds from "29:47", "1:29:47", "29:47.5", "1787", "29m47s".

    Deliberately generous. This is read from things people type at midnight
    and from things a language model wrote, and refusing "29.47" on a
    technicality helps nobody. What it will NOT do is guess: anything it
    cannot read confidently comes back None and is ignored, because a
    misread timecode is worse than no timecode — it is a confident wrong
    answer wearing the one label this tool promises never to check.
    """
    if text is None:
        return None
    if isinstance(text, (int, float)):
        return float(text) if float(text) >= 0 else None
    s = str(text).strip().lower()
    if not s:
        return None

    got = re.fullmatch(r"(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:([\d.]+)s)?", s)
    if got and any(got.groups()):
        h, m, sec = got.groups()
        return (float(h or 0) * 3600.0 + float(m or 0) * 60.0
                + float(sec or 0))

    parts = s.replace(";", ":").split(":")
    try:
        if len(parts) == 1:
            # A bare number is seconds. "29.47" is 29 seconds, not 29:47 —
            # anyone writing minutes writes a colon.
            return max(0.0, float(parts[0]))
        if len(parts) == 2:
            return max(0.0, float(parts[0]) * 60.0 + float(parts[1]))
        if len(parts) == 3:
            return max(0.0, float(parts[0]) * 3600.0 + float(parts[1]) * 60.0
                       + float(parts[2]))
    except ValueError:
        return None
    return None


def parse_range(text) -> tuple | None:
    """(lo, hi) from "29:30-33:40", "29:30 to 33:40", or a single "29:30"."""
    if text is None:
        return None
    s = str(text).strip()
    if not s:
        return None
    # An en dash is what a word processor turns a hyphen into, and a script
    # that has been through one should not silently lose its ranges.
    s = s.replace("–", "-").replace("—", "-")
    s = re.sub(r"\s+to\s+", "-", s, flags=re.I)
    bits = [b for b in s.split("-") if b.strip()]
    if len(bits) >= 2:
        lo, hi = parse_timecode(bits[0]), parse_timecode(bits[1])
        if lo is None or hi is None:
            return None
        return (min(lo, hi), max(lo, hi)) if hi != lo else (lo, lo)
    at = parse_timecode(bits[0] if bits else s)
    if at is None:
        return None
    return (at, at)


@dataclass
class Stated:
    """One line somebody typed, or one range a script declared."""
    show: str = ""              # "" means "whatever episode this run uses"
    season: int | None = None
    episode: int | None = None
    lo: float = 0.0
    hi: float = 0.0
    source: str = "typed"       # typed | script

    @property
    def window(self) -> tuple:
        if self.hi > self.lo:
            return (max(0.0, self.lo), self.hi)
        return (max(0.0, self.lo - POINT_PAD_S), self.lo + POINT_PAD_S)

    @property
    def label(self) -> str:
        key = (f"S{self.season:02d}E{self.episode:02d}"
               if self.season is not None and self.episode is not None
               else "?")
        return f"{self.show + ' ' if self.show else ''}{key}"


# "S04E01 29:30-33:40", "Breaking Bad S03E13 30:05", "4x01 29:30 - 33:40"
_LINE = re.compile(r"""^\s*
    (?P<show>.*?)\s*
    (?P<key>s\d{1,2}\s*e\d{1,3}|\d{1,2}\s*x\s*\d{1,3})\s*
    [:\-–,]?\s*
    (?P<time>[\d:;.\s].*?)\s*$""", re.I | re.X)


def parse_lines(text: str) -> list[Stated]:
    """Every readable line of the New Video timings box.

    Unreadable lines are skipped rather than raised on. Someone pasting six
    lines from a chat window will have a stray heading in there, and losing
    the whole box to it — right before a two-hour build — would be a poor
    trade for strictness nobody asked for.
    """
    out = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        got = _LINE.match(line)
        if not got:
            continue
        span = parse_range(got.group("time"))
        if span is None:
            continue
        key = subtitles.episode_key(got.group("key"))
        if not key:
            continue
        season, episode = key
        out.append(Stated(show=(got.group("show") or "").strip(),
                          season=season, episode=episode,
                          lo=span[0], hi=span[1], source="typed"))
    return out


# What a script may call the fields. Written wide on purpose: the visual
# script comes out of a language model, the prompt asks for one name, and
# the model will occasionally use a synonym. Accepting the synonym costs one
# line here; rejecting it costs a whole run of the video.
SHOT_TIME_KEYS = ("at", "timestamp", "time", "episode_time", "at_seconds")
RANGE_KEYS = ("scene_range", "episode_range", "range", "scene_time",
              "scene_timestamp")


def shot_time(shot: dict) -> float | None:
    """The moment a single shot states it happens at, if it states one."""
    for key in SHOT_TIME_KEYS:
        if key in (shot or {}):
            at = parse_timecode(shot.get(key))
            if at is not None:
                return at
    return None


def shot_times(beats: list) -> dict:
    """{(beat, shot index from 1): seconds} for every shot that states one."""
    out: dict = {}
    for i, beat in enumerate(beats or [], 1):
        beat_no = beat.get("beat", i)
        for n, shot in enumerate(beat.get("shots") or [], 1):
            at = shot_time(shot)
            if at is not None:
                out[(beat_no, n)] = at
    return out


def from_script(beats: list) -> list[Stated]:
    """Ranges the script itself declares, one per run that declares one.

    Read off any shot of the run: the model is asked to put it on the first
    shot, and a range repeated on all of them says the same thing.
    """
    out = []
    for run in align.runs(beats or []):
        key = subtitles.episode_key(run.season_episode or "")
        span = None
        for entry in run.entries:
            for name in RANGE_KEYS:
                if name in (entry.data or {}):
                    span = parse_range((entry.data or {}).get(name))
                    if span:
                        break
            if span:
                break
        if not span:
            continue
        out.append(Stated(show=run.source or "",
                          season=key[0] if key else None,
                          episode=key[1] if key else None,
                          lo=span[0], hi=span[1], source="script"))
    return out


def _matches(run, said: Stated) -> bool:
    """Is this typed line talking about this run's episode?"""
    key = subtitles.episode_key(run.season_episode or "")
    if said.season is not None and said.episode is not None:
        if not key or key != (said.season, said.episode):
            return False
    if said.show:
        want, have = normalize(said.show), normalize(run.source or "")
        if want and have and want not in have and have not in want:
            return False
    return True


def windows_for(beats: list, stated: list, log=lambda *a: None) -> dict:
    """{beat: (lo, hi)} for every run somebody stated a time for.

    Typed lines are applied after script ranges, so the box in front of
    someone wins over a field written days ago by a model. That is the right
    way round: the box is what they reach for when the script is wrong.
    """
    if not stated:
        return {}
    out: dict = {}
    for said in sorted(stated, key=lambda s: s.source == "typed"):
        for run in align.runs(beats or []):
            if not _matches(run, said):
                continue
            for entry in run.entries:
                out[entry.beat] = said.window
            lo, hi = said.window
            log(f"      {run.label}: you said this is at "
                f"{lo/60:.0f}-{hi/60:.0f} min — nothing will look elsewhere")
    return out


def unstated(beats: list, stated: list) -> list:
    """Runs nobody has stated a time for, worst first.

    This is the whole point of asking for timings: telling someone which
    six lines to type is a far better use of a pre-flight than telling them
    the video will be 40% guesswork.
    """
    have = set()
    for said in stated or []:
        for run in align.runs(beats or []):
            if _matches(run, said):
                have.add(run.label)
    out = []
    for run in align.runs(beats or []):
        if run.label not in have:
            out.append((len(run.entries), run.label, run.season_episode))
    out.sort(reverse=True)
    return out
