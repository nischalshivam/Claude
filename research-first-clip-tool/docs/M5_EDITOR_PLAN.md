# M5 — Editor aur Template System ka poora plan

Ye document batata hai ki UI kaisa banega, usme aap kya control karenge, aur tool
apne aap kya karega. M4.2 (stability) ho chuka hai; ye uske upar banta hai.

---

## 1. Poora raasta — 6 stage

```
1. INPUT        script + voiceover + SRT + research JSON
2. RESEARCH     pack ka imaandar report card
3. RAW DRAFT    poori video, sirf clips — koi effect nahi
4. EDITOR       aap clips theek karte ho, gaps bharte ho, lock karte ho
5. TEMPLATE     ab jaake animation/transition/style lagti hai
6. EXPORT       final.mp4
```

**Sabse zaroori usool:** stage 4 se pehle tool koi animation, transition, effect,
music ya filter nahi lagata. Sirf sahi clip, sahi jagah. Aap pehle *kya dikh raha
hai* theek karte ho; *kaisa dikh raha hai* uske baad aata hai.

Aur stage 5 kabhi content nahi badalta — na clip, na trim, na narration timing.

---

## 2. Kya aapke haath mein, kya tool ke

| Aap decide karte ho | Tool khud karta hai |
|---|---|
| script, voiceover, SRT, research JSON | schema check, hashing, dependency check |
| hybrid workflow accept karna | alignment, download, cut, local QA |
| missing jagah par media dena | gap dhoondhna, stable request ID, provenance |
| clip replace / reject karna | scope lock (galat episode kabhi nahi) |
| trim in/out, crop, zoom, fit | slot ki timing (narration se bandhi hui) |
| zaroori beat approve karna | blocking rules, approval invalidation |
| content lock | snapshot, manifest, cache invalidation |
| template + intensity chunna | deterministic template expansion |
| export format/resolution | FFmpeg graph, retry, output validation |

**Tool ye kabhi chup-chaap nahi karega:** galat show/episode ka footage lagana,
card ko "media" bolna, zaroori beat khud approve karna, aapka chuna hua media
badalna, narration timing badalna, ya aisi file ka naam lena jo bani hi nahi.

---

## 3. Editor ka layout

Dark, desktop jaisa, browser mein — `START_UI.bat` se khulega.

```
┌───────────────────────────────────────────────────────────────────┐
│ Project | Undo Redo | Assembly>Lock>Style>Export | auto 67% ▸ done 100% │
├──────────┬────────────────────────────────────┬───────────────────┤
│ LEFT     │        PREVIEW (16:9)              │  INSPECTOR        │
│          │                                    │                   │
│ Missing  │   [ video / image dikh raha hai ]  │  narration line   │
│ Media    │                                    │  must show / not  │
│ Beat     │   ▶ ⏸  ◀▏▕▶   02:14 / 14:57        │  ─────────────    │
│ Rejected │                                    │  source in/out    │
│ Search   │                                    │  replace / alt    │
│          │                                    │  crop zoom fit    │
│          │                                    │  approve (critical)│
├──────────┴────────────────────────────────────┴───────────────────┤
│ V2  overlays/titles                    (Style stage mein khulega) │
│ V1  ██exact ██context ██still ██user ██MISSING  ← main track      │
│ C1  captions                                                      │
│ A1  ▁▂▄█▄▂▁ voiceover (locked)                                    │
│ A2  music / SFX                        (Style stage mein khulega) │
└───────────────────────────────────────────────────────────────────┘
```

**Rang ka matlab** (ek nazar mein pata chale kya kahan se aaya):
green = exact clip · blue = context · purple = still/hint · orange = aapka media ·
red = MISSING · teal = graphic.

### Left panel — 5 tab

1. **Missing** — jo jagah abhi khaali hain, waqt ke hisaab se. Sabse upar wahi
   jo zaroori (HOOK/HARD_EVIDENCE) hain.
2. **Project Media** — jo download ho chuka, keyframes, aur aapki di hui files.
3. **Is Beat ke liye** — selected slot ke liye tool ke suggestions + alternates.
4. **Rejected** — jo aapne hataya (undo ke liye rakha rehta hai).
5. **Search Help** — hubahu narration, must-show/must-not-show, aur copy karne
   layak YouTube/Image search queries.

