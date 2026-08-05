# KNOWN LIMITATIONS — M5.0-B (imaandar list)

## M5.0-B — pro editor + EDL→render parity

Is release ne GPT/Codex ke editor patch ko adopt kiya (verify karke, blindly
nahi) aur uska sabse bada bacha hua P0 khud fix kiya:

**Ab SACH mein chalta hai (asli test se proven):**
- **Editor player**: voiceover-master play/pause, scrub, timecode, moving
  playhead, prev/next shot, Space/arrow keys, browser-safe proxy (MKV/AV1/VP9
  ke liye) — Codex ka, adopt kiya.
- **18s gap = 1 file poora bhare; 10 file = 10 barabar shot**; chhoti video loop
  ho kar poora gap bharti hai. (m5b-contract 8/0)
- **P0-A EDL→render parity (main naya fix)**: editor mein kiya crop/scale/fit/
  trim ab FINAL `final.mp4` mein sach mein lagta hai — pehle sirf preview mein
  dikhta tha. Pixel-verified: `crop_x=0`→baayaan half, `crop_x=1`→daayaan half;
  timing kabhi nahi badalti; `render-manifest.json` mein `edl_parity` block +
  har shot par `edl_applied`. Mismatch par final BLOCK hota hai. (edl-parity 6/0)
- **Missing-scenes note** (scene-wise, ready-to-copy) + **2 ChatGPT prompts**
  (Stage1 script map, Stage2 missing-scene research — Stage2 note ke saath
  auto-bhara) Missing Media page par.
- **Recoverable remove** (`.trash`), media ordering, "Media editor mein lagao"
  (bina full render ke sync).

**Abhi bhi seemayein (aage):**
- Multi-shot ke aage full timeline drag/split/ripple — abhi slot-locked edit.
- Style templates/transitions/effects — Content Lock ke baad (M5.1). Abhi koi
  transition/effect nahi.
- Offline Whisper (asli transcription) optional mode — abhi auto-SRT estimated hi
  hai (real .srt daalo to wahi jeetega).
- Streaming upload/proxy worker-queue (bade uploads abhi RAM mein aate hain).
- Queue aur real multi-project Library abhi placeholder.
- UI browser-test: is environment mein browser nahi chala sakta; API + parity
  asli ffmpeg se test kiye (server 15/0, m5b 8/0, parity 6/0, regression 133/0,
  content 13/0). Screen par kuch ajeeb dikhe to batana.

---

# KNOWN LIMITATIONS — M5.0-A.2 (imaandar list)

## M5.0-A.2 — naya "Movie Editor" design + sab UI se

Ab UI wahi design language use karta hai jo aapko pasand tha (sidebar, dark/light
theme, cards, badges). Aur ye sab **UI se** ho jata hai — koi folder drag nahi:

- **In-UI inputs**: research pack (.json), voiceover (mp3/m4a/wav — auto-detect),
  clean script (paste ya .txt) — sab New Video screen se upload. (server-test T-SRV11..13)
- **Auto-SRT**: script + audio se estimated `voiceover.srt`. (T-SRV13)
- **Fresh start**: purana sab `archive/<ts>` mein move (delete kabhi nahi), naya
  project shuru. (T-SRV14)
- **Genspark prompt** UI panel + `/genspark-prompt`. (T-SRV15)

### Iski honest seemayein
- **Auto-SRT anumaan-timing hai**, asli transcription nahi. Offline Whisper (model
  download) is tool ke zero-install waade ko todta hai, isliye nahi rakha. Timing
  ±kuch second ho sakti hai — draft ke liye theek, editor mein fine-tune. **Aapke
  paas asli .srt (TTS/Whisper) ho to wahi daalo — tool usi ko lega.**
- **Library screen** abhi coming-soon. Design mein wo "apni movies index karo"
  wali thi; is tool ki sourcing abhi research-pack (Genspark/online) se hoti hai —
  wahi aapka asli flow hai. Local-movie indexing alag engine hai, baad mein.
- **Queue** abhi coming-soon (design + placeholder maujood). Batch (5-10 video)
  aage aayega; abhi ek waqt mein ek project.
- **"Look" presets** (Cinematic/Tense/Documentary) abhi sirf chun ke rakhne ke
  liye — effect Content Lock ke baad (M5.1) lagega.
- **UI browser-test**: main is environment mein browser nahi chala sakta, isliye
  API poori tarah test ki (server-test 15/0) aur ek live draft server ke through
  chalaya. Visual layout design se milaya, par pixel-level browser QA aapke saath
  pehli baar hoga — kuch bhi ajeeb dikhe to batana, turant theek karunga.

