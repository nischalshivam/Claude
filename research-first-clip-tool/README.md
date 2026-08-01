# Research-First Clip Tool (M1.3)

Anime / cartoon / documentary video-essays ke liye **research-first, local-first**
clip automation. Ek **Scene Research Pack** (source + dialogue clue) se exact clips
cut karke narration ke sath align karta hai — aur galat/doubtful clip lagane ke
bajaye honest `NEEDS_SOURCE` / `NEEDS_REVIEW` card deta hai.

**Koi API key nahi. Koi paid service nahi. Koi Gemini API nahi.**
Sab kuch free, open-source tools par chalta hai (Node + FFmpeg + yt-dlp).

---

## 1. Poora process (7 simple steps)

```
1. Genspark/Gemini Pro se research pack banwao   (browser mein, ek baar)
2. input/ mein 3 files rakho                      (pack + SRT + voiceover)
3. CHECK.bat chalao                               (ek baar setup verify)
4. START.bat chalao                               (poora kaam automatic)
5. quality-report.html kholo                      (har shot ka evidence)
6. NEEDS_SOURCE.csv dekho                         (jo missing hai wahi fix karo)
7. final.mp4 use karo
```

### Step 1 — research pack (ye ek manual step hai)

1. `prompts/GENSPARK_M1_2_ONE_SHOT_SCENE_RESEARCH_PROMPT.txt` kholo. **Yehi
   canonical prompt hai** (isi se test kiya hua pack bana tha).
2. Usme sirf `<PASTE CLEAN NARRATION SCRIPT HERE>` ki jagah apni **poori clean
   script** paste karo. Aur kuch mat badlo.
3. Genspark (ya koi bhi browsing research AI: Gemini Pro, ChatGPT with search,
   Perplexity) se live YouTube search + transcript inspection ke sath chalwao.
4. Jo **JSON object** aaye, use `input/scene-research.json` mein save karo.

> `prompts/LEGACY-research-pack-generator.txt` purana generic prompt hai — normal
> use ke liye **mat** lo.

### Step 2 — input files

```
input/scene-research.json   zaroori  (Genspark ka JSON)
input/voiceover.srt         zaroori  (narration timing)
input/voiceover.mp3         zaroori  (render ke liye)
input/script.txt            optional
```

### Step 3-4 — chalao

```
CHECK.bat     ek baar (node/ffmpeg/yt-dlp/JS runtime verify)
START.bat     poori pipeline (ya beech mein ruke to resume)
```

Output `jobs/<project>/` mein: `final.mp4`, `quality-report.html`,
`NEEDS_SOURCE.csv`, `timeline.json`, `run.log`, `clips/`.

---

## 2. Andar kya hota hai (9 stages)

| Stage | Kya karta hai |
|---|---|
| 0 setup | node / ffmpeg / ffprobe / yt-dlp / JS runtime check |
| 1 validate | pack schema, IDs, URLs, timestamp bounds |
| 2 align | SRT se har moment ka narration time-window (kaunsa visual **kab**) |
| 3 locate | `EXACT_TIME` bounds-check; `DIALOGUE` → asli captions mein fuzzy-match karke **exact second khud nikaalta hai** |
| 4 download | `yt-dlp` se sirf zaroori range (poori video nahi) — **per-moment progress dikhta hai** |
| 5 cut | FFmpeg frame-accurate cut, `preferred_clip_sec` (3-9s), source audio **mute** |
| 6 QA | decode / duration / black / freeze / low-res / duplicate; fail → alternate candidate |
| 7 timeline | beat-driven, poori narration tile; missing → honest card (**random footage kabhi nahi**) |
| 8 render | 1080p, continuous master voiceover |
| 9 report | `quality-report.html` (har shot ka evidence) + `NEEDS_SOURCE.csv` |

Har stage `state.json` mein checkpoint — beech mein ruke to wahin se resume.

---

## 3. Kaunse tools use hote hain (sab free)

| Tool | Kaam | Cost |
|---|---|---|
| **Node.js 18+** (22/24 better) | pipeline | free, open source |
| **FFmpeg + FFprobe** | cut / QA / render | free, open source |
| **yt-dlp** | metadata, captions, range download | free, open source |
| **Deno 2.3+** (ya Node 22+) | yt-dlp ka YouTube JS challenge (EJS) | free, open source |
| **Genspark / Gemini Pro / ChatGPT** browser | Step 1 research (manual, ek baar) | jo bhi aap already use karte ho |

**Tool ke andar koi API key, koi paid subscription, koi Gemini API nahi.**
Research step browser-based hai — kisi ek AI par lock-in nahi, koi bhi browsing
research AI chal jayega.

---

## 4. Honest limitations (ye zaroor padho)

- **Semantic distraction removal nahi hai.** M1.3 khud se facecam / reaction host /
  logo / overlay ko *dekhkar* nahi hata sakta. Source ki safai (a) Genspark prompt
  ke rules se aati hai, (b) aapke `quality-report.html` review se. README kahin
  ye claim nahi karta ki ye automatic hai.
- **Jitna research pack mein evidence hoga, utne hi exact clips banenge.** Jis beat
  ka verified source nahi, wahan honest card aayega — random clip **kabhi nahi**.
- **NEEDS_REVIEW final video mein nahi jaata** (report mein candidate dikhta hai,
  final mein review card). Ye jaan-boojh kar hai — precision > coverage.
- Stage 4 serial hai: ek yt-dlp attempt 300s tak chup reh sakta hai. Progress lines
  se pata chalta rehta hai ki kaam chal raha hai.

Interruption (Ctrl+C) ke baad:
- Poore ho chuke **range caches reuse** hote hain (log mein `RANGE-CACHE` dikhega).
- Download stage ka checkpoint poora stage khatam hone par lagta hai.
- `--redo` jaan-boojh kar generated artifacts saaf karke fresh start karta hai
  (aapke input files kabhi delete nahi hote).

---

## 5. Test

```
npm run test:all      # content (13) + regression (23)
npm run test:mini     # content cases
npm run test:reg      # correctness/blocker cases
```

Tests **isolated jobs root** (`tests/tmp/`) mein chalte hain — production `jobs/`
ko kabhi touch nahi karte (sentinel test se verify).

---

## 6. Changelog

**M1.3**
- **Narration runner-up fix** — dense micro-cue (Whisper) SRT mein overlapping
  sliding windows ab alag occurrence nahi maane jaate. Real production input par
  `29 OK + 53 false AMBIGUOUS` → **82 OK, 0 AMBIGUOUS**. Wahi fix `subtitles.js`
  ke DIALOGUE matcher mein bhi (same bug class).
- **Dense-SRT regression tests** (overlapping windows OK rehte hain; genuine
  disjoint repetition ab bhi AMBIGUOUS).
- **Visible Stage-4 progress** — per-moment aur per-attempt lines, elapsed time,
  READY / RANGE-CACHE / RESUME-CACHE / ALTERNATE / FAILED, aur 300s quiet-window note.
- **Canonical Genspark prompt bundled** (`prompts/GENSPARK_M1_2_ONE_SHOT_...txt`),
  purana prompt LEGACY mark.
- README correction: honest limitations, koi auto-distraction-removal claim nahi.

**M1.2** — stale-media invalidation (clip/final ab input change par sach mein badalte
hain), official `--js-runtimes` shared builder, isolated test job root + sentinel.

**M1.1** — path safety, resume fix, NEEDS_REVIEW held out of final, dialogue margin,
ms-exact range cache, real black/freeze/low-res QA, timeline no-drift, run.log.
