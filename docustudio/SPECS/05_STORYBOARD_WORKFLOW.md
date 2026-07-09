# SPEC 05 — Storyboard approval workflow (before render)

The storyboard is the tool's replacement for the failed Filmora-export
idea: instead of handing an editable project to another app, DocuStudio
shows its FULL edit plan in the browser **before** spending render
hours, and lets the owner fix anything scene-by-scene.

## The flow, step by step

```
inputs → [processing 20–60 min] → STORYBOARD opens → you review/fix
      → APPROVE → [render, hours] → final MP4 + quality report
      → watch it → re-render single scenes if needed → done
```

### 1. Start
GUI: pick the 5 input files + assets folder, genre pack, resolution
(1080p/4K), toggles. Press **Prepare Storyboard**. The tool parses,
downloads/cuts assets, QCs them, whisper-aligns the VO, and builds the
full edit plan. A progress bar shows each stage. No rendering yet.

### 2. Storyboard opens (local page in the browser)
Top bar — the whole video at a glance:
- **Pacing graph**: scene lengths across the runtime (spikes = dense,
  plateaus = holds) so a 40-min video's rhythm is visible in one look.
- **Music/mood curve**: which mood plays when, where silences fall.
- **Coverage meter**: % of scenes with strong assets, # of flagged scenes.
- Chapter markers (from `[CHAPTER]` tags).

Below — one **card per scene**, in order. Each card shows:
- Scene number, start–end time, duration, MOOD, PACING.
- The narration lines of that scene.
- Thumbnails of the chosen visuals **in playback order**, each with its
  dwell time and motion (zoom-in / drift / hold / split-screen).
- Chips for every generated element: `DATE CARD: July 31 1999`,
  `SOURCE: Ozark Police Report`, `TEXT: ENGINE STILL WARM`,
  `SFX: sub_drop`, `SILENCE 1.2s` — each toggleable.
- ⚠ warnings when something needs eyes: *asset QC-weak*, *no asset
  found (using fallback)*, *timestamp missing — auto-picked segment*,
  *possible censor region*.

### 3. What you can do on a card
| Action | How |
|--------|-----|
| Reorder visuals | drag thumbnails |
| Replace a visual | pick from the scene's unused pool, or paste a new link (+ timestamp) — tool fetches it in the background |
| Trim/retime | edit a visual's dwell seconds |
| Edit on-screen text | click the TEXT chip, type |
| Kill/add an element | toggle any chip (date card, source label, sting…) |
| Change feel | switch the scene's MOOD or PACING — plan regenerates for that scene only |
| Mark censor | draw/confirm blur regions on a thumbnail |
| Regenerate | "re-plan this scene" button = new variation |

A filter button shows **only flagged scenes** — on a 100-scene video you
review the 8–12 that need attention instead of scrolling everything.

### 4. Approve → render
**Approve & Render** locks the plan and starts the full render
(overnight is fine). Output: final MP4 + a quality report
(pacing stats, credibility coverage, text density, which scenes used
fallback assets).

### 5. After watching the final video
Storyboard stays available. Fix scene 34 → change it on its card →
**Re-render scene** → the tool re-renders ONLY that scene and stitches
it back into the MP4 in minutes. No full re-render ever needed for
small fixes.

### 6. Bulk queue mode
Per video, choose: `review storyboard first` (default) or
`auto-approve` (tool renders straight through — for topics you trust).
Queued videos prepare storyboards one after another; you can approve
video 1's board while video 2 is still downloading assets.

## Why this beats a Filmora hand-off
- Nothing to import into third-party software — no format to break.
- Review happens BEFORE the expensive render, not after.
- Every fix stays inside the tool, so re-render is scene-level and fast.
- The storyboard doubles as the project archive: reopen any old video's
  board and re-render with changes anytime.
