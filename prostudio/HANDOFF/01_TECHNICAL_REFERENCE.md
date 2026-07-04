# TECHNICAL REFERENCE — ProStudio (for an LLM that will edit the code)

Python 3.10+. Deps: numpy, Pillow, opencv-python-headless, faster-whisper
(optional), system/bin ffmpeg+ffprobe. No GPU. Windows-first (bat files).

## LAYOUT (prostudio/)
- prostudio.py — CLI + Job dataclass + run_job orchestration (+ --queue)
- gui.py — Tkinter: JobCard list (+Add Video, max 15), dropdowns, live log;
  writes jobs.json and shells prostudio.py (CLI is the source of truth)
- engine/
  - __init__.py — FPS=30, RESOLUTIONS {4K:3840x2160, 1080p}, color consts
  - qc.py — score_media/qc_scene_media: black<12 brightness, image sharpness
    (512px-normalised Laplacian var < 25 = blurry), 8x8 aHash dupes (≤4 bits),
    <800x450 lowres. Returns MediaScore lists (images sorted sharpest-first).
  - audio_sync.py — scene_windows(): whisper word timestamps if importable,
    else weighted-by-words boundaries SNAPPED to silencedetect gaps (±1.4s);
    word_time() interpolates a word index inside a scene window.
  - script_nlp.py — chunk_scene(): 2-3 word chunks split on punctuation;
    per-word colors (DANGER/SUCCESS lexicons, names via mid-sentence caps,
    numbers/years); scene_mood(); select_text_events(): dense<60s + crucial +
    35s forced refresher, then overlap-clamp (events never co-exist).
  - subjects.py — OpenCV haarcascade faces → best_text_zone() among 5 zones
    (bottom / lower_left / lower_right / top_left / top_right) minimising face
    overlap; try_subject_mask() = optional rembg hook (returns False w/o dep).
  - planner.py — read_scenes(): scene_* dirs, NARRATION/TEXT parsing from
    scene.txt, QC integration; plan_shots(): clips 2-5s first, images 3-7s
    (cycle pool ≤2x when starved), J/L offset 0.4s alternating, punch_in 22%
    of shots >3s, drift_seed per shot, zone per shot; transition soft/scene.
  - formats.py — FORMATS dict (10 packs: font/size/upper/spaced/anim/border/
    shake/drift/grain/vignette/letterbox/glitch/sepia/pushin/spotlight/pan +
    soft/scene xfade tuples); resolve_format(auto=rotate by job index);
    NICHE_BASE grades x MOOD_TWEAK; grade_for().
  - textlayout.py — chunk_filters(): ONE line per event, per-word drawtext
    with estimated x advance (width_factor x 1.30 uppercase, gap 0.62em),
    safe margins 7.5%W, letterbox-aware vertical band, font auto-fit,
    anims: bounce/pop/fade/type; languages.json width factors.
  - renderer.py — render_shot(): zoompan Ken Burns + seeded drift + punch,
    video fit/pushin(pzoom)/shake(crop-sway), grade+grain+glitch(rgbashift
    pulses)+vignette+letterbox+spotlight(glow overlay); render_job(): per-join
    pads, xfade chain with offsets = cumulative NET durations (keeps audio
    sync exact), text drawtext on the composite at ABSOLUTE times, atrim
    audio, x264 crf19 + aac, faststart.
- presets/languages.json — per-language width_factor/allow_upper.

## CRITICAL INVARIANTS (do not regress)
1. xfade offset = sum of net shot durations (NOT padded) — audio sync depends
   on it (final length == last shot end == narration window end).
2. Text events must never overlap in time (script_nlp clamp) and drawtext
   x/width math must keep text inside 7.5% margins.
3. QC sharpness threshold is on the 512px-NORMALISED Laplacian (25) — raw
   resolution-dependent variance was wrong (rejected sharp 4K posters).
4. drawtext expressions: escape , and : inside expressions with \\, and \\:.
   No apostrophes/quotes in text (esc() strips).
5. Every deep problem so far was found by extracting frames — always verify
   renders visually: ffmpeg -ss T -i out.mp4 -frames:v 1 f.jpg.

## EXTENSION POINTS
- New format: add a dict to FORMATS (+ optional new anim in textlayout).
- Text-behind-subject: render_shot → if mask png exists for an image, overlay
  text BETWEEN bg and subject cutout (subjects.try_subject_mask provides the
  cutout). Wire behind a Job flag; keep off by default (heavy).
- BGM: add input in render_job, sidechaincompress/volume duck under [n:a].
- SFX on cuts: tiny whoosh at each join offset via amix + adelay.
- Split-screen segments (F5 richer): planner emits a "collage" shot type;
  renderer builds overlay filter_complex (proven pattern in session demos).
- True per-word whisper text timing: pass words list into select_text_events
  (word_time currently interpolates; exact times when whisper present).

## PERF (measured, this container ~ mid laptop)
1080p: 213s video ≈ 14.6 min render. 4K ≈ 4x. Whisper base ≈ 1-2 min per
10-min audio (CPU int8). QC+faces: seconds.
