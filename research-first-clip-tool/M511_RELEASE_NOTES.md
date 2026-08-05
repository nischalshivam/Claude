# M5.1.1 — Clean Media Export

## Real failure

The Horrid Henry export contained sentences such as “He earned the name”,
“The line” and “Never looked at from zero” over darkened frames. The export had
205 valid media shots and zero missing cards, so this was not a missing-media
failure. The research pack classified 73/108 moments as GRAPHIC/analysis and
the old renderer treated `overlay_text` as final on-screen typography.

## Fix

- `config.render.burnResearchOverlayText` defaults to `false`.
- New timelines convert analysis/frame-hint visuals to clean stills and keep
  the proposed words only as `suggested_text` metadata.
- Renderer defense-in-depth sanitizes old cached `kind=graphic` timelines too:
  no dim layer, accent bar or drawtext is rendered.
- Final manifest records `research_overlay_policy` and every suppressed shot.
- Production fails closed if a `TEMPLATE_GRAPHIC_MEDIA` asset somehow survives
  while the policy is disabled.
- Text/templates remain a future explicit, non-destructive Editor feature.

## Proof

- Legacy GRAPHIC fixture with bright green media and a research hint rendered
  RGB `1,254,0`, proving that neither dimming nor white text was applied.
- Manifest recorded `VERIFIED_SOURCE_STILL`, `research_overlay_suppressed:true`
  and policy `enabled:false`.
- Regression 133 PASS / 0 FAIL.
- Real FFmpeg EDL parity 11 PASS / 0 FAIL.
- Presentation policy is stage-scoped: changing it rebuilds timeline/render but
  preserves source downloads, clips and QA cache.
- Entire current suite: 195 PASS / 0 FAIL.
