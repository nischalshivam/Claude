# Canonical handoff to Claude — Research-First Clip Tool M5.1.1

This source ZIP is the canonical continuation base. It contains every Codex
change made after Claude's M5.0-B build. Do not merge an older generated folder
over it and do not restore the old `UPDATE_TOOL.bat` / folder-drag workflow.

## 1. Product contract

The tool is local-first and human-in-the-loop:

1. User imports research JSON, voiceover, script and SRT in the UI.
2. Engine validates/probes research, aligns narration, downloads/caches approved
   sources, cuts exact clips and creates a full draft.
3. Unresolved ranges become stable DATA requests with time, narration and search
   help. User fills only those ranges.
4. Critical user media requires explicit fingerprinted review.
5. Editor allows per-shot correction; final renderer must match Editor state.
6. Export is fail-closed: no missing placeholders, silent media substitution,
   stale approval, lost EDL edit or shortened voiceover may be called success.

## 2. Codex changes after Claude M5.0-B

### M5.0-B.1/B.2 foundation stabilization

- One `MOVIE_EDITOR.bat`; launcher reuses its own running instance and selects a
  free port when 7900 is occupied. Child consoles are hidden on Windows.
- Removed updater/old-folder drag workflow. Fresh Start archives; it does not
  delete the previous project.
- UI build is fail-closed: success requires exit zero plus the expected MP4.
- Canonical media-token proxy supports exact clips, source bank, images,
  montages, graphics, voiceover and editor replacements without exposing raw
  paths to the browser.
- EDL transform/crop/fit/trim is reconciled into FFmpeg final output and parity
  is recorded in the manifest.
- Timeline/audio/manifest durations use voiceover as authority; concat rounding
  cannot silently remove narration tail.
- UI async views use an epoch guard so stale New Video/Missing responses cannot
  overwrite Editor after rapid navigation.

### M5.1 editor and export changes

- `POST /api/v1/requests/approve-all-ready-critical`: one explicit confirmation
  approves only VALID critical requests that already contain inspected media.
  Empty/broken/short media cannot be bulk-approved. Byte or input changes expire
  approval through fingerprints.
- `POST /api/v1/edl/:shot/replace` and
  `DELETE /api/v1/edl/:shot/replacement`: right-click Change Clip/Image and
  Restore Original. Replacement is copied into project storage, revision
  guarded, tokenized, survives EDL rebuild and reaches final FFmpeg render.
- Left shot rail and Inspector show exact start, end and duration.
- `GET /api/v1/artifacts/final`: streams final MP4. Chrome/Edge use the File
  System Access picker for Export/Save As; other browsers use normal download.
- Short SRT handling: voiceover remains authoritative. SRT ending up to five
  seconds early produces `EXTENDED_TO_AUDIO`; final visual extends to exact
  audio end. Large mismatch blocks instead of guessing.

### M5.1.1 clean-media fix

Observed real export: 73/108 moments were GRAPHIC/analysis. Old code converted
research `overlay_text` into darkened on-screen titles, producing unwanted
sentences over most of the video although all media slots were valid.

New invariant:

- `overlay_text`, fallback text and research template names are planning data.
- `config.render.burnResearchOverlayText` defaults to `false`.
- `src/timeline.js` makes hint-backed analysis shots clean stills and stores the
  words only as `suggested_text` with `research_overlay_suppressed:true`.
- `src/render.js` independently sanitizes legacy cached `kind=graphic` shots.
  No dim, accent bar or drawtext is applied when policy is false.
- Manifest contains `research_overlay_policy` and per-shot suppression proof.
- Production throws if `TEMPLATE_GRAPHIC_MEDIA` survives while policy is off.
- Never re-enable this globally. Future typography must be an explicit Editor
  overlay track/action with its own EDL data and undo history.
- The overlay policy is excluded from the acquisition fingerprint and included
  in the render signature. Changing it rebuilds timeline/render/report only;
  it must never wipe downloaded sources, cuts or QA cache.

## 3. Important changed files

- `server/app.js` — canonical state, critical bulk approval, replacement and
  artifact-stream APIs, token allow-list.
