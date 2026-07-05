"""ffmpeg renderer — shots + text events -> final 16:9 MP4 (4K or 1080p).

Human-feel details baked in:
  - camera drift: every static shot gets a subtle seeded sway (never
    mathematical-straight pans)
  - punch-in: occasional quick push mid-shot
  - J/L boundaries come pre-shifted from the planner
  - sentiment grade per shot (niche base + scene mood)
  - format decides transitions, grain, letterbox, glitch pulses, spotlight
"""
from __future__ import annotations

import math
import os
import shutil
import subprocess
import tempfile

from . import FPS, RESOLUTIONS
from .audio_sync import duration
from .formats import FORMATS, grade_for
from .textlayout import chunk_filters


def _run(cmd, log, timeout=None):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        log(f"ffmpeg timed out after {timeout}s (stuck process, likely waiting "
            "on stdin) -> aborting this shot")
        raise RuntimeError("ffmpeg timed out")
    if p.returncode:
        log("ffmpeg error:\n" + p.stderr[-1500:])
        raise RuntimeError("ffmpeg failed")


def _run_progress(cmd, log, total, work, lo=88, hi=99, stall_secs=900):
    """Run a long ffmpeg with LIVE progress so the final compose step never
    looks frozen. Maps encoded time -> [lo..hi]%. Aborts only if there is NO
    progress at all for `stall_secs` (a genuine hang), not just because it's
    slow."""
    import time
    errpath = os.path.join(work, "compose_err.log")
    with open(errpath, "w", encoding="utf-8") as errf:
        p = subprocess.Popen(cmd + ["-progress", "pipe:1", "-nostats"],
                             stdout=subprocess.PIPE, stderr=errf, text=True)
        last_pct, last_beat = lo, time.time()
        try:
            for line in p.stdout:
                line = line.strip()
                if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
                    try:
                        val = int(line.split("=", 1)[1])
                    except ValueError:
                        continue
                    # ffmpeg quirk: BOTH out_time_us and out_time_ms are in
                    # microseconds (out_time_ms is misnamed) -> divide by 1e6
                    secs = val / 1e6
                    frac = min(1.0, max(0.0, secs / max(0.1, total)))
                    pct = int(lo + (hi - lo) * frac)
                    now = time.time()
                    if pct > last_pct or now - last_beat > 20:
                        last_pct, last_beat = max(pct, last_pct), now
                        log(f"[{last_pct:3d}%] compositing ... "
                            f"{secs:.0f}/{total:.0f}s encoded")
                elif line.startswith("progress=end"):
                    break
        finally:
            p.stdout.close()
        p.wait()
    if p.returncode:
        try:
            err = open(errpath, encoding="utf-8", errors="replace").read()
        except OSError:
            err = ""
        log("ffmpeg error:\n" + err[-1500:])
        raise RuntimeError("ffmpeg failed")


def _glow_png(path, size=1000):
    from PIL import Image
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()
    c = size // 2
    for y in range(size):
        for x in range(size):
            d = math.hypot(x - c, y - c) / c
            if d < 1:
                px[x, y] = (255, 238, 190, int(160 * (1 - d) ** 2.3))
    img.save(path)


def _zoompan_image(shot, W, H, secs, style):
    frames = max(1, int(secs * FPS))
    big = 2 if H <= 1080 else 1.5
    bw, bh = int(W * big), int(H * big)
    rate = 0.0010
    zmax = 1.16 if not style.get("strong_push") else 1.30
    drift = style["drift"]
    a = drift * 5 * (H / 1080)
    ph = shot.drift_seed % 7
    punch = ""
    if shot.punch_in:
        n = int(frames * 0.55)
        punch = f"+if(gte(on\\,{n})\\,min(0.05\\,(on-{n})*0.012)\\,0)"
    if style.get("pan") == "lr":
        z = "1.12"
        x = f"(iw-iw/zoom)*on/{frames}"
    elif shot.zoom_in:
        z = f"min(1.0+{rate}*on{punch},{zmax})"
        x = f"iw/2-(iw/zoom/2)+{a:.1f}*sin(on/37+{ph})"
    else:
        z = f"max({zmax}-{rate}*on{punch},1.0)"
        x = f"iw/2-(iw/zoom/2)+{a:.1f}*sin(on/41+{ph})"
    y = f"ih/2-(ih/zoom/2)+{a * 0.7:.1f}*cos(on/43+{ph})"
    return (f"scale={bw}:{bh}:force_original_aspect_ratio=increase:"
            f"flags=lanczos,crop={bw}:{bh},"
            f"zoompan=z='{z}':d={frames}:x='{x}':y='{y}':s={W}x{H}:fps={FPS},"
            f"setsar=1")


