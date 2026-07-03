# TECHNICAL REFERENCE — Auto Editor (for an LLM that will edit the code)

Pair with `00_PROJECT_HANDOFF.md`. Python 3.10+. Deps: `Pillow`,
`faster-whisper` (optional), system/`bin/` `ffmpeg`+`ffprobe`.

================================================================
## REPO LAYOUT (auto_editor/)
================================================================
- `auto_editor.py`   — CLI entry + orchestration (the conductor)
- `planner.py`       — the "editor brain": scenes+windows → concrete Plan
- `footage.py`       — reads tool #1 output folders + instructor file labels
- `align_audio.py`   — narration→scene windows (whisper/weighted/per-scene/fixed)
- `filmora/`
  - `template.py`    — harvest prototypes from a real Filmora save (the sample)
  - `timeline.py`    — Plan → timeline.wesproj JSON (+ sidecar JSONs)
  - `bundle.py`      — package everything into a .wfpbundle
  - `probe.py`       — ffprobe wrapper (+ PIL fallback) + thumbnails
  - `ids.py`         — GUID/uuid/userData binary-blob helpers
- `verify_bundle.py` — structural self-check of a generated bundle
- `template_data/filmora_15_6_4.json` — extracted template (user's Filmora 15.6.4)
- `gui.py`, `setup.bat`, `run.bat`, `setup.sh`, `run.sh`, `requirements.txt`
- `HANDOFF/` — this documentation

================================================================
## THE FILMORA FORMAT (as decoded from a real 15.6.4 save)
================================================================
```
X.wfpbundle (zip, STORED)
├─ Medias/{MEDIA-GUID}/<actual media file>          (one folder per file)
└─ X.wfp (zip, STORED)
   └─ ProjectFolder/
      ├─ project_info.json          (name, duration, resolution, project_guid,
      │                              timeline_mediaId → TL-GUID)
      ├─ Anon/AppData/Windows/functionExtraData.json
      └─ Medias/
         ├─ medias_info.json        (media library: media_items{GUID→type,path,len},
         │                           media_type: 8=video 16=image 4=audio 1048576=timeline)
         ├─ {TL-GUID}/timeline.wesproj   ← THE TIMELINE (plain JSON)
         ├─ {TL-GUID}/extra.json         (clip-instance GUID → mediaId map,
         │                                beatDetectInfo, font info)
         └─ {MEDIA-GUID}/media.json (+thumbnail.png)  (per-file stream metadata)
```

### timeline.wesproj essentials
- All times: integer ticks, **1s = 10,000,000**.
- `timelineInfos[]`: `type:0` = main timeline; `type:1` = a **text
  sub-timeline** (one per title; referenced by a type-7 clip's `timelineId`).
- Main timeline `trackInfos[]` (sample layout, reproduced verbatim):
  - [0] trackType 2 — narration audio (clip type 2)
  - [1] trackType 2, tag 1 — audio of video clips (we intentionally leave it
    empty → silent b-roll under narration)
  - [2] trackType 1, tag 2 — MAIN VIDEO TRACK (clip type 1)
  - [3] trackType 2, tag 3 — empty audio
  - [4] trackType 1, tag 4 — TEXT track (clip type 7)
- Media clip (type 1): `filename` = `%DOCUMENT_DIR%/Medias/{GUID}/<file>`,
  `sourceUuid` → entry in top-level `resources[]`, `tlBegin/tlEnd` (timeline),
  `inPoint/outPoint` (source; **images anchor at 3600s**, i.e. 36000000000),
  `speed.offset/offsetEnd` = in/out in seconds.
- `postTransition` on a clip = transition INTO THE NEXT clip:
  `{display, id: GUID-of-effect, tlBegin/tlEnd: window straddling the cut}`.
  Known 15.6.4 ids: Dissolve `2981D185-D52E-44f4-ABD5-3CE83890E32E`,
  fade_black `3B49DBEE-9A15-4844-B613-E2C2497EA236` (harvested, not hardcoded).
- `inAnimation` = intro animation: `{duration, effectChain.effectList[
  {id:"video/effect/motion", paramMapList[{key, keyFrame.parameter:
  "<JSON string with keyframeSets[{_time,_value,Interpolation}]>"}]}]}`.
  Ken Burns = Scale_x/Scale_y 200→100 etc. Animation display name lives in
  clip `userData` key 13011.
- `effectChainList` on every media clip: crop-pan-zoom + transform (copied
  verbatim from prototypes).
- Text clip (type 7 on text track) → sub-timeline whose inner clip (type 4)
  carries **`scriptBuf`: a JSON STRING** with `Text`, `TextData[].CharData`
  (both = the text, lines separated by `\r`), font/pos/scale fields.
- `userData` entries: base64 blobs. key 3 = clip-instance {GUID} (padded to
  64 bytes, null-terminated) — must appear in extra.json `mediaClipsMapInfo`;
  key 10 = media {GUID}; key 50 = display name; key 13011 = animation name.
  Text clips map to mediaId `"Basic_1"`.
- `resources[]`: one entry per media file: `filename` = `file:/C:/abs/path`,
  `sourceUuid`, stream metadata (patched from ffprobe).
- medias_info `timeline_uuid` must equal main timeline userData key 11000
  (we keep the template's).

================================================================
## DATA FLOW
================================================================
```
tool#1 output dir ──footage.read_footage()──► [Scene(clips,images,frames,narration)]
instructor .txt ──footage.apply_instructor()─► narration + on_screen per scene
narration.mp3 ──align_audio.compute_windows()► [(begin,end) ticks] per scene
                └ whisper: word timestamps + proportional estimate + fuzzy refine
planner.make_plan(scenes, windows, template, opts)
   ├ clips first, then images fill (cycle pool ≤2x if starved)
   ├ transitions: opts.transition inside scene, opts.scene_transition at end
   ├ image animations cycled from opts.image_animations
   └ TextItem for scenes with on_screen
filmora.timeline.build(plan, template) ─► BuildResult(wesproj, project_info,
                                           medias_info, extra_json, media_entries)
filmora.bundle.write_bundle(result, template, out) ─► X.wfpbundle
verify_bundle.py X.wfpbundle [reference.wfpbundle] ─► structural checks
```

================================================================
## CLI FLAGS (auto_editor.py)
================================================================
`--footage <dir>` (required) | `--audio <mp3>` | `--instructor <txt>`
`--title`, `--out <x.wfpbundle>`, `--template <bundle|json>`
`--align whisper|weighted|per-scene|fixed` (+ `--scene-audio-dir`,
`--fixed-secs`, `--whisper-model tiny|base|small`, `--language hi|en|…`)
`--transition`, `--scene-transition`, `--image-animation "a,b"`,
`--animate-videos`, `--max-image-secs`, `--min-item-secs`, `--text-secs`,
`--no-text`, `--no-frames`, `--max-clips-per-scene`, `--no-thumbnails`,
`--dry-run`

================================================================
## EXTENSION POINTS
================================================================
- **New Filmora version** → save a small sample project in it, then
  `python -m filmora.template New.wfpbundle template_data/new.json`;
  pass with `--template`. If `_index()` fails, the track/clip layout changed —
  update the heuristics in `template.py::_index`.
- **More transitions/animations/text styles** → add them to a sample project,
  re-extract. Nothing else to change (names resolved fuzzily in
  `planner._resolve_name`).
- **Background music track** → harvest a music clip prototype (add music in a
  sample), then in `timeline.build` append a clip to a `trackType 2` track with
  a `volumeKeyframe` (copy the structure from the prototype).
- **B-roll audio audible** → populate the tag-1 audio track: build type-2
  clips (prototype = the sample's track-1 clips) paired with each video item.
- **Different scene layouts (image-first, clip sandwich)** → the loop in
  `planner.make_plan`.
- **Vertical/Shorts** → the sample project must be 9:16; everything else is
  resolution-agnostic (timeline `resolutionWidth/Height` come from template).
- **Better whisper alignment** → `align_audio.whisper_windows` (proportional
  estimate ±20-word fuzzy window; could use DTW).

================================================================
## FRAGILE POINTS
================================================================
- Filmora major upgrades may change the wesproj schema (template re-extract
  fixes; the code itself is schema-light because of deep-copying).
- `scriptBuf` is JSON-in-a-string; keep `ensure_ascii=False` and `\r` line
  separators.
- Keep zips **ZIP_STORED** (Filmora writes stored zips; safest to match).
- Windows paths in JSON use forward slashes (`C:/Users/...`).
- Never bare-call `yt-dlp`-style tools; ffprobe is resolved from `bin/` first
  (`probe._exe`), same pattern as tool #1.
- Test order: `--dry-run` → generate → `verify_bundle.py out.wfpbundle sample.wfpbundle`
  → open in Filmora.