- `server/ui/app.js` — approval UX, right-click replacement, exact times,
  Save-As streaming and async-view epoch guard.
- `server/ui/index.html` — editor rail/context-menu/banner styling.
- `src/edl.js` — persistent replacement, restore, stable slot reconciliation,
  replacement signature.
- `src/render.js` — EDL/replacement parity, full voiceover, Save-As artifact,
  clean-media legacy defense and overlay-policy manifest.
- `src/timeline.js` — clean analysis stills and suggested-text metadata.
- `src/timebase.js`, `src/align.js` — bounded audio-leading-SRT extension.
- `config.json` — 5-second SRT lead bound and research overlays default off.
- Tests: `server-test.js`, `m5b-contract-test.js`, `regression.js`,
  `edl-parity-test.js`.

## 4. Non-negotiable regression invariants

Any future change must preserve these:

1. Voiceover is never shortened; final duration matches audio within tolerance.
2. Research text never appears unless the user explicitly creates/enables a
   text overlay in Editor.
3. Editor preview and FFmpeg final use the same EDL transform/replacement.
4. Replacing media bytes expires critical approval.
5. No raw filesystem path is returned to browser APIs.
6. No missing/diagnostic/generic card may exist in successful production final.
7. Same-show other-episode borrowing stays explicit and provenance-labelled.
8. Fresh Start archives; it never destroys project work.
9. Final success requires exit zero and a real, probeable final artifact.
10. Existing source/download cache is reused; UI edits must not trigger a full
    redownload.

## 5. Verification baseline

- Mini/content: 13/0
- Regression: 133/0
- Server/API: 17/0
- M5B contracts: 21/0
- Real FFmpeg EDL parity: 11/0
- Total: 195 PASS / 0 FAIL

The overlay defense has actual pixel proof: a legacy GRAPHIC slot with an
internal hint and bright-green media exported as RGB `1,254,0`; manifest asset
was `VERIFIED_SOURCE_STILL`, policy disabled, one suppression recorded.

## 6. Next architecture — recommended order

Do not add all features in one rewrite. Build on this foundation in gates:

### M5.2 — Project Library and Render Queue

- Project registry with immutable project id, title, thumbnail, duration,
  status, last opened and disk path.
- Background worker queue with states QUEUED/RUNNING/PAUSED/FAILED/COMPLETE,
  concurrency limit, cancel and resume-from-stage.
- Atomic job state writes and crash recovery. UI must never own worker truth.
- Shared content-addressed source/proxy cache with reference tracking; no
  automatic destructive cache cleanup.

### M5.3 — Non-destructive text and template tracks

- Separate EDL tracks for titles/callouts/captions; never overload research
  `overlay_text`.
- Explicit add/toggle/delete, font, position, safe area, in/out and preview.
- Template id + parameters stored in EDL; render applies exactly that data.
- Undo/redo and autosave before adding bulk templates.

### M5.4 — Transitions, animations and effects

- Start with cut, crossfade, dip-to-black and simple Ken Burns presets.
- Transition duration must consume adjacent handles without shifting narration.
- GPU acceleration may be optional; CPU output remains deterministic fallback.
- Every template/effect needs a visual parity fixture and duration invariant.

### Later pro features

- Audio waveform, markers, captions track and loudness meter.
- Proxy generation for smooth long-project preview.
- Version snapshots and compare/restore.
- Batch QC dashboard: missing media, duplicate shots, black frames, frozen
  frames, host/reaction/logo detection when an optional vision model is enabled.
- Export presets, hardware encoder detection and safe software fallback.
- Rights/provenance report per source and user replacement.

## 7. Instructions for Claude when continuing

1. Start from this exact ZIP and read `M511_RELEASE_NOTES.md`,
   `FINAL_VERIFICATION.txt` and this handoff.
2. Run existing tests before editing and again after editing.
3. Add a failing regression test for every reported real bug before the fix.
4. Never claim cross-niche perfection without pilots; engine invariants may be
   universal, research quality is still evidence-dependent.
5. Return a clean fresh-start ZIP. Do not ask the user to drag an old folder.
6. Include migration code only when an existing project schema actually needs
   it; migrations must be idempotent and archive/backup before mutation.