def _video_vf(shot, W, H, style):
    fit = (f"scale={W}:{H}:force_original_aspect_ratio=increase:flags=lanczos,"
           f"crop={W}:{H},setsar=1,fps={FPS}")
    sk = style["shake"]
    if sk > 0:
        mx = int(70 * sk * (W / 1920)) + 8
        my = int(40 * sk * (H / 1080)) + 6
        return (f"scale={W + 2*mx}:{H + 2*my}:force_original_aspect_ratio=increase"
                f":flags=lanczos,crop={W + 2*mx}:{H + 2*my},"
                f"crop={W}:{H}:x='{mx}+{mx*0.4:.0f}*sin(t*15)+{mx*0.25:.0f}*sin(t*31)'"
                f":y='{my}+{my*0.45:.0f}*cos(t*19)',setsar=1,fps={FPS}")
    if style.get("pushin") or style.get("strong_push"):
        zmax = 1.13 if not style.get("strong_push") else 1.22
        return fit + (f",zoompan=z='min(pzoom+0.0011,{zmax})':d=1"
                      f":x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
                      f":s={W}x{H}:fps={FPS}")
    return fit


def _ensure_duration(out, secs, log):
    """Pad a short segment up to `secs` so the composite offsets stay exact."""
    got = duration(out)
    if got + 0.05 < secs:
        tmp = out + ".p.mp4"
        _run(["ffmpeg", "-nostdin", "-y", "-v", "error", "-i", out, "-vf",
              f"tpad=stop_mode=clone:stop_duration={secs - got:.3f}",
              "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
              tmp], log, timeout=120)
        os.replace(tmp, out)


def _render_full(shot, out, style, niche, W, H, secs, glow, log, timeout):
    """The full styled render (Ken Burns / drift / grade / grain / glitch)."""
    if shot.kind == "image":
        vf = _zoompan_image(shot, W, H, secs, style)
        ins = ["-loop", "1", "-t", f"{secs + 0.4:.3f}", "-i", shot.path]
    else:
        vf = _video_vf(shot, W, H, style)
        ins = ["-t", f"{secs + 0.4:.3f}", "-i", shot.path]
    vf += "," + grade_for(niche, shot.mood, style["sepia"])
    if style["grain"]:
        vf += f",noise=alls={style['grain']}:allf=t+u"
    if style["glitch"]:
        s4 = max(2, int(4 * W / 1920))
        vf += (f",rgbashift=rh={s4}:bv=-{s4}"
               f":enable='lt(mod(t\\,2.7)\\,0.13)'")
    if style["vignette"]:
        vf += ",vignette=PI/4.6"
    if style.get("spotlight"):
        vf += ",eq=brightness=-0.16:saturation=0.85"
    if style["letterbox"]:
        vh = int(W * 9 / 21)
        vf += f",crop={W}:{vh},pad={W}:{H}:0:(oh-ih)/2:black"

    if style.get("spotlight"):
        gs = int(min(W, H) * 1.15)
        fc = (f"[0:v]{vf}[b];[1:v]scale={gs}:{gs}[g];"
              f"[b][g]overlay=x=(W-w)/2:y=(H-h)/2-{int(0.06*H)}:format=auto[v]")
        cmd = ["ffmpeg", "-nostdin", "-y", "-v", "error", *ins,
               "-loop", "1", "-t", f"{secs + 0.4:.3f}", "-i", glow,
               "-filter_complex", fc, "-map", "[v]"]
    else:
        cmd = ["ffmpeg", "-nostdin", "-y", "-v", "error", *ins, "-vf", vf]
    cmd += ["-t", f"{secs:.3f}", "-an", "-r", str(FPS), "-c:v", "libx264",
            "-pix_fmt", "yuv420p", "-preset", "veryfast", out]
    _run(cmd, log, timeout=timeout)
    _ensure_duration(out, secs, log)


