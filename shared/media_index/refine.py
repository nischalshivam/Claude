"""Move guessed shots onto a frame a vision model actually looked at.

The last step, and the only one that touches the beats nothing else could.
After dialogue, picture search and pacing have run, some shots are still
placed by pure interpolation between distant anchors — and on a silent scene
that means minutes of error. Measured on the Gus build: twenty of thirty-six
beats were all-interpolated, and the bell that rings at 37:42 was laid at
32:25.

This module hands each of those shots to `gemini`: a bounded window that
interpolation already chose, a handful of frames sampled across it, and the
question "which of these is the moment". A confident answer moves the shot
onto that frame. Anything else leaves it exactly where interpolation put it.

Two things are kept deliberately at arm's length, because they are the parts
that need a network and a disk and cannot be unit-tested:

  - `grab(path, at_s) -> jpeg bytes`   — pull one frame
  - `ask(intent, frames, people) -> Choice`  — the model call

They are injected, so every decision this module makes — which shots are
eligible, where to sample, what a verdict does to a placement — is testable
with fakes, and only the two thin edges touch the real world.

Nothing here can make a build worse. A shot it does not move stays a
Tier-B interpolation; a shot it moves becomes a Tier-B frame a model chose.
It never promotes anything to Tier A and never deletes a placement.
"""
from __future__ import annotations

from dataclasses import dataclass

from . import align, gemini, verify as verify_mod

# A window narrower than this is already tight enough that interpolation is
# fine — the shots are seconds apart and there is nothing for a model to fix.
# The waste worth avoiding is a frame call per shot on a run that was never
# wrong.
MIN_WINDOW_S = 90.0
# How many frames to show the model per shot. Enough to cover a wide window
# at a usable spacing; more than this is cost without recall.
FRAMES_PER_SHOT = 12
# Never sample two candidate frames closer than this.
MIN_FRAME_GAP_S = 2.0


@dataclass
class Refinement:
    looked: int = 0                 # shots we asked the model about
    moved: int = 0                  # shots it confidently re-placed
    kept: int = 0                   # shots it declined to move

    def summary(self) -> str:
        if not self.looked:
            return "  vlm: koi shot check karne layak nahi tha"
        return (f"  vlm: {self.looked} shot dekhe {chr(183)} {self.moved} "
                f"sahi frame par le jaaye {chr(183)} {self.kept} jahan the "
                "wahin rahe")


def eligible(placements: list, windows: dict) -> list:
    """[(placement, (lo, hi))] for interpolated shots inside a wide window.

    Only interpolation is touched. An anchor is a matched line and a stated
    time is a person's word — moving either on a model's opinion would trade
    something known for something guessed, which is the wrong direction and
    the opposite of what this is for.
    """
    out = []
    for p in placements:
        if p.method != "interpolated":
            continue
        window = windows.get((p.beat, p.shot))
        if not window:
            continue
        lo, hi = window
        if hi - lo >= MIN_WINDOW_S:
            out.append((p, window))
    return out


def candidate_times(window: tuple, n: int = FRAMES_PER_SHOT) -> list:
    """Evenly spaced sample times across a window, never too dense.

    Even spacing rather than anything cleverer because the window is all the
    prior we have — if we knew where inside it to look, we would not be
    asking. The model supplies the cleverness.
    """
    lo, hi = window
    if hi <= lo:
        return [lo]
    span = hi - lo
    count = max(2, min(n, int(span // MIN_FRAME_GAP_S) + 1))
    step = span / (count - 1)
    return [lo + i * step for i in range(count)]


def _intent(entry) -> str:
    """What the shot is meant to show, in the words the script already has."""
    data = entry.data or {}
    return (str(data.get("visual") or "").strip()
            or str(data.get("nearest_dialogue") or "").strip()
            or str(data.get("exact_dialogue") or "").strip()
            or "the moment this shot describes")


def _people(entry) -> list:
    data = entry.data or {}
    who = data.get("must_be_visible") or data.get("characters") or []
    if isinstance(who, str):
        who = [who]
    return [str(x).strip() for x in who if str(x).strip()]


def _entry_for(beats: list, beat: int, shot: int):
    for b in beats:
        if b.get("beat") != beat:
            continue
        shots = b.get("shots") or []
        if 1 <= shot <= len(shots):
            e = align.Entry(beat=beat, shot=shot, data=shots[shot - 1])
            return e
    return None


def apply_choice(placement, choice) -> bool:
    """Move a placement onto the chosen frame. True if it moved.

    Keeps the shot's own length; only its position changes. The method
    becomes `vlm`, which `tiers` ceilings at B — a frame a model looked at is
    better than a guess between two far-apart lines, and still not the
    millisecond certainty of a matched line.
    """
    if not choice.chose:
        return False
    dur = max(1, placement.end_ms - placement.start_ms)
    placement.start_ms = int(choice.at_s * 1000)
    placement.end_ms = placement.start_ms + dur
    placement.method = "vlm"
    placement.confidence = "medium"
    placement.note = f"vlm ne frame chuna: {choice.reason}"[:200]
    return True


def refine_runs(beats: list, placements: list, windows: dict, log=lambda *a: None,
                grab=None, ask=None) -> Refinement:
    """Ask the model to re-place every wide interpolated shot. Never raises.

    `grab` and `ask` default to the real frame extractor and the real model
    call; tests pass fakes. If the model is not configured, this returns
    immediately and the build is untouched.
    """
    out = Refinement()
    todo = eligible(placements, windows)
    if not todo:
        return out
    if ask is None:
        ok, why = gemini.available()
        if not ok:
            log(f"  vlm: {len(todo)} shot behtar ho sakte the, par Gemini "
                f"set nahi hai ({why}). settings.txt me gemini_key/gemini_base "
                "daal do.")
            return out
        ask = gemini.verify
    if grab is None:
        grab = _real_grab

    log(f"  vlm: {len(todo)} interpolated shot ko sahi frame dhoondhne "
        "bhej rahe hain...")
    for p, window in todo:
        entry = _entry_for(beats, p.beat, p.shot)
        if entry is None:
            continue
        frames = []
        for at in candidate_times(window):
            jpeg = grab(p.path, at)
            if jpeg:
                frames.append(gemini.Frame(at_s=at, jpeg=jpeg))
        if not frames:
            continue
        out.looked += 1
        try:
            choice = ask(_intent(entry), frames, _people(entry))
        except Exception as exc:            # a verifier may never break a build
            log(f"      vlm call fail (beat {p.beat}): {exc}")
            out.kept += 1
            continue
        if apply_choice(p, choice):
            out.moved += 1
            log(f"      beat {p.beat} shot {p.shot}: "
                f"{choice.at_s/60:.0f}:{choice.at_s%60:04.1f} "
                f"({choice.confidence:.2f}) — {choice.reason}")
        else:
            out.kept += 1
    log(out.summary())
    return out


def _real_grab(path: str, at_s: float) -> bytes:
    """One JPEG frame at `at_s`, in memory. Empty bytes on any failure."""
    import os                                              # noqa: PLC0415
    import tempfile                                        # noqa: PLC0415
    from .cutter import extract_frame                      # noqa: PLC0415
    from .probe import ProbeError                          # noqa: PLC0415

    tmp = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
    tmp.close()
    try:
        extract_frame(path, at_s, tmp.name, width=768)
        with open(tmp.name, "rb") as f:
            return f.read()
    except (ProbeError, OSError):
        return b""
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
