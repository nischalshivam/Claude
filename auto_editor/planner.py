"""Turn scenes + time windows into a concrete timeline Plan.

Editing logic (the "editor brain"):
- Inside a scene: video clips first (real footage carries the story), then
  images/frames fill the rest of the narration time with Ken Burns style
  animation so stills don't feel static.
- Transitions: a soft one between visuals inside a scene, a stronger one on
  scene boundaries. Only transitions harvested from the user's own sample
  project are ever used.
- On-screen text: only where the instructor file specifies it (a few beats,
  not the whole video).
"""
from __future__ import annotations

from dataclasses import dataclass

from filmora.probe import probe
from filmora.timeline import Plan, PlanItem, TextItem

TICKS = 10_000_000


@dataclass
class PlanOptions:
    transition: str = "dissolve"          # between visuals inside a scene
    scene_transition: str = "fade_black"  # on scene boundaries
    image_animations: tuple = ("zoom out 2",)  # cycled over images
    animate_videos: bool = False
    min_item_secs: float = 1.6
    max_image_secs: float = 6.0
    text_secs: float = 4.0
    max_clips_per_scene: int = 99
    use_frames: bool = True


def _resolve_name(requested: str, available: dict, fallback_names) -> str | None:
    """Map a friendly name to a template key ('fade to black' -> 'fade_black')."""
    if not requested or requested.lower() in ("none", "off"):
        return None
    req = requested.lower().strip()
    if req in available:
        return req
    compact = req.replace(" ", "").replace("-", "").replace("_", "")
    for k in available:
        if k.replace(" ", "").replace("-", "").replace("_", "") == compact:
            return k
    for k in available:  # substring match
        if compact in k.replace(" ", "").replace("-", "").replace("_", ""):
            return k
    for name in fallback_names:
        if name in available:
            return name
    return next(iter(available), None)


def make_plan(scenes, windows, template, opts: PlanOptions, project_name: str,
              narration_audio: str | None, log=print) -> Plan:
    plan = Plan(project_name=project_name, narration_audio=narration_audio)

    transition = _resolve_name(opts.transition, template.transitions, ("dissolve",))
    scene_tr = _resolve_name(opts.scene_transition, template.transitions,
                             ("fade_black", "dissolve"))
    if opts.transition and transition != opts.transition.lower():
        log(f"  transition '{opts.transition}' -> template '{transition}'")
    if opts.scene_transition and scene_tr != opts.scene_transition.lower():
        log(f"  scene transition '{opts.scene_transition}' -> template '{scene_tr}'")

    anims = [a for a in (
        _resolve_name(name, template.animations, ()) for name in opts.image_animations)
        if a] or ([next(iter(template.animations))] if template.animations else [])
    anim_cycle = 0

    min_t = int(opts.min_item_secs * TICKS)
    max_img_t = int(opts.max_image_secs * TICKS)

    for s, (w_begin, w_end) in zip(scenes, windows):
        window = w_end - w_begin
        if window <= 0:
            continue
        t = w_begin
        scene_items = []

        # 1) video clips (up to the scene's share of time)
        for clip in s.clips[:opts.max_clips_per_scene]:
            if w_end - t < min_t:
                break
            try:
                src = probe(clip).duration_ticks
            except RuntimeError as exc:
                log(f"  WARNING: {exc}")
                continue
            dur = min(src, w_end - t)
            if dur < min_t and len(scene_items) > 0:
                break
            scene_items.append(PlanItem(
                path=clip, kind="video", tl_begin=t, tl_end=t + dur,
                in_point=0, scene_index=s.index,
                animation=(anims[anim_cycle % len(anims)] if opts.animate_videos and anims else None)))
            t += dur

        # 2) images fill the remaining narration time
        pool = (s.images + (s.frames if opts.use_frames else [])) or []
        remaining = w_end - t
        if remaining >= min_t and pool:
            # enough images that none stays longer than max_image_secs;
            # if the pool is small we cycle it (with animation) rather than
            # freezing one still for half a minute
            import math
            n = max(1, math.ceil(remaining / max_img_t))
            if n > len(pool):
                if n > 2 * len(pool):
                    n = 2 * len(pool)
                log(f"  NOTE: scene {s.index}: only {len(pool)} images for "
                    f"{remaining / TICKS:.0f}s — some images repeat with animation.")
            share = remaining // n
            for i in range(n):
                dur = share if i < n - 1 else (w_end - t)
                img = pool[i % len(pool)]
                a = anims[anim_cycle % len(anims)] if anims else None
                anim_cycle += 1
                scene_items.append(PlanItem(
                    path=img, kind="image", tl_begin=t, tl_end=t + dur,
                    scene_index=s.index, animation=a))
                t += dur
        elif remaining >= min_t and scene_items:
            # no images: stretch the last item if it's an image, else leave the
            # last clip frozen — extend the previous image or repeat last clip
            last = scene_items[-1]
            if last.kind == "image":
                last.tl_end = w_end
            else:
                log(f"  NOTE: scene {s.index}: {remaining / TICKS:.1f}s of narration has no "
                    "visuals left — last clip is extended by re-trimming.")
                src = probe(last.path).duration_ticks
                extend = min(remaining, max(0, src - last.duration))
                last.tl_end += extend
            t = scene_items[-1].tl_end

        if not scene_items:
            log(f"  WARNING: scene {s.index} has no usable visuals — the narration "
                "will play over the previous scene's last frame.")
            continue

        # 3) transitions: soft inside the scene, strong at the scene boundary
        for it in scene_items[:-1]:
            it.transition = transition
        scene_items[-1].transition = scene_tr

        # 4) on-screen text (only where the instructor asked for it)
        if s.on_screen:
            plan.texts.append(TextItem(
                text=s.on_screen, tl_begin=w_begin,
                tl_end=min(w_end, w_begin + int(opts.text_secs * TICKS)),
                scene_index=s.index))

        plan.items.extend(scene_items)

    if plan.items:
        plan.items[-1].transition = None  # nothing after the last clip
    return plan


def describe_plan(plan: Plan, scenes, windows, log=print) -> None:
    log("")
    log("=== PLAN ===")
    by_scene = {}
    for it in plan.items:
        by_scene.setdefault(it.scene_index, []).append(it)
    texts = {t.scene_index: t for t in plan.texts}
    for s, (b, e) in zip(scenes, windows):
        items = by_scene.get(s.index, [])
        log(f"scene {s.index:03d}  {b / TICKS:7.1f}s → {e / TICKS:7.1f}s   "
            f"{len([i for i in items if i.kind == 'video'])} clips + "
            f"{len([i for i in items if i.kind == 'image'])} images"
            + (f"   text: {texts[s.index].text[:40]!r}" if s.index in texts else ""))
        for it in items:
            import os
            log(f"    {it.tl_begin / TICKS:7.1f}s  {it.kind:5s}  "
                f"{os.path.basename(it.path):24s} {it.duration / TICKS:5.1f}s"
                + (f"  anim={it.animation}" if it.animation else "")
                + (f"  →{it.transition}" if it.transition else ""))
    log(f"total: {plan.duration / TICKS:.1f}s, {len(plan.items)} visuals, "
        f"{len(plan.texts)} texts")
    log("")
