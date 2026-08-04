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
