# PROJECT HANDOFF — Auto Editor (A-to-Z context for any future LLM)

> Give this file (and `01_TECHNICAL_REFERENCE.md`) to any AI assistant and it
> will understand the entire project. This is TOOL #2 in the user's pipeline;
> TOOL #1 is the "Footage Collector" (separate folder, has its own HANDOFF).
> Read this fully before modifying anything.

---

## 1. WHAT THIS PROJECT IS (one paragraph)
A desktop tool that turns the **Footage Collector's output + a narration audio
file into an editable Wondershare Filmora project (`.wfpbundle`)**. It arranges
every scene's clips and images on the timeline **in sync with the narration**,
applies **transitions** between visuals, **animations (Ken Burns style zoom)**
on images, and **on-screen text** where the script asks for it — then writes a
native Filmora project the user double-clicks to open. The user's human editor
does the last ~10% polish inside Filmora. No paid APIs; runs on the user's own
Windows PC with a simple GUI.

## 2. THE USER & THEIR GOAL
- Same non-technical user as tool #1: makes faceless documentary/essay YouTube
  videos. Cannot code; everything must stay turnkey (GUI + .bat + guides).
- They chose **Filmora** (version **15.6.4**) because DaVinci/Premiere are too
  complex and CapCut doesn't work in India.
- Their words: if the tool gives **"90% work done"** — clips arranged scene by
  scene, transitions, animations on images/clips, occasional on-screen text
  (only ~5-6% of the video needs text) — they are happy; their editor reviews
  and finishes the last 10%.
- Audio (voiceover) is generated manually by the user; the tool must sync
  visuals to ONE full narration audio file automatically.

## 3. THE CORE TECHNICAL INSIGHT (read carefully)
Filmora does NOT import EDL/XML/FCPXML. The ONLY way to hand it an editable
timeline is to write its **native project format**, which is undocumented but
fully readable:

- `.wfpbundle` = a ZIP: `Medias/{GUID}/<media files>` + `<Name>.wfp`
- `.wfp` = another ZIP: `ProjectFolder/...` with **`timeline.wesproj`** —
  plain JSON holding tracks, clips, transitions, animations, text, everything.
- All times are integer ticks, **10,000,000 per second**.

**The golden rule: we never invent Filmora structures.** The tool requires a
small **sample project saved by the user's own Filmora** (they made one with
2 clips, images with animations, transitions, a title). Every clip/transition/
animation/text block we write is a **deep copy of a prototype harvested from
that sample**, with only times/ids/file references/text changed. That is why
every effect is guaranteed supported by their Filmora version — the GUIDs come
from their own installation.

The user's sample gave us (Filmora 15.6.4): transitions **dissolve**,
**fade_black**; image/video animations **zoom out 2, zoom in 1, boom, fade**;
one text style (Archivo Black, sample layout). To add more, the user adds them
to a new sample project and re-extracts (see §7).

## 4. THE JOURNEY (problem → decision)
1. User asked: can the whole editing be automated? Decision: generate a
   **90% assembled editable project**, not a final render — keeps creative
   control, fits their editor's workflow.
2. Output format: user wanted **Filmora** specifically → reverse-engineered
   `.wfpbundle` from their sample (schema fully decoded; see TECH REFERENCE).
3. Effects-support doubt: solved by the **sample-as-template** rule above.
4. Timing: user records ONE full narration audio → **Whisper alignment**
   (faster-whisper, free, offline) maps each scene's script text to its exact
   audio window; visuals are laid to those windows. Fallbacks: weighted (by
   word count), per-scene audio files, fixed seconds (preview).
5. Whisper may fail (no internet for model download, etc.) → always **falls
   back gracefully to weighted**; never crashes the run.
6. Images looked static → apply the sample's **zoom/Ken Burns animations**,
   cycling; if a scene has few images and long narration, images repeat with
   animation rather than freezing for 30s.
7. Text: only beats whose instructor file has `On-Screen Text:` get a title
   (user wants text on ~5% of the video, not everywhere).

## 5. END-TO-END WORKFLOW (how the user actually uses it)
1. Run TOOL #1 (Footage Collector) → `output/scene_NNN/` folders + footage.
2. Record/generate the narration audio (one mp3 for the whole video).
3. Open Auto Editor (`run.bat` → GUI): pick footage folder, audio, instructor
   .txt, output path → **Generate**.
4. Double-click the produced `.wfpbundle` → Filmora opens the assembled
   timeline: narration on the audio track, visuals scene-by-scene in sync,
   transitions, animations, texts.
5. Editor polishes (swap a clip, nudge a cut, add music) and exports.

## 6. HONEST LIMITATIONS
- **Version lock:** the template JSON was extracted from Filmora **15.6.4**.
  A major Filmora upgrade may change the schema → re-save a sample project in
  the new version and re-extract (one command, §7). Minor updates usually fine.
- Whisper alignment is ~95% right; a boundary can be off by a second — that's
  part of the human 10%.
- We only apply effects present in the sample (by design, see §3).
- The text style (font/position) is whatever the sample title used.
- Filmora may re-index/re-generate thumbnails on first open (normal).
- If Filmora refuses to open a generated bundle after some future change,
  compare against a fresh sample save with `verify_bundle.py` (see TECH REF).

## 7. HOW TO ADD MORE TRANSITIONS/ANIMATIONS/TEXT STYLES LATER
1. In Filmora, make a tiny project: apply the NEW transition between two clips,
   the NEW animation on an image, the NEW title style; save as e.g. `More.wfp`
   / export the bundle.
2. Re-extract: `python -m filmora.template More.wfpbundle template_data/filmora_15_6_4.json`
   (or keep multiple template JSONs and pass `--template`).
3. The new names now work in `--transition/--scene-transition/--image-animation`.

## 8. KEY DESIGN PRINCIPLES (do not regress)
- **Sample-as-template**: never fabricate Filmora structures or GUIDs of
  effects; always deep-copy from the user's sample.
- **Editable, not baked**: everything lands as normal timeline objects the
  editor can move/trim/replace in Filmora.
- **Graceful degradation**: whisper→weighted, missing prototypes→warn+skip,
  missing images→stretch, never crash on a fixable situation.
- **Turnkey UX**: GUI + one-click .bat; CLI remains the single source of truth
  (GUI shells out to it).
- **Honesty over hype**: surface warnings; don't silently produce a broken file.

## 9. HOW TO ASK AN LLM FOR A CHANGE LATER
Attach BOTH handoff files and say e.g.:
- "Speed up: probe media in parallel."
- "Add a `--music` flag that puts a background music file on a second audio
  track at 20% volume."  (harvest a music clip prototype from a sample first!)
- "Support Filmora 16 — here's a fresh sample bundle."
Point it to `01_TECHNICAL_REFERENCE.md` § Extension points.
Always test with `--dry-run`, then verify with `verify_bundle.py` against a
real sample before opening in Filmora.
