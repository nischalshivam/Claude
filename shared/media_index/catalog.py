"""Turn a whole film or series into a searchable, tagged shot library.

This is the engine a friend's "index the entire series once, then every video
reuses it" workflow is built on, and it is the piece this tool was missing.
The idea is not clever, it is just thorough: watch the source once, break it
into short shots, and have a vision model write down what each shot *is* — who
is on screen, what happens, the kind of shot, whether it is clean enough to
use. Store that beside the exact dialogue timing already pulled from the
subtitles. The result is a catalogue that can be searched by meaning, so the
edit step can ask "a close-up of Arthur alone, dim, no on-screen text" and get
real answers instead of guessing between two spoken lines.

## Why a catalogue and not just embeddings

The tool already stores a CLIP-style vector per frame, and that vector is a
good *tie-breaker* but a weak *finder*: on a silent scene the right frame does
not clearly beat the noise floor. A one-line description written by a vision
model — "a thin man in clown make-up dances slowly, alone, arms out, dim
bathroom" — is a far stronger match for a narration beat about that moment
than any embedding, because it is language matched against language.

## What is deliberately NOT here

No scraping, no YouTube, no third-party upload. The source is the local file
the user already owns; the catalogue sits next to it on disk. The model is a
labeller, not an oracle — it is shown real frames and asked to describe what
it sees, never asked "where in this film is X". Its character labels are a
claim to be *verified* later (a second pass, `cast.py`), exactly as a friend's
brief describes: "before a character's footage is used, a second check
confirms the person is actually in the shot."

## Testability

Segmentation is a pure function of cut points and duration. The build loop
takes an injectable frame-grabber and an injectable `ask` (the model call),
so the whole pipeline runs in a unit test with neither ffmpeg nor a network.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import time
from dataclasses import dataclass, field, asdict

# A shot shorter than this is merged into its neighbour (a 4-frame flash is not
# a usable clip); one longer than this is split (a 40-second static talk is
# several beats' worth of footage, not one).
MIN_SHOT_S = 1.5
MAX_SHOT_S = 8.0
TARGET_SHOT_S = 5.0

# Frames shown to the model per shot. Enough to see how a shot moves without
# paying to describe near-identical stills.
FRAMES_PER_SHOT = 4

# ffmpeg's scene score above which a frame is treated as a new shot. 0.4 is the
# usual middle ground — lower floods on lighting flicker, higher misses soft
# cuts. Overridable per call.
SCENE_THRESHOLD = 0.40


@dataclass
class Shot:
    """One catalogued shot. Mirrors the course's library.json entry."""
    id: str
    source: str
    file: str
    start: float
    end: float
    description: str = ""
    tags: list = field(default_factory=list)
    characters: list = field(default_factory=list)
    action: str = ""
    shot_type: str = ""
    quality: str = ""            # high | mid | low
    safe: bool = True            # False = burned-in text/caption/graphic
    dialogue: str = ""

    @property
    def dur(self) -> float:
        return round(self.end - self.start, 2)


# ---------------------------------------------------------------------------
# segmentation — pure, so it is tested without a video
# ---------------------------------------------------------------------------

def _slug(name: str) -> str:
    base = os.path.splitext(os.path.basename(name))[0]
    return re.sub(r"[^a-z0-9]+", "_", base.lower()).strip("_") or "src"


def shots_from_cuts(cuts: list, duration: float,
                    min_s: float = MIN_SHOT_S, max_s: float = MAX_SHOT_S,
                    target_s: float = TARGET_SHOT_S) -> list:
    """(start, end) windows from a sorted list of cut times and a duration.

    A cut list of [12.0, 47.0] over a 60s clip is three raw shots — 0-12,
    12-47, 47-60. The 35-second middle one is longer than a shot should be, so
    it is split into ~target-length pieces; a sub-`min_s` sliver is folded into
    the shot before it rather than shipped as its own entry.
    """
    if duration <= 0:
        return []
    points = [0.0] + sorted(t for t in cuts if 0.0 < t < duration) + [duration]
    raw = []
    for a, b in zip(points, points[1:]):
        if b - a <= 0:
            continue
        if raw and (a - raw[-1][0]) < 1e-6:      # duplicate cut
            continue
        raw.append((a, b))

    out = []
    for a, b in raw:
        span = b - a
        if span <= max_s:
            out.append((a, b))
            continue
        # split a long take into roughly target-length pieces
        n = max(1, round(span / target_s))
        step = span / n
        for k in range(n):
            out.append((a + k * step, a + (k + 1) * step if k < n - 1 else b))

    # fold slivers into the previous shot
    merged = []
    for a, b in out:
        if merged and (b - a) < min_s:
            pa, _pb = merged[-1]
            merged[-1] = (pa, b)
        else:
            merged.append((a, b))
    return [(round(a, 3), round(b, 3)) for a, b in merged]


