"""Read the Footage Collector (tool #1) output + the visual instructor file.

Tool #1 writes:  output/scene_001/clip_*.mp4, shot*_*.jpg (frames), image_*.jpg,
scene.txt, and a top-level manifest.json. We scan folders (robust) and use the
instructor file for narration text + On-Screen Text.
"""
from __future__ import annotations

import glob
import json
import os
import re
from dataclasses import dataclass, field

VIDEO_EXT = (".mp4", ".mkv", ".webm", ".mov", ".avi")
IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp", ".bmp")


@dataclass
class Scene:
    index: int
    dir: str = ""
    clips: list = field(default_factory=list)
    images: list = field(default_factory=list)   # searched images
    frames: list = field(default_factory=list)   # stills grabbed from clips
    narration: str = ""
    on_screen: str = ""

    @property
    def all_images(self):
        # searched images first (usually higher quality), then frames
        return self.images + self.frames

    @property
    def word_count(self):
        return max(1, len(self.narration.split())) if self.narration else 1


def _natural_key(path):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", os.path.basename(path))]


def read_footage(footage_dir: str) -> list[Scene]:
    scene_dirs = sorted(
        (d for d in glob.glob(os.path.join(footage_dir, "scene_*")) if os.path.isdir(d)),
        key=_natural_key)
    if not scene_dirs:
        raise FileNotFoundError(
            f"No scene_* folders found in {footage_dir!r}. "
            "Point --footage at the Footage Collector output folder.")
    scenes = []
    for i, d in enumerate(scene_dirs, start=1):
        s = Scene(index=i, dir=d)
        for f in sorted(glob.glob(os.path.join(d, "*")), key=_natural_key):
            base = os.path.basename(f).lower()
            if base.endswith(VIDEO_EXT):
                s.clips.append(f)
            elif base.endswith(IMAGE_EXT):
                if base.startswith(("shot", "frame")):
                    s.frames.append(f)
                else:
                    s.images.append(f)
            elif base == "scene.txt":
                try:
                    with open(f, "r", encoding="utf-8", errors="replace") as fh:
                        s.narration = fh.read().strip()
                except OSError:
                    pass
        scenes.append(s)
    return scenes


# ---------------------------------------------------------------------------
# Visual instructor file: narration + On-Screen Text per beat (same labels
# as tool #1's instructor_parser; see its FORMAT_SPEC).
# ---------------------------------------------------------------------------

_NARRATION = re.compile(r"^\s*script\s*cue(?:\s*\(narration\))?\s*:\s*(.*)$", re.I)
_ONSCREEN = re.compile(r"^\s*on[-\s]?screen\s*text\s*:\s*(.*)$", re.I)
_OTHER_LABEL = re.compile(
    r"^\s*(visual\s*/\s*exact clip to use|visual|spoken line|dialogue|clip links?|clips|youtube|"
    r"image search|images|editor notes?|notes)\s*:", re.I)


def parse_instructor(path: str) -> list[dict]:
    """Return [{'narration':…, 'on_screen':…}, …] in beat order."""
    beats = []
    cur = None
    field_name = None
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.rstrip("\n")
            m = _NARRATION.match(line)
            if m:
                cur = {"narration": m.group(1).strip().strip('"'), "on_screen": ""}
                beats.append(cur)
                field_name = "narration"
                continue
            m = _ONSCREEN.match(line)
            if m and cur is not None:
                cur["on_screen"] = m.group(1).strip()
                field_name = "on_screen"
                continue
            if _OTHER_LABEL.match(line):
                field_name = None
                continue
            if cur is not None and field_name and line.strip() and not line.strip().isupper():
                cur[field_name] = (cur[field_name] + " " + line.strip()).strip()
    return beats


def apply_instructor(scenes: list[Scene], instructor_path: str, log=print) -> None:
    beats = parse_instructor(instructor_path)
    if not beats:
        log("  WARNING: no beats found in instructor file; using scene.txt narration.")
        return
    if len(beats) != len(scenes):
        log(f"  NOTE: instructor has {len(beats)} beats, footage has {len(scenes)} scenes; "
            "matching by order.")
    for s, b in zip(scenes, beats):
        if b["narration"]:
            s.narration = b["narration"]
        s.on_screen = b.get("on_screen", "")
        # placeholder note like "None" or "-" means no text
        if s.on_screen.strip().lower() in ("none", "-", "n/a", "na", ""):
            s.on_screen = ""
