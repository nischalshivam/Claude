"""Text layout + animation — EXACT metrics edition.

Words are measured with the real TTF via Pillow (no estimation), so words in a
line never collide and text never leaves the frame. Position varies per event
(the caller rotates zones) so it reads like an editor's motion-graphics, not
subtitles. Per-word colors preserved (keyword colorization).
"""
from __future__ import annotations

import json
import os

from PIL import ImageFont

LANG_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "presets", "languages.json")
_LANGS = None
_FONTS = {}


def lang_cfg(code: str) -> dict:
    global _LANGS
    if _LANGS is None:
        with open(LANG_FILE, encoding="utf-8") as f:
            _LANGS = json.load(f)
    return _LANGS.get(code, _LANGS["en"])


def _font(path: str, size: int):
    key = (path, size)
    if key not in _FONTS:
        _FONTS[key] = ImageFont.truetype(path, size)
    return _FONTS[key]


def esc(t: str) -> str:
    # remove EVERY apostrophe form (straight/curly) — any apostrophe left in a
    # drawtext text closes the filter's quote and corrupts the whole graph
    for ch in ("'", "’", "‘", "`", "´", '"', "“", "”"):
        t = t.replace(ch, "")
    return (t.replace("\\", "").replace(":", "\\:")
             .replace(",", "\\,").replace("%", "\\%")
             .replace("—", "-").replace("…", "..."))


# anchor (cx fraction, cy fraction) inside the VISIBLE area — many varied spots
ZONE_XY = {
    "bottom":       (0.50, 0.84),
    "top":          (0.50, 0.16),
    "lower_left":   (0.32, 0.80),
    "lower_right":  (0.68, 0.80),
    "upper_left":   (0.32, 0.22),
    "upper_right":  (0.68, 0.22),
    "center":       (0.50, 0.52),
}
# rotation order the planner cycles through for editorial variety
ZONE_ROTATION = ["bottom", "upper_right", "lower_left", "top",
                 "lower_right", "upper_left", "center"]


def _measure(font, words, space_w):
    widths = [font.getlength(w) for w in words]
    total = sum(widths) + space_w * (len(words) - 1)
    return widths, total


def chunk_filters(chunk, t0, t1, style, zone, W, H, lang="en", letterbox=False):
    cfg = lang_cfg(lang)
    fontpath = style["font"]
    scale = H / 1080.0
    base = max(22, int(style["size"] * scale))

    vis_h = int(W * 9 / 21) if letterbox else H
    vis_top = (H - vis_h) // 2
    margin = int(0.06 * W)
    safe_w = W - 2 * margin

    words = chunk.text.split()
    upper = style["upper"] and cfg["allow_upper"]
    disp = [w.upper() if upper else w for w in words]
    if style.get("spaced"):
        disp = [" ".join(list(w)) for w in disp]

    # fit: shrink until the whole line fits the safe width (EXACT measurement)
    fs = base
    while fs > 22:
        font = _font(fontpath, fs)
        space_w = font.getlength("  ")
        widths, total = _measure(font, disp, space_w)
        if total <= safe_w:
            break
        fs = int(fs * 0.92)
    font = _font(fontpath, fs)
    space_w = font.getlength("  ")
    widths, total = _measure(font, disp, space_w)

    cx_f, cy_f = ZONE_XY.get(zone, ZONE_XY["bottom"])
    x0 = int(cx_f * W - total / 2)
    x0 = max(margin, min(x0, W - margin - int(total)))
    y = int(vis_top + cy_f * vis_h - fs * 0.62)
    y = max(vis_top + int(0.03 * vis_h),
            min(y, vis_top + vis_h - int(fs * 1.25)))

    sx, sy = max(2, int(3 * scale)), max(3, int(4 * scale))
    filters, x = [], float(x0)
    for i, (dw, wd) in enumerate(zip(disp, widths)):
        color = chunk.colors[i] if i < len(chunk.colors) else "0xFFFFFF"
        if style["anim"] == "type":
            s = t0 + 0.10 * i
            yexpr, alpha = str(y), f"if(lt(t\\,{s})\\,0\\,1)"
        elif style["anim"] == "bounce":
            s = t0 + 0.09 * i
            yexpr = (f"{y}+{int(24*scale)}*exp(-max(0\\,(t-{s}))*11)"
                     f"*cos((t-{s})*19)")
            alpha = f"if(lt(t\\,{s})\\,0\\,min(1\\,(t-{s})*9))"
        elif style["anim"] == "pop":
            s = t0 + 0.07 * i
            yexpr = f"{y}+{int(12*scale)}*exp(-max(0\\,(t-{s}))*13)"
            alpha = f"if(lt(t\\,{s})\\,0\\,min(1\\,(t-{s})*8))"
        else:  # fade
            s = t0 + 0.05 * i
            yexpr = str(y)
            alpha = (f"if(lt(t\\,{s})\\,0\\,if(lt(t\\,{s}+0.5)\\,(t-{s})/0.5\\,"
                     f"if(lt(t\\,{t1-0.4})\\,1\\,max(0\\,({t1}-t)/0.4))))")
        filters.append(
            f"drawtext=fontfile='{fontpath}':text='{esc(dw)}':fontsize={fs}"
            f":fontcolor={color}:borderw={style['border']}:bordercolor=black@0.92"
            f":shadowcolor=black@0.8:shadowx={sx}:shadowy={sy}"
            f":x={int(round(x))}:y='{yexpr}':alpha='{alpha}'"
            f":enable='between(t,{max(0,t0-0.05)},{t1})'")
        x += wd + space_w
    return filters
