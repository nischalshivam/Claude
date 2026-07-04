# ProStudio — automatic documentary video editor

Scene folders (from the Footage Collector) + narration audio → finished
ready-to-upload **16:9 4K MP4**, edited like a pro human editor.

## Quick start (Windows)
1. `setup.bat` (once)
2. `run.bat` → GUI opens with ONE video card:
   - Scenes folder (scene_001, scene_002, …)
   - Narration audio (one mp3 for the whole video)
   - Optional clean script (.txt)
   - Format (Auto-Rotate / Random / F1..F10), Language, Niche,
     Keyword-colors toggle
   - **+ Add Video** → queue up to 15 videos (overnight bulk)
3. **Start Queue** → videos land in the output folder with a report each.

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
