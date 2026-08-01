# Changelog — what Claude changed (for GPT to review)

This file is kept up to date so it can be handed to GPT. Each entry says
what changed, why, and — where it can be honestly measured — how much it
helped or hurt. Newest first.

The single most important honest note: until the **gold set** (below) is
filled in by a human, every "% better/worse" is an estimate from logs, not a
measured fact. That is exactly the gap GPT's recovery strategy calls out,
and the gold evaluator is the first thing built to close it.

---

## 2026-08-01 — "subtitle present but empty" is now a distinct, honest state

**Change.** `subtitles.load_for_video` used to collapse two very different
situations into `"none"`: (a) no subtitle file exists, and (b) a subtitle
file sits right next to the video but parses to **zero** readable cues — the
classic broken ~1 KB download (an HTML error page or placeholder saved with
a `.srt` name). It now returns a new kind `"empty"` for case (b), carrying
the path of the file it found. `library.py` turns that into a precise
message: *"a subtitle file is present but has no readable lines — probably a
broken download (a real movie .srt is tens of KB, not ~1 KB); replace it and
re-index."* Also added a test proving a scene-release name with brackets —
`Joker.2019.1080p.WEBRip.x264-[YTS.LT].srt` — is still found by the sidecar
glob (`glob.escape` already handled it; the test locks it in).

**Why.** Real user report: a freshly downloaded Joker (2019) movie showed
"subtitle hai hi nahi" (no subtitle) even though a `.srt` named identically
to the `.mp4` was in the folder. The `.srt` was 1 KB — junk. The old message
sent the user looking for a missing file that was not missing. This is a
diagnosis fix, not a placement fix: it changes what the tool *says*, so the
user fixes the right thing (swap the broken .srt) in one step.

**Measured.** 2 new tests; full subtitle + web + queue suite green (105).

---

## 2026-08-01 — P0.5 fail-closed: a guess never ships as moving footage

