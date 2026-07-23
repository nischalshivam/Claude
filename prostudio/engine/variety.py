"""Editing-variety helpers — premium, tasteful, anti-repetitive.

The goal is MORE variation without looking cheap or repetitive:
  - each format keeps its signature transition (used most of the time), so the
    format's identity survives
  - the rest of the time we swap in a curated alternative, never repeating the
    same transition back-to-back
  - flashy "accent" transitions are rationed hard (rare, never adjacent), so
    they feel intentional instead of gimmicky
"""
from __future__ import annotations

# curated xfade families (all real xfade names, none of the cheesy ones)
SOFT_ALTS = ["dissolve", "smoothleft", "smoothright", "fade"]
SCENE_ALTS = ["dissolve", "fadeblack", "smoothup", "smoothdown",
              "coverleft", "coverright"]
ACCENTS = ["circleopen", "zoomin", "radial"]        # rare, scene-only


def _pick(pool, avoid, rng):
    opts = [x for x in pool if x != avoid] or list(pool)
    return rng.choice(opts)


def plan_transitions(shots, style, rng):
    """Return [(xfade_type, duration)] for each shot boundary (len == n-1).

    Keeps the format's signature transition dominant, layers curated variety
    with anti-repeat, and rations accents (>= 3 scene-cuts apart, max ~12%)."""
    n = len(shots)
    base_soft_t, base_soft_d = style["soft"]
    base_scene_t, base_scene_d = style["scene"]
    plan, prev_type, since_accent = [], None, 99
    for i in range(n - 1):
        is_scene = shots[i].transition == "scene"
        if is_scene:
            r = rng.random()
            if since_accent >= 3 and r < 0.12:
                t, d = _pick(ACCENTS, prev_type, rng), rng.uniform(0.5, 0.7)
                since_accent = 0
            elif r < 0.55:
                t, d = base_scene_t, base_scene_d
                since_accent += 1
            else:
                t, d = _pick(SCENE_ALTS, prev_type, rng), rng.uniform(0.4, 0.62)
                since_accent += 1
        else:
            since_accent += 1
            if rng.random() < 0.55:
                t, d = base_soft_t, base_soft_d
            else:
                t, d = _pick(SOFT_ALTS, prev_type, rng), rng.uniform(0.18, 0.34)
        if t == prev_type:                      # never repeat back-to-back
            t = _pick(SCENE_ALTS if is_scene else SOFT_ALTS, prev_type, rng)
        plan.append((t, d))
        prev_type = t
    return plan
