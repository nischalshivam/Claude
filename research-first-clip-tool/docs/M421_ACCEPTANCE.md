# M4.2.1 — Acceptance gate (asli Candace project par)

Unit tests kaafi nahi hain. M5 ka UI kaam tabhi shuru hoga jab **aapke apne
897-second wale project** par ye poora raasta ek baar chal jaye aur aakhir mein
`final.mp4` bina ek bhi placeholder ke bane.

Har step ke saath likha hai ki **kya dikhna chahiye** — wahi sabse zaroori hai.
Agar kahin alag dikhe, wahin ruk kar wo line bhej dena.

---

## Step 1 — Update

```
NAYE folder mein: UPDATE_TOOL.bat  ->  purana folder drag  ->  y
```

Dikhna chahiye:

```
UPDATE CHECK — sach mein kya laga aur kya bacha
  version   : 4.2.1
  NAYA CODE:  [ok] src\ tools\ lib\ prompts\ schemas\ tests\ docs\
              [ok] 11 zaroori file maujood aur naye code se match kar rahi hain
  AAPKA KAAM: [surakshit] input  DATA  jobs  output  config.json
  purane code ka backup: _backup_code_NNNN
```

`docs\` par `[NAHI AAYA]` dikhe to update aadha hua hai — dobara chalao.

---

## Step 2 — Purana media wapas

```
node tools\recover-orphaned-media.js --dry-run
node tools\recover-orphaned-media.js --apply
```

Dikhna chahiye: har `[WAPAS]` line ke saath `EXACT` ya `STRONG`, aur
`output\orphan-recovery-report.json`.

`[SHAYAD]` wale folders tool khud nahi lagata — report dekh kar aap decide karo.

**Check:** jitne folders `_ORPHANED` mein the, unke media ab kisi na kisi
`MISSING_...` folder ke `media\` mein hone chahiye. `_ORPHANED` mein files
**abhi bhi** hongi (delete nahi hoti) — ye jaan-boojh kar hai.

---

## Step 3 — Evidence merge (agar M3.6.1 folder maujood ho)

```
node tools\merge-pack.js input\scene-research.json "C:\...\M3.6.1\...\input\scene-research.json"
```

Dikhna chahiye:

```
locators (EXACT_TIME/DIALOGUE) : A -> B   (+N)
frame hints (alag-alag frame)  : C -> D   (+M)
moments par locator            : ...
moments par frame hint         : ...
[THEEK HAI] Kuch khoya nahi, aur N nayi validated cheezein aayi hain.
```

Koi fix number expect **mat** karo (68 nahi, kuch bhi nahi). Sirf ye do:
kuch ghata nahi + kuch naya aaya. Theek lage to `--apply`.

---

## Step 4 — Pack check

```
START_HERE.bat -> 2
```

`5 check fail` jaisa message normal hai — wo raw research pack ka score hai.

---

## Step 5 — Draft

```
START_HERE.bat -> D
```

Dikhna chahiye:

- `timebase:` line (agar audio aur SRT mein farak hai)
- run beech mein kabhi na ruke
- `draft.mp4` bane, uske andar `MISSING NNN` cards hon
- `DATA\` mein utne hi folder jitne cards

**Check karo — `jobs\<naam>\render-manifest.json` -> `duration`:**

```json
"duration": {
  "audio": 894.700,
  "srt_end_before_clamp": 896.100,
  "timeline": 894.700,
  "rendered": 894.72,
  "correction": "CLAMPED_SRT_TAIL",
  "difference_sec": 1.400
}
```

Koi bhi `null` nahi hona chahiye. `timeline` aur `audio` barabar hone chahiye.

Agar run yahan `AUDIO_TIMEBASE_MISMATCH` par ruk jaye — ye **theek** hai. Iska
matlab hai voiceover aur SRT mein 2 second se zyada ka farak hai. Screen par
likha hoga kya karna hai. Pehle wo tool 30 second tak chup-chaap kaat deta tha.

---

## Step 6 — Media bharo

Har `DATA\MISSING_...` folder ke `media\` mein apni files.

Critical (HOOK / HARD_EVIDENCE) folders mein `APPROVE_MEDIA.txt` bhi.

**Check:** `START_UI.bat` kholo. Jo dashboard bolta hai wahi engine bhi bolega —
`READY_FOR_CONTENT_REVIEW` tabhi jab sach mein sab bhara ho.

**Ek baar ye bhi test kar lena** (30 second lagenge, par isi se pata chalega ki
manzoori sach mein bandhi hui hai):

1. Kisi critical folder ko approve karo — card hara ho jayega
2. Us folder ki koi image badal do (ya ek nayi daal do)
3. Dashboard refresh karo

Dikhna chahiye: `manzoori expire ho gayi — media badal gaya`, Final button
band, aur folder mein `APPROVE_MEDIA.txt` ki jagah `APPROVAL_EXPIRED.txt`.

---

## Step 7 — Final

```
START_HERE.bat -> 8
```

Acceptance PASS tabhi jab ye SAB sach ho:

| # | Kya check karna hai | Kahan |
|---|---|---|
| 1 | `final.mp4` bani (draft.mp4 nahi) | `jobs\<naam>\` |
| 2 | ek bhi `MISSING_PLACEHOLDER` nahi | `render-manifest.json` -> `missing_placeholders: []` |
| 3 | `duration.rendered` ≈ `duration.audio` (0.5s ke andar) | `render-manifest.json` |
| 4 | `status: "SUCCESS"` | `job-result.json` |
| 5 | har user shot par `manual_request_key` + `manual_sha256` | `render-manifest.json` -> `shots[]` |
| 6 | shot-review mein har shot ka asli frame | `shot-review.html` |
| 7 | koi download dobara nahi hua | `run.log` |

Ye saat cheezein pass ho gayin — tabhi M5 (editor UI) shuru hoga.

---

## Agar kahin ruke

Screen par likhi line + `jobs\<naam>\run.log` bhej dena. Har blocked run ke
saath `blocked-report.html`, `job-result.json` aur `NEEDS_SOURCE.csv` bhi bante
hain — wo bhi kaam ke hain.
