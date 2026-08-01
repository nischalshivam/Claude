# Final Strategy — the one plan the tool is built around

Decided after measuring, not guessing. The gold benchmark showed the truth:
the Gus video (one long scene) came out **100% usable by the user's own
labels**; the Hank video (a "greatest hits" essay across 15 episodes) came
out ~15%. So the tool already works when it has a tight scene, and fails when
a beat is a brief reference with no dialogue and a wide window. Everything
below is aimed at that one gap, and at never shipping garbage in the meantime.

## The product promise

> Every video is watchable. Where the tool is sure, it places the exact
> clip. Where it is not, it places a clean still of the character or scene
> the narration is talking about — from the same movie. It never fills the
> timeline with wrong moving footage.

This is the user's Option 2, and it is what GPT's recovery strategy also
concludes. It works for every kind of essay the user makes:

- **"Why Jesse keeps choosing pain"** (one character across the whole
  series) → when the exact moment isn't found, a clean Jesse still keeps the
  right face on screen.
- **"The cruelest thing Walt ever said"** (one specific scene) → the quoted
  line anchors it exactly. Already works.
- **"Why Gus killed Victor"** (one long scene) → already 100% usable.

## The four-layer placement, per beat

Tried in order; the first that succeeds wins:

1. **Sure clip.** A line of dialogue from the beat is found in the local
   subtitles → the exact millisecond. **Works today.** (Tier A.)
2. **Located clip.** No line, but the character/scene is known → Gemini
   locates the exact moment inside the local movie by a **coarse→dense frame
   search** (wide sample to find the region, then a dense sample inside it).
   This fixes the "16 frames across 8 minutes miss the 2-second moment"
   problem. (Tier B.) *— to build (P2)*
3. **Character / scene still.** Exact moment not found, but the character IS
   known → Gemini picks a clean, sharp still of that character (or the
   location) from the local movie. A right face beats wrong motion. (Tier C
   — safe.) *— to build next (P1)*
4. **NEEDS VISUAL card.** Even the character is unknown → an editor card.
   Only here, and rarely.

## Where the pixels come from — decided

- **Local movie files ONLY.** Lawful, high quality, reproducible, and they
  contain exactly the scene the essay is about.
- **NOT YouTube / yt-dlp as the source.** GPT analysed this and rejected it,
  and this project agrees: YouTube search finds titles, not exact frames;
  competitor clips are cropped/subtitled/watermarked; copyright and API
  policy forbid downloading/re-cutting; famous clips repeat. YouTube stays
  **optional**, only ever to discover a scene's name or a licensed asset —
  never as the footage that ends up in the video.
- **Gemini API = the brain, not the source.** The user's key locates and
  verifies; the pixels always come from the local movie. A **browser-
  automation hack of the Gemini Pro website is explicitly not built** — it is
  fragile, breaks constantly, and violates terms. The proper API (already
  connected) does everything needed, including custom frame-rate and clipping
  video understanding.

## What makes a movie usable by the tool

One folder per title, containing:

- the movie file (`.mp4`, `.mkv`, `.avi`, `.mov`, …), and
- a subtitle file with the **same name** (`.srt`, `.vtt`, `.ass`).

Example:
```
D:\Movies\Joker (2019)\
    Joker (2019).mp4
    Joker (2019).srt
```

In the tool: **Library → Add title → paste that folder's path**. It reads
the subtitles (fast), then reads the frames for picture search (slow, one
time). After that every video about that movie uses it for free. Subtitles
are what make dialogue anchoring — the tool's strongest signal — work, so a
movie without an `.srt` will be much weaker.

## Build order (measured at each step against the gold set)

- **P1 — Character-still safety net (next).** Reuses the Gemini integration:
  for an unsure beat with a known character, Gemini picks a clean still of
  that character from the local movie instead of leaving wrong footage. This
  alone turns "10-15% usable" Hank-type videos into "watchable everywhere",
  which is the user's Option 2 and the biggest single improvement available.
- **P2 — Coarse→dense exact-clip location.** Gemini locates the exact moment
  inside a wide window in two passes, fixing the sparse-frame bottleneck.
- **P3 — Real face recognition.** Makes the still bank clean and reliable,
  and lets "required character present" become a hard filter.

Face-name captions today are not face recognition; that is P3, not a claim.

## How progress is proven from here

The gold set is the answer key. After each change the same labelled videos
are re-scored, so "better/worse" is a measured delta, never a guess. The
user never labels again — that was one-time, developer-side. Production
videos are fully automatic: script + clue in, video out.
