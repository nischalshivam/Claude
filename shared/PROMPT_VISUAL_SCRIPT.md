# The visual-script prompt

Give this to Genspark / ChatGPT / Claude along with the clean narration script.

Every rule below is here because of something measured on a real 71-beat
script run against a real 62-episode library — not because it sounded sensible.

| Measured | Rule it produced |
|---|---|
| 106 shots, 5 quoted lines, **1** of them found in the subtitles | one **verbatim** line per 10 shots |
| the other 4 were paraphrases | verbatim or nothing — never approximate |
| the closing line was also quoted at shot 1 as a hook, which pinned the end of the scene to the start of the run and put the whole sequence four minutes late | a hook quote is marked, not ordered |
| 70 shots hung off 1 anchor, so shot 1 sat 221 s from the only known point | anchors spread through the run, not clustered |
| 12 shots in runs that quoted nothing anywhere | every run needs a line |
| planned 47% of the video's length | a duration budget |
| "real-world press photo" searched for as if it were a film | `type` decides where an image comes from |

---

## The prompt

````
You are a visual researcher for a documentary-style video essay. I will give
you a CLEAN NARRATION SCRIPT. You will return a VISUAL SCRIPT as JSON.

## What happens to your answer

A tool takes it and searches the real subtitle files of the real episodes. A
line you quote word for word becomes an exact millisecond. Every other shot is
placed by counting outwards from those lines.

So the quoted lines are not decoration. They are the only fixed points in the
whole document. A shot near one is right for the same reason a shot far from
one is a guess.

You have NO access to any video. Never output a URL, a video ID, or a
timestamp — you would have to invent them, and the tool would cut the wrong
footage with nothing to reveal the mistake.

## RULE 1 — one verbatim line every ten shots

Within any stretch of shots from the same episode, at least one shot in every
ten must carry `exact_dialogue` quoted word for word as it is spoken.

Word for word means word for word. "Whatever it is you think I've done, you
have to let me explain" does not match a subtitle reading "Look, whatever you
think I did, let me explain." A near-miss finds nothing, and is worse than an
empty field, because an empty field is honest.

If you cannot recall a line exactly, leave `exact_dialogue` empty and quote a
DIFFERENT line in the same stretch that you do remember exactly. Short lines
are fine. Five plain words really said beat a fine sentence that was not.

Spread them. A line at shot 1 and nothing after gives that run one fixed
point. One near the start, one near the middle and one near the end gives it
a shape that cannot drift.

## RULE 2 — a hook quote is not part of the scene

Essays open by quoting the ending. That is good writing, and it breaks the
tool, because the tool reads your order as the scene's order — the closing
line placed at shot 1 says the scene ENDS where it BEGINS, and the whole
sequence lands minutes late.

When you quote a line before the moment it belongs to, set:

    "hook": true

Keep the quote. It will be used for the picture and ignored for the ordering.

## RULE 3 — order is the scene's order, never the essay's

Within one episode, list shots in the order they happen ON SCREEN. If the
narration doubles back, name the episode again later in the file rather than
moving a shot out of sequence.

## RULE 4 — every beat gets something, including the abstract ones

Some narration has no obvious picture: "most people read this as rage", "he
had already decided". Do not skip these, and do not invent a shot.

Use the nearest CONCRETE thing the sentence is about, in this order:

  1. the face of the person the sentence is about, in that scene
  2. the object the sentence turns on — the box cutter, the phone, the door
  3. the room itself, wide or empty
  4. another shot from the same scene carrying the same feeling

Say which you chose, plainly, in `visual`: "Gus's face, held, while the
narration argues about his motive." A held face under an argument is what a
real editor cuts, and it is always available.

## RULE 5 — the duration budget

1. Count the words in the narration.
2. Spoken seconds = words / 150 * 60.
3. Every beat's visuals must cover its own narration.
4. State the totals at the end and confirm they match.

A visual script covering half the narration is not half-finished. It is
unusable — the other half of the video has nothing on screen.

## Shot length and the image split

Roughly 55% of screen time on STILLS, 45% on CLIPS.
  - a still holds for about 5 seconds
  - a clip runs 3 to 5 seconds, never longer

A 12-second beat is one clip (4 s) + one still (5 s) + one clip (3 s). Write
them separately. Never one 12-second shot.

Where several stills come from the same moment, use `count` instead of
repeating near-identical entries.

## Pace

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
        "hook": true,

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

**kind** — "clip" for moving footage, "still" for a held frame. Required.

**count** — stills only. How many distinct frames to take from that moment.

**exact_dialogue** — spoken during this shot, word for word, or empty.

**hook** — true when the line is quoted out of sequence (Rule 2).

**nearest_dialogue** — REQUIRED whenever exact_dialogue is empty. The closest
line before or after, word for word, and which side it falls on.

  A silent shot with a nearby quoted line can still be found — the tool
  locates the line and walks outward. A silent shot with nothing quoted
  anywhere near it cannot be found at all.

  If a whole sequence is silent, quote the last line before it and the first
  line after it and attach those to the first and last shots. Two lines will
  place a dozen silent shots between them.

**season_episode** — "S04E01", or "unknown". Never invent one; set
se_confidence to "high", "guess" or "unknown" and let the tool verify.

**source** — the exact title, every time, no abbreviations. When a character
appears across several titles, say which title each individual shot is from.

**duration_target_sec** — how long the finished CLIP runs, not how long the
moment lasts on screen.

**images / type** — "from_source" (a frame of the film, and then `source` must
be the film's real title), "real_world" (an actor, writer, place, event) or
"stock". Never give a URL, and never put a description where a title goes:
`"source": "real-world press photo"` is not a film, and will be searched for
in a library of films.

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
    "verbatim_lines": 0,
    "longest_gap_between_verbatim_lines": 0,
    "runs_without_any_verbatim_line": 0
  }
}

Fix and re-answer if any of these is true:
  - coverage_percent below 95
  - longest_gap_between_verbatim_lines above 10
  - runs_without_any_verbatim_line above 0

Now here is my script:
````

---

## Reading what comes back

```
mi.bat sources  script.json --db library.db     which titles are needed
mi.bat align    script.json --db library.db     how many shots can be placed
```

Then build it, and read the run lines:

```
Breaking Bad S04E01: 70 shot(s), 1 anchor(s), span 2010s-2264s
  only one line matched, at shot 62 of 70...
```

**The anchor count is the number that matters.** One anchor in a run of
seventy means every other shot in it is arithmetic, and shot 1 sits 221
seconds from the only thing actually known. Seven anchors across the same
seventy shots means no shot is ever more than a few seconds of guesswork from
a fixed point.

Coverage is not accuracy. 89% placed with one anchor is 89% of the shots
sharing one guess.
