# SPEC 02 — Editing Help Script (format + generation prompt)

The Editing Help Script is the clean narration script **annotated** with
scene breaks and bracket tags. It tells the tool WHAT matters on every
line: dates, on-screen texts, sources, holds, reveals, censoring.

**GOLDEN RULE:** the narration text stays word-for-word identical to the
clean script (and therefore to the voiceover). Whisper alignment depends
on it. Nothing is rewritten — only structure and tags are ADDED.

---

## 1. File format

Plain text (`.txt`). One block per scene:

```
=== SCENE 12 ===
MOOD: tension
PACING: normal

On the evening of July 31st, 1999, Tracy left her home in Dothan.
[DATE: July 31, 1999] [MAP: Dothan, Alabama]
Her black Mazda was found on Herring Avenue, the engine still warm.
[TEXT: ENGINE STILL WARM]
Police found no sign of struggle. [SOURCE: Ozark Police Report] [HOLD]
```

### Scene header
- `=== SCENE <n> ===` — numbers are sequential and **must match the
  Visual Help File** scene numbers.
- `MOOD:` one of: `neutral, curious, tension, dark, tragic, emotional,
  hopeful, triumphant, action, epic, calm, nostalgic, mystery`
  → drives music selection + color grade.
- `PACING:` one of:
  - `hold` — heavy moment; long dwells, slow zoom, room to breathe
  - `normal` — default documentary rhythm
  - `dense` — information-heavy; visuals rotate faster inside the scene

### Tags (inline, placed right AFTER the line they belong to)

| Tag | Meaning | Tool behavior |
|-----|---------|---------------|
| `[TEXT: ...]` | Words to show on screen (max ~6 words) | Kinetic text synced to the spoken word |
| `[DATE: ...]` | A date mentioned | Genre-styled date card |
| `[MAP: place]` | Location change | Map card with pin/zoom |
| `[STAT: value — label]` | Statistic | Stat panel (uses data file if present) |
| `[SOURCE: ...]` | Fact/claim origin | Small credibility label (corner) |
| `[NAME: person — role]` | Person introduced | Lower-third when their photo shows |
| `[QUOTE: ...]` | Spoken/written quote | Quote card with attribution |
| `[CHAPTER: title]` | Act/chapter break (long videos) | Full-screen chapter card + music reset |
| `[HOLD]` | Let this moment sit | 8–15 s dwell, slow zoom, minimal cuts |
| `[SILENCE]` | Beat of quiet after the line | Music dips/stops 0.8–1.5 s |
| `[REVEAL]` | Twist/answer lands here | Build-up + sting + hold (silhouette/blur-reveal allowed) |
| `[CENSOR: what]` | Sensitive imagery in this scene | Blur that region/asset |
| `[EVIDENCE: item]` | Crime genre: pin to evidence board | Item appears on the board graphic |
| `[COMPARE: A vs B]` | Two things contrasted | Split-screen / comparison panel |
| `[TIMELINE: event]` | Event on a running timeline | Timeline graphic advances |

Labels are case-insensitive and forgiving (`[Text: ...]`, `[text ...]`
also parse). Unknown tags are logged, never fatal.

### Density rules (what makes it look pro, not cheap)
- `[TEXT]` — max 1 per scene, and only ~1 in every 3–4 scenes.
- `[HOLD]` — roughly 1 per 8–10 scenes, only on genuinely heavy lines.
- `[SOURCE]` — EVERY factual claim, quote, or statistic.
- `[DATE]` / `[MAP]` — every date mention and location change.
- `[CHAPTER]` — only for videos > 25 min; every 8–15 min of runtime.

---

## 2. Ready-made LLM prompt (copy-paste)

Give this prompt + your clean script to any LLM to generate the file:

```
You are a professional documentary edit-planner. Convert the clean
narration script below into an EDITING HELP SCRIPT for an automated
editing tool. Follow every rule exactly.

GOLDEN RULE: never rewrite, shorten, reorder, or "improve" the narration
text. Copy every sentence word-for-word. You only ADD scene breaks and
square-bracket tags.

STEP 1 — SPLIT INTO SCENES
- A scene = one story unit: one event, one idea, one location, or one
  step of the argument.
- Typical scene = 2–6 narration sentences (~15–30 seconds of speech).
- Target: a 30–40 min script → 80–120 scenes; a 1–2 hr script →
  150–250 scenes. Do NOT over-fragment; this is a documentary, not a
  shorts montage.

STEP 2 — SCENE HEADER (every scene)
=== SCENE <n> ===
MOOD: one of [neutral, curious, tension, dark, tragic, emotional,
hopeful, triumphant, action, epic, calm, nostalgic, mystery]
PACING: one of [hold, normal, dense]
(blank line, then the scene's narration lines)

STEP 3 — TAGS (place inline, immediately after the line they refer to)
[TEXT: ...]    on-screen words, max 6 words — only names, numbers,
               dates, or shocking phrases. Max 1 per scene, and only
               in about 1 of every 3–4 scenes.
[DATE: ...]    every explicit date mentioned.
[MAP: place]   every location change.
[STAT: value — label]   every statistic.
[SOURCE: ...]  every factual claim, quote, or statistic — name the
               most plausible source type (police report, newspaper,
               official records, archive footage, study).
[NAME: person — role]   first time a person is introduced.
[QUOTE: ...]   direct quotes.
[CHAPTER: title]   act breaks, only if script is >25 min; every
               8–15 minutes of runtime; short dramatic titles.
[HOLD]         after genuinely heavy lines (death, twist, tragedy,
               final quote). About 1 per 8–10 scenes maximum.
[SILENCE]      after a shocking reveal line where quiet hits harder.
[REVEAL]       on the line where a mystery/twist is answered.
[CENSOR: what] scenes that will show blood, bodies, graphic injury.
[EVIDENCE: item]   (crime only) items that belong on an evidence board.
[COMPARE: A vs B]  when two things are explicitly contrasted.
[TIMELINE: event]  when events form a running chronology.

OUTPUT: plain text only, exactly in the format of this example:

=== SCENE 12 ===
MOOD: tension
PACING: normal

On the evening of July 31st, 1999, Tracy left her home in Dothan.
[DATE: July 31, 1999] [MAP: Dothan, Alabama]
Her black Mazda was found on Herring Avenue, the engine still warm.
[TEXT: ENGINE STILL WARM]
Police found no sign of struggle. [SOURCE: Ozark Police Report] [HOLD]

Now here is the clean script:
<PASTE CLEAN SCRIPT HERE>
```