def _safe_still(path, kind, W, H, work, log, timeout=60):
    """Decode ONE frame (single pass, bounded) and normalize it to WxH.

    This is the escape hatch for a pathological input (huge / corrupt /
    exotic-codec video): one decode instead of per-frame heavy filtering.
    Returns the still path or None."""
    still = os.path.join(work, "safe_" + str(abs(hash(path)) % 10**8) + ".png")
    seek = []
    if kind == "video":
        d = duration(path)
        if d > 0.2:
            seek = ["-ss", f"{min(max(d * 0.5, 0.0), max(0.0, d - 0.1)):.2f}"]
    cmd = (["ffmpeg", "-nostdin", "-y", "-v", "error", *seek, "-i", path,
            "-frames:v", "1", "-vf",
            f"scale={W}:{H}:force_original_aspect_ratio=increase:flags=bilinear,"
            f"crop={W}:{H}", still])
    try:
        _run(cmd, log, timeout=timeout)
    except Exception:
        return None
    return still if os.path.isfile(still) else None


def _render_still_simple(still, out, shot, W, H, secs, style, niche, log,
                         timeout=90):
    """A gentle, robust render from a NORMALIZED still (input already WxH,
    so this is always fast). Slow zoom + grade only — no grain/glitch."""
    z = 1.10
    x = "iw/2-(iw/zoom/2)"
    y = "ih/2-(ih/zoom/2)"
    frames = max(1, int(secs * FPS))
    if shot.zoom_in:
        zexpr = f"min(1.0+0.0009*on,{z})"
    else:
        zexpr = f"max({z}-0.0009*on,1.0)"
    vf = (f"scale={int(W*1.2)}:{int(H*1.2)}:flags=bilinear,"
          f"zoompan=z='{zexpr}':d={frames}:x='{x}':y='{y}':s={W}x{H}:fps={FPS},"
          f"setsar=1," + grade_for(niche, shot.mood, style["sepia"]))
    if style["letterbox"]:
        vh = int(W * 9 / 21)
        vf += f",crop={W}:{vh},pad={W}:{H}:0:(oh-ih)/2:black"
    cmd = ["ffmpeg", "-nostdin", "-y", "-v", "error", "-loop", "1",
           "-t", f"{secs + 0.4:.3f}", "-i", still, "-vf", vf,
           "-t", f"{secs:.3f}", "-an", "-r", str(FPS), "-c:v", "libx264",
           "-pix_fmt", "yuv420p", "-preset", "veryfast", out]
    _run(cmd, log, timeout=timeout)
    _ensure_duration(out, secs, log)


def _render_filler(out, W, H, secs, log):
    """Last resort: a neutral dark clip of the exact duration, so the
    timeline never breaks even if a file is completely unusable."""
    _run(["ffmpeg", "-nostdin", "-y", "-v", "error", "-f", "lavfi",
          "-i", f"color=c=0x0b0d10:s={W}x{H}:r={FPS}:d={secs:.3f}",
          "-t", f"{secs:.3f}", "-c:v", "libx264", "-pix_fmt", "yuv420p",
          "-preset", "veryfast", out], log, timeout=60)


def render_shot(shot, out, style, niche, W, H, pad, glow, log, work=None):
    """Render one shot, GUARANTEED to produce a valid segment.

    Tier 1: full styled render (bounded timeout).
    Tier 2: on timeout/failure, a single-decode safe still (gentle motion).
    Tier 3: on any further failure, neutral filler of the right length.
    A single bad/huge/corrupt file can never stall or fail the whole job."""
    secs = shot.secs + pad
    work = work or os.path.dirname(out)
    try:
        _render_full(shot, out, style, niche, W, H, secs, glow, log,
                     timeout=180)
        return "full"
    except Exception as exc:
        log(f"  shot slow/failed ({exc}); retrying in safe mode "
            f"[{os.path.basename(shot.path)}] ...")
    try:
        still = _safe_still(shot.path, shot.kind, W, H, work, log)
        if still:
            _render_still_simple(still, out, shot, W, H, secs, style, niche, log)
            return "safe"
    except Exception as exc:
        log(f"  safe mode failed ({exc}); using neutral filler ...")
    _render_filler(out, W, H, secs, log)
    return "filler"