---

# KNOWN LIMITATIONS — M5.0-A (imaandar list)

Ye woh cheezein hain jo M5.0-A mein JAAN-BOOJH kar abhi nahi ki gayi, ya jo aage
ke milestone mein aayengi. Koi "10/10" dawa nahi — jo chal raha hai wo asli test/
artifact ke saath, aur jo baaki hai wo saaf-saaf.

## Kya ABHI SACH MEIN chalta hai (proven)

| Kaam | Proof |
|---|---|
| Do mandatory fix (expired approval approvedKeys se bahar; updater exit code) | regression `T-M50A1`, `T-M50A2` |
| Local server, token gate, path containment | server-test `T-SRV1,2,6,10` |
| Canonical `PROJECT_STATE` (UI kabhi khud calc nahi karta) | `T-SRV3` |
| Missing-media list stable key + criticality se | `T-SRV4` |
| EDL `project-edl-v1` draft se banti, tokens only | `T-SRV5` |
| media token allow-list (bogus token 404) | `T-SRV6` |
| EDL patch + revision + `409` on stale + disk persist | `T-SRV7,8` |
| upload → approve → APPROVED; bytes badle → EXPIRED | `T-SRV9` |
| **"Draft banao" button server ke through asli draft.mp4 + gap-plan + EDL banata hai** | live draft run: `READY_TO_RESEARCH → NEEDS_MEDIA`, 2 EDL shots (AUTO_CONTEXT + MISSING), 1 stable-key request |
| Poore backend (897s wale sab bug) | regression 133/0, content 13/0 |

## Deliberate deviation: React+Vite ki jagah no-build UI

Spec React + TypeScript + Vite maangti hai. Maine M5.0-A mein UI ko ek **single
self-contained page** (vanilla JS, koi build step nahi) rakha, isi Node server se
serve hoti hai. Wajah:

1. **Zero-install / offline-first** is tool ki jaan hai. React+Vite ka toolchain
   (~200MB `npm install`, network chahiye) us waade ko tod deta — aur aapke saath
   pehle "download/install" wale steps hi sabse zyada toote hain.
2. Is build environment mein main browser UI ko **runtime-test nahi kar sakta**.
   3000 line untested React bhej kar aapko blank-screen par 5 din phansana galat
   hota. No-build page + poori tarah tested API zyada bharosemand hai.
3. API poori tarah framework-agnostic hai (`docs/API_CONTRACT.md`). React/Vite
   frontend baad mein isi contract par baith sakta hai bina backend chhue.

Agar aap React+Vite hi chahte ho, to M5.1 ke saath migrate kar dunga — API waisi
ki waisi rahegi. Abhi priority: chalne wala editor foundation.

## Abhi NAHI (M5.0-B / aage)

- **EDL edits → render**: crop/scale/trim EDL mein save hote hain aur preview par
  dikhte hain, par abhi ASLI ffmpeg render mein nahi jaate. Final render abhi
  DATA-folder + approval waala (tested) rasta use karta hai. EDL→ffmpeg bridge M5.0-B.
  (Missing-media upload/approve/reuse render ko ABHI bhi affect karte hain.)
- **Undo/redo**: EDL ka har save revision snapshot banata hai (`project/revisions/`),
  par ek full undo/redo stack UI mein abhi nahi. Reload se kaam bacha rehta hai.
- **Split / reorder / multi-select / ripple** timeline ops: M5.0-B.
- **Content Lock + Style + templates**: M5.1 se. Abhi koi transition/effect/music nahi.
- **Multi-project home screen**: abhi ek hi "current" project (aapka `input/`).
  Multi-project layout (`projects/<id>/`) baad mein.
- **Waveform / proxy** timeline: abhi thumbnails hain, poora waveform track M5.0-B.
- **`allow_reuse` strict mode**: abhi reuse transparency-warning deta hai
  ("N jagah wahi file dobara lagi — ~M file do"), block nahi karta. Strict
  "require unique media" M5 editor setting M5.0-B/M5.1.
- **J/K/L, frame-step, full keyboard map**: partial. Basic click-to-select + inspector hai.

## Acceptance jo AAPKI machine par baaki hai

Ye synthetic tests kaafi nahi — asli gate aapka Candace project hai. `docs/M50B_ACCEPTANCE.md`
mein 13-point checklist hai. Jab tak wo aapke asli 897-second project par pass na
ho, main "M5.0-B complete" nahi bolunga aur templates shuru nahi karunga.
