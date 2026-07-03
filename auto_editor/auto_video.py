#!/usr/bin/env python3
"""Auto Video — turn Footage Collector output + narration audio into a finished
ready-to-upload MP4 (no editor needed).

  python auto_video.py --footage "C:/…/output" --audio narration.mp3 \
      --instructor my_video.txt --out MyVideo.mp4

Clips are placed scene-by-scene in sync with the narration, images get a Ken
Burns zoom, scenes are joined with transitions, and On-Screen Texts are burned
in. The result is a complete video — nothing left to edit.
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from align_audio import compute_windows
from footage import apply_instructor, drop_black_frames, read_footage
from planner import PlanOptions, describe_plan, make_plan
from render import render


class _NoTemplate:
    """The renderer needs no Filmora template; supply the transition/animation
    names the planner expects directly (ffmpeg maps them itself)."""
    transitions = {"dissolve": 1, "fade": 1, "fade_black": 1, "wipe": 1, "slide": 1}
    animations = {"zoom out 2": 1, "zoom in 1": 1, "zoom out": 1, "zoom in": 1}


def build_arg_parser():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--footage", required=True, help="Footage Collector output folder")
    p.add_argument("--audio", help="full narration audio (mp3/wav)")
    p.add_argument("--instructor", help="visual instructor .txt (narration + On-Screen Text)")
    p.add_argument("--out", default="AutoVideo.mp4", help="output video file")
    p.add_argument("--width", type=int, default=1920)
    p.add_argument("--height", type=int, default=1080)
    p.add_argument("--fps", type=int, default=30)

    g = p.add_argument_group("timing / sync")
    g.add_argument("--align", choices=["whisper", "weighted", "per-scene", "fixed"],
                   default="whisper")
    g.add_argument("--scene-audio-dir")
    g.add_argument("--fixed-secs", type=float, default=12.0)
    g.add_argument("--whisper-model", default="base")
    g.add_argument("--language")

    e = p.add_argument_group("style")
    e.add_argument("--transition", default="dissolve", help="within-scene transition")
    e.add_argument("--scene-transition", default="fade_black")
    e.add_argument("--image-animation", default="zoom out 2")
    e.add_argument("--xfade", type=float, default=0.5, help="transition length (s)")
    e.add_argument("--max-image-secs", type=float, default=6.0)
    e.add_argument("--min-item-secs", type=float, default=1.6)
    e.add_argument("--text-secs", type=float, default=4.0)
    e.add_argument("--font", help="TTF font file for on-screen text")
    e.add_argument("--no-text", action="store_true")
    e.add_argument("--no-frames", action="store_true")
    p.add_argument("--dry-run", action="store_true", help="print the plan only")
    return p


def main(argv=None):
    args = build_arg_parser().parse_args(argv)
    log = print
    log("=" * 60)
    log("AUTO VIDEO — footage -> finished MP4")
    log("=" * 60)

    scenes = read_footage(args.footage)
    log(f"footage: {len(scenes)} scenes")
    if args.instructor:
        apply_instructor(scenes, args.instructor, log)
    if not args.no_frames:
        drop_black_frames(scenes, log)

    windows = compute_windows(scenes, mode=args.align, audio=args.audio,
                              scene_audio_dir=args.scene_audio_dir,
                              fixed_secs=args.fixed_secs,
                              whisper_model=args.whisper_model,
                              language=args.language, log=log)

    opts = PlanOptions(
        transition=args.transition, scene_transition=args.scene_transition,
        image_animations=tuple(a.strip() for a in args.image_animation.split(",") if a.strip()),
        min_item_secs=args.min_item_secs, max_image_secs=args.max_image_secs,
        text_secs=args.text_secs, use_frames=not args.no_frames)
    plan = make_plan(scenes, windows, _NoTemplate(), opts,
                     project_name=os.path.splitext(os.path.basename(args.out))[0],
                     narration_audio=args.audio, log=log)
    if args.no_text:
        plan.texts = []
    describe_plan(plan, scenes, windows, log)

    if args.dry_run:
        log("--dry-run: nothing rendered.")
        return 0

    render(plan, args.out, width=args.width, height=args.height, fps=args.fps,
           xfade=args.xfade, font=args.font, log=log)
    log("")
    log(f"DONE -> {args.out}  (ready to upload)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
