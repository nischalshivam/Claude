# EDL — `project-edl-v1`

Editor ka database. Research JSON aur engine ki `timeline.json` se ALAG — wo har
run par dobara banti hai; EDL insaan ke faisle rakhta hai aur dobara khulne par
bilkul waisa wapas aata hai.

- File: `project/project.edl.json`
- Har save: atomic temp-write + rename, aur `project/revisions/rev-NNNNN.json` snapshot
- Har mutation `expected_revision` bhejti hai → stale par `409` (purana tab overwrite nahi kar sakta)
- Identity STHIR `request_key` se — display number kabhi nahi
- `src/edl.js` isse banata/padhta/patch karta hai; `buildFromJob()` draft ke
  `timeline.json` + `render-manifest.json` + `gap-plan.json` se banata hai

## Top level

```json
{
  "schema": "project-edl-v1",
  "project_id": "current",
  "source_job": "candace",
  "revision": 42,
  "duration_sec": 894.7,
  "fps": 30,
  "resolution": { "width": 1920, "height": 1080 },
  "content_locked": false,
  "tracks": { "video_main": [ ...shots ], "captions": [], "voiceover": [], "overlays": [], "music": [] }
}
```

## Ek shot (video_main[])

```json
{
  "shot_id": "SHOT_0007",
  "slot_id": "SLOT_0007",
  "request_key": "REQ_ab12cd34",
  "display_label": "MISSING 003",
  "moment_ids": ["P03_M05"],
  "timeline": { "start": 120.0, "end": 125.0 },
  "asset": {
    "asset_id": "ASSET_9f2c1a",
    "sha256": "…",
    "path_token": "…",
    "type": "video",
    "source_in": 12.4,
    "source_out": 17.4
  },
  "transform": { "fit": "fill", "crop_x": 0.5, "crop_y": 0.5, "scale": 1.0, "rotation": 0, "opacity": 1, "blur_bg": false },
  "provenance": { "origin": "AUTO_EXACT", "source_id": "…", "scope_relation": "SAME_EPISODE", "url": "…" },
  "approval": { "required": true, "status": "APPROVED", "criticality": "HARD_EVIDENCE" },
  "cue": "the exact narration line",
  "missing": false
}
```

- `path_token` = server-side path ka opaque hash. Browser ko response mein
  `asset.path` KABHI nahi milta (server strip karta hai). Media `/api/v1/media/:token` se aata hai.
- `origin`: `AUTO_EXACT · AUTO_CONTEXT · AUTO_STILL · AUTO_MONTAGE · AUTO_GRAPHIC · USER · MISSING`
- `approval.status` live readiness se chadhta hai (`APPROVED · PENDING · EXPIRED · null`), store mein nahi rakha jaata — wo fingerprint se derive hota hai.

## PATCH — kya badal sakte ho, kya nahi

Sirf ye (allow-list): `transform.{fit,crop_x,crop_y,scale,rotation,opacity,blur_bg}`
aur `asset.{source_in,source_out}` (trim).

**Kabhi nahi (yahan se):** narration timing, slot range, asset identity, approval,
scope, provenance. Wo apne apne raste se badalte hain (media upload, approval flow).

```
PATCH /api/v1/edl
{ "expected_revision": 42, "ops": [ { "shot_id": "SHOT_0007", "transform": { "fit": "blur", "scale": 1.2 } } ] }
```

Validate hone par hi commit; revision +1; snapshot; warna structured error
(`REVISION_CONFLICT` / `INVALID` / `CONTENT_LOCKED` / `NO_SHOT`).

## Note (M5.0-A ka daayra)

M5.0-A mein EDL banti, dikhti, patch aur save/reload hoti hai. EDL ke
transform/trim edits ko ASLI ffmpeg render se jodna **M5.0-B** hai — abhi final
render wahi DATA-folder + approval waala tested rasta use karta hai. Missing-media
(upload / approve / reuse) edits render ko ABHI bhi affect karte hain (wo overrides
se hote hain), sirf editor ke crop/trim abhi render mein nahi jaate.
