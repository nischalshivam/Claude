# ProStudio — automatic documentary video editor

Scene folders (from the Footage Collector) + narration audio → finished
ready-to-upload **16:9 4K MP4**, edited like a pro human editor.

## Quick start (Windows)
1. `setup.bat` (once)
2. `run.bat` → GUI opens with ONE video card:
   - Scenes folder (scene_001, scene_002, …)
   - Narration audio (one mp3 for the whole video)
   - Optional clean script (.txt)
   - **Optional visual-editor file** (.txt/.md) — your per-scene plan;
     overrides scene narration and pins exact on-screen text (see below)
   - Format (Auto-Rotate / Random / F1..F10), Language, Niche,
     Keyword-colors toggle
   - **+ Add Video** → queue up to 15 videos (overnight bulk)
3. **Start Queue** → a live **% progress bar** shows each stage
   (footage check → audio sync → shot plan → render → compositing);
   videos land in the output folder with a report each.

## Visual-editor file (optional per-scene guide)
Give the tool your own editing sheet and it follows it. Plain text, one
block per scene — labels are flexible:
```
Scene 1
NARRATION / TEXT: Tony arrived in Miami in 1980 with nothing.
ON-SCREEN TEXT: 1980 — MIAMI

Scene 2
Script Cue: He built an empire on fear.
On-Screen Text: THE EMPIRE
```
- `NARRATION` / `Script Cue` / `Narration` → overrides that scene's narration.
- `ON-SCREEN TEXT` → the exact words to show on screen for that scene
  (guaranteed to appear; `none` = let the tool auto-pick). Ignored if
  on-screen text is turned OFF.

## On-screen text (per-video toggle)
- **On-screen text: ON** — text synced to the narration. With `faster-whisper`
  installed you get **word-perfect** sync (text lands on the spoken word);
  without it, a silence-based fallback (~90%).
- **On-screen text: OFF** — clean footage, no text (add it later in an editor).

## Languages
- **Any language's audio + footage works** for the video itself.
- **Text ON** works out of the box for **Latin-script languages** (English,
  French, German, Spanish, Italian, Portuguese, Polish, Czech, Hungarian,
  Dutch — accents included). Whisper syncs 90+ languages.
- **Non-Latin scripts** (Hindi/Devanagari, Arabic, Chinese, …) need a matching
  font: set `PS_FONT_SANS` / `PS_FONT_SERIF` / `PS_FONT_MONO` to a Unicode TTF
  (the tool warns you). Or just turn text OFF for those.

## What it does automatically
- rejects junk media (black / blurry / duplicate / low-res)
- syncs every cut and every text to the real narration timing
- clips 2-5s carry the story; images 3-7s with Ken Burns + human camera drift
- J/L cuts, punch-ins, sentiment color grade per scene mood
- text: dense first minute, then crucial moments only (names/numbers/danger
  words highlighted), always inside the frame, never overlapping
- 10 distinct formats so bulk videos never look repeated

## CLI (same engine)
```
python prostudio.py --scenes DIR --audio narration.mp3 --out video.mp4 \
    --format F2 --niche "Movie Essay" --language en --resolution 4K
python prostudio.py --queue jobs.json
```

Docs for future changes: `HANDOFF/`.
