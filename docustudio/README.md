# DocuStudio — Documentary Editing Brain (Tool #4)

Turns **script + voiceover + assets** into a fully edited, genre-aware
documentary video (final MP4, 1080p or 4K, 16:9), with a **storyboard
approval step before render** and per-scene re-render after.

> STATUS: design/spec phase. The specs in `SPECS/` are the foundation —
> input file formats, library structure, storyboard workflow, genre packs.
> Engine will reuse ProStudio's proven pieces (whisper word-sync, Ken Burns
> + drift, planner, QC, renderer). **No Filmora/.wfpbundle export** — that
> approach failed and is dropped for good; output is a rendered MP4 only.
> The editable/reviewable artifact is our own **storyboard**, not a
> third-party project file.

## The user's inputs (per video)

| # | Input | What it is |
|---|-------|------------|
| 1 | Clean script | Word-for-word narration text (same words as the VO) |
| 2 | Editing Help Script | Clean script + scene breaks + bracket tags (`SPECS/02`) |
| 3 | Visual Help File | Per-scene asset list: links, timestamps, search intents (`SPECS/03`) |
| 4 | Voiceover audio | ONE full narration file (30 min – 2 hr) |
| 5 | Data file (optional) | Stats/facts used by `[STAT]` cards |
| 6 | Assets folder | Local images/clips referenced as `LOCAL:` |
| 7 | Library folder | User's music/ambience/SFX collection (`SPECS/04`) |

## Pipeline (7 stages)

1. **Parse** — read the 3 files into one project model; validate scene
   numbers match between Editing Help Script and Visual Help File.
2. **Acquire** — download/cut clips (yt-dlp + timestamp ranges), fetch
   images, QC every asset (reject black/blur/dupe/low-res), detect
   archival-vs-modern era for treatment.
3. **Align** — whisper word-level sync of clean script ↔ VO audio →
   every scene gets exact start/end times. Scene durations come from the
   narration, never from a retention timer.
4. **Plan** — the editing brain: per-scene shot plan from the genre
   grammar pack (visual order, dwell times, Ken Burns/holds,
   split-screens), tag events (date cards, texts, sources synced to the
   spoken word), curiosity devices on `[REVEAL]`, variation ranges so no
   two videos look templated.
5. **Graphics** — generate date cards, source labels, stat panels, map
   cards, lower-thirds, chapter cards, evidence-board frames in the
   pack's typography.
6. **Sound design** — 4 tracks: VO / music (mood curve per scene) /
   ambience / SFX stings, with smooth ducking and `[SILENCE]`/`[HOLD]`
   swells.
7. **Storyboard → Render** — storyboard opens for approval
   (`SPECS/05`); after approve, render final MP4 + quality report;
   any scene can be re-rendered alone afterwards.

## Pacing philosophy (owner's rule)

Documentaries are information-first. A 30–40 min video is ~80–120 scenes
(avg scene 18–25 s), a 1–2 hr lore video ~150–250. A scene may rotate
2–4 visuals internally, but cuts follow the story, not a timer.
Accuracy of clip-to-line matching beats speed of cutting.

## Genres (grammar packs)

history, war, machinery, farming, sports, science, nature/wildlife,
crime, lore (long-form). All run on ONE engine + per-genre JSON packs —
see `SPECS/06_GENRE_PACKS.md`.

## Censorship

Anything tagged `[CENSOR]` gets blurred; the tool also auto-blurs
detected blood/gore regions by default (YouTube-policy safety). The
always-blur list is configurable in the UI.
