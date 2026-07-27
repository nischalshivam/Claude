"""Find out when each beat is actually spoken, instead of assuming.

`timeline.boundaries` estimates a beat's length from its word count at 150
words a minute, then stretches the whole plan onto the real runtime. That is
fine when the read is even. Real reads are not even: a narrator pauses on the
turn, races the list, holds the last line. An eight-minute script over a
nine-minute recording does not drift evenly — it drifts wherever the pauses
are, and every visual after a long pause sits under the wrong sentence.

The narration is scripted, so the recording says the same words the script
does. That makes this a text-to-audio alignment, and the tool already owns
both halves: `transcribe` turns the voiceover into timed words, and the
alignment idea is the one `align.py` uses for footage —

    find the handful of points that are unambiguous,
    keep only those that agree on order,
    interpolate everything between them.

An unambiguous point here is a word that occurs **exactly once in the script
and exactly once in the transcript**. There is no other place it could match.
On a two-thousand-word essay there are hundreds of them, which is far more
than the couple of dozen boundaries that need placing — so the interpolation
between anchors is over a few seconds, not a few minutes.

Everything degrades: no faster-whisper, no model, a transcript that will not
align — each of those returns nothing and lets `timeline` fall back on the
estimate it already had, with the reason said out loud.
"""
from __future__ import annotations

import os
import re
import tempfile
import time
from dataclasses import dataclass, field

DEFAULT_MODEL = "base.en"
# A beat boundary further than this from the nearest anchor is interpolated
# across a stretch long enough that the estimate could be wrong by a shot.
FAR_FROM_ANCHOR_WORDS = 60
_WORD = re.compile(r"[a-z0-9']+")


class NarrationUnavailable(RuntimeError):
    """The voiceover could not be transcribed."""


@dataclass
class Word:
    text: str
    start: float
    end: float


@dataclass
class Alignment:
    """Where every beat begins and ends in the recording."""
    spans: list = field(default_factory=list)        # [(start, end)] per beat
    anchors: int = 0
    script_words: int = 0
    heard_words: int = 0
    total_seconds: float = 0.0
    weak: list = field(default_factory=list)         # beats placed on a guess
    reason: str = ""                                 # why it did not work

    @property
    def ok(self) -> bool:
        return bool(self.spans) and not self.reason

    @property
    def rate(self) -> float:
        return self.anchors / self.script_words if self.script_words else 0.0

    def summary(self) -> str:
        from . import term
        if not self.ok:
            return f"  narration not aligned — {self.reason}"
        d = term.sym("dot")
        return (f"  heard {self.heard_words} word(s) in "
                f"{self.total_seconds / 60:.1f} min {d} "
                f"{self.anchors} unmistakable word(s) matched "
                f"({self.rate:.0%}) {d} "
                f"{len(self.spans) - len(self.weak)}/{len(self.spans)} beats "
                "placed on the recording itself")


def normalise(text: str) -> list:
    """Lowercase words, no punctuation. Both sides, identically."""
    return _WORD.findall(str(text or "").lower())


def script_words(beats: list) -> tuple:
    """(words, beat_end_index) — every narration word, in order.

    `beat_end_index[i]` is how many words have been spoken by the end of beat
    i, which is the only thing a boundary actually is.
    """
    words, ends = [], []
    for beat in beats:
        words += normalise(beat.get("narration") or "")
        ends.append(len(words))
    return words, ends


# ---------------------------------------------------------------------------
# hearing the recording
# ---------------------------------------------------------------------------

def available() -> tuple:
    from . import transcribe
    if not transcribe.available():
        return False, ("faster-whisper is not installed — run setup.bat, or "
                       "pip install faster-whisper")
    return True, "ready"


def heard(audio_path: str, model_name: str = DEFAULT_MODEL,
          log=lambda *a: None) -> list:
    """Every word of the voiceover, with the second it was said.

    Word timestamps rather than segment ones. A segment is a sentence or
    more, so placing a beat boundary on segment times can only ever be right
    to within a sentence — and a sentence is three or four shots.
    """
    from . import transcribe
    ok, why = available()
    if not ok:
        raise NarrationUnavailable(why)
    if not os.path.isfile(audio_path):
        raise NarrationUnavailable(f"no such file: {audio_path}")

    wav = os.path.join(tempfile.gettempdir(),
                       f"_mi_nar_{abs(hash(audio_path))}.wav")
    try:
        log("    reading the voiceover…")
        transcribe.extract_audio(audio_path, wav)
        model = transcribe._load_model(model_name)
        log(f"    listening with {model_name}…")
        segments, _info = model.transcribe(
            wav, language="en", word_timestamps=True, beam_size=5,
            # No VAD here. It exists to skip silence in a film; on a
            # voiceover it can clip the quiet start of a line, and a word
            # dropped from the transcript is one fewer anchor.
            vad_filter=False,
            condition_on_previous_text=False)
        out = []
        for seg in segments:
            for w in (getattr(seg, "words", None) or []):
                text = normalise(getattr(w, "word", ""))
                if not text:
                    continue
                out.append(Word(text=text[0],
                                start=float(getattr(w, "start", 0.0)),
                                end=float(getattr(w, "end", 0.0))))
        return out
    finally:
        try:
            os.remove(wav)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# matching the two