def fixed_windows(duration: float, win_s: float = TARGET_SHOT_S) -> list:
    """Even windows across the whole file — the fallback when cut detection is
    unavailable. Deterministic, and good enough to catalogue from."""
    if duration <= 0:
        return []
    out, t = [], 0.0
    while t < duration - 1e-6:
        out.append((round(t, 3), round(min(t + win_s, duration), 3)))
        t += win_s
    return out


def detect_cuts(path: str, threshold: float = SCENE_THRESHOLD,
                timeout: int = 1800) -> list:
    """Cut timestamps from ffmpeg scene detection. [] if ffmpeg cannot run.

    One pass, reading only the scene scores ffmpeg prints — no video is
    decoded to disk. A failure here is never fatal: the caller falls back to
    fixed windows, which still produces a usable catalogue.
    """
    import subprocess
    from .probe import ffmpeg_bin
    try:
        exe = ffmpeg_bin()
    except Exception:
        return []
    cmd = [exe, "-v", "info", "-i", path, "-filter_complex",
           f"select='gt(scene,{threshold})',showinfo", "-f", "null", "-"]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return []
    text = (r.stderr or b"").decode("utf-8", "replace")
    cuts = []
    for m in re.finditer(r"pts_time:(\d+(?:\.\d+)?)", text):
        cuts.append(float(m.group(1)))
    return sorted(set(cuts))


def dialogue_for(cues: list, start: float, end: float) -> str:
    """Subtitle text that overlaps a shot window, joined in order.

    A shot's spoken line is the strongest label it can carry, so it is stored
    right next to the model's description — the same shot is then findable by
    what was said in it and by what it looked like.
    """
    parts = []
    for c in cues or []:
        cs, ce = c.start_ms / 1000.0, c.end_ms / 1000.0
        if ce > start and cs < end:           # any overlap
            t = (c.text or "").strip()
            if t:
                parts.append(t)
    return " ".join(parts)[:400]


# ---------------------------------------------------------------------------
# the model prompt and its answer
# ---------------------------------------------------------------------------

def tag_messages(frames: list, known_characters: list | None = None,
                 dialogue: str = "") -> list:
    """Messages asking the model to DESCRIBE a shot from its frames.

    Framed as description, never location: the model is shown real frames and
    asked what is in them. A hint list of known character names nudges it to
    use the right spelling, but it is told to say `unknown` rather than guess —
    an invented name is worse than an honest blank, because the whole point of
    the later verification pass is that names are claims, not truth.
    """
    from .gemini import _data_uri
    known = ", ".join(known_characters) if known_characters else ""
    rules = (
        "You label footage for a searchable clip library. You are shown a few "
        "frames sampled from ONE short shot, in order. Describe only what is "
        "visibly there.\n\n"
        "Answer ONLY with strict JSON:\n"
        '{"description": "<one vivid sentence: who + what + setting>", '
        '"tags": ["<lowercase keyword>", ...], '
        '"characters": ["<named person actually visible>", ...], '
        '"action": "<what happens, few words>", '
        '"shot_type": "<wide|medium|close-up|extreme close-up|insert|aerial>", '
        '"quality": "<high|mid|low>", '
        '"safe": <true|false>}\n\n'
        "Rules:\n"
        "- characters: only people you can actually see and recognise. If you "
        "are not sure who someone is, use \"unknown\". Never guess a name.\n"
        "- safe=false if the shot has burned-in subtitles, captions, or large "
        "on-screen text/graphics; otherwise true.\n"
        "- quality: low if blurry, dark to the point of unreadable, or a "
        "transition/black frame.\n"
        "- tags: 4-8 concrete keywords (mood, setting, objects, action)."
    )
    ask = "Describe this shot."
    if known:
        ask += f"\nKnown characters in this title (use these spellings if you " \
               f"see them): {known}"
    if dialogue:
        ask += f'\nLine spoken during this shot (context only): "{dialogue}"'
    content = [{"type": "text", "text": ask}]
    for i, jpeg in enumerate(frames, 1):
        content.append({"type": "text", "text": f"Frame {i}:"})
        content.append({"type": "image_url",
                        "image_url": {"url": _data_uri(jpeg)}})
    return [{"role": "system", "content": rules},
            {"role": "user", "content": content}]


