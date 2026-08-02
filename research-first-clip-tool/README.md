# Research-First Clip Tool (M2 — zero-card visual engine)

> **M2.1 mein sabse bada badlav:** jahan exact clip nahi milti, wahan **usi
> approved source (usi episode) ke frames** se still/montage lagta hai — sahi
> show, sahi character, Ken Burns motion ke saath. Analysis/quote beats bhi ab
> plain card nahi, **asli frame ke upar** text overlay hote hain.
>
> **Metrics ab honest hain.** Report `render-manifest.json` se banti hai (jo sach
> mein render hua) aur har class alag ginī jaati hai:
> `media-backed total` · `video` · `stills` · `montage` · `graphic-over-media` ·
> **`GENERIC full-screen text`** · `diagnostic cards` · `render failures`.
> Pehle M2 mein full-screen gradient+text ko `EDITORIAL_GRAPHIC` bolkar
> "0% cards" mein chhupa diya gaya tha — **wo galat tha aur ab theek hai.**
> Target: media-backed ≥85%, generic text ≤15%, cards 0%.


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
3b. CHECKPACK.bat chalao                          (pack ka report card - render se PEHLE)
4. START.bat chalao                               (poora kaam automatic)
5. quality-report.html kholo                      (har shot ka evidence)
6. NEEDS_SOURCE.csv dekho                         (jo missing hai wahi fix karo)
7. final.mp4 use karo
```

> **Step 3b sabse zyada time bachata hai.** Final video ki quality 80% research
> pack se aati hai, tool se nahi. `CHECKPACK.bat` bina render kiye bata deta hai
> ki pack se kya banega — aur jo kami hai uska ready-made "work order" bana deta
> hai jo seedha Genspark mein paste karna hota hai. Details neeche section 1b.

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

## 1b. CHECKPACK.bat — render se pehle pack ka report card

Ye tool **45-minute render kiye bina** batata hai ki pack se kya banega.

```
CHECKPACK.bat          poora check (sources ke ASLI captions bhi verify karta hai)
CHECKPACK.bat fast     sirf offline check (internet ke bina, ~8 second)
```

Kya check hota hai:

| Check | Kyun zaroori hai |
|---|---|
| narration ke kitne **seconds** ke paas exact evidence hai | moment-count jhooth bolta hai — 5s aur 25s ka moment barabar nahi |
| **dialogue asli captions mein hai ya nahi** | LLM aksar dialogue paraphrase kar deta hai. Jo line captions mein nahi, us par clip nahi lagegi |
| **EXACT_TIME episode ki length ke andar hai ya nahi** | 22-minute episode par `start_sec: 1400` = guaranteed fail |
| **source abhi live hai ya delete/private ho gaya** | pack purana ho to URLs mar jate hain |
| **scope title mismatch** | ek hi show ke do alag spelling = engine unhe do alag show samajhta hai = sources aapas mein use nahi hote |
| **alignment** | `script_cue_exact` voiceover se hubahu match hona chahiye, warna clip galat jagah lagegi |

Do files banti hain `output/` mein:

```
output/pack-report.json     saare numbers (UI/automation ke liye)
output/NEEDS_RESEARCH.txt   Genspark mein paste karne wala READY work order
```

`NEEDS_RESEARCH.txt` mein sirf **jo missing hai** wahi hota hai — poora pack
dobara nahi banwana padta. Loop aisa hai:

```
CHECKPACK.bat  ->  NEEDS_RESEARCH.txt Genspark mein paste  ->  naya JSON merge
   ->  CHECKPACK.bat dobara  ->  verdict OK  ->  tab PREVIEW/START
