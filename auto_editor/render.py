"""Render a Plan to a finished MP4 with ffmpeg — the reliable, editor-free path.

Given the same Plan the Filmora backend used (scene-by-scene clips + images with
Ken Burns animation, transitions, on-screen texts) plus the narration audio, this
produces a ready-to-upload 1920x1080 30fps video with perfect audio sync.

Design (keeps EXACT narration sync while still crossfading):
- each visual item is rendered to a normalised segment of length
  (item_duration + XF), except the last (item_duration only);
- segments are joined with an xfade chain whose k-th transition starts at
  sum(durations[0..k-1]); each xfade consumes XF, so the final video length is
  exactly sum(item_durations) — matching the planned timeline and the audio;
- on-screen texts are drawn on the final composited stream by absolute time.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile

from filmora.probe import _exe, probe

TICKS = 10_000_000


def _ff() -> str:
    ff = _exe("ffmpeg")
    if not ff:
        raise RuntimeError("ffmpeg not found — run setup.bat or add ffmpeg to PATH.")
    return ff


def _run(cmd, log):
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        log("  ffmpeg error:\n" + proc.stderr[-1500:])
        raise RuntimeError("ffmpeg failed (see log above)")
    return proc


def _default_font() -> str | None:
    for f in ("C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/arial.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
              "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"):
        if os.path.isfile(f):
            return f
    return None


def _esc_path(p: str) -> str:
    # ffmpeg filter path escaping (Windows drive colon + backslashes)
    return p.replace("\\", "/").replace(":", "\\:")


# ---------------------------------------------------------------------------
# Per-item segment rendering
# ---------------------------------------------------------------------------

def _kenburns_vf(animation: str | None, W: int, H: int, dur_frames: int) -> str:
    """A smooth Ken Burns move. We upscale first (zoompan jitters on small
    inputs), then zoom/pan. Direction picked from the animation name."""
    name = (animation or "zoom out 2").lower()
    zoom_in = "in" in name and "out" not in name
    # zoompan zoom expression
    if zoom_in:
        z = "min(zoom+0.0009,1.20)"
    else:  # zoom out: start zoomed, ease back
        z = "if(eq(on,0),1.20,max(zoom-0.0009,1.0))"
    # gentle drift toward centre
    x = "iw/2-(iw/zoom/2)"
    y = "ih/2-(ih/zoom/2)"
    return (
        f"scale={W*2}:{H*2}:force_original_aspect_ratio=increase,"
        f"crop={W*2}:{H*2},"
        f"zoompan=z='{z}':d={dur_frames}:x='{x}':y='{y}':s={W}x{H}:fps=30,"
        f"setsar=1"
    )


def _render_image_segment(item, out_path, seg_secs, W, H, fps, log):
    ff = _ff()
    frames = max(1, int(round(seg_secs * fps)))
    vf = _kenburns_vf(item.animation, W, H, frames)
    cmd = [ff, "-y", "-hide_banner", "-loglevel", "error",
           "-loop", "1", "-t", f"{seg_secs:.3f}", "-i", item.path,
           "-vf", vf, "-r", str(fps), "-frames:v", str(frames),
           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
           out_path]
    _run(cmd, log)


def _render_video_segment(item, out_path, seg_secs, W, H, fps, log):
    ff = _ff()
    ss = item.in_point / TICKS
    vf = (f"scale={W}:{H}:force_original_aspect_ratio=decrease,"
          f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps}")
    cmd = [ff, "-y", "-hide_banner", "-loglevel", "error",
           "-ss", f"{ss:.3f}", "-t", f"{seg_secs:.3f}", "-i", item.path,
           "-vf", vf, "-an",
           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
           out_path]
    _run(cmd, log)
    # if the source was shorter than requested, pad by freezing the last frame
    got = probe(out_path).duration_ticks / TICKS
    if got + 0.05 < seg_secs:
        pad = seg_secs - got
        tmp = out_path + ".pad.mp4"
        vf2 = f"tpad=stop_mode=clone:stop_duration={pad:.3f}"
        _run([ff, "-y", "-hide_banner", "-loglevel", "error", "-i", out_path,
              "-vf", vf2, "-c:v", "libx264", "-pix_fmt", "yuv420p",
              "-preset", "veryfast", tmp], log)
        os.replace(tmp, out_path)


# ---------------------------------------------------------------------------
# Main render
# ---------------------------------------------------------------------------

_XFADE = {"dissolve": "fade", "fade": "fade", "fade_black": "fadeblack",
          "fadeblack": "fadeblack", "wipe": "wiperight", "slide": "slideright"}


def render(plan, out_path: str, width=1920, height=1080, fps=30,
           xfade=0.5, font=None, log=print) -> str:
    if not out_path.lower().endswith((".mp4", ".mov", ".mkv")):
        out_path += ".mp4"
    items = sorted(plan.items, key=lambda i: i.tl_begin)
    if not items:
        raise RuntimeError("Nothing to render — the plan has no visuals.")
    ff = _ff()
    font = font or _default_font()
    workdir = tempfile.mkdtemp(prefix="autovid_")
    try:
        durs = [it.duration / TICKS for it in items]
        n = len(items)
        # transition length used at each join (index i = join between seg i and
        # seg i+1). A "cut" (no transition set) still uses a tiny fade so the
        # xfade chain stays contiguous. Capped to the shorter neighbour.
        MIN_CUT = 0.04
        xfs = []
        for i in range(n - 1):
            cap = min(durs[i], durs[i + 1]) * 0.6
            if items[i].transition:
                xfs.append(max(0.1, min(xfade, cap)))
            else:
                xfs.append(min(MIN_CUT, cap))

        log(f"rendering {n} segments ...")
        segs = []
        for i, it in enumerate(items):
            seg = os.path.join(workdir, f"seg_{i:04d}.mp4")
            pad = xfs[i] if i < n - 1 else 0.0  # pad = length of the join after it
            seg_secs = durs[i] + pad
            if it.kind == "image":
                _render_image_segment(it, seg, seg_secs, width, height, fps, log)
            else:
                _render_video_segment(it, seg, seg_secs, width, height, fps, log)
            segs.append(seg)
            if (i + 1) % 10 == 0 or i == n - 1:
                log(f"  {i + 1}/{n} segments done")

        # Build the xfade chain (or plain concat if no transitions at all)
        inputs = []
        for s in segs:
            inputs += ["-i", s]
        filt = []
        if n > 1:
            # chained xfade. The k-th transition begins at the running sum of the
            # NET (unpadded) durations of all earlier segments — this makes the
            # final length exactly sum(durs), so the narration stays in sync.
            prev = "0:v"
            acc = 0.0
            for i in range(1, n):
                t = xfs[i - 1]
                trans = (_XFADE.get((items[i - 1].transition or "").lower(), "fade")
                         if items[i - 1].transition else "fade")
                acc += durs[i - 1]        # acc = sum(durs[0..i-1]) = net boundary
                offset = acc              # transition starts at the net boundary;
                #                           the segment's pad supplies the tail
                lbl = f"v{i}"
                filt.append(
                    f"[{prev}][{i}:v]xfade=transition={trans}:"
                    f"duration={t:.3f}:offset={offset:.3f}[{lbl}]")
                prev = lbl
            vlabel = prev
        else:
            filt.append("[0:v]copy[v0]")
            vlabel = "v0"

        # On-screen texts drawn on the final stream by absolute time
        text_files = []
        if font and plan.texts:
            cur = vlabel
            for j, tx in enumerate(plan.texts):
                tf = os.path.join(workdir, f"text_{j}.txt")
                with open(tf, "w", encoding="utf-8") as fh:
                    fh.write(tx.text)
                text_files.append(tf)
                s0, s1 = tx.tl_begin / TICKS, tx.tl_end / TICKS
                fin, fout = s0 + 0.3, s1 - 0.3
                alpha = (f"if(lt(t,{s0}),0,if(lt(t,{fin}),(t-{s0})/0.3,"
                         f"if(lt(t,{fout}),1,if(lt(t,{s1}),({s1}-t)/0.3,0))))")
                nxt = f"t{j}"
                filt.append(
                    f"[{cur}]drawtext=fontfile='{_esc_path(font)}':"
                    f"textfile='{_esc_path(tf)}':"
                    f"fontcolor=white:fontsize=h/18:box=1:boxcolor=black@0.5:"
                    f"boxborderw=18:x=(w-text_w)/2:y=h-text_h-h/10:"
                    f"line_spacing=8:alpha='{alpha}':"
                    f"enable='between(t,{s0},{s1})'[{nxt}]")
                cur = nxt
            vlabel = cur

        # Audio: narration (if any), else silent
        total = sum(durs)
        if plan.narration_audio:
            inputs += ["-i", plan.narration_audio]
            aidx = n
            filt.append(f"[{aidx}:a]apad,atrim=0:{total:.3f},asetpts=N/SR/TB[aout]")
            amap = ["-map", "[aout]"]
        else:
            amap = ["-f", "lavfi", "-t", f"{total:.3f}", "-i",
                    "anullsrc=channel_layout=stereo:sample_rate=44100"]

        filtergraph = ";".join(filt)
        cmd = [ff, "-y", "-hide_banner", "-loglevel", "error", *inputs]
        if not plan.narration_audio:
            cmd += amap  # anullsrc input
            amap = ["-map", f"{n}:a"]
        cmd += ["-filter_complex", filtergraph, "-map", f"[{vlabel}]", *amap,
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium",
                "-crf", "20", "-r", str(fps), "-c:a", "aac", "-b:a", "192k",
                "-movflags", "+faststart", "-t", f"{total:.3f}", out_path]
        log("compositing final video ...")
        _run(cmd, log)
        got = probe(out_path).duration_ticks / TICKS
        log(f"done: {out_path}  ({got:.1f}s, {os.path.getsize(out_path)/1e6:.1f} MB)")
        return out_path
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