def canonicalize(names: list, canon: dict) -> list:
    """Collapse the model's varied character labels to canonical names.

    Gemini calls the same person "Joaquin Phoenix", "Joker", and "Arthur
    Fleck" across three shots — an actor name, a persona, a full name. For
    search to work, one person must have one name. `canon` maps any known
    alias (lowercased) to the canonical label; an unmapped name is kept as-is
    (it might be a real minor character), and duplicates are removed in order.
    """
    out, seen = [], set()
    for raw in names:
        key = re.sub(r"\s+", " ", str(raw).strip().lower())
        name = canon.get(key, raw)
        if name.lower() not in seen:
            out.append(name)
            seen.add(name.lower())
    return out


def alias_map(people: list) -> dict:
    """{alias_lower: canonical} for a list of 'Canonical = alias, alias' lines
    or plain names. `Arthur = Arthur Fleck, Joker, Joaquin Phoenix` teaches
    the collapse; a bare `Murray` maps only itself."""
    canon: dict = {}
    for line in people or []:
        line = str(line).strip()
        if not line:
            continue
        if "=" in line:
            name, aliases = line.split("=", 1)
            name = name.strip()
            parts = [name] + [a.strip() for a in aliases.split(",")]
        else:
            name, parts = line, [line]
        for a in parts:
            if a:
                canon[a.lower()] = name
    return canon


def parse_tags(text: str) -> dict:
    """The model's JSON, made safe. Tolerant of fences and stray prose."""
    raw = (text or "").strip()
    a, b = raw.find("{"), raw.rfind("}")
    if a < 0 or b <= a:
        return {}
    try:
        obj = json.loads(raw[a:b + 1])
    except (ValueError, TypeError):
        return {}
    if not isinstance(obj, dict):
        return {}

    def as_list(v):
        if isinstance(v, list):
            return [str(x).strip() for x in v if str(x).strip()]
        if isinstance(v, str) and v.strip():
            return [p.strip() for p in re.split(r"[,;]", v) if p.strip()]
        return []

    chars = [c for c in as_list(obj.get("characters"))
             if c.lower() not in ("unknown", "none", "n/a", "")]
    return {
        "description": str(obj.get("description") or "").strip()[:400],
        "tags": [t.lower() for t in as_list(obj.get("tags"))][:12],
        "characters": chars[:8],
        "action": str(obj.get("action") or "").strip()[:120],
        "shot_type": str(obj.get("shot_type") or "").strip().lower()[:40],
        "quality": (str(obj.get("quality") or "").strip().lower() or "mid"),
        "safe": bool(obj.get("safe", True)),
    }


# ---------------------------------------------------------------------------
# the library file
# ---------------------------------------------------------------------------