```

Exit codes: `0` = pack theek, `2` = weak (upgrade karo), `1` = pack padha nahi gaya.

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

## 3b. Preview pehle, full render baad mein (zaroori)

3 ghante ka full run karne se pehle **hamesha** 2-minute preview:

```
PREVIEW.bat            ->  pehle 120 second
PREVIEW.bat 300        ->  300s se 120 second
PREVIEW.bat 300 90     ->  300s se 90 second
```

Preview **acquisition se pehle** filter karta hai — yaani sirf un moments ke
sources download hote hain. Output alag `jobs/preview/` mein jaata hai, full job
ko touch nahi karta.

Preview mein ye check karo: media-backed ≥85%, generic text ≤15%, cards 0%,
koi galat show/character nahi, koi 1s se lamba frozen shot nahi.

## 4. Honest limitations (ye zaroor padho)

- **Semantic distraction removal nahi hai.** Tool khud se facecam / reaction host /
  logo / overlay ko *dekhkar* nahi hata sakta. Source ki safai (a) Genspark prompt
  ke rules se aati hai, (b) aapke `quality-report.html` + preview review se.
  `must_not_show` report mein dikhta hai par automatically enforce nahi hota.
- **Frame selection deterministic hai, semantic nahi.** Engine `frame_hints`
  (source + second), moment ke source-time ki nazdeeki, aur simple quality use
  karta hai. `keyframe_queries` ko base engine **ignore** karta hai — usse coverage
  mat maano. Sahi frame chahiye to research pack mein `frame_hints` do.
- **Captions ke bina anime abhi solve nahi hai.** Aise sources ke liye
  `EXACT_TIME` + `frame_hints` kaam karte hain; local ASR abhi nahi hai.
- **`APPROX_WINDOW` / `SEARCH_ONLY` se exact clip nahi banti** — wo beats
  fallback_plan/keyframe se bharte hain ya honestly unresolved rehte hain.
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

## 5b. M2 kaise "cards" khatm karta hai

M1.3 mein video ka ~61% cards tha. Uske do kaaran the — aur dono ab fix hain:

**(a) 44 cards mere code ke bugs se aa rahe the, research gap se nahi:**

| Bug | Kitna nuksan | Fix |
|---|---|---|
| `probe()` 262-byte empty download ko valid maan raha tha | 10 clips | strict probe: video stream + w/h + duration + size zaroori; invalid file quarantine + alternate |
| Ek middle-frame se duplicate detect (cartoon close-ups false-positive) | 6 clips | ab same-source **overlapping range** hi duplicate; visual similarity sirf warning |
| Micro-gap (0.4-0.68s) par flash text card | 33 cards | ≤1.5s gaps adjacent visual mein absorb |
| Low-res exact clip hard reject | 1 clip | 360p+ exact clip accept (flag ke saath), sirf <288p reject |

**(b) Jahan sach mein clip nahi thi, wahan ab card ki jagah asli visual:**

```
exact clip  →  usi source ka keyframe still (Ken Burns)  →  montage
            →  designed editorial graphic     [production mein card kabhi nahi]
```

Keyframes **already-downloaded approved source** se aate hain — isliye 100%
sahi show/character, koi nayi API nahi, koi galat image nahi.

**Aur:** ek source ab **ek hi baar** download hoti hai (53 downloads → ~13), aur
lamba narration 4-6 second ke shots mein tootta hai (7-14 second ka frozen frame
khatam).

## 6. Changelog

**M2.5**
- **`CHECKPACK.bat` / `tools/check-pack.js`** — research pack ka report card
  render se pehle. Narration ko **seconds** ke hisaab se tolta hai (moment-count
  nahi), asli pipeline ka hi alignment (`align.bestWindows`) aur wahi scope-rules
  use karta hai jo `locate.js` use karta hai — isliye iski prediction aur asli
  render ek hi jagah se aate hain.
- **Live verify** — har `DIALOGUE` locator ko source ke **asli captions** mein
  dhoondh kar dekhta hai, har `EXACT_TIME` ko episode ki duration se check karta
  hai, aur dead/private sources pakadta hai. Yehi "best case" aur "asli result"
  ka farq khatam karta hai.
- **Scope-title mismatch detector** — ek hi show ke do alag titles (jaise
  "The Amazing World of Gumball" vs "The Wonderfully Weird World of Gumball")
  engine ko do alag show dikhte hain; ab ye render se pehle pakda jata hai.
- **`output/NEEDS_RESEARCH.txt`** — Genspark/Gemini ke liye ready-made work order,
  sirf missing cheezon ka (poora pack dobara nahi banwana padta). GRAPHIC/analysis
  packs ke liye alag guidance: unhe apne sources nahi, `allowed_pack_ids` +
  `frame_hints` chahiye.
- **~4x tez alignment** — `lib/fuzzy.js` mein bounded memoization (normalize /
  tokens / trigrams). Pack check 29.6s → 7.9s; poore run ka Stage-2 bhi utna hi tez.
- 7 naye regression tests (T-PACK1..7). Suite ab **30 PASS / 0 FAIL**.

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