Kisi bhi tile ko timeline par drag karo — wo sirf ek *decision* banata hai. Asli
file kabhi move/delete nahi hoti.

### Preview

- Play/pause, frame step, agla/pichhla cut
- Fit modes: **Fill / Fit / Blur background / Original** — portrait media kabhi
  stretch nahi hoga
- Crop aur position seedha preview par handles se
- Speed ke liye chhota proxy; "full quality frame" button jab detail dekhni ho
- Har shot par ek chhota badge: Auto Exact / Auto Context / Hint Still / Aapka
  Media / Missing

### Inspector (right)

Upar: is beat ki narration line, must-show, must-not-show, aur source kahan se
aaya. Neeche controls:

- source In/Out (slot ki lambai fix rehti hai)
- replace / alternate dhoondho / pichhla-agla asset
- split, duplicate, delete/restore
- crop X/Y, zoom, rotate, opacity, fit mode, blur strength
- source audio hamesha mute (narration hi master hai)
- "ye galat hai" — galat character / galat show / reaction host / watermark
- **zaroori beat par approve checkbox** (bina iske final nahi banegi)
- reset — tool ke automatic faisle par wapas

### Timeline

- Waveform aur SRT cue ribbon hamesha dikhte hain
- Cue aur shot boundary par snap
- **Default: slot-locked.** Trim karne se slot nahi khiskta — sirf uske andar ka
  source badalta hai. Isse narration kabhi out of sync nahi hoti.
- Ripple editing (slot khiskana) chhupa hua hai, warning ke peeche
- Red marker = blocker, amber = warning, green = approved
- `G` dabao → agle gap par chala jayega

Shortcuts: `Space` play · `J/K/L` · `←/→` frame · `↑/↓` cut · `S` split ·
`R` replace · `F` fit/fill · `G` next gap · `Ctrl+Z/Y` undo/redo

---

## 4. Content Lock

Style tab tab tak band rahega jab tak:

- koi missing slot na ho
- koi gap/overlap na ho
- har zaroori beat approve ho
- koi file kharab/gayab na ho
- video ki lambai audio se match kare
- aapne **Lock Content** dabaya ho

Lock ek snapshot banata hai. Baad mein content badla to Style apne aap unlock ho
jayega (par aapki template settings bachi rahengi).

---

## 5. Template system — 20-30 variations

Aapka idea sahi hai. Bas ek zaroori baat: **30 alag render systems nahi banenge.**
6 reusable style systems banenge aur 24-30 presets unhi se bante hain — data ke
roop mein, code ke roop mein nahi. Warna ek bug 30 jagah theek karna padega.

Template ye control karta hai:

- caption ka font, jagah, emphasis
- frame/border/background treatment
- still image ka movement (none / slow push / pan / halka parallax)
- transition family aur duration
- text-card aur callout ka style
- colour grade, contrast, grain, vignette
- overlay/texture
- SFX aur music ducking
- motion intensity aur pacing
- kaunsa effect kis tarah ke asset par lagega

**Pakke niyam:**

- Same content lock + same template + same seed = **bilkul same video**
- Template kabhi clip, trim, approval ya narration timing nahi badalta
- Transition slot ke andar hi rehta hai — total duration nahi badalti
- Har shot par effect alag se band kiya ja sakta hai
- Har cut par transition **nahi** — shot ki lambai dekh kar
- Poori video par lagane se pehle 15-30 second ka preview

Pehli baar mein **4 presets** poore validate honge (Clean Essay, Cartoon Pop,
Anime Impact, Archive Film), phir baaki data ke roop mein add honge:

Clean Essay · Clean Documentary · Editorial News · Premium Minimal ·
Cinematic Dark · Cinematic Warm · True Crime · Archive Film · Retro TV ·
VHS Nostalgia · 90s Kids TV · Cartoon Pop · Cartoon Clean · Comic Panels ·
Anime Clean · Anime Impact · Manga Mono · Neon Tech · Sci-Fi HUD · Scrapbook ·
Polaroid · Dark Gallery · Fast YouTube · Calm Longform · Sports Energy ·
Documentary Maps · Documentary Archive · Studio Purple · High Contrast Red ·
Soft Pastel

---

## 6. Project ka data — kuch bhi mitega nahi

