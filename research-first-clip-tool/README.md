# Research-First Clip Tool — M5.0-A (editor foundation)

> **M5.0-A — ab ek chalne wala local editor hai.** `START_UI.bat` chalao,
> browser khul jayega (sirf `127.0.0.1`, na account, na internet, na npm install).
> Overview · Research Health · Missing Media · Editor — sab ek jagah. "Draft banao"
> button server ke through asli `draft.mp4` + gap-plan + EDL banata hai. Do addendum
> fix (expired approval, updater exit code) is release ke pehle commit mein lage.
> Kya chalta hai / kya baaki: `KNOWN_LIMITATIONS.md`. Acceptance: `docs/M50B_ACCEPTANCE.md`.
> API: `docs/API_CONTRACT.md` · EDL: `docs/EDL_SCHEMA.md`.

---

# Research-First Clip Tool — M4.2.1

> **M3.3 mein sabse bada fix:** renderer ab jo SACH mein render hua wahi label
> karta hai. Pehle planned asset ka file missing ho to shot chupchap generic text
> card ban jata tha, par manifest `EXACT_VIDEO`/`CONTEXT_VIDEO` hi likhta tha —
> yaani screen par card, report mein "media-backed". Decoded-pixel tests ab isse
> pakadte hain.
>
> **Frame hints ab exact second par** materialize hote hain (±0.5s), sampled bank
> se nahi — pehle 22-minute source par ~11s aur 67-minute source par ~34s tak
> galat frame aa sakta tha.
>
> **HOOK/HARD_EVIDENCE ab gate hain**, sirf metadata nahi: exact evidence na ho to
> production export rukta hai.
>
> **`shot-review.html`** — final render se har shot ka thumbnail, evidence ke saath.
> Percentages ye nahi bata sakte ki character sahi hai ya nahi; ye page 2 minute
> mein visual audit karwa deta hai.
>
> **M2.1 ka badlav:** jahan exact clip nahi milti, wahan **usi
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

Research **do stage mein** hoti hai, do alag Genspark accounts par. Ek hi prompt
mein "script baanto + video dhoondho + verify karo + timestamp nikaalo" maangne
par model ka poora budget instructions follow karne mein chala jata hai aur asli
browsing reh jati hai. Alag karne se har stage ka kaam chhota hai — aur stage 2
stage-1 ke links ko **verify** bhi karta hai.

**STAGE 1 — sources + beats** (pehla account)

1. `prompts/STAGE1_SOURCES_AND_BEATS_PROMPT.txt` kholo
2. `<PASTE CLEAN NARRATION SCRIPT HERE>` ki jagah poori clean script paste karo
3. Jo JSON aaye use `input/scene-research.json` mein save karo

   Is stage ka kaam: script ko beats mein baantna aur **asli, chalne wale source
   videos** dhoondhna. Timestamps yahan zaroori nahi — isliye model ka poora
   budget browsing par lagta hai.

**STAGE 2 — verify + timestamps** (`REPAIR.bat`)

```
CHECKPACK.bat        pehle — taaki tool jaan sake kya toota hai
REPAIR.bat           -> 1. Repair prompts banao
```

