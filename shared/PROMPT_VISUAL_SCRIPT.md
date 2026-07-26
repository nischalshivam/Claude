# The visual-script prompt

Give this to Genspark / ChatGPT / Claude along with the clean narration script.

It is written against measured failures of the previous version, tested on a
real 71-beat script:

| Problem measured | Fixed by |
|---|---|
| Planned 47% of the video's length | a duration budget the model must satisfy |
| 16 images for a video needing ~108 | images requested per beat, proportional to narration |
| `nearest_dialogue` filled on 2 of 97 silent shots | made mandatory, with the reason stated |
| 92% of shots unanchored | every beat must carry at least one locatable line |
| No way to tell a clip request from a still request | `kind` on every shot |

---

## The prompt

````
You are a visual researcher for a documentary-style video essay. I will give
you a CLEAN NARRATION SCRIPT. You will return a VISUAL SCRIPT as JSON.

## What you can and cannot know

You have NO access to any video, and you cannot watch anything. Never output a
URL, a video ID, or a timestamp — you would have to invent them, and a tool
downstream would then cut the wrong footage and no one would know why.

What you CAN know, and what I need from you:
  - which film or series a moment belongs to
  - roughly which season and episode
  - what is happening on screen
  - what is being SAID at or near that moment

That last one is the most valuable thing in this entire document. A downstream
tool searches the real subtitle files of the real episodes. One quoted line
gives it an exact millisecond. Everything else is guesswork by comparison.

## The duration budget — do this arithmetic first

1. Count the words in the narration script.
2. Spoken length in seconds = words / 150 * 60.
3. Every beat's visuals must cover its own narration. A beat whose narration
   takes 12 seconds to say needs 12 seconds of visuals — for example two 4 s
   clips and one 4 s still.
4. At the end, state the totals and confirm they match.

A visual script that covers half the narration is not half-finished. It is
unusable, because the other half of the video will have nothing on screen.

## The image / clip split

Aim for roughly 55% of screen time on STILLS and 45% on CLIPS.
  - a still holds for about 5 seconds
  - a clip runs 3 to 5 seconds, never longer

So a 12-second beat is typically: one clip (4 s) + one still (5 s) + one clip
(3 s). Write them out individually. Do not write one 12-second shot.

You do not need to describe a hundred separate images. Where several stills
come from the same moment of the same scene, say so with `count` — the tool
extracts that many distinct frames from it.

## Pace

Match the pace to the writing:
  - argument, analysis, setup  ->  4-6 second visuals, calmer
  - a list, a montage, a turn  ->  2-3 second visuals, rapid
  - one dramatic beat          ->  a single held 6-8 second clip

## OUTPUT — valid JSON only, no commentary

[
  {
    "beat": 1,
    "header": "SHORT ALL-CAPS LABEL",
    "narration": "<the exact sentence(s) from my script>",
    "narration_seconds": 12,
    "shots": [
      {
        "kind": "clip",
        "source": "Breaking Bad",
        "season_episode": "S04E01",
        "se_confidence": "high",

        "exact_dialogue": "Well? Get back to work.",
        "speaker": "Gus Fring",
        "dialogue_confidence": "high",

        "nearest_dialogue": "",
        "nearest_dialogue_position": "",

        "visual": "Gus, apron bloodied, delivers the line to Walt and Jesse.",
        "characters": ["Gus Fring", "Walter White", "Jesse Pinkman"],
        "setting": "underground superlab, fluorescent light",
        "must_not_have": ["talking head commentary", "burned-in subtitles",
                          "reaction cam", "fan art"],
        "duration_target_sec": 4
      },
      {
        "kind": "still",
        "count": 2,
        "source": "Breaking Bad",
        "season_episode": "S04E01",
        "nearest_dialogue": "Well? Get back to work.",
        "nearest_dialogue_position": "before",
        "visual": "Close on the bloodied apron and the box cutter.",
        "duration_target_sec": 5
      }
    ],
    "images": [
      {
        "subject": "Giancarlo Esposito, formal press portrait",
        "type": "real_world"
      }
    ]
  }
]

## Field rules

**kind** — "clip" for moving footage, "still" for a held frame. Every shot
needs one.

**count** — stills only. How many distinct frames to take from that moment.
Use it instead of repeating near-identical entries.

**exact_dialogue** — the line spoken during this shot, word for word.

**nearest_dialogue** — REQUIRED whenever exact_dialogue is empty. The closest
line before or after, and which side it is on.

  Leaving both empty is the single most damaging thing you can do. A silent
  shot with a nearby quoted line can still be found — the tool locates the
  line and walks outward. A silent shot with nothing quoted anywhere near it
  cannot be found at all.

  Silent scenes are exactly where this matters. If a whole sequence has no
  dialogue, quote the last line before it starts and the first line after it
  ends, and attach those to the first and last shots of the sequence. Two
  lines will place a dozen silent shots between them.

  **Every beat must end up with at least one quoted line somewhere in it.**

**season_episode** — "S04E01", or "unknown". Never invent one; set
se_confidence to "high", "guess" or "unknown" and let the tool verify.

**source** — the exact title, every time. No abbreviations. When a character
appears across several titles (Saul Goodman in both Breaking Bad and Better
Call Saul), say which title each individual shot comes from.

**Order matters.** Within a stretch of shots from the same scene, list them in
the order they happen on screen. The tool uses that order to place the silent
shots between the quoted ones. Do not reorder a scene for narrative effect.

**images / type** — "from_source" (a frame of the film itself), "real_world"
(an actor, writer, place, event — fetched from Wikimedia) or "stock" (generic
b-roll). Never give a URL.

## Before you finish

Append one final JSON object:

{
  "summary": {
    "narration_words": 0,
    "narration_seconds": 0,
    "visual_seconds_planned": 0,
    "coverage_percent": 0,
    "beats": 0,
    "clips": 0,
    "stills": 0,
    "beats_without_any_quoted_line": 0
  }
}

If coverage_percent is below 95, or beats_without_any_quoted_line is above 0,
go back and fix it before answering.

Now here is my script:
````

---

## Checking what comes back

```
mi.bat sources  script.json --db library.db     which titles are needed
mi.bat align    script.json --db library.db     how many shots can be placed
```

`beats_without_any_quoted_line` should be 0, and `coverage_percent` at least
95. Those two numbers decide whether the rest of the pipeline has anything to
work with.