# ---------------------------------------------------------------------------

def unique_anchors(script: list, spoken: list) -> list:
    """[(script_index, spoken_index)] for words that can only match once.

    A word appearing once in the script and once in the transcript has
    exactly one possible pairing — there is nothing to be wrong about. Common
    words are skipped entirely rather than guessed at, which is why this
    needs no scoring, no threshold and no tuning.
    """
    def once(words):
        seen: dict = {}
        for i, w in enumerate(words):
            seen[w] = i if w not in seen else -1
        return {w: i for w, i in seen.items() if i >= 0}

    a, b = once(script), once(spoken)
    pairs = [(a[w], b[w]) for w in a.keys() & b.keys()]
    return sorted(pairs)


def increasing(pairs: list) -> list:
    """The longest run whose spoken order matches the script order.

    A unique word can still be a false friend — the transcriber mishears one
    word as another that happens to appear elsewhere — and one such pair
    dragged out of order would pull every boundary near it. Keeping only the
    longest increasing run drops those without needing to know which they
    are. O(n log n), because a scripted essay yields hundreds of anchors.
    """
    import bisect
    if not pairs:
        return []
    tails, tail_at, prev = [], [], [-1] * len(pairs)
    for i, (_s, spoken) in enumerate(pairs):
        pos = bisect.bisect_left(tails, spoken)
        if pos == len(tails):
            tails.append(spoken)
            tail_at.append(i)
        else:
            tails[pos], tail_at[pos] = spoken, i
        prev[i] = tail_at[pos - 1] if pos else -1
    out, i = [], tail_at[-1]
    while i != -1:
        out.append(pairs[i])
        i = prev[i]
    return out[::-1]


def time_at(word_index: int, anchors: list, spoken: list,
            total: float) -> tuple:
    """(seconds, distance_in_words_to_the_nearest_anchor).

    Between two anchors the reading rate is taken as constant, which over a
    few seconds it very nearly is. Outside them the nearest anchor's rate is
    carried on, because refusing to place the first and last beats would
    leave the two most visible parts of the video unaligned.
    """
    if not anchors:
        return 0.0, 10 ** 6
    times = [spoken[b].start for _s, b in anchors]
    keys = [s for s, _b in anchors]

    import bisect
    pos = bisect.bisect_left(keys, word_index)
    if pos == 0:
        near = 0
    elif pos >= len(keys):
        near = len(keys) - 1
    else:
        near = pos if (keys[pos] - word_index) < (word_index - keys[pos - 1]) \
            else pos - 1
    distance = abs(keys[near] - word_index)

    lo = min(max(pos - 1, 0), len(keys) - 2) if len(keys) >= 2 else 0
    if len(keys) < 2:
        return max(0.0, min(total, times[0])), distance
    hi = lo + 1
    span = keys[hi] - keys[lo]
    if span <= 0:
        return max(0.0, min(total, times[lo])), distance
    frac = (word_index - keys[lo]) / span
    at = times[lo] + frac * (times[hi] - times[lo])
    return max(0.0, min(total, at)), distance


def align(beats: list, spoken: list, total_seconds: float = 0.0) -> Alignment:
    """Turn a transcript into one (start, end) per beat."""
    words, ends = script_words(beats)
    total = total_seconds or (spoken[-1].end if spoken else 0.0)
    result = Alignment(script_words=len(words), heard_words=len(spoken),
                       total_seconds=total)
    if not words:
        result.reason = "the script has no narration text"
        return result
    if not spoken:
        result.reason = "nothing was heard in the recording"
        return result

    anchors = increasing(unique_anchors(words, [w.text for w in spoken]))
    result.anchors = len(anchors)
    if len(anchors) < 2:
        result.reason = (f"only {len(anchors)} word(s) could be matched "
                         "between the script and the recording — is this the "
                         "right audio for this script?")
        return result

    marks, t = [], 0.0
    for i, end_word in enumerate(ends):
        at, distance = time_at(end_word, anchors, spoken, total)
        at = max(at, t + 0.2)               # a beat can never end before it began
        if distance > FAR_FROM_ANCHOR_WORDS:
            result.weak.append(i + 1)
        marks.append((t, at))
        t = at
    # The last beat runs to the end of the recording: the closing line is
    # usually the one place a narrator slows right down, and cutting the
    # picture before the voice stops is the most visible mistake there is.
    if marks:
        start, _end = marks[-1]
        marks[-1] = (start, max(total, start + 0.5))
    result.spans = marks
    return result


def align_audio(beats: list, audio_path: str, model_name: str = DEFAULT_MODEL,
                total_seconds: float = 0.0, log=lambda *a: None) -> Alignment:
    """The whole thing: listen, match, report. Never raises."""
    t0 = time.time()
    try:
        spoken = heard(audio_path, model_name=model_name, log=log)
    except NarrationUnavailable as exc:
        return Alignment(reason=str(exc))
    except Exception as exc:                    # a bad recording is not fatal
        return Alignment(reason=f"{type(exc).__name__}: {exc}")
    out = align(beats, spoken, total_seconds=total_seconds)
    log(f"    listened in {time.time() - t0:.0f}s")
    return out
