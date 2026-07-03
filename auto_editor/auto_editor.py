#!/usr/bin/env python3
"""Auto Editor — turn Footage Collector output + narration audio into an
editable Wondershare Filmora project (.wfpbundle).

Typical run (on the user's PC):
  python auto_editor.py --footage "C:/…/output" --audio narration.mp3 ^
      --instructor my_video.txt --title "My Video" --out "C:/…/MyVideo.wfpbundle"

The result opens in Filmora with every scene's clips/images placed on the
timeline in sync with the narration, transitions + animations applied, and
on-screen texts added — ready for the final 10% human polish.
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from align_audio import compute_windows
from filmora.bundle import write_bundle
from filmora.template import load_template
from filmora.timeline import build
from footage import apply_instructor, read_footage
from planner import PlanOptions, describe_plan, make_plan

DEFAULT_TEMPLATE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "template_data", "filmora_15_6_4.json")


def build_arg_parser():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--footage", required=True,
                   help="Footage Collector output folder (contains scene_001/, …)")
    p.add_argument("--audio", help="full narration audio file (mp3/wav)")
    p.add_argument("--instructor", help="visual instructor .txt (narration + On-Screen Text)")
    p.add_argument("--title", default="AutoEdit", help="project name")
    p.add_argument("--out", default="AutoEdit.wfpbundle", help="output .wfpbundle path")
    p.add_argument("--template", default=DEFAULT_TEMPLATE,
                   help="Filmora sample: a .wfpbundle saved by YOUR Filmora, or an "
                        "extracted template .json (default: bundled 15.6.4 template)")

    g = p.add_argument_group("timing / sync")
    g.add_argument("--align", choices=["whisper", "weighted", "per-scene", "fixed"],
                   default="whisper",
                   help="how to sync scenes to the narration (default: whisper; "
                        "falls back to weighted if faster-whisper isn't installed)")
    g.add_argument("--scene-audio-dir", help="folder with scene_001.mp3 … (per-scene mode)")
    g.add_argument("--fixed-secs", type=float, default=12.0,
                   help="seconds per scene when no audio is given (default 12)")
    g.add_argument("--whisper-model", default="base",
                   help="faster-whisper model size: tiny/base/small (default base)")
    g.add_argument("--language", help="narration language code (hi/en/…); auto-detected if omitted")

    e = p.add_argument_group("editing style")
    e.add_argument("--transition", default="dissolve",
                   help="transition between visuals inside a scene (default dissolve; 'none' to disable)")
    e.add_argument("--scene-transition", default="fade_black",
                   help="transition on scene boundaries (default fade_black)")
    e.add_argument("--image-animation", default="zoom out 2",
                   help="comma-separated animation names cycled over images "
                        "(must exist in the sample project; default 'zoom out 2')")
    e.add_argument("--animate-videos", action="store_true",
                   help="also apply the animation to video clips (default: images only)")
    e.add_argument("--max-image-secs", type=float, default=6.0,
                   help="longest a single image may stay on screen (default 6)")
    e.add_argument("--min-item-secs", type=float, default=1.6,
                   help="shortest any visual may be (default 1.6)")
    e.add_argument("--text-secs", type=float, default=4.0,
                   help="how long each on-screen text stays (default 4)")
    e.add_argument("--no-text", action="store_true", help="skip on-screen texts")
    e.add_argument("--no-frames", action="store_true",
                   help="don't use shot*.jpg frames grabbed from clips as images")
    e.add_argument("--max-clips-per-scene", type=int, default=99)

    p.add_argument("--no-thumbnails", action="store_true",
                   help="skip generating media thumbnails inside the project")
    p.add_argument("--dry-run", action="store_true",
                   help="print the plan only; write nothing")
    return p


def main(argv=None):
    args = build_arg_parser().parse_args(argv)
    log = print

    log("=" * 64)
    log("AUTO EDITOR — footage -> Filmora project")
    log("=" * 64)

    if not os.path.exists(args.template):
        log(f"ERROR: template not found: {args.template}")
        log("Save a small sample project in YOUR Filmora (2 clips + 1 image with an "
            "animation + 1 transition + 1 title), export it as a .wfpbundle and pass "
            "it with --template.")
        return 2
    template = load_template(args.template)
    log(f"template: {os.path.basename(args.template)}")
    log(f"  transitions available: {', '.join(sorted(template.transitions)) or '(none)'}")
    log(f"  animations available:  {', '.join(sorted(template.animations)) or '(none)'}")

    scenes = read_footage(args.footage)
    log(f"footage: {len(scenes)} scenes in {args.footage}")
    if args.instructor:
        apply_instructor(scenes, args.instructor, log)

    windows = compute_windows(
        scenes, mode=args.align, audio=args.audio,
        scene_audio_dir=args.scene_audio_dir, fixed_secs=args.fixed_secs,
        whisper_model=args.whisper_model, language=args.language, log=log)

    opts = PlanOptions(
        transition=args.transition,
        scene_transition=args.scene_transition,
        image_animations=tuple(a.strip() for a in args.image_animation.split(",") if a.strip()),
        animate_videos=args.animate_videos,
        min_item_secs=args.min_item_secs,
        max_image_secs=args.max_image_secs,
        text_secs=args.text_secs,
        max_clips_per_scene=args.max_clips_per_scene,
        use_frames=not args.no_frames,
    )
    plan = make_plan(scenes, windows, template, opts,
                     project_name=args.title,
                     narration_audio=args.audio, log=log)
    if args.no_text:
        plan.texts = []
    describe_plan(plan, scenes, windows, log)

    if args.dry_run:
        log("--dry-run: nothing written.")
        return 0

    log("building Filmora project…")
    result = build(plan, template)
    for w in result.warnings:
        log(f"  WARNING: {w}")
    out = write_bundle(result, template, args.out,
                       thumbnails=not args.no_thumbnails, log=log)
    log("")
    log(f"DONE -> {out}")
    log("Open it in Filmora (double-click), check the timeline, polish, export.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
