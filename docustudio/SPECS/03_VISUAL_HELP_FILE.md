# SPEC 03 — Visual Help File (format + generation prompt)

The Visual Help File maps **every scene to its visuals**: YouTube clips
(with time ranges), image links, local files, and fallback search
queries for the Footage Collector. Scene numbers **must match** the
Editing Help Script.

## Why timestamps matter (`@ mm:ss-mm:ss`)

A YouTube link may be 15 minutes long while only 20 seconds of it is
relevant. `@ 02:31-02:55` tells the tool to cut exactly that portion.
With timestamps the clip-to-line accuracy is near-perfect; without them
the tool auto-picks the best-looking segments (scene detection + quality
scoring), which can miss the point. **Rule: whoever finds the link
writes the timestamp.** If genuinely unknown, omit it — the tool will
auto-select and flag that scene in the storyboard for review.

---

## 1. File format

Plain text (`.txt`). One block per scene:

```
=== SCENE 12 ===
SEARCH INTENT: 1999 Alabama missing person case, black Mazda crime scene
ASSETS:
CLIP: https://www.youtube.com/watch?v=XXXXXXX @ 02:31-02:55 | shows: police walking around the car | priority: 1
IMAGE: https://example.com/mazda_herring_ave.jpg | shows: the black Mazda on the road | priority: 2
IMAGE: LOCAL: tracy_yearbook.png | shows: Tracy's yearbook portrait | priority: 3
FALLBACK: 1990s police investigation footage, rural road crime scene aerial, missing person poster close-up
NOTE: car clip first, then slow zoom into the yearbook photo
```

### Fields
- `SEARCH INTENT:` one line describing what this scene needs — this is
  what the Footage Collector uses when links are missing.
- `ASSETS:` zero or more lines, each:
  - `CLIP:` video link. Optional `@ start-end` range (can repeat:
    `@ 02:31-02:55, 05:10-05:20`).
  - `IMAGE:` image link, or `LOCAL: <path>` relative to the project's
    assets folder.
  - `DOC:` article/wikipedia/newspaper link — rendered as a
    screenshot-style credibility visual.
  - `| shows: ...` — REQUIRED. What the asset depicts. The planner uses
    this to place the right visual under the right line.
  - `| priority: n` — optional ordering hint (1 = show first).
- `FALLBACK:` comma-separated search queries if assets fail
  (dead link, blocked download, QC reject).
- `NOTE:` free-text direction for the planner (ordering, emphasis).

### Quantity guide
- `PACING: normal` scene (~20 s) → 2–3 assets.
- `PACING: dense` → 3–5 assets.
- `PACING: hold` → 1 strong asset (it will be dwelled on).
- Era-accurate archival beats generic stock every time.

---

## 2. Ready-made LLM prompt (copy-paste)

Give this prompt + the **Editing Help Script** (not the clean script —
scene numbers must carry over) to the LLM/researcher that builds the
visual plan:

```
You are a documentary footage researcher. Using the EDITING HELP SCRIPT
below (already split into numbered scenes with mood/pacing and tags),
produce a VISUAL HELP FILE that maps every scene to its visuals.

RULES
1. Keep the exact same scene numbers. Every scene gets a block, none
   skipped.
2. For each scene output:
   === SCENE <n> ===
   SEARCH INTENT: <one line: what footage/images this scene needs>
   ASSETS:
   <zero or more asset lines — see format>
   FALLBACK: <2–4 comma-separated search queries>
   NOTE: <optional one-line direction: order, emphasis>
3. Asset line format (one per line):
   CLIP: <video url> @ <mm:ss>-<mm:ss> | shows: <what it depicts> | priority: <n>
   IMAGE: <image url or LOCAL: filename> | shows: <what it depicts> | priority: <n>
   DOC: <article/wikipedia url> | shows: <what it proves> | priority: <n>
   - "shows:" is mandatory on every asset.
   - Include timestamp ranges on every CLIP you are confident about;
     omit the range only if unknown.
4. Asset count by the scene's PACING: hold = 1 strong asset,
   normal = 2–3, dense = 3–5.
5. Match the era and place: archival for historical scenes, no modern
   stock under 1940s narration. Respect [CENSOR] scenes by preferring
   non-graphic angles.
6. Think about the scene's tags: a [DATE]/[MAP]/[STAT]/[SOURCE] card
   is generated automatically — your assets are the pictures BEHIND
   those cards, so pick visuals that leave room for them.
7. If you cannot find a real link for a scene, leave ASSETS empty and
   write a strong SEARCH INTENT + FALLBACK — the Footage Collector
   will hunt using those queries.
8. Output plain text only, exactly in the block format above.

Now here is the Editing Help Script:
<PASTE EDITING HELP SCRIPT HERE>
```

## 3. How this plugs into the Footage Collector (Tool #1)

The Collector reads this same file: for every `CLIP` it downloads and
cuts the given range; for every `IMAGE`/`DOC` it fetches; for scenes
with empty `ASSETS` it searches using `SEARCH INTENT` + `FALLBACK` and
drops results into `scene_<n>/` folders. DocuStudio then QCs everything
and the storyboard shows exactly which scene got which asset — weak
scenes are flagged for you to swap before render.
