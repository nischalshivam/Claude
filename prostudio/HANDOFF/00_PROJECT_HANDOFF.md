# PROJECT HANDOFF — ProStudio (A-to-Z context for any future LLM)

> TOOL #2 of the user's pipeline (TOOL #1 = Footage Collector, separate repo
> folder with its own HANDOFF). Give this file + 01_TECHNICAL_REFERENCE.md to
> any AI assistant and it will understand everything. Read fully before editing.

## 1. WHAT THIS IS (one paragraph)
A desktop tool that turns **scene-wise footage (from the Footage Collector) +
a narration audio file into a finished, ready-to-upload 16:9 documentary video
(4K or 1080p MP4)** — fully automatically. It quality-checks the media (drops
black/blurry/duplicate junk), syncs every visual and on-screen text to the real
narration timing, plans shots like a human editor (clips first 2-5s, images
3-7s with motion, J/L cuts), applies one of **10 distinct editing formats**
(kinetic typography, cinematic serif, letterbox, glitch, spotlight, …), and
renders with ffmpeg on any normal CPU — no GPU, no paid APIs. GUI supports a
**queue of up to 15 videos** (add one by one) for overnight bulk production.

## 2. THE USER
Non-technical faceless-YouTube creator (documentary/essay videos, e.g.
Scarface/Tony Montana essays). Everything must be turnkey: GUI + .bat.
Priorities: perfect audio-text sync, text always inside the frame, high
quality (4K), format variety so bulk videos never look repeated.

## 3. THE JOURNEY (why things are the way they are)
1. First target was generating **Filmora project files** (.wfpbundle) so a human
   could polish. Format was reverse-engineered deeply (see auto_editor/ HANDOFF)
   but Filmora rejects foreign files with an opaque check we could never see
   (can't run Filmora in the dev environment). ABANDONED for the render path.
2. Switched to **direct ffmpeg rendering** — verifiable end-to-end without the
   user testing every build. Instantly reliable.
3. Iterated on real competitor references (Gus Fring / Incredibles video
   essays) → kinetic color-coded typography, quote cards, split screens,
   2.6s average cuts.
4. User reviews fixed: text overlap, text outside frame/letterbox bars,
   audio-text desync (fixed via silence-detected phrase boundaries; whisper
   word-timing when available), always 16:9.
5. Gemini "7 pro rules" folded in: NLP 2-3-word chunking, J/L cuts, camera
   drift, sentiment grading, subject-aware text zones (OpenCV face detect),
   liquid easing. Text-behind-subject (rembg) is scaffolded but OPTIONAL/off.

## 4. PIPELINE (8 stages)
INPUT → audio sync (whisper→silence-snap fallback) → media QC → script NLP
(chunks/triggers/colors/mood) → subject analysis (face → text zone) → shot
planner (clips-first, J/L, drift seeds) → format style pack → ffmpeg render →
MP4 + report.json.

## 5. TEXT POLICY (user's spec, implemented in script_nlp.select_text_events)
- first 60s: dense text (hook phase)
- after: only crucial moments (names→GOLD, numbers/years→YELLOW,
  danger words→RED, success→YELLOW/GREEN)
- forced refresher if 35s pass without text; min 5s gap; 2.2-5s hold
- events NEVER overlap in time; text NEVER outside the visible image.

## 6. THE 10 FORMATS (engine/formats.py)
F1 Cinematic, F2 Kinetic (the Gus-style flagship), F3 Archival typewriter,
F4 Depth (strong parallax; true 2.5D pending rembg), F5 Grid lower-third,
F6 Letterbox 21:9, F7 Glitch, F8 Horizontal pan, F9 FocusPuller blur-snap,
F10 Spotlight glow. "Auto-Rotate" cycles per job; "Random" picks per job.
F1/F2/F6/F9 were approved by the user on real footage before the tool was built.

## 7. HONEST LIMITS / EXPECTATIONS
- Whisper model downloads once from the internet; when blocked the
  silence-snap fallback is ~90% as good (user's PC normally fine).
- 4K render ≈ 4x slower than 1080p (10-min video ≈ 1.5-2.5h on an i5; overnight
  queue is the intended workflow). No GPU needed.
- Text width is estimated (drawtext can't measure); widths are padded
  conservatively — extremely long words auto-shrink.
- rembg (text-behind-subject) optional: pip install rembg, then wire
  subjects.try_subject_mask into the renderer (extension point documented).
- Faces: OpenCV haarcascade — good, not perfect; fallback zone is bottom.

## 8. TESTED (this session, real Tony Montana data: 12 scenes, 3.5-min audio)
- QC: 44 files → 7 junk auto-rejected (all true duplicates/black)
- Full 213s video rendered end-to-end at 1080p in 14.6 min (this container);
  4K path verified (3840x2160); queue of 2 jobs with auto-rotation verified.

## 9. HOW TO ASK AN LLM FOR CHANGES
Attach both HANDOFF files + name the module (see 01_TECHNICAL_REFERENCE).
Test loop: mini scenes dir + 12s audio clip → render 1080p (<1 min) → check
frames with ffmpeg -ss T -frames:v 1. Never ship without that loop.
