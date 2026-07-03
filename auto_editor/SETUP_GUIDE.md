# AUTO EDITOR — Setup & Use (simple guide)

Turns your Footage Collector output + narration audio into a ready-to-polish
**Filmora project**. You do the last 10% in Filmora; this does the boring 90%.

## One-time setup (Windows)
1. Install Python 3.10+ (python.org) if you haven't (tool #1 already needed it).
2. Double-click **setup.bat**. It installs the Python packages and ffmpeg
   (it reuses the Footage Collector's ffmpeg if it finds it).

## Every video (normal use)
1. Run tool #1 (Footage Collector) → you get `output/scene_001/…` folders.
2. Get your narration audio as ONE file (mp3/wav) — the same script the
   instructor file was made from.
3. Double-click **run.bat** → the Auto Editor window opens:
   - **Footage folder** → the tool #1 `output` folder
   - **Narration audio** → your mp3
   - **Instructor file** → the same .txt you gave tool #1 (this is where
     narration text + On-Screen Text come from)
   - Leave template/transitions as they are (defaults match your Filmora)
   - Click **Preview plan** to see what it will do, then
     **Generate Filmora project**.
4. Double-click the created **.wfpbundle** → Filmora opens with everything
   arranged. Polish and export.

## Sync modes (how scenes match the audio)
- **Whisper (best)** — the tool listens to your narration and finds where each
  scene's words are spoken. First run downloads a small model (needs internet
  once).
- **By word count** — no listening; splits time by how long each scene's text
  is. Good backup, works offline.
- **Fixed** — no audio needed; every scene gets N seconds (quick preview).

## If something breaks
- "ffprobe missing" → run setup.bat again.
- Whisper fails/downloads blocked → the tool automatically falls back to
  "By word count"; the project still generates.
- Filmora won't open the file after a Filmora UPDATE → see
  `HANDOFF/README.md` ("the sample project") — 5-minute fix.

## Command line (optional, same engine as the GUI)
```
python auto_editor.py --footage "C:\...\output" --audio narration.mp3 ^
    --instructor my_video.txt --title "My Video" --out MyVideo.wfpbundle
```
Add `--dry-run` to only print the plan. `python auto_editor.py -h` for all options.
