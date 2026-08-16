# Source-Media Pipeline — exact scene clipping for movie / series / anime essays

**Question being answered:** should the collector keep scraping YouTube for
movie and series footage, or should the user download the full films / seasons
and let the tool cut from those?

**Answer: own the source and index it.** YouTube stays only as a fallback for
material that cannot be owned. The reasoning, the evidence, and the full system
design are below.

This supersedes the YouTube-first assumption in `FOOTAGE_RELEVANCE_UPGRADE.md`
for the *movie / series / anime* niches. The verification layer described in
that document still applies on top of everything here.

---

## 1. Evidence: why the current system cannot work

Measured on a real visual-editor file produced by the current Genspark/ChatGPT
prompt (`The_Anime_Villains_You_Were_Supposed_to_Hate_But_Couldnt_DATA.txt`,
52 scenes).

### 1.1 The timestamps are fabricated — this is the root cause

| Metric | Value |
|---|---|
| `Clip Links` entries | 51 |
| Unique YouTube video IDs | 33 |
| Timestamps that are a multiple of 5 | **50 of 51** |
| Only exception | `t=8` |

Observed values: `5, 8, 10, 15, 20, 30, 40, 45, 55, 60, 90, 95, 105, 120, 130,
150, 180, 200, 210, 220, 280`. Not a single `t=147` or `t=283`.

Anyone who had actually watched a video and noted where a moment occurs would
produce arbitrary numbers. A run of 50 consecutive multiples of five has a
chance of roughly `(1/5)^50` of occurring naturally. **These timestamps were
not observed; they were invented.**

The cause is structural, not a bad prompt: **an LLM cannot watch YouTube.** It
has no way to know what is at second 90 of a given video ID. Asked for a link
plus a timestamp, it must fabricate one. So the collector is being handed
coordinates that point nowhere, and then blamed for returning irrelevant
footage. It is faithfully downloading exactly what it was told to download.

Corroborating pattern: one video ID (`bur2NVw0w_8`) is cited as containing the
Nagato reveal (t=10), Jiraiya teaching the Ame orphans (t=130), young Nagato
with Yahiko (t=180) *and* Jiraiya's death (t=220) — four distinct scenes at
tidy round offsets inside one clip. That is a model laying out a plausible
shape, not reading a real video.

### 1.2 Composite shots are given a single link

8 of 52 scenes ask for a montage, split-screen, cross-cut or portrait lineup —
"rapid cuts of Pain descending on Konoha, Scar walking rain-soaked streets,
Reiner in uniform, Stain licking his blade, Meruem hatching" — and supply
**one** clip link for all five. No single video contains those five moments.
These scenes can never be satisfied as specified.

Fix: a scene must emit an **array of shots**, each independently locatable.

### 1.3 The most valuable field is mostly empty

`Spoken Line` is filled in only **15 of 52** scenes; 37 are blank. As section 3
shows, this field is the single most reliable way to locate a scene — and the
prompt is leaving it empty 71% of the time.

Only 2 scenes name a season or episode.

---

## 2. Own the source — the case, honestly

### Why local source media beats YouTube for these niches

| | YouTube scrape | Owned source file |
|---|---|---|
| Locating a scene | Hallucinated timestamps | Frame-exact via subtitles |
| Quality | Re-encoded re-upload, often 2nd/3rd generation | Original 1080p/4K |
| Watermarks / overlays | Channel logos, reaction cams, burned-in subs | None |
| Anti-copyright edits | Mirrored, zoomed, sped up, pitch-shifted | Untouched |
| Availability | Re-uploads get taken down mid-project | Permanent |
| Repeatability | Same query → different result next month | Deterministic forever |
| Cost per reuse | Re-scrape every video | Index once, reuse forever |

For a channel that covers the same franchises repeatedly, indexing *Breaking
Bad* once serves every future Breaking Bad video. That is the compounding
advantage YouTube scraping can never have.

### Practical cost

| Item | Size |
|---|---|
| Game of Thrones, 8 seasons, 73 eps @1080p x265 | ~150–250 GB |
| Breaking Bad, 62 eps @1080p | ~100–150 GB |
| A feature film @1080p | ~2–8 GB |
| **Index** per 45-min episode (embeddings + metadata) | **~2 MB** |

A 4 TB external drive holds roughly 20 full series. Storage is not the
constraint — the index is what matters, and it is tiny.