`scene-research.json` aur `timeline.json` editor ka database nahi banenge. Ek
alag **EDL (Edit Decision List)** banegi:

```
projects/<id>/
  project.json
  inputs/manifest.json
  research/scene-research.json     ← research, kabhi editor se nahi badalti
  assembly/auto-timeline.json      ← tool ka automatic faisla
  assembly/edit-decision-list.json ← AAPKE faisle
  assembly/gap-plan.json
  style/style.json
  revisions/<timestamp>.json       ← har bade kaam se pehle snapshot
  cache/proxies/  cache/thumbs/
  exports/<id>/
```

Har clip EDL mein: timeline start/end, source in/out, transform (crop/zoom/fit),
provenance (auto exact / user media / kaunsa source), aur approval.

- Atomic write (temp + rename), autosave, undo/redo
- Har bade badlav se pehle revision snapshot
- Asli media hamesha read-only — trim/crop sirf EDL mein
- Asset ki pehchaan SHA-256 se, path se nahi (file khiskane par kuch nahi tootega)

---

## 7. Technical

- Backend wahi Node engine hai jo abhi hai — file aur process ka kaam sirf wahi karta hai
- UI: React + TypeScript + Vite, build karke usi localhost server se serve
- Sirf `127.0.0.1`, session token, path containment, upload limit
- Preview ke liye chhote proxy + thumbnails + waveform backend banata hai
- **Final render hamesha FFmpeg se** — browser se nahi. Browser ka WebCodecs
  container muxing deta hi nahi, aur FFmpeg pehle se proven aur deterministic hai
- Template kabhi raw FFmpeg string nahi — ek typed allow-list, taaki UI se koi
  command inject na ho sake

API (versioned, aur har mutation apni EDL revision bhejta hai taaki purana tab
naya kaam overwrite na kar de):

```
GET  /api/v1/projects/:id/state
POST /api/v1/projects/:id/draft
PATCH /api/v1/projects/:id/edl
POST /api/v1/projects/:id/assets
POST /api/v1/projects/:id/requests/:key/approve
POST /api/v1/projects/:id/content-lock
POST /api/v1/projects/:id/style-preview
POST /api/v1/projects/:id/export
GET  /api/v1/jobs/:id/events        (live progress)
```

---

## 8. Export se pehle ke gates

**Block karenge:** koi missing/gap/overlap · kharab ya gayab asset · bina approval
wala zaroori beat · galat scope ka media · audio/timeline mismatch · production
mein placeholder · output probe fail · approval ke baad badla hua media.

**Warning denge (aap chaho to aage badh sakte ho):** low resolution · portrait ·
ek image bahut der · aas-paas duplicate · watermark/host ka risk · udhaar context ·
zyada graphics.

Export ke saath milega: `final.mp4`, `export-result.json`, `render-manifest.json`,
`quality-report.html`, `shot-review.html`, `edl.snapshot.json`,
`style.snapshot.json`, `run.log`.

---

## 9. Delivery — kis order mein

| | Kya | Kya milega |
|---|---|---|
| **M4.2** | stability (ho chuka) | stable IDs, ek sach, sahi messages, audio timebase |
| **M5.0** | UI + raw editor | project screens, missing-media UI, preview, inspector, timeline, EDL, undo/redo, content lock — **koi effect nahi** |
| **M5.1** | template engine | typed schema, short preview, 4 validated templates, per-shot override |
| **M5.2** | preset library + niche | 24-30 presets, anime/documentary/Hollywood profiles aur pilots |

Har stage ke baad aapke asli project par acceptance chalega — sirf synthetic
tests par "ho gaya" nahi bolenge.

---

## 10. Cross-niche

Engine ek hi rahega, policies alag:

- **Cartoon / anime** — show + season + episode ka sakht scope; dialogue aur frame
  evidence; AMV/reaction/recap se door; analysis ke liye same-show montage theek
- **Film** — title + year ka scope; official clips/trailers/interviews; exact scene
  aur trailer ko alag ginna
- **Documentary** — `image_candidates`, archive photos, maps, documents; source
  URL aur license saath rakhna; image pan/zoom ko kabhi "exact video" nahi kehna

Cross-niche "production ready" tabhi bolenge jab teeno par 3-5 minute ki poori
pilot chal jaye — gap stability, manual fill, content lock, style preview aur
final export ke saath.
