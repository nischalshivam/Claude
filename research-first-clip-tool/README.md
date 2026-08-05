# Research-First Clip Tool — M5.1.1 FINAL

Local-first video-essay assembly and editing tool. Current production flow:

1. Unzip once.
2. Double-click `MOVIE_EDITOR.bat`.
3. Add research pack, voiceover, clean script and SRT in **New Video**.
4. Click **Build → Editor**.
5. Fill unresolved ranges in **Missing Media** and review/edit the timeline.
6. Export the final video.
7. Use **Fresh start** for the next project.

## M5.1.1 clean-media policy

Research-pack `overlay_text`, fallback text and template labels are planning
metadata. They are **not burned into final video by default**. Analysis beats
render as clean source frames/stills; old cached `graphic` timelines are also
sanitized by the renderer. `config.render.burnResearchOverlayText` remains
`false`. Future text/templates must be explicit non-destructive Editor actions.

There is no old-folder drag, updater, or manual input-folder workflow. Fresh
start archives the prior project instead of deleting it.

## What M5.1 adds

- **Critical review is explicit but quick:** once valid HARD EVIDENCE media is
  uploaded, one confirmation approves every ready critical request. Empty,
  broken or too-short media can never be bulk-approved.
- **Per-shot replacement:** right-click any shot in the list or timeline and
  choose `Change Clip / Image...`. `Restore Original` provides a safe undo.
  Replacements survive editor rebuilds and are used by the final FFmpeg render.
- **Exact timing in the shot list:** every row shows start, end and duration.
- **Export / Save As:** Chrome and Edge ask for the output filename and folder;
  unsupported browsers fall back to their normal Save As download.
- **Voiceover is authoritative:** a 2–3 second short SRT extends the final
  visual to the exact audio end. The audio is never shortened. Larger timing
  mistakes still block instead of silently producing a wrong video.
- **Race-safe navigation:** rapid page switching no longer lets an older async
  response overwrite the current Editor view.

## Earlier M5.0-B.2 foundation

- One-click single-instance launcher: reopens an existing instance and chooses
  a free port if another copy already owns the preferred port.
- Fail-closed build status: a draft/final is successful only when the child
  process exits zero and the expected MP4 actually exists.
- Persistent, human-readable failure card and progress log in the UI.
- Successful draft automatically opens the Editor.
- Bounded final-subtitle display-tail handling for long voiceovers; large audio/
  SRT mismatches still block.
- Editor EDL crop/scale/fit/trim is applied to real FFmpeg final output.
- Missing-media files exactly tile their requested time range; HARD EVIDENCE
  still requires explicit human approval.
- Exact clips, source-bank videos, stills, montages, graphics and user media
  now share one canonical media-token contract; old broken EDLs self-repair.
- Legacy research packs get missing criticality migrated automatically (with a
  backup); cross-episode borrowing is never auto-approved.
- A fully completed pre-M5.0-B.2 project can export without invalidating its
  filled DATA folders or cached downloads; the bridge requires HYBRID_READY.
- FFmpeg/FFprobe/yt-dlp run in the background without flashing CMD windows.
- Multi-shot concat rounding no longer cuts the final fraction of narration.

## Inputs

- `scene-research.json` / research pack
- voiceover: MP3, M4A or WAV
- clean narration script: paste or TXT
- SRT: upload a real SRT, or use the estimated Auto-SRT option

Auto-SRT is timing estimation, not speech transcription. A real TTS/Whisper SRT
is more accurate.

## Verified

- Content/mini: 13 pass, 0 fail
- Regression: 133 pass, 0 fail
- Server/API: 17 pass, 0 fail
- M5B contract: 20 pass, 0 fail
- Real Candace project: 137/137 editor shots resolved; sampled exact/context
  video proxies and image/graphic previews returned valid media
- Real Candace final export: 137 shots, 0 missing placeholders, 1920x1080,
  894.77s video / 894.70s voiceover, exit 0
- Real FFmpeg EDL parity: 9 pass, 0 fail
- Total automated checks (M5.1.1): 195 pass, 0 fail
- Local browser QA: pass, zero console errors
- User timebase: 894.7s audio / 897.0s SRT accepted as a 2.3s display-tail

See `FINAL_VERIFICATION.txt` for the exact verification record and
`KNOWN_LIMITATIONS.md` for remaining product scope.

## Honest scope

This build is the stable foundation and current shot editor, not yet a CapCut
replacement. Full split/ripple/reorder editing, style templates, transitions,
effects, batch queue and multi-project library are later milestones. Research
quality still depends on real available footage; Missing Media is the intended
human-in-the-loop fallback when no trustworthy source exists.