Keep **480p proxy copies** for analysis and preview, and cut the final clip
from the original file. Analysis then runs several times faster and the export
stays full quality.

### Legal note, stated once

Acquiring films or series from unlicensed sources is copyright infringement in
most jurisdictions, and that is a separate question from whether the finished
commentary video is fair use — the essay format generally is, the acquisition
generally is not. Lawful routes to the same architecture: rip discs the user
owns, use licensed clip/stock services, or use footage whose licence permits
it. The pipeline design below is identical regardless of how the files were
obtained; the sourcing decision is the user's.

---

## 3. The system: dialogue locates, vision selects

Downloading the seasons alone changes nothing — the tool would hold 60 hours of
video and no way to find 4 seconds in it. **The index is the product.**

The core idea, and the reason this reaches accuracy YouTube scraping cannot:

> **Dialogue is a coarse locator: it narrows 60 hours to 10 seconds.**
> **Vision is a fine selector: it narrows 10 seconds to the right 4.**

Neither is sufficient alone. Together they are near-exact.

### 3.1 Ingest (one time per file)

```
episode.mkv
   ├─ subtitles (embedded track, or OpenSubtitles .srt)
   │     → dialogue index: every line + start/end ms + character
   ├─ PySceneDetect ContentDetector
   │     → shot list with in/out points  (~600–1000 shots per 45-min episode)
   ├─ keyframe per shot
   │     ├─ SigLIP / OpenCLIP embedding        → vector index
   │     ├─ VLM caption (one line per shot)    → text index
   │     └─ character recognition              → who is on screen
   └─ 480p proxy for analysis + preview
```

Store in SQLite (metadata) + LanceDB (vectors). One row per shot:

```jsonc
{ "title": "Attack on Titan", "season": 2, "episode": 6,
  "shot_id": 412, "start": 872.4, "end": 878.1,
  "caption": "Two young men in uniform sit on a windy grassy hill in daylight, talking",
  "characters": ["Reiner Braun", "Bertholdt Hoover", "Eren Yeager"],
  "dialogue": "I am the Armored Titan and he is the Colossal Titan",
  "has_text_overlay": false, "motion": 0.12, "resolution": "1920x1080" }
```

Ingest cost: shot detection ~5–10× realtime on CPU at reduced resolution;
embeddings on one keyframe per shot ≈ 1–2 min per episode on a GPU. A full
season indexes overnight, once, forever.

### 3.2 Retrieval — three ladders, highest confidence first

**Ladder 1 — dialogue match (~99% when the line is correct)**

`Spoken Line: "I am the Armored Titan and he is the Colossal Titan"`
→ fuzzy search (rapidfuzz, threshold ~85) over the dialogue index
→ exact hit: S02E06 @ 872.4s
→ take the shots overlapping `[start − 2.0s, end + 1.5s]`
→ let vision pick which of those shots matches the visual description
→ cut on shot boundaries.

Deterministic. No hallucination is possible, because the ground truth is the
subtitle file, not a model's memory.

**Ladder 2 — episode-scoped visual search (~90%)**

For silent scenes ("Meruem hatches", "Konoha in ruins"):
resolve the episode first (see 3.3), then embed the
`Visual / Exact Clip to Use` description and vector-search **only that
episode's shots**, filtered by `characters` and `has_text_overlay`. Verify the
top 5 with a VLM contact sheet as per `FOOTAGE_RELEVANCE_UPGRADE.md` §4.

Scoping to one 24-minute episode instead of 100 hours is what makes this
accurate — the search space shrinks by three orders of magnitude.

**Ladder 3 — whole-library visual search (~80%)**

Episode unknown: search the whole franchise index. Always VLM-verified.
Lowest confidence, so route these to the human approval grid first.

Only if all three fail does the collector fall back to a YouTube search — and
that result goes through full visual verification before it is allowed in.

### 3.3 Resolving which episode a scene is in

Two cheap methods, use both:

1. **Subtitle-only pre-pass.** Subtitle files for a whole series are a few MB
   of text. Build the dialogue index from subtitles *before* touching video.
   Any scene with dialogue resolves to an exact episode + timestamp instantly,
   and only the episodes actually needed get indexed for video. This is the
   fastest possible route from script to clip list.
