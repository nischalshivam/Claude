# media_index — the dialogue index

Turns a folder of owned movies / series into a searchable index of **every
spoken line**, so a quote from a script resolves to an exact file and
millisecond.

This is the foundation of the movie automation tool. It replaces the step that
is currently broken — asking an LLM for a YouTube link and timestamp, which it
cannot know and therefore invents.

> **The LLM says WHAT to look for. This module finds WHERE it is.**
> Every timestamp here comes from a real subtitle file. Nothing is guessed.

---

## Quick start

```bash
# 1. build the index (subtitles only — no video is decoded)
python -m media_index build "D:/Media" --db library.db

# 2. find a line
python -m media_index find "I never wanted the harvest" --db library.db

# 3. pre-flight a whole script before rendering anything
python -m media_index resolve script.json --db library.db --out report.json

# what is in the library
python -m media_index stats --db library.db
```

Try it with no media at all:

```bash
python -m media_index.demo.make_demo_library demo_media
python -m media_index build demo_media --db demo.db
python -m media_index resolve media_index/demo/demo_script.json --db demo.db
```

---

## Measured performance

A synthetic 73-episode series (8 seasons, ~800 lines per episode):

| | |
|---|---|
| Dialogue lines indexed | **59,200** |
| Index build time | **3.0 s** |
| `library.db` size | **9.4 MB** |
| Single search | **~150 ms** |

Building is incremental — a re-scan of unchanged files touches nothing, so
adding a new season costs seconds. **Indexing is one-time per file, not per
video project.**

## Dependencies

**None required.** `rapidfuzz` is used when installed and gives a faster, more
accurate fuzzy match; without it the module falls back to stdlib `difflib`.
The test suite passes on both paths. `ffmpeg` is optional and only needed to
pull subtitles embedded inside a video file.

---

## What it handles

Built and tested against the shapes real libraries actually have:

| Case | Handled |
|---|---|
| Release filenames (`Show.S01E02.1080p.WEB-DL.x265-GRP.mkv`) | ✅ |
| `2x01`, `Season 3 Episode 12`, title from folder | ✅ |
| Sidecar `.srt`, `.en.srt`, `Subs/<episode>/2_English.srt` | ✅ |
| `.ass` / `.ssa` / `.vtt` subtitles | ✅ |
| Embedded subtitle track (via ffmpeg) | ✅ |
| `<i>` tags, `{\an8}`, `SPEAKER:` labels, `[SOUND FX]`, `♪` | stripped |
| utf-8 / utf-8-sig / cp1252 / latin-1 encodings | ✅ |
| **A quote split across two or three cues** | ✅ — see below |
| Contractions (`doesn't` ≡ `does not`) | ✅ |
| The same line spoken in two episodes | flagged `ambiguous` |
| A file with no subtitles at all | reported, never silently skipped |

### The detail that makes it work

Subtitles break on reading speed, not on sentences:

```
285  00:14:31,220 --> 00:14:33,900   I am the Armored Titan
286  00:14:34,010 --> 00:14:36,480   and he is the Colossal Titan.
```

Matching cue-by-cue would fail on almost every real quote. Instead a window of
1–4 **consecutive** cues is merged and matched, and the tightest window that
scores well wins.

Two guards keep that honest:

- **`MAX_CUE_GAP_MS`** — cues that are consecutive by *index* may be minutes
  apart in *time*. Without this guard a merge produced a nine-minute "clip".
- **fragment retry** — if a long quote spans a pause too big to merge, the
  search retries with the leading fragment, which is what a human would do.

---

## Confidence, and why it matters

Every result carries a confidence band. This is the mechanism that lets the
pipeline run unattended:

| Band | Meaning | What the pipeline does |
|---|---|---|
| `high` | score ≥ 88 and ≥ 80% of the query's words present | use it |
| `medium` | score ≥ 72, ≥ 55% coverage | use it, but flag for review |
| `low` | below that | do not trust — fall back to visual search |

A misquoted line still finds the right moment but is **downgraded, not
accepted silently**. That is the whole point: the LLM is allowed to be wrong,
because being wrong is now visible.

## Batch pre-flight

`resolve` takes the JSON from the visual-script prompt and resolves every shot
before a single frame is rendered. Each shot lands in exactly one bucket:

| Status | Meaning |
|---|---|
| `resolved` | exact, unambiguous match |
| `ambiguous` | matched equally well in more than one place |
| `weak` | found, but the wording differs — verify |
| `not_found` | no dialogue match — needs visual search or is missing from the library |
| `no_query` | no dialogue supplied — goes to visual search |

The command exits non-zero when anything is `not_found`, so a queue runner can
refuse to start a render that would fail halfway through.

A wrong `season_episode` hint in the script does **not** override the library —
the real match wins and the disagreement is reported.

---

## Tests

```bash
cd shared && python -m unittest discover tests -v
```

30 tests, covering filename parsing, subtitle formats, contraction handling,
split-cue merging, the silence-gap regression, ambiguity, scoping, and every
`resolve` status. They run in under a second and need no media files.

## Not in scope (yet)

- **Subtitle sync verification** — a downloaded `.srt` can be timed for a
  different release. The `media.sub_offset_ms` column exists for the
  correction; the Whisper-based detector that fills it is the next piece.
- **Visual index** (shot detection + embeddings) for shots with no dialogue —
  that is Ladder 2, a separate module.