4. `output\repair\` mein chhoti-chhoti prompt files banti hain (12–18 moments each)
5. Har file **kisi bhi nayi chat/account** mein paste karo — Genspark, Gemini,
   ChatGPT, Perplexity, jiske paas live web ho. **Purani chat ki zaroorat nahi.**
6. Jo JSON aaye unhe `output\repair\responses\` mein daal do (naam kuch bhi)
7. `REPAIR.bat` -> **2. Jawab lagao** — sab merge hoga aur CHECKPACK khud chalega

   Is stage ka kaam: stage-1 ke har source ko **kholna aur verify karna**, dead/
   galat URL ko **badalna**, aur har beat ka asli timestamp/dialogue/frame dena.

**Genspark ki ek-message-per-din wali dikkat**: prompts ab khud-mukhtar hain,
isliye ek din ek batch bhejo, doosre din doosra — responses folder mein jama
karte raho. Apply tool jitni files milengi utni laga dega. Koi chat memory nahi
chahiye.

**Aur ye do cheezein AI ke bina hi theek hoti hain** (`REPAIR.bat` -> 3/4):

- **cue mismatch** — `tools/fix-cues.js` narration cue ko `voiceover.srt` se
  hubahu mila deta hai. Sahi jawab pehle se aapki apni SRT mein padha hai.
- **criticality** — `tools/migrate-pack.js` har moment par HOOK / HARD_EVIDENCE /
  NORMAL bhar deta hai, aur purani `allowed_pack_ids` wali cross-episode
  permission ko approval ke liye saamne rakh deta hai.

`apply-repair.js` bharosa nahi karta — check karta hai. Jo galat hai wo pack mein
**jata hi nahi** aur console par wajah ke saath dikhta hai: doosre show ka source,
episode ki length se bahar ka timestamp, pack mein na hone wala moment_id,
do-shabd ka dialogue, ya junk replacement URL. Pack ka `.bak` bhi banta hai.
Pehle **dry run** chalta hai — dekh kar haan bolo tabhi pack badalta hai.

Bade packs (80+ moments) ke liye stage 2 ko `--part=1/2` se do accounts mein
baant sakte ho.

> **Ek hi shot mein sab kuch chahiye?** `prompts/GENSPARK_M2_5_ONE_SHOT_...txt`
> wo karta hai, par tabhi jab script chhoti ho (~8 min se kam). Lambi script par
> do-stage system kaafi zyada bharosemand hai.
>
> `prompts/GENSPARK_M1_2_ONE_SHOT_...txt` aur
> `prompts/LEGACY-research-pack-generator.txt` purane versions hain.

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
| **source sach mein khola gaya?** | `METADATA_ONLY` ka matlab hai AI ne sirf search result dekha. Us par timestamp banwana coin-flip hai |
| **GRAPHIC pack ka size** | 25% se zyada = jin beats ki research nahi hui unhe "analysis" bolkar park kiya gaya |

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

**`CHECKPACK.bat` ke baad `--apply-probe` chalana faydemand hai:**

```
node tools\check-pack.js input\scene-research.json input\voiceover.srt --apply-probe
```

Probe ne jo **naapa** hai (asli duration, captions hain ya nahi) wo pack mein
likh deta hai — research ke anumaan ki jagah. Isse do faayde: baad ke timestamps
**sahi** duration par check honge (galat duration par sahi timestamp bhi reject
ho jata hai), aur stage 2 ko wahi cheez dobara verify nahi karni padegi.
Backup `.bak` bhi banta hai.

---

## 1c. Jab research AI ne research ki hi nahi

Aisa hota hai: AI script ko **theek** beats mein baant deta hai (cues exact, poori
coverage) par live browsing nahi karta — sources `METADATA_ONLY` reh jate hain,
locators khaali ya `APPROX_WINDOW`. Aisa pack render nahi ho sakta.

Us pack ko phenkna **mat**. Segmentation sahi hai, sirf evidence missing hai —
aur wahi stage 2 ka kaam hai. Seedha `make-stage2.js` chala do (upar Step 1). Jo
sources jhoothe the, stage 2 unhe khud pakad kar badal dega, kyunki wo alag
account/session hai aur unhe khud khol kar dekhta hai.

`CHECKPACK.bat` har stage ke baad chalao — 8 second mein pata chal jayega ki
kitna aage badhe.

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

**M4.2.1 — final hardening: char jagah jahan "theek lag raha tha" par sach nahi tha**

M4.2 ne sthir `request_key` bana di thi — par poore tool ne use nahi kiya.
Ye release wahi baaki kaam hai, aur M5 editor iske contracts par khada hoga.

| Kya toota tha | Ab |
|---|---|
| `scan()` sthir key se dekhta tha par `applyToTimeline()` abhi bhi `request_id` se — renumber hote hi dashboard "reuse on, 20s bhar gaya" bolta tha aur **renderer wahi setting dhoondh hi nahi paata tha** | `requestKey()` aur `overrideFor()` — ek hi jagah. scan, apply, fingerprint, approval, ordering, trim, reuse, UI aur provenance sab isi se. Har manual shot par `manual_request_key` + `manual_request_id` dono |
| manzoori kisi cheez se **bandhi hui nahi thi** — file A approve karke usi naam se file B rakh do, purani "haan" chalti rehti thi | `DATA/manual-approvals.json` — har manzoori ke saath media, request aur input (pack/SRT/audio) ka fingerprint. Ek bhi badla to `EXPIRED`, aur `APPROVE_MEDIA.txt` ka naam `APPROVAL_EXPIRED.txt` ho jata hai (andar wajah likhi hoti hai) |
| audio ka hisaab sirf **mux ke waqt** lagta tha — timeline 896.1s, gap plan 896.1s, final 894.7s. Yaani aapse 1.4s ka aisa media manga jata tha jo baad mein kat jata. Aur **30 second tak** ka farak chup-chaap kat sakta tha | `src/timebase.js` — `project_duration = audio` sabse pehle. Timeline, gap plan, review aur render sab usi ek number par. `<= 2s` apne aap clamp, `> 2s` par run **rukta hai** aur batata hai kya theek karna hai |
| `render-manifest.json` mein `rendered: null, audio: null` — sabse zaroori do number hi gayab | `duration` block mein `audio`, `srt_end_before_clamp`, `timeline`, `rendered`, `correction`, `difference_sec` — sab asli file se |
| M4.1 ne aapke **16 folder** `_ORPHANED` mein daal diye the. M4.2 ne dobara hona to roka, par purana kaam wapas nahi laya | `node tools/recover-orphaned-media.js --dry-run` / `--apply` — key → moments+range → narration similarity. Kabhi overwrite nahi, original kabhi delete nahi, `output/orphan-recovery-report.json` |
| draft banne se **pehle** bhi "koi khaali jagah nahi — video automatic poori ban sakti hai" | `NO_DRAFT` aur `AUTO_READY` alag. Poora project-state enum (`NO_INPUTS` … `FINAL_READY`) `readiness.PROJECT_STATE` mein |
| `UPDATE_TOOL.bat` `docs/` copy hi nahi karta tha, aur update ke baad sirf "HO GAYA" likh deta tha | `docs/` ab update aur backup dono mein. Update ke baad `tools/verify-update.js` sach check karta hai: version, zaroori files ke hash, aur aapka `input/DATA/jobs/config` bacha hai ya nahi |
| `PADHO.txt` merge ke liye ek **fix number** maangta tha (`49 -> 68`) — wo galat tha, kyunki merge ek union hai | Ab sirf do baatein: **kuch khoya nahi** aur **positive union**. `merge-pack.js` khud `[THEEK HAI]` / `[RUKO]` likhta hai, aur locator / frame-hint / moments-with-hints teeno alag-alag ginta hai |

Frozen backend contracts (M5 UI inpar bharosa kar sakta hai):
`docs/M5_EDITOR_PLAN.md` → section 6.1

**M4.2 — stability: wo bugs jo 897-second run ne pakde**

Draft ban gayi (896s, 87% covered) — par teen cheezein aisi thi jo har baar
aapka kaam wapas mangwa deti:

| Kya toota tha | Ab |
|---|---|
| ek gap bharte hi baaki gaps ka **number** badal jata tha, aur folder match nahi hota tha — **16 folders** (aapke dhoondhe hue media ke saath) `_ORPHANED` chale gaye | `request_key` sthir hai (project + range + moments). Number sirf dikhane ke liye. Number badle to folder **rename** hota hai, media wahin rehta hai |
| jo request aap **bhar chuke ho** wo agli baar gap nahi rehti, isliye purana code use "ab zaroorat nahi" samajh kar orphan kar deta tha — media chala jata tha aur gap **wapas khul jata tha** | jis folder mein media hai wo kabhi orphan nahi hota. Jaata sirf tab jab script/SRT/pack hi badal jaye |
| dashboard `HYBRID READY 23/23` bolta tha, engine turant `16 CRITICAL` par ruk jata tha | `src/readiness.js` — **ek hi evaluator**. UI, CLI, gate aur job-result sab wahi poochte hain. Zaroori beat par media + saaf approval, dono chahiye |
| UI par approve ka checkbox tha hi nahi (jabki tool usi ka intezaar kar raha tha) | har critical card par laal badge + "maine ye visual dekh liya hai" checkbox. Ya folder mein `APPROVE_MEDIA.txt` |
| draft ke baad likhta tha "final.mp4 aur shot-review.html dekho" — dono thi hi nahi | `tools/print-job-result.js` — natija `job-result.json` aur disk se, exit code ke andaze se nahi. Sirf wahi files jo sach mein hain |
| audio 894.7s, timeline 896.1s — aakhir mein 1.4s ka khaali silence | audio hi aakhri sach hai; timeline usi par kat jati hai |

**Aur ek galti jo maine ki thi:** pichhle ZIP ka `reference-pack` galat file thi
— us se wo merge ho hi nahi sakta tha jo maine kaha tha. Wo file hata di. Ab
`reference-pack/PADHO.txt` aapko **aapke apne M3.6.1 folder** se merge karna
batata hai, aur koi fix count nahi maangta (M4.2.1).

Aage ka poora plan (editor, timeline, templates): `docs/M5_EDITOR_PLAN.md`

**M4.1 — asli 897-second run se: draft timeline par hi mar gaya**

M4 mein `--draft` set to hota tha, par `timeline.js` sirf `review` ko diagnostic
maanta tha. Isliye draft bhi production hi tha aur 13 HOOK/HARD_EVIDENCE beats
par timeline THROW kar gayi — render, gap plan aur DATA folders bane hi nahi.
95/0 tests pass the kyunki har hybrid fixture mein missing beats `NORMAL` the.

Aur uske peeche ek doosra, bada bug tha: **user ka media timeline ke BAAD lagta
tha.** Yaani critical beat ke liye aap file de bhi dete, wo kabhi lagti hi nahi —
timeline pehle hi mar chuki hoti.

| Kya toota tha | Ab |
|---|---|
| draft ko production mana jata tha | draft aur review, dono diagnostic |
| criticality gate timeline ke andar throw karta tha | `src/effectivegate.js` — EK gate, manual media ke BAAD, CLI/UI/tests sab wahi use karte hain |
| user media gate ke baad lagta tha | ab pehle: candidate timeline → manual media → gate → render |
| video par "MISSING 002", folder kahin nahi | gap plan render se PEHLE; label video, folder aur request.json teeno par ek |
| draft hamesha `--redo` — downloads dobara | `D` ab `--redo` nahi karta; `R` alag option hai saaf shuruat ke liye |
| draft↔final mode badalne se poora job wipe | `output.mode` config fingerprint se bahar; sirf timeline/render/report dobara |
| media badalne par timeline reuse ho jati thi | manual fingerprint badle to timeline/render/report invalidate (downloads safe) |
| ek hi kharab source par 2×165s barbaad | "zero video streams" jaisi galti = source ki kharabi; ek baar mein hi band |
| 30s cap ke bawajood 40s ka request | split ki guarantee — har request ≤30s |
| critical gap par file copy = READY | critical par saaf approval chahiye: `APPROVE_MEDIA.txt` ya dashboard ka tick |

**Aur wo cheez jisne aapke 19 locators khaye:** "purana folder replace kar do".
Ab do naye tools:

- `tools/merge-pack.js` — teen-tarfa merge. Abhi wale pack ke theek kiye hue cues
  aur criticality **jaise ke waise**; purane repaired pack se sirf wo locators/
  hints/source-health jo abhi missing hain, aur har ek validate hokar. Har
  accept/reject `output/pack-merge-report.json` mein likha jata hai.
- `UPDATE_TOOL.bat` — sirf CODE badalta hai. `input\`, `DATA\`, `jobs\` ko
  kabhi haath nahi lagata. Purane code ka backup bhi rakhta hai.

**M4 — jab footage internet par hai hi nahi (human-assisted completion)**

Ye milestone research ko behtar banane ki koshish NAHI hai. Ye us sachai ko
maan leta hai jo Candace project ne saabit ki: kuch footage public web par hai
hi nahi. P03 (movie) ke dono uploads mar chuke hain — 21 moments, ~162 second.
Genspark, Gemini, Claude, koi bhi wo clip nahi bana sakta.

Ab tak iska nateeja ye tha ki poori video hi atak jati thi. Ab:

| Ab kya hota hai | Kaise |
|---|---|
| Tool jo bana sakta hai wo **poora** bana deta hai | `--draft` mode — timeline end tak jati hai, kabhi beech mein rukti nahi |
| Khaali jagah **chhupti nahi** | laal `MISSING 001` placeholder, uspar waqt aur narration likhi hui |
| Har khaali jagah ka apna folder | `DATA/MISSING_001__02m03s-02m24s__P03_M01/` — tool khud banata hai, aapko naam guess nahi karna |
| Folder mein saaf-saaf likha hota hai kya chahiye | `WHAT_IS_MISSING.txt` — asli video-time, hubahu narration, kya dikhna/na dikhna chahiye, aur **search karne ke shabd** |
| Aap sirf files daalte ho | `media/` folder mein. Order chahiye to `01_`, `02_`, `03_` |
| Ya dashboard se | `START_UI.bat` — drag & drop, sirf 127.0.0.1 par, koi account/key nahi |
| Video phir poori ban jati hai | `HYBRID_READY` — final render tabhi jab har slot par sach mein media ho |

**Do cheezein jaan-boojh kar nahi ki gayin:**

1. Koi AI andaza nahi lagata ki aapki 10 files mein se kaunsi kis line par
   lagni chahiye. Order **aap** batate ho (filename ya drag). Jo tool nahi
   jaanta, wo jaanne ka dikhawa nahi karta.
2. Aapka media kabhi `EXACT_VIDEO` label nahi paata. Wo `USER_VIDEO` /
   `USER_IMAGE` / `USER_MONTAGE` hai, `scope_relation: USER_APPROVED` ke saath.
   Automation ka score aapki files se **kabhi nahi badalta** — warna report
   bekaar ho jati.

**Aur wo bug jisne aapke 10 cue fixes aur 109 criticality values kha liye:**
`REPAIR.bat` ke confirm prompt mein `(y/n)` likha tha — cmd.exe us `)` ko
if-block ka END samajh leta hai. Isliye option 3/4 chalte hi nahi the, aur phir
bhi `[OK] pura hua` chhap jata tha. Ab har action apni alag label par hai, aur
mana karne par saaf `CANCELLED — NO CHANGES APPLIED` aata hai.

**Preview ab rukte nahi.** Mid/weak preview download, cut aur QA sab paar kar
gaye the aur ek missing graphic par poora render ruk gaya — yaani jise dekhne ke
liye preview chalaya tha wahi kabhi bani hi nahi. Preview ab draft hai:
placeholder lagta hai aur video end tak banti hai. **Final ab bhi block hota
hai** — wo rule nahi badla.

**M3.6.1 — asli Windows run se: engine chala hi nahi tha**

Sabse bada: **CHECKPACK apni hi report ko stale kar deta tha.** `--apply-probe`
report likhne ke BAAD pack ko badalta tha, isliye report mein purana hash reh
jata tha. Nateeja — option 2 chalane ke turant baad 5/6/7 teeno production gate
par exit 3 khate the. Na align, na download, na render. User ke liye ye "sab kuch
fail ho gaya" dikhta tha, jabki engine ko chalne ka mauka hi nahi mila.

| Kya toota tha | Ab |
|---|---|
| report ka hash pack ke mutation se pehle ka hota tha | probe → pack likho → disk se reload → checks → report SABSE AAKHIR mein; likhne ke baad khud verify bhi karta hai |
| weak pack par sirf warning, poora export phir bhi chal jata | preview = DIAGNOSTIC (chalega), poora export = `pass:true` ke bina **block** |
| gate par ruka run koi repair file nahi chhodta tha | job dir gate se pehle banti hai; har block par `job-result.json` + `blocked-report.html` |
| menu sirf file dekh kar "pack check: ho chuka" likh deta tha | `tools/pack-status.js` — NOT_CHECKED / STALE / NEEDS_RESEARCH / DIAGNOSTIC_READY / PRODUCTION_READY |
| weak pack par `[FAILED]` chhapta tha (lagta tool toot gaya) | `CHECK COMPLETE — RESEARCH CHAHIYE`; `[FAILED]` sirf asli crash par |
| check-pack aur locate ke scope key alag the | ek `src/scope.js` — aur SERIES ka **air year ab show ki pehchaan nahi** (P&F ke 7 episodes 7 alag "show" ban rahe the) |
| `scope_relation` padosi moment se guess hota tha | source ka asli maalik pack se — authoritative catalog |
| purani `allowed_pack_ids` chupke se doosre episode ka footage khol deti thi | `borrow_approved` ke bina nahi, aur critical beat par kabhi nahi |
| criticality missing = sab NORMAL, gate lagta hi nahi | poora export block; `tools/migrate-pack.js` se migrate |

**Aur repair loop poora badla** — yehi Genspark ki ek-message-per-din wali dikkat
ka asli hal hai:

- `tools/repair.js` — chhote **khud-mukhtar** prompts (12–18 moments), jo kisi
  bhi nayi chat/account mein chalte hain. "Usi chat mein paste karo" har jagah
  se hataya gaya.
- `tools/apply-repair.js` — `research-repair-v2`: cue, criticality, locators,
  frame hints, allowed packs/sources, borrow approval, overlay, source
  add/replace/update. Permissions **hints se pehle** lagti hain (pehle naya hint
  purane scope par reject ho jata tha). Ek saath kitni bhi response files.
- `tools/fix-cues.js` — cue mismatch **local SRT se** theek, koi AI call nahi.
- Repair batches ab un moments ko bhi lete hain jinka locator MAUJOOD hai par
  CHECKPACK ne use toota sabit kiya (pehle wo kisi batch mein aate hi nahi the).

**M3.6 — foundation hardening (teeno preview ke audit se)**
Weak preview FAIL hua tha par launcher ne "Ho gaya" likh diya, aur error ne jis
`NEEDS_SOURCE.csv` ko dekhne bola wo bani hi nahi thi. Ye sab ab band hai.
- **`START_HERE.bat` ab exit code padhta hai** aur `final.mp4` bhi check karta
  hai. Fail par saaf `[FAILED]` + jo files SACH mein bani hain unki list.
- **Fail par bhi repair package** — har job ab `job-result.json` (SUCCESS/FAILED),
  `NEEDS_SOURCE.csv` aur `blocked-report.html` chhodta hai, chahe render beech
  mein ruk jaye. Report kabhi aisi file ki taraf ishara nahi karti jo maujood na ho.
- **Production gate** — preview/full render ke liye ab is pack aur is SRT ka
  **taaza** `pack-report.json` chahiye (hash se tied). Nahi hai to exit 3 aur
  saaf hidayat. Sirf dekhne ke liye `--diagnostic-override`.
- **Episode-level scope** — "same show" ka matlab "same episode" nahi. Default
  fallback ab episode ke andar rehta hai; doosre episode ka footage tabhi jab
  research ne `allow_context_borrow: true` kaha ho, aur CRITICAL beats par kabhi
  nahi. (Asli mid preview mein P06 ko P01 ka episode mil gaya tha.)
- **Planned vs actual provenance** — har shot par `planned_source_id`,
  `actual_source_id` aur `scope_relation` alag likhe jate hain; shot-review par
  "ye exact scene NAHI hai" saaf dikhta hai.
- **Recovery safety** — `acquireFullSource` ab metadata KHUD load karta hai
  (caller par nirbhar nahi). Duration pata na chale to full download se inkaar,
  cap dono jagah lagta hai, per-source circuit breaker (2 fail = us run mein
  band), aur `.part` files saaf hoti hain.
- **`criticality` missing** ab validator warning hai (count ke saath) — pehle
  chupchap NORMAL ban jati thi, yaani gate lagta hi nahi tha.
- **Review dashboard** (`option 9`) — teeno preview ek jagah, verdict ke saath ki
  full render chalana chahiye ya nahi.
- 8 naye regressions (T-M361..368). Suite ab **68 PASS / 0 FAIL**.

**M3.5 — doosre asli preview se**
- **Lambi source par range download bharosemand nahi hai** — ye ab naapa hua
  sach hai: 1351s ka episode POORA 11.8s mein aaya, jabki usi source ka ek
  range download 300s par do baar ETIMEDOUT hua. Isliye 10 minute se lambi
  source ab EK moment ke liye bhi poori laayi jati hai (`rangeUnsafeAboveSeconds`).
- **Range fail ho to poori source se RECOVERY** — pehle source haar kar chhod
  diya jata tha aur us moment ka clip khatam. Ab ek baar poora download try
  hota hai (cap ke andar).
- Range timeout 300s → 180s (poora download hi ~12s ka hai, 300s intezaar bekaar).
- **Preview ka audio message ab saaf hai** — preview mein voiceover poori hoti
  hai par timeline sirf window jitni; wo normal hai, mismatch nahi. Ab wo INFO
  line hai, warning nahi.

**M3.4 — pehle asli preview se mile fixes**
Ye sab tabhi mile jab asli YouTube ke saath 120-second preview chalaya gaya.
Synthetic fixtures inme se ek bhi nahi pakad sakte the.
- **Range download har baar 300s par ETIMEDOUT ho raha tha** (6 mein se 5 moments
  khoye). Wajah: `--force-keyframes-at-cuts`, jo yt-dlp se poori stream RE-ENCODE
  karwata hai. Flag hata diya — frame-accuracy waise bhi `cut.js` deta hai jo
  range ke andar `-ss/-t` se dobara encode karta hai.
- **22-minute episode full-download se reject ho raha tha** (`cap 900s`), phir
  range bhi fail — yaani us source se kuch bhi nahi milta tha. Ab cap uses-aware
  hai: jo source kai moments ko chahiye use `fullDownloadHardMaxSeconds` (2400s)
  tak poora laate hain; variety/fallback ke liye purana 900s cap.
- **Ek hi hint moment ke DO lagatar shots par lag jata tha** — screen par 8-11
  second wahi frame, freeze jaisa. Ab har shot alag hint leta hai; hints khatam
  hon to rotate hota hai, par lagatar repeat kabhi nahi.
- **Analysis beats ka overlay text gayab ho gaya tha.** M3.3 mein hint-backed
  visual ko pehle chunne se GRAPHIC beats plain still ban gaye the — "Nothing."
  jaisi thesis line screen par likhi hi nahi jati thi. Ab analysis beat ka
  hint-backed frame media-backed GRAPHIC banta hai (frame + dim + text).
- **CHECKPACK bina SRT ke alignment "OK" bol deta tha.** Asli run mein 31/109
  moments REVIEW/AMBIGUOUS nikle jabki report ne "0" kaha tha — kyunki us waqt
  `voiceover.srt` input mein tha hi nahi. Ab wo check saaf bolta hai ki chala hi
  nahi.
- 3 naye regressions (T-M338..340). Suite ab **60 PASS / 0 FAIL**.

**M3.3 — reliability release**
- **P0 renderer honesty.** Har branch ki condition mein `fs.existsSync` tha, isliye
  missing file par execution agli branch mein gir kar generic text card bana deta
  tha — par manifest planned label (`EXACT_VIDEO`/`CONTEXT_VIDEO`) hi rakhta tha.
  Ab asset pehle absolute path par resolve hota hai, `kind` par switch hota hai,
  aur label wahi likha jata hai jo SACH mein bana. Missing media par verified
  fallback state machine chalti hai; production mein koi verified alternate na ho
  to export rukta hai. Fixtures par ye bug live tha (`CONTEXT_VIDEO` label,
  screen par card) — ab decoded-pixel tests isse pakadte hain.
- **`sourceMediaPath` path bug.** Local-file sources ROOT-relative path dete the
  aur render unhe job-relative maanta tha — valid source "missing" lagta tha.
- **Frame hints exact second par** (`materializeHint`): pehle uniformly-sampled
  bank se nazdeeki frame milta tha — 1351s source par ~11s aur 4052s par ~34s tak
  galat. Ab hint par apna frame nikalta hai, aur manifest mein
  `hint_time`/`hint_delta` likha jata hai.
- **Hint-backed visual ab generic context se PEHLE** chunta hai.
- **Hint-only sources bhi index hote hain** — pehle sirf un sources ka bank banta
  tha jinse clip kati thi, isliye analysis beats ke hints bekaar jaate the.
- **Scope-strict fallback.** Neighbour se udhaar sirf same `scope_key` par
  (ab year/version bhi shaamil), warna honest khaali. Cross-show bleed band.
- **`criticality` ab gate hai.** HARD_EVIDENCE ko exact clip chahiye, HOOK ko
  exact clip ya materialized hint — warna production export rukta hai.
- **Cut-failure par alternate candidate retry** (pehle seedha NEEDS_SOURCE).
- **`--redo` ab `render-manifest.json` bhi hataata hai** (warna purane percentages).
- **Acquisition:** `noClipCount` cut se PEHLE `!e.clip` dekhta tha, isliye har
  fresh project mein context-variety downloads trigger ho jaate the. Full-download
  cap ab `acquireFullSource` ke andar hai (lazy/variety paths bhi cover), aur bank
  video-only aata hai (final mein source audio waise bhi mute hai).
- **Preview SRT rebase.** Moments 0 se shuru hote the par timeline asli SRT padhta
  tha — 300s wala preview apne cuts SRT ki shuruat par snap karta tha.
- **`shot-review.html`** — final render se har shot ka thumbnail + narration cue +
  must_show/must_not_show + source/time + hint delta, aur galat shots ki CSV.
- **CHECKPACK:** DIALOGUE `REVIEW` ab exact nahi gina jata (production usse clip
  banata hi nahi).
- **Windows:** `.cmd`/`.bat` tools ab shell ke through chalte hain (T-JS failure).
- **`START_HERE.bat`** — ek menu jisme har step aur "kab karna hai" likha hai.
- 7 naye decoded-pixel regressions (T-M331..337). Suite ab **57 PASS / 0 FAIL**.


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
- **Naya canonical prompt** `prompts/GENSPARK_M2_5_ONE_SHOT_...txt` — one-shot ke
  liye likha gaya (Genspark ka 1-message-per-day limit). Isme wo paanch galtiyan
  naam lekar band ki gayi hain jo asli packs mein measure hui thi, aur coverage
  ab seconds mein maangi jati hai.
- **Split mode + `tools/merge-packs.js`** — lambi script ko 2-3 accounts par
  baant kar chalao aur locally merge karo. ID collision par automatic prefix
  (saare references bhi rewrite hote hain), duplicate sources report hote hain,
  aur scope-title mismatch sirf batata hai — apne-aap merge nahi karta
  (`--unify-titles` explicitly maango), kyunki "Naruto" aur "Naruto Shippuden"
  sach mein alag show hain.
- **`tools/make-stage2.js` + `tools/apply-stage2.js`** — jab research AI segmentation
  to sahi kare par live research na kare, tab us pack ko bachane ke liye. Focused
  prompt (sirf locators maangta hai) + validating merge jo galat entry ko andar
  ghusne nahi deta.
- **Two-stage research** — `prompts/STAGE1_SOURCES_AND_BEATS_PROMPT.txt` (beats +
  asli sources dhoondho, timestamps nahi) + `tools/make-stage2.js` (verify +
  timestamps maangne wala prompt) + `tools/apply-stage2.js` (validating merge).
  Stage 2 stage-1 ke dead/galat sources ko replace bhi kar sakta hai; junk URL
  aur unknown source_id refuse hote hain, aur timestamps corrected duration par
  check hote hain.
- **CHECKPACK ab do aur cheezein pakadta hai** — `METADATA_ONLY` sources (AI ne
  search mein dekha, khola nahi) aur 25% se bada GRAPHIC pack. Dono pack ke apne
  fields se check hote hain, AI ki self-report se nahi.
- **CHECKPACK ka naapa hua sach ab stage 2 tak jata hai** — `make-stage2.js`
  `output/pack-report.json` padh kar har source ko `[CONFIRMED WORKING]` (asli
  duration + captions ke saath) ya `*** CONFIRMED DEAD — REPLACE ***` mark karta
  hai, aur wo dialogue lines bhi naam se batata hai jo asli captions mein nahi
  mile. Stage 2 ko wahi kaam dobara nahi karna padta.
- **`--apply-probe`** — naapi hui duration/captions pack mein likh deta hai.
- **Enum normalization** — `apply-stage2` ab AI ke near-miss enums (`WATCHED`,
  `LICENSED_CLIP`) ko sahi value par map karta hai; jo pehchana na jaye use
  chhod deta hai. Pehle wo seedha pack mein chala jata tha aur schema todta tha.
- 26 naye regression tests (T-PACK1..9, T-MERGE1..5, T-S21..29, T-S210..212).
  Suite ab **49 PASS / 0 FAIL**.

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