def load_library(path: str) -> dict:
    """{id: Shot}. A missing or unreadable file is an empty library."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    out = {}
    for row in data.get("shots", []) if isinstance(data, dict) else []:
        try:
            out[row["id"]] = Shot(**{k: row.get(k) for k in
                                     Shot.__dataclass_fields__ if k in row})
        except (KeyError, TypeError):
            continue
    return out


def save_library(path: str, shots: dict) -> None:
    """Write the whole catalogue, sorted by source then time. Atomic-ish."""
    rows = sorted((asdict(s) for s in shots.values()),
                  key=lambda r: (r["source"], r["start"]))
    tmp = path + ".tmp"
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"shots": rows, "count": len(rows)}, f,
                  ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def plan_shots(duration: float, path: str = "") -> list:
    """The (start, end) windows to catalogue: real cuts if we can, else even
    windows. Kept separate so a caller can preview the count before paying to
    tag anything."""
    cuts = detect_cuts(path) if path else []
    windows = shots_from_cuts(cuts, duration) if cuts else fixed_windows(duration)
    return windows


def build_catalog(source: str, file: str, duration: float, out_json: str,
                  grab, ask, cues: list | None = None,
                  known_characters: list | None = None,
                  canon: dict | None = None,
                  windows: list | None = None, log=lambda *a: None,
                  resume: bool = True) -> dict:
    """Catalogue one video into `out_json`. Returns {id: Shot}.

    `grab(start, end) -> [jpeg_bytes, ...]` samples representative frames of a
    window; `ask(messages) -> text` is the model call. Both injected so this
    runs under test with neither ffmpeg nor a network. Saved after every shot,
    so a run interrupted at shot 900 of 1500 resumes there — no frame is
    described twice, and nothing is lost to a crash. `canon` collapses the
    model's varied character labels (actor/persona/name) to one name each.
    """
    library = load_library(out_json) if resume else {}
    slug = _slug(file or source)
    canon = canon or {}
    windows = windows if windows is not None else plan_shots(duration, file)
    total = len(windows)
    done = 0
    for i, (start, end) in enumerate(windows):
        shot_id = f"{slug}__{i:05d}"
        if shot_id in library and library[shot_id].description:
            done += 1
            continue
        line = dialogue_for(cues, start, end)
        try:
            frames = grab(start, end)
        except Exception as exc:                 # a bad window never dies a run
            log(f"      shot {i} grab failed: {exc}")
            frames = []
        tags = {}
        if frames:
            try:
                tags = parse_tags(ask(tag_messages(
                    frames, known_characters, line)))
            except Exception as exc:
                log(f"      shot {i} tag failed: {exc}")
                tags = {}
        if tags.get("characters"):
            tags["characters"] = canonicalize(tags["characters"], canon)
        library[shot_id] = Shot(
            id=shot_id, source=source, file=file, start=start, end=end,
            dialogue=line, **{k: tags[k] for k in
                              ("description", "tags", "characters", "action",
                               "shot_type", "quality", "safe") if k in tags})
        done += 1
        save_library(out_json, library)          # crash-safe, every shot
        if done % 25 == 0 or done == total:
            log(f"      catalogued {done}/{total} shots")
    return library


# ---------------------------------------------------------------------------
# the real wiring — ffmpeg frames and the Gemini call
# ---------------------------------------------------------------------------

def real_grab(path: str, n: int = FRAMES_PER_SHOT, width: int = 768):
    """A frame-grabber over a real file: the best `n` distinct frames of a
    window, as JPEG bytes. Reuses the same sharpness/dedupe scoring the still
    picker uses, so a shot is described by clean frames, not blurred ones."""
    from .cutter import extract_frame
    from . import frames as frames_mod

    def grab(start: float, end: float) -> list:
        try:
            best = frames_mod.pick(frames_mod.scan(path, start, end), n)
        except Exception:
            best = []
        times = [c.time for c in best] or [(start + end) / 2.0]
        out = []
        for t in times:
            fd, tmp = tempfile.mkstemp(suffix=".jpg")
            os.close(fd)
            try:
                extract_frame(path, t, tmp, width=width)
                with open(tmp, "rb") as f:
                    out.append(f.read())
            except Exception:
                pass
            finally:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
        return out
    return grab


def gemini_ask(cfg=None):
    """An `ask` bound to the configured Gemini endpoint. Returns '' on any
    failure so a single bad shot never dies the whole catalogue run."""
    from . import gemini
    cfg = cfg or gemini.config()

    def ask(messages) -> str:
        text, _detail = gemini.call(cfg, messages)
        return text or ""
    return ask


def run(video_path: str, out_json: str = "", known_characters: list | None = None,
        max_minutes: float = 0.0, log=lambda *a: None) -> dict:
    """Catalogue one local video end to end. The function the CLI/UI calls.

    `max_minutes` caps how far in it goes — set it to 20 for a cheap quality
    check before paying to tag a whole two-hour film. `out_json` defaults to
    `<video>.catalog.json` beside the file.
    """
    from .probe import probe
    from . import subtitles, naming, gemini

    ok, why = gemini.available()
    if not ok:
        raise RuntimeError(f"Gemini set nahi hai: {why}")

    duration = probe(video_path).duration
    if max_minutes and max_minutes * 60.0 < duration:
        duration = max_minutes * 60.0
    kind, _src, cues = subtitles.load_for_video(video_path)
    source = naming.parse(video_path).label
    out_json = out_json or (os.path.splitext(video_path)[0] + ".catalog.json")

    # Say out loud whether the dialogue signal is even present. A catalogue
    # with zero subtitle lines still works off the descriptions, but the
    # strongest label a shot can carry is what was said in it — so if this is
    # 0 it is worth knowing now, not discovering it silently in the JSON.
    if cues:
        log(f"  subtitles: {len(cues)} lines ({kind}) — dialogue will be tagged")
    else:
        # List the subtitle-looking files that ARE beside the video, so a
        # "none" is not a dead end. If an .srt is sitting right there but not
        # matched, that is a naming/sync problem to see, not a missing file.
        folder = os.path.dirname(video_path)
        subs = []
        try:
            subs = [f for f in os.listdir(folder)
                    if f.lower().endswith((".srt", ".vtt", ".ass", ".ssa"))]
        except OSError:
            pass
        log(f"  subtitles: koi line nahi mili ({kind}) — sirf picture se tag hoga.")
        if subs:
            log(f"    (folder me ye subtitle file(s) hain par match nahi hui: "
                f"{', '.join(subs[:5])} — naam video jaisa rakho ya .en.srt)")
        else:
            log("    (folder me koi .srt file hai hi nahi — download karke daalo)")

    # A character list (which may carry aliases, e.g.
    # "Arthur = Arthur Fleck, Joker, Joaquin Phoenix") both nudges the model
    # to name the canonical person AND collapses its varied labels afterwards.
    canon = alias_map(known_characters or [])
    canon_names = sorted({v for v in canon.values()}) or (known_characters or [])
    if canon_names:
        log(f"  characters: {', '.join(canon_names)} (baaki ko 'unknown' rakhega)")

    cuts = detect_cuts(video_path)
    windows = (shots_from_cuts(cuts, duration) if cuts
               else fixed_windows(duration))
    how = f"{len(cuts)} scene cuts" if cuts else "even windows (no cuts found)"
    log(f"  {source}: {len(windows)} shots to catalogue — {how}")
    return build_catalog(source, video_path, duration, out_json,
                         real_grab(video_path), gemini_ask(), cues=cues,
                         known_characters=canon_names, canon=canon,
                         windows=windows, log=log)


# ---------------------------------------------------------------------------
# retrieval — search the catalogue by meaning (lexical v1)
# ---------------------------------------------------------------------------

_WORD = re.compile(r"[a-z0-9']+")


def _terms(text: str) -> set:
    return set(_WORD.findall((text or "").lower()))


def search(library: dict, query: str, character: str = "",
           need_safe: bool = True, limit: int = 8) -> list:
    """Best shots for a narration query, most relevant first.

    A lexical overlap over description + tags + action + dialogue, weighted so
    a tag hit counts more than a description hit and a named-character hit is
    decisive. This is the honest v1: it turns the catalogue into something
    searchable today. A semantic embedding of the descriptions is the next
    upgrade and slots in behind the same function.
    """
    q = _terms(query)
    if not q:
        return []
    want_char = character.strip().lower()
    scored = []
    for shot in library.values():
        if need_safe and not shot.safe:
            continue
        if shot.quality == "low":
            continue
        desc_t = _terms(shot.description) | _terms(shot.action)
        tag_t = _terms(" ".join(shot.tags))
        dlg_t = _terms(shot.dialogue)
        score = (2.0 * len(q & tag_t) + 1.0 * len(q & desc_t)
                 + 1.5 * len(q & dlg_t))
        if want_char:
            chars = " ".join(shot.characters).lower()
            if want_char in chars:
                score += 5.0
            elif shot.characters:                # named someone else, not them
                score -= 1.0
        if score > 0:
            scored.append((score, shot))
    scored.sort(key=lambda s: (-s[0], s[1].start))
    return [shot for _s, shot in scored[:limit]]
