# M5.0-B.1 production acceptance

Start only with `MOVIE_EDITOR.bat`. There is no update/old-folder workflow.

## Automated gates

- A second launcher click reopens the running instance; no `EADDRINUSE` crash.
- Draft is successful only if process exit is zero **and** `draft.mp4` exists.
- Final is successful only if process exit is zero **and** `final.mp4` exists.
- Any non-zero render exit stays on New Video with the real error and log.
- A small final-SRT display tail is clamped to voiceover; large mismatches block.
- Fresh start archives the current project and returns to empty inputs.

## One real-video acceptance run

1. New Video: add pack, voiceover, script and SRT.
2. Build -> Editor. Confirm the Editor opens only after the draft artifact exists.
3. Play, pause and scrub through three distant sections.
4. Fill every Missing Media card; approve every HARD EVIDENCE card.
5. In Editor, change one obvious crop/scale/trim and reload the page; it must persist.
6. Export. Confirm `final.mp4` has no MISSING placeholder and its duration matches voiceover within 0.5s.
7. Double-click `MOVIE_EDITOR.bat` while the editor is already open; it must reopen, not crash.
8. Click Fresh start and confirm the next project begins empty while the old work remains under `archive/`.

## Honest scope

This verifies the production foundation and current editor. Full ripple editing,
split/reorder, style templates, transitions/effects, batch queue, and a real
multi-project library remain later milestones; see `KNOWN_LIMITATIONS.md`.