2. **Synopsis matching.** Embed every episode synopsis (TMDB for live action,
   AniList/Wikipedia for anime), match the scene description against them, take
   the top episode. Good for silent scenes.

### 3.4 Character recognition

- **Live action:** InsightFace embeddings, clustered per series, auto-labelled
  from TMDB cast photos. Very reliable, and it lets a query like "only shots
  containing Walter White" work directly.
- **Anime:** ordinary face models fail. Use an anime face detector plus
  **WD-Tagger / DeepDanbooru**, which output rich per-frame tags — character
  names, hair colour, setting, action. For anime this generally outperforms
  CLIP for retrieval, because the tag vocabulary was trained on exactly this
  domain.

---

## 4. Fix the upstream prompt (do this first — it is free)

The current prompt asks the LLM for something it cannot know (a YouTube video ID
and a timestamp) and under-uses what it genuinely does know (dialogue, plot,
characters, episode structure — all of which are heavily represented in its
training data through scripts, wikis and subtitle corpora).

**Rule: ask the model only for facts it can actually know.**

Replace `Clip Links:` entirely. New per-scene output:

```
SCENE 14
Narration: "He is directly connected to the catastrophe that defines Eren's childhood."
SHOTS:                                  # always an array — montages become N shots
  - source: Attack on Titan
    season_episode: S02E06              # "unknown" is allowed
    exact_dialogue: "I am the Armored Titan and he is the Colossal Titan"
    speaker: Reiner Braun
    dialogue_confidence: high           # high | approximate | none
    visual: "Windy grassy hill, daylight. Reiner sits beside Bertholdt, calmly
             telling Eren the truth. Medium two-shot."
    characters: [Reiner Braun, Bertholdt Hoover, Eren Yeager]
    setting: outdoor hillside, daytime, overcast
    must_not_have: [talking head commentary, burned-in subtitles, reaction cam]
    duration_target: 4s
```

Four changes, each closing one measured gap:

1. **`exact_dialogue` for every shot** — closes the 37-of-52 empty gap. For
   silent shots, ask for the *nearest* line before or after; that still locates
   the scene. Mark it `approximate` when unsure so the pipeline knows to
   fuzzy-match wider.
2. **`SHOTS` is an array** — closes the 8 composite scenes that are currently
   unsatisfiable.
3. **`season_episode`** — turns a whole-library search into a single-episode
   search. Verified against the subtitle index, so a wrong guess is caught
   rather than trusted.
4. **No links, no timestamps** — removes the hallucination surface entirely.

Every field above is verifiable against the local index. If the LLM misquotes a
line, fuzzy match fails, the pipeline drops to Ladder 2, and the scene is
flagged for the approval grid. **Wrong guesses degrade gracefully instead of
silently producing a wrong clip** — which is the whole difference from today.

---

## 5. Expected accuracy

| Path | Share of scenes | Accuracy |
|---|---|---|
| Ladder 1 — dialogue match | ~60–70% once the prompt is fixed | ~99% |
| Ladder 2 — episode-scoped visual + VLM | ~25% | ~90% |
| Ladder 3 — library-wide visual + VLM | ~10% | ~80% |
| **Blended** | | **~93–96% automatic** |

Plus the approval grid for the flagged minority → effectively complete.

Compare with today: the primary locator is fabricated, so the realistic
per-scene hit rate is whatever the surrounding search terms happen to catch.

---

## 6. Build order

| Step | Work | Why first |
|---|---|---|
| **1** | Rewrite the Genspark/ChatGPT prompt (§4) | Free, one afternoon, removes the root cause |
| **2** | Subtitle-only dialogue index + fuzzy search → episode + timestamp | No video processing needed; immediately proves the approach on an existing script |
| **3** | PySceneDetect + cut on shot boundaries around the matched line | Turns a timestamp into a usable 4s clip |
| **4** | SigLIP embeddings + VLM captions per shot → Ladders 2 and 3 | Covers silent scenes |
| **5** | Character recognition (InsightFace / WD-Tagger) | Precision boost, enables character-filtered queries |
| **6** | `manifest.json` with scores → tool #2 sorts by score | See `FOOTAGE_RELEVANCE_UPGRADE.md` §8 |

Step 2 is the proof point: take the existing anime script, feed only subtitle
files, and see how many of the 52 scenes resolve to an exact episode and
timestamp. That number tells you whether to invest in the rest — and it costs
almost nothing to find out.