def render_job(job, shots, text_events, log=print):
    style = FORMATS[job.format_key]
    W, H = RESOLUTIONS[job.resolution]
    work = tempfile.mkdtemp(prefix="prostudio_")
    try:
        glow = os.path.join(work, "glow.png")
        if style.get("spotlight"):
            _glow_png(glow)

        # per-join pads (soft within scene / scene at boundary)
        n = len(shots)
        joins = []
        for i in range(n - 1):
            ttype, tdur = style["scene" if shots[i].transition == "scene"
                                else "soft"]
            tdur = min(tdur, shots[i].secs * 0.5, shots[i + 1].secs * 0.5)
            joins.append((ttype, max(0.05, tdur)))

        log(f"  rendering {n} shots at {W}x{H} ...")
        segs, degraded = [], 0
        for i, sh in enumerate(shots):
            seg = os.path.join(work, f"s{i:03d}.mp4")
            pad = joins[i][1] if i < n - 1 else 0.0
            tier = render_shot(sh, seg, style, job.niche, W, H, pad, glow, log,
                               work=work)
            if tier != "full":
                degraded += 1
            segs.append(seg)
            # shots span 25%..85% of the whole job
            pct = 25 + int(60 * (i + 1) / n)
            log(f"[{pct:3d}%] rendered shot {i + 1}/{n}")
        if degraded:
            log(f"  note: {degraded}/{n} shot(s) used a simplified render "
                "(a source file was too large/slow/corrupt) — the video is "
                "complete; you can swap those clips in your editor if needed.")

        durs = [duration(s) for s in segs]
        inputs = []
        for s in segs:
            inputs += ["-i", s]
        filt, prev, acc = [], "0:v", 0.0
        for i in range(1, n):
            ttype, tdur = joins[i - 1]
            acc += shots[i - 1].secs
            filt.append(f"[{prev}][{i}:v]xfade=transition={ttype}"
                        f":duration={tdur:.3f}:offset={acc:.3f}[x{i}]")
            prev = f"x{i}"
        total = acc + durs[-1]

        # text overlay on the composite, absolute times (== audio times)
        tfilters = []
        for (t0, t1, si, chunk, zone) in text_events:
            tfilters += chunk_filters(chunk, t0, t1, style, zone, W, H,
                                      lang=job.language,
                                      letterbox=style["letterbox"])
        if tfilters:
            filt.append(f"[{prev}]" + ",".join(tfilters) + "[vt]")
            prev = "vt"

        filt.append(f"[{n}:a]atrim=0:{total:.3f},afade=t=in:d=0.25,"
                    f"afade=t=out:st={max(0, total - 1.2):.3f}:d=1.2[a]")
        inputs += ["-i", job.audio]

        out = job.out_path
        os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
        # long timelines (many shots + text events) produce a filtergraph far
        # bigger than the OS command-line limit -> pass it as a script file
        graph_file = os.path.join(work, "graph.txt")
        with open(graph_file, "w", encoding="utf-8") as f:
            f.write(";\n".join(filt))
        # encoder preset: at 4K, "medium" is needlessly slow — "fast" at the
        # same CRF looks all but identical and cuts the compose time a lot.
        preset = job.preset
        if W * H >= 3840 * 2160 and preset in ("medium", "slow", "slower"):
            preset = "fast"
        log(f"[ 88%] compositing final video (longest step, ~{total:.0f}s at "
            f"{W}x{H}/{preset}) — live progress below ...")
        _run_progress(
            ["ffmpeg", "-nostdin", "-y", "-v", "error", *inputs,
             "-filter_complex_script", graph_file,
             "-map", f"[{prev}]", "-map", "[a]",
             "-c:v", "libx264", "-crf", str(job.crf), "-preset", preset,
             "-pix_fmt", "yuv420p", "-r", str(FPS),
             "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
             "-t", f"{total:.3f}", out],
            log, total=total, work=work)
        log(f"[100%] done: {out} ({total:.1f}s, {os.path.getsize(out)/1e6:.1f} MB)")
        return out, total
    finally:
        shutil.rmtree(work, ignore_errors=True)
