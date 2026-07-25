# Footage Relevance Upgrade — 70% → pro level

**Problem statement (user's words):** even after all the work, clips are often
irrelevant. Every scene folder has to be opened and checked by hand, and
sometimes the collector returns something completely unrelatable. The result is
footage that does not match the voiceover, which kills audience retention.

This document is the design for fixing it. It is written for the same audience
as the other `HANDOFF/` files: a future LLM (or developer) implementing the
change, mostly inside **TOOL #1 (Footage Collector)**, with two small changes in
TOOL #2 (`auto_editor/`, `prostudio/`).

---

## 1. Root cause (diagnosis before cure)

The current pipeline is:

```
scene text  →  keyword search (YouTube/DDG/Wikimedia)  →  download  →  crop  →  folder
```

There is **no stage anywhere that looks at the pixels and asks "is this actually
what the scene needs?"** Every relevance decision is delegated to a search
engine's title/metadata matching. Concretely:

| Gap | Where | Effect |
|---|---|---|
| Narration is used as a search query | tool #1 | Narration is *abstract* ("he built an empire on fear"); it is not a *visual* description. Search engines answer it with whatever text matches. |
| No negative constraints | tool #1 | Nothing rejects talking heads, reaction cams, let's-play HUDs, watermarks, burned-in subtitles, modern footage in a period scene. |
| No semantic scoring | tool #1 | Candidates are not ranked by how well they match. First N results win. |
| Whole video treated as one clip | tool #1 | A correct video still has intros, credits, commentary faces. Cropping by a guessed timestamp lands on those. |
| QC is technical only | `prostudio/engine/qc.py` | Rejects black / blurry / duplicate / low-res. A perfectly sharp, perfectly *wrong* clip passes. |
| Order = filename order | `auto_editor/footage.py`, `prostudio/engine/planner.py` | `manifest.json` is named in the docstring but never read. No score reaches the editor, so the best clip is not used first. |
| Cross-scene borrowing | `prostudio/engine/planner.py:161` `_borrow_images()` | Fills a starved scene with **another scene's** images — by definition off-topic. |

So: the accuracy ceiling is not a scraping problem. It is a **verification**
problem.

---

## 2. The target architecture

Replace *search-and-trust* with **retrieve → verify → rank → select**, and put
a persistent library underneath so quality compounds across videos.

```
clean script + visual editor script
        │
        ▼
┌───────────────────────┐
│ A. SHOT BRIEF (LLM)   │  narration → structured visual requirement
└───────────────────────┘  (+ positive prompt, negative list, queries)
        │
        ▼
┌───────────────────────┐
│ B. LIBRARY RETRIEVAL  │  vector search over already-owned footage  ← grows every video
└───────────────────────┘
        │ (gaps only)
        ▼
┌───────────────────────┐
│ C. MULTI-SOURCE FETCH │  YouTube API + Archive.org + stock + Wikimedia
└───────────────────────┘  recall-first: 5-8 candidates per scene
        │
        ▼
┌───────────────────────┐
│ D. SHOT SPLIT         │  PySceneDetect → individual shots, not whole videos
└───────────────────────┘
        │
        ▼
┌───────────────────────┐
│ E. VISUAL VERIFY      │  ① CLIP/SigLIP score  ② hard rejectors  ③ VLM judge
└───────────────────────┘  ← THE MISSING STAGE. Biggest single win.
        │
        ▼
┌───────────────────────┐
│ F. WINDOW PICK        │  best contiguous 3-6s inside the best shot
└───────────────────────┘
        │
        ▼
┌───────────────────────┐
│ G. MANIFEST + SCORES  │  scene_NNN/ + manifest.json with per-clip scores
└───────────────────────┘
        │
        ▼
   TOOL #2 (sorts by score)  →  approval grid  →  render
        │
        ▼
┌───────────────────────┐
│ H. FEEDBACK LOOP      │  every human accept/reject is logged and reused
└───────────────────────┘
```

---

## 3. Stage A — the Shot Brief (stop searching with narration)

The single highest-leverage cheap change. An LLM pass converts each beat of the
visual-editor script into a **structured, checkable visual requirement**.

```json
{
  "scene": 12,
  "narration": "He built an empire on fear.",
  "intent": "show 1980s Miami wealth and menace",
  "shot_type": "establishing wide",
  "subject": { "name": "Miami skyline", "type": "place", "era": "1980s" },
  "must_have":     ["city skyline", "palm trees", "daylight", "period cars"],
  "must_not_have": ["talking head", "burned-in subtitles", "reaction webcam",
                    "modern skyscrapers", "channel watermark", "gameplay HUD"],
  "accept_prompt": "a wide daylight shot of the 1980s Miami skyline with palm trees, film stock look",
  "reject_prompts": ["a person talking to camera", "a screen recording with text overlay",
                     "a modern city at night"],
  "queries": {
    "youtube":   ["Miami 1980s aerial footage", "Scarface Miami skyline scene 1983"],
    "archive":   ["Miami Florida 1980s stock footage"],
    "stock":     ["miami skyline retro"],
    "wikimedia": ["Miami skyline 1985"]
  },
  "fallback": "image_kenburns"
}
```

Three things this unlocks:

1. **Queries become visual, not narrative.** Search engines can actually answer
   them.
2. **`accept_prompt` / `reject_prompts` make relevance machine-checkable** —
   this is what stage E consumes. Without this field, no automatic verification
   is possible at all.
3. **Entity resolution.** For movie / anime / cartoon / documentary channels,
   resolve the entity first (TMDB, Wikipedia, AniList, Wikidata) so the query
   carries canonical names + year: `"Scarface 1983 chainsaw bathroom scene"`
   beats `"he faced danger"` by a mile.

**Multi-query fan-out:** generate 4–6 query variants per scene (entity query,
visual-descriptor query, era/stock query, b-roll query) and fetch from all of
them. Optimise for **recall** here; precision is stage E's job. Record which
variant produced the winning clip — that becomes a learned prior per niche.

---

## 4. Stage E — visual verification (the actual fix)

Three sub-stages, cheap → expensive, each one shrinking the candidate set.

### E1. Embedding score (fast, offline, free)

- Sample frames every ~1s from each candidate shot (or 5 frames per shot).
- Compute image embeddings with **SigLIP** (`google/siglip-so400m-patch14-384`)
  or **OpenCLIP ViT-H/14**. Both run locally; GPU ideal, CPU workable.
- Score:

  ```
  relevance = sim(frame, accept_prompt) − max_i sim(frame, reject_prompts[i])
  shot_score = mean(top-3 frame relevance)      # robust to one odd frame
  ```

- Drop everything below a niche-tuned threshold. This alone removes the
  "ek dum irrelevant" cases, because a clip about a completely different topic
  scores visibly lower than one about the right topic.

### E2. Hard rejectors (deterministic, no model needed)

Run these as boolean filters — a pro editor would cut all of them:

| Rejector | How | Why |
|---|---|---|
| Talking head | face bbox area > ~12% of frame across >60% of frames (OpenCV / YOLO-face) | Commentary footage, not b-roll |
| Burned-in text / subtitles | EAST or PaddleOCR text-area coverage > ~5% | Someone else's captions on your screen |
| Watermark / logo | persistent high-edge region in a corner across frames | Re-upload channel branding |
| Static / frozen | mean optical-flow magnitude below threshold | A still pretending to be a clip |
| Letterbox / pillarbox | black-bar detection on frame borders | Nested re-encode, kills 4K quality |
| Shot too short | usable window < 2.5s | Cannot fill a 3-6s slot |
| Face-swap / reaction PiP | small persistent face box in a corner | Reaction upload |

Existing `qc.py` already has the right shape for this — extend it rather than
writing a new module, and keep the technical checks it already does.

### E3. VLM judge on the shortlist (the accuracy ceiling-breaker)

For the top 3–5 surviving candidates per scene only:

- Build a **contact sheet**: 3×3 grid of frames from the shot, ~512px each,
  one JPEG.
- Send to a vision model with a strict rubric and the scene brief. Ask for JSON:

  ```json
  { "shows_required_subject": true,
    "shot_type_matches": true,
    "era_consistent": true,
    "has_talking_head": false,
    "has_burned_in_text": false,
    "has_watermark": false,
    "usable_seconds": [3.2, 8.6],
    "score": 4,
    "why": "wide daylight skyline, period cars visible, no overlays" }
  ```

- Accept only `score >= 4` and all boolean constraints satisfied.

This is where 93% becomes 98%, because a model is genuinely *looking* at the
footage the way the user currently does by hand. Cost is modest: one contact
sheet per shortlisted candidate, and only for candidates that already survived
E1 + E2. For a 60-scene video that is roughly 200–300 small images.

**Ask the VLM for `usable_seconds`** — it doubles as stage F's input.

---

## 5. Stage D + F — clip *inside* the video, not the whole video

Even a perfect video is mostly unusable footage. Never crop by a guessed
timestamp.

1. **Shot split** with PySceneDetect (`ContentDetector`) → list of shots with
   in/out points.
2. Score each shot **independently** (stage E).
3. Inside the winning shot, pick the best contiguous **3–6s window**: highest
   mean frame relevance, with stable-but-non-zero motion, avoiding the first and
   last ~0.4s (transition residue from the source edit).
4. Export that window losslessly where possible (`-c copy` on keyframe
   boundaries) or a high-bitrate re-encode.

This alone fixes a large share of "the video was right but the clip was wrong".

---

## 6. Stages B + C — where footage should come from

### Honest answer on the YouTube Data API question

Using the official API **is** an upgrade over scraping — but for *search
quality*, not for relevance:

- **What it gives you:** reliable results, and genuinely useful filters —
  `videoDuration`, `videoDefinition=high`, `videoLicense=creativeCommon`,
  `publishedAfter`, `relevanceLanguage`, `topicId`, `order=relevance|viewCount`.
  `creativeCommon` alone is a meaningful copyright-risk reduction.
- **What it does not give you:** downloading (still yt-dlp), and — critically —
  **it does not make clips relevant.** It ranks by metadata, same as scraping.
- **Quota reality:** 10,000 units/day, `search.list` = 100 units → ~100 searches
  per day on the free quota. With 4–6 query variants × 40–60 scenes, that is
  roughly one video per day per project. Plan for caching, or request a quota
  increase, or reserve API search for the scenes that failed cheaper sources.

**Verdict: adopt the API, but do not expect it to solve the problem. It is a
10% improvement on a stage that is not the bottleneck.** Stage E is the fix.

### Source priority ladder

Fetch in this order, stop when enough verified candidates exist:

1. **Own library** (stage B) — free, instant, already verified.
2. **Public domain / CC0**: Internet Archive (enormous for documentary,
   newsreel, Prelinger), Wikimedia Commons, NASA, Library of Congress, national
   archives. Best copyright profile that exists.
3. **Free stock APIs**: Pexels, Pixabay, Videvo, Coverr, Mixkit — clean, high
   resolution, licence-safe, and API-friendly. Excellent for generic b-roll
   (city, crowd, money, nature, tech).
4. **Paid stock subscription** — at pro level this is the highest ROI purchase
   in the whole stack. Storyblocks (unlimited download subscription) or
   Artgrid / Envato. For documentary and essay channels it removes both the
   relevance *and* the copyright problem in one move, and downloads can be
   automated.
5. **YouTube** — last, and mainly for the cases where nothing else can work:
   specific movie / anime / cartoon / event footage.

### For movie / anime / cartoon essay channels

Scraping YouTube for source clips gives re-uploads with watermarks, reaction
overlays, mirrored/zoomed anti-copyright edits and heavy compression. The pro
approach is to **own and index the source media**: keep the actual films or
episodes the channel covers as local files and index them (stage B). Then
"Scarface bathroom scene" is a vector lookup in your own library at full
quality, with a precise in/out point — not a scrape. Fair-use commentary
handling stays the user's editorial/legal call; the pipeline just stops
laundering the footage through third-party re-uploads.

---

## 7. Stage B — the indexed footage library (the structural upgrade)

Stop scraping per video. Build an asset library that gets better forever.

**Ingest** (once per new file, runs in the background):

```
file → PySceneDetect → shots → keyframe per shot
     → SigLIP embedding + VLM caption + tags
       (entities, era, mood, motion level, has_face, has_text, resolution, licence)
     → LanceDB / Qdrant / FAISS  +  SQLite metadata
```

**Retrieve** (per scene, milliseconds):

```
accept_prompt → embedding → top-k shots, filtered by
                            must_not_have tags + licence + min resolution
```

Payoff:

- Cache hit rate climbs every video; scraping shrinks to gap-filling only.
- Collection time per video drops from hours to minutes.
- Licences are tracked per asset, so copyright posture is auditable — which
  matters directly to the 40–60% images strategy.
- The same index serves *all* channels (movies, cartoon, anime, documentary),
  and a shot bought/verified once is reused forever.

---

## 8. Two small changes in TOOL #2 (this repo)

These are cheap and should ship with Phase 0.

### 8.1 Read the manifest and rank by score

`auto_editor/footage.py` currently mentions `manifest.json` in its docstring but
never opens it; `read_footage()` sorts by `_natural_key` (filename). Same in
`prostudio/engine/planner.py`, which sorts *images* by sharpness but leaves
*videos* in filename order.

Change: collector writes per-asset scores into `manifest.json`; both tools read
it and sort clips **best-score-first**, and drop anything below the accept
threshold instead of putting it on the timeline.

```jsonc
// scene_012/manifest.json
{
  "scene": 12,
  "brief": { /* the Shot Brief from stage A */ },
  "assets": [
    { "file": "clip_02.mp4", "kind": "video", "score": 0.91,
      "vlm_score": 5, "source": "archive.org", "licence": "public-domain",
      "in_point": 3.2, "duration": 4.8,
      "why": "wide daylight skyline, period cars, no overlays" },
    { "file": "clip_01.mp4", "kind": "video", "score": 0.44,
      "vlm_score": 2, "flags": ["talking_head"] }
  ]
}
```

Backwards compatible: if `manifest.json` is missing, fall back to today's
filename ordering.

### 8.2 Anchor clips to the phrase they illustrate

`auto_editor/planner.py:84` packs clips from the **start** of the scene window
in order. Whisper word timestamps are already available (`align_audio.py`), so a
clip can instead be placed at the moment its **trigger phrase** is actually
spoken. The Shot Brief should carry a `trigger_phrase` field for this.

This fixes the second half of the user's complaint — "voiceover kuch aur, screen
pe kuch aur" — which is a *placement* problem even when the clip is correct.

Also revisit `_borrow_images()` (`prostudio/engine/planner.py:161`): borrowing a
neighbouring scene's images guarantees an off-topic visual. Better order:
extend the current scene's best image with a slower Ken Burns move → generic
niche-safe b-roll from the library (tagged `filler_safe`) → only then borrow.

---

## 9. Stage H — the feedback loop

Log every decision as a row: `(brief, candidate, embedding score, rejector
flags, VLM verdict, human accept/reject)`.

After a few hundred scenes this gives:

- Auto-tuned thresholds **per niche** (anime tolerates burned-in text far less
  than a documentary tolerates a talking head).
- A small learned reranker (logistic regression / gradient boosting on
  embedding score + flags + source + resolution) trained on real human labels —
  usually worth several points of accuracy on its own.
- Auto-discovered negative prompts per niche ("no reaction cam", "no let's-play
  HUD", "no modern smartphone in a period scene").

The human approval pass is not overhead — it is the training data.

---

## 10. Human-in-the-loop: 5 minutes, not an hour

`prostudio/review_server.py` already does most of this. Extend it into a single
**approval grid** for the whole video: one row per scene, showing the narration
line + top 3 candidates with scores and the VLM's `why`, and a one-click swap.

With verification in place the top candidate is right most of the time, so the
pass takes minutes instead of opening every folder by hand. Every click feeds
stage H.

---

## 11. Roadmap (ordered by return on effort)

| Phase | Work | Expected accuracy |
|---|---|---|
| **0** | Shot Brief + negative prompts + multi-query fan-out; `manifest.json` with scores; tool #2 sorts by score | 70% → **~85%** |
| **1** | PySceneDetect shot split + SigLIP/CLIP scoring + hard rejectors + best-window pick | ~85% → **~93%** |
| **2** | VLM judge on shortlist + approval grid | ~93% → **~97-98%** |
| **3** | Indexed library + paid stock + feedback loop | **98%+**, and collection time drops ~10× |

Phase 0 is days of work and delivers the largest jump per hour spent. Phase 1
is the real fix and is where the effort should concentrate.

---

## 12. Honest note on "100%"

Fully automatic 100% relevance is not an achievable target, and any tool that
claims it is lying — "the right visual for this sentence" is an editorial
judgement, and even two human editors disagree. What *is* achievable:

- **97–98% automatic** first-pass relevance, and
- a **5-minute human approval pass** that catches the rest.

The output is then effectively 100%, at a fraction of the current manual cost.
That is what a professional pipeline actually looks like — the tool does not
remove the editor's judgement, it stops wasting it on obvious rejects.

The clearest sign of progress to watch: **how many scenes need a manual swap.**
Today it is most of them. After Phase 1 it should be roughly one in ten; after
Phase 2, one in thirty.
