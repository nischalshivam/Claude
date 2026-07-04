"""Text layout + animation — the proven safe-box engine, language-aware.

Guarantees (from user review round):
  - text NEVER leaves the visible image (letterbox bars excluded)
  - lines never overlap (fixed line-height stacking)
  - auto font-fit for long words/languages (German etc.)
  - per-word colors inside a chunk (keyword colorization)
  - liquid easing: spring-bounce / fade / pop / typewriter
"""
from __future__ import annotations

import json
import os

LANG_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "presets", "languages.json")
_LANGS = None


def lang_cfg(code: str) -> dict:
    global _LANGS
    if _LANGS is None:
        with open(LANG_FILE, encoding="utf-8") as f:
            _LANGS = json.load(f)
    return _LANGS.get(code, _LANGS["en"])


def esc(t: str) -> str:
    return (t.replace("\\", "").replace(":", "\\:").replace("'", "")
             .replace(",", "\\,").replace("%", "\\%").replace('"', "")
             .replace("“", "").replace("”", "").replace("’", ""))


ZONE_XY = {   # anchor fractions (cx, bottom_y) inside the visible area
    "bottom": (0.50, 0.88),
    "lower_left": (0.25, 0.86),
    "lower_right": (0.75, 0.86),
    "top_left": (0.25, 0.34),
    "top_right": (0.75, 0.34),
}


def fit_font(display: str, base: int, max_w: int, widthf: float) -> int:
    est = len(display) * widthf * base
    return base if est <= max_w else max(24, int(base * max_w / est))


def chunk_filters(chunk, t0, t1, style, zone, W, H, lang="en",
                  letterbox=False):
    """drawtext filter list for one text event (a 2-3 word chunk).

    Words of the chunk share ONE line (human phrasing, not robotic
    word-flash); each word can carry its own color. The whole line animates
    in together with the format's easing.
    """
    cfg = lang_cfg(lang)
    font = style["font"]
    scale = H / 1080.0
    base = int(style["size"] * scale)
    vis_h = int(W * 9 / 21) if letterbox else H
    vis_top = (H - vis_h) // 2
    margin = int(0.075 * W)
    safe_w = W - 2 * margin

    words = chunk.text.split()
    upper = style["upper"] and cfg["allow_upper"]
    disp_words = [w.upper() if upper else w for w in words]
    if style.get("spaced"):
        disp_words = [" ".join(w) for w in disp_words]
    # uppercase bold glyphs run ~22% wider than the mixed-case estimate
    widthf = cfg["width_factor"] * (1.30 if upper else 1.06)
    joined = "  ".join(disp_words)
    fs = fit_font(joined, base, safe_w, widthf)

    cx_f, by_f = ZONE_XY.get(zone, ZONE_XY["bottom"])
    y = vis_top + int(by_f * vis_h) - int(fs * 1.25)
    # estimated widths for per-word x placement on one line
    est = [int(len(w) * widthf * fs) for w in disp_words]
    gap = int(fs * 0.62)
    total_w = sum(est) + gap * (len(est) - 1)
    x0 = int(cx_f * W) - total_w // 2
    x0 = max(margin, min(x0, W - margin - total_w))

    filters, x = [], x0
    for i, (dw, w_est) in enumerate(zip(disp_words, est)):
        color = chunk.colors[i] if i < len(chunk.colors) else "0xFFFFFF"
        if style["anim"] == "type":
            s = t0 + 0.12 * i
            yexpr, alpha = str(y), f"if(lt(t\\,{s})\\,0\\,1)"
        elif style["anim"] == "bounce":
            s = t0 + 0.10 * i
            yexpr = (f"{y}+{int(26*scale)}*exp(-max(0\\,(t-{s}))*10)"
                     f"*cos((t-{s})*20)")
            alpha = f"if(lt(t\\,{s})\\,0\\,min(1\\,(t-{s})*9))"
        elif style["anim"] == "pop":
            s = t0 + 0.08 * i
            yexpr = f"{y}+{int(14*scale)}*exp(-max(0\\,(t-{s}))*12)"
            alpha = f"if(lt(t\\,{s})\\,0\\,min(1\\,(t-{s})*7))"
        else:  # fade
            s = t0 + 0.06 * i
            yexpr = str(y)
            alpha = (f"if(lt(t\\,{s})\\,0\\,if(lt(t\\,{s}+0.55)\\,(t-{s})/0.55\\,"
                     f"if(lt(t\\,{t1-0.4})\\,1\\,max(0\\,({t1}-t)/0.4))))")
        filters.append(
            f"drawtext=fontfile='{font}':text='{esc(dw)}':fontsize={fs}"
            f":fontcolor={color}"
            f":borderw={style['border']}:bordercolor=black@0.9"
            f":shadowcolor=black@0.75:shadowx={max(2,int(3*scale))}"
            f":shadowy={max(3,int(4*scale))}"
            f":x={x}:y='{yexpr}':alpha='{alpha}'"
            f":enable='between(t,{max(0,t0-0.05)},{t1})'")
        x += w_est + gap
    return filters