**Change.** `runner.py`: a moving clip is now cut only for a placement whose
method is trusted — `anchor / stated / chosen / verified / vlm / picture`
(`MOTION_OK`). An interpolated, paced or filler guess no longer becomes a
moving clip; it is shown as a STILL (a frozen frame is an honest "roughly
this scene"; wrong motion is a confident lie). Stills still play with a slow
hold, so nothing goes black — the video just stops pretending a guessed
moment is real. This is GPT review point #2, implemented without reverting to
Strict / black cards.

**Effect.** Confident wrong MOTION can no longer ship. Guessed placements
survive only as stills, which are softer and, on a wrong-moment guess, far
less jarring. Trusted placements (dialogue-located, VLM-verified) still get
moving clips as before.

**Measured.** New test asserts every moving clip in a real build comes from a
MOTION_OK method and that an interpolated shot appears only as a still. 785
tests pass. The real precision delta will come from the next gold labelling
pass on a rebuilt video.

**Still open (honest):** a dialogue-located clip is still not fully verified
(character/action/crop) — that is P2/P3. And the still shown for a guess is
still from roughly-the-right scene, not yet a verified character still — that
is P1.

---

## 2026-08-01 — GPT review accepted; over-claims retracted

GPT's review of STRATEGY_FINAL.md + this changelog was correct on the
substance. Corrections made (STRATEGY_FINAL.md updated):

1. **Gus 100% / Hank 15% retracted as proven.** Gus labels were reconstructed
   from the user's screenshot (~100% usable, 0 wrong) but the raw
   `mi gold --score` output + labelled `gold.csv` are still needed to stand
   as evidence — treated as indicative, not proven. Hank "15%" is an eyeball
   estimate, NOT gold-labelled. No "100%/works for every essay/fully
   automatic" claim stands until frozen human labels prove it.
2. **"Never wrong footage" marked as GOAL, not current state.** Today, an
   unverified interpolated/paced shot still ships as a moving clip in
   Balanced. Fixing that (P0.5 fail-closed) now leads the build order.
3. **Dialogue match is a LOCATOR, not Tier A.** Strategy updated: a real
   Tier A needs locator + occurrence + required-character + action + final-
   crop verification. The tool has the locator only today.
4. **P1 circularity fixed.** Character-still fallback now requires minimum
   identity verification (user reference portraits + face/quality filter +
   unknown→reject), not blind Gemini picks. Full tracking stays P3.
5. **Gold should be per visual-request/shot, not per scene** — acknowledged;
   the per-scene sheet hides a 2-right-3-wrong scene under one "ok". Per-shot
   labelling to be added, plus dev/frozen/audit split.
6. **Input evidence statuses adopted:** VERIFIED / SUPPORTED / UNVERIFIED /
   CONTRADICTED; clean narration is authority, Genspark is a proposal.
7. **P2 is hierarchical retrieval,** not sparse coarse frames alone; NONE OF
   THESE mandatory.

Revised build order: **P0.5 fail-closed → P1 character-still with identity →
P2 hierarchical location → P3 face tracking.**

---

## 2026-08-01 — Final strategy decided (see STRATEGY_FINAL.md)

After the gold benchmark showed Gus = 100% usable / Hank = ~15%, the
architecture is locked to a **precision-first four-layer placement**: (1)
sure clip from dialogue anchor [works today], (2) Gemini locates the exact
moment in the LOCAL movie via coarse->dense frame search [P2], (3) clean
character/scene still from the local movie when the exact moment is not found
[P1, next], (4) NEEDS VISUAL card only if the character is unknown.

Decided and recorded: local movie files are the only footage source;
YouTube/yt-dlp is optional-only (copyright + quality + availability);
Gemini API is the brain, not the source; no browser-automation of the Gemini
website. Build order: P1 character-still safety net (next) -> P2 exact-clip
location -> P3 face recognition.

---

## 2026-08-01 — Gold benchmark & honest metrics (P0, per GPT's plan)

**Change.** New `media_index/gold.py` + `mi gold` command. It turns a
finished build's `manifest.json` into a labelling sheet (`gold.csv`), one row
per scene with the narration and what the tool placed. A person watches the
video once and writes a verdict per scene: `exact` / `ok` / `wrong` / `none`.
`mi gold --score gold.csv` then prints the only numbers that mean anything:

- **usable precision** = (exact + ok) / auto-placed
- **exact precision** = exact / auto-placed
- **coverage** = scenes filled / all scenes
- a **per-method breakdown** so a wrong "Tier B" can no longer hide inside a
  healthy-looking total.

**Why.** GPT's strategy §11 P0: *"Before solver changes, build a 40–50
request semantic gold set and evaluator. Never use placeable, moved,
rendered or non-black as accuracy."* This is that. Nothing here changes a
build — it measures one, and the solver may never again be tuned against a
number the solver itself produced.

**Measured.** 12 new tests. On the Gus-4 (Strict) manifest the evaluator
correctly separates 16 anchor-placed scenes from 20 declined (card) scenes.
Real accuracy numbers await the human labelling pass — that is the point.

**What the user must do:** run `mi gold --template <manifest.json>`, watch
the video, fill the `verdict` column, run `mi gold --score gold.csv`. That
produces the first honest accuracy number this project has ever had.

---

## 2026-08-01 — Vision model given every guessed shot

**Change.** `refine.py`: the VLM (Gemini) was offered only wide interpolated
shots. Now it is offered every GUESSED shot — interpolated, paced, and
homeless — down to a 30-second window, and a homeless shot it recognises is
rescued into a real placement instead of becoming filler.

**Measured.** Hank build: shots offered to the VLM went 20 → 36; shots moved
went 7 → 13. **But** the finished video was still poor by eye. This is the
evidence behind GPT's key point: the bottleneck is no longer how many shots
the model is *asked* about, it is that the right frame is often not among the
~16 sampled across a 5–8 minute window (retrieval recall, not model
intelligence). See GPT strategy §2.2 and §8.

---

## 2026-08-01 — Default mode changed Strict → Balanced

**Change.** New Video defaulted to Strict, which turns every non-dialogue
shot into a black card. A build came back >50% black cards with nothing
broken. Default is now Balanced.

**Note for GPT:** GPT's strategy §3 flags that Balanced can hide weak footage
inside a complete-looking timeline — this is correct, and the gold evaluator
above is what will expose it. The right end state (GPT §9) is a
precision-first ladder: exact clip → curated still → NEEDS VISUAL, never
wrong moving footage. That is the next architecture, not yet built.

---

## 2026-08-01 — Gemini (GPT/Gemini vision API) integration

**Change.** `gemini.py` + `refine.py`: OpenAI-compatible vision call, key
read from `settings.txt` (never committed). For silent/no-dialogue shots the
model is shown candidate frames of a window and picks the one matching the
shot's description. Graceful: not configured / network error / abstention
all leave the shot where it was. `mi gemini` diagnoses key + endpoint with a
text ping then an image ping, and shows the real HTTP error instead of
"no answer".

**Measured.** The picks the model logs look correct (e.g. Walt driving the
Aztek with Hank; the family dinner with all four at the table). Coverage
limited by the frame-sampling bottleneck above.

---

## 2026-07-31 → 08-01 — The correctness bugs that caused bad builds

Each was a real, measured failure, all now fixed and covered by tests:

1. **Subtitle mis-linking (the big one).** "…Season 4 Episode 1.mp4" was
   indexed against "…Episode 13.srt" (glob `stem + "*"` matched 1/10/11/12/13,
   tie-break preferred the largest file). Every quoted line was "found" at a
   real millisecond of the *wrong* episode — dashboard read 99% while the
   video was 95% wrong. Fixed: a subtitle whose own episode number
   contradicts the video's is refused.
2. **One episode ≠ one scene.** S04E01's 31 shots were three sequences; as
   one run their anchors couldn't all increase in time, so the solver
   dropped line after line (31 shots → 1 anchor). Fixed: runs split by
   `scene_range` into scene-sequences.
3. **Clue lines duplicated.** A clue covering 10 beats wrote its 3 lines into
   all 10, so each line claimed 10 positions and was thrown out. Fixed: each
   line placed once, spread across the scene's empty shots.
4. **`(beat, shot)` window keying**, **anchor clustering**, **contradicted-
   range rejection** — earlier fixes to the same family of "the window
   belonged to the wrong thing" bugs.

**Note for GPT:** the document `PROJECT_STATE_FOR_GPT.md` claimed "every
anchor/Tier A is correct". GPT correctly pushed back (§3): a matched subtitle
proves the *time of the line*, not that the required character/action is
on screen at that time. This is now treated as an open item — dialogue is a
locator, not proof of the visual — and is part of why the gold set matters.

---

## Baseline capabilities that work and should be preserved

Local episode ingest; subtitle sidecar matching (now episode-safe); dialogue
search; per-`(beat,shot)` windows; clue-script grounding; narration/voiceover
timeline; FFmpeg cutter/render; queue/resume/editor; Strict/Balanced/Draft;
NEEDS VISUAL placeholders; episode-scoped lookup; Gemini error surfacing.
