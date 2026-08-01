# Research-First Clip Tool

Anime / cartoon / documentary video-essays ke liye **research-first, local-first**
clip automation. Ek **Scene Research Pack** (source + dialogue clue) se exact clips
cut karke narration ke sath align karta hai — aur galat/doubtful clip lagane ke
bajaye `NEEDS_SOURCE`/fallback deta hai.

> Ye Avatar Automation se **alag** tool hai. Avatar generic B-roll match karta hai;
> ye **exact scene** match karta hai (dialogue se timestamp khud nikaal kar).

## Milestone 1 (abhi ye bana hai) — deterministic core, koi Gemini nahi

Kaam karta hai bina kisi API key ke:

- Setup check (node / ffmpeg / ffprobe / yt-dlp)
- `scene-research-pack-v1` JSON validation
- Narration (SRT) alignment — har moment ka time-window
- **EXACT_TIME** locator (bounds/metadata check ke sath)
- **DIALOGUE** locator — source ke asli captions se **fuzzy-match karke exact second** (M1 ka accuracy core)
- `yt-dlp` se sirf zaroori range download (+ local file source support)
- Frame-accurate FFmpeg cut — **video length = moment ka `preferred_clip_sec` (normally 3-9s)**, source audio **mute**
- Beat-driven timeline (poori narration tile) — gap/fail par honest text/`NEEDS_SOURCE` card, **random footage kabhi nahi**
- Continuous master voiceover render (video length = audio length)
- `quality-report.html` (self-contained) + `NEEDS_SOURCE.csv`
- Checkpoint / resume

**Milestone 2 (baad mein):** local Whisper ASR, `APPROX_WINDOW`, Gemini short-clip
verification, reaction/facecam/logo rejection, alternate candidate loop, still/graphic
fallbacks, chhota UI.

## Requirements (Windows)

- Node.js 18+ (20/22 recommended)
- FFmpeg + FFprobe (PATH mein, ya `config.json > tools`)
- yt-dlp (`yt-dlp.exe` PATH mein) — **latest version rakho**
- **JS runtime for yt-dlp YouTube:** yt-dlp ko ab YouTube ke liye ek JS runtime
  chahiye (nsig/PO-token challenge). **Deno** recommended (Bun/Node bhi). Bina iske
  kuch YouTube sources/subtitles `403` de sakte hain — tab tool alternate try karta hai.
  Ref: https://github.com/yt-dlp/yt-dlp/wiki/EJS · https://github.com/yt-dlp/yt-dlp/wiki/Po-Token-Guide

`CHECK.bat` chala kar confirm karo (ye JS runtime bhi check karta hai).

## Use

`input/` mein rakho:

```
input/scene-research.json   (zaroori — Genspark/Gemini Pro se; prompts/ dekho)
input/voiceover.srt         (zaroori — narration timing)
input/voiceover.mp3         (render ke liye)
input/script.txt            (optional)
```

Phir:

```
START.bat
```

Output `jobs/<project>/` mein: `final.mp4`, `timeline.json`, `quality-report.html`,
`NEEDS_SOURCE.csv`, `clips/`.

### CLI

```
node src/run.js                     poori pipeline
node src/run.js --only=check        sirf setup check
node src/run.js --from=7            stage 7 se aage (resume)
node src/run.js --redo              sab dobara (job dir clean)
node src/run.js --input=<dir> --job=<id>
```

## Accuracy kaise aati hai (M1)

1. **Timestamp guess nahi** — DIALOGUE moments mein tool khud asli caption se second nikalta hai.
2. **EXACT_TIME bhi blindly trust nahi** — bounds/metadata/QA pass zaroori.
3. **Doubtful ko force nahi** — verify na ho to `NEEDS_SOURCE`/fallback. Precision isi "na" se banti hai.
4. **Clip length preferred_clip_sec (3-9s), source muted, master VO continuous** — clean edit; har faisla report mein.

## Test

```
npm run test:mini
```

Synthetic "episode" videos (color-coded time regions) + subtitle tracks se poori
pipeline offline chalti hai (YouTube ke bina). 10 moments: EXACT_TIME, DIALOGUE,
repeated source, dead-source→alternate recovery, unresolved→NEEDS_SOURCE, cross-show.
Har cut sahi region par landa — color se verify hota hai.
