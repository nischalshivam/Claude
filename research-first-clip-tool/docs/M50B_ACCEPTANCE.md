# M5.0-B acceptance — asli Candace project (UI ke through)

Ye woh gate hai jab tak main "M5.0-B complete" nahi bolunga aur templates/effects
shuru nahi karunga. Synthetic tests (regression 133/0, content 13/0, server 10/0,
live draft) pass ho chuke — par asli video aapke project par bane, wahi sach hai.

Editor kholo: `START_UI.bat` (browser apne aap khulega).

| # | Kya check karna hai | Kahan |
|---|---|---|
| 1 | update verify pass (version 5.0.0-a, docs\ aaya) | UPDATE_TOOL ke baad ka check |
| 2 | orphan recovery report dekha | `output\orphan-recovery-report.json` |
| 3 | Draft editor mein khulta hai | Editor tab → shots dikhein |
| 4 | har missing range sahi stable request_key par | Missing tab: har card ka key `REQ_…` |
| 5 | order/trim/reuse reload ke baad bache | edit → refresh → wahi rahe |
| 6 | critical media badalne par approval EXPIRE | file badlo → card orange "expire" |
| 7 | Final tab tak disabled jab tak sab blocker clear na ho | header Final button |
| 8 | `final.mp4` mein zero placeholder | `render-manifest.json` → `missing_placeholders: []` |
| 9 | rendered ≈ voiceover (0.5s ke andar) | `render-manifest.json` → `duration.rendered` vs `duration.audio` |
| 10 | har user shot par request key + media hash | `render-manifest.json` → `shots[].manual_request_key` + `manual_sha256` |
| 11 | shot-review ke frame sahi | `shot-review.html` |
| 12 | warm rerun par download dobara nahi | `run.log` mein "pehle ho chuka, skip" |
| 13 | fail/cancel kabhi success na dikhe | job log + `job-result.json` status |

Kahin bug mile to main active M5 branch mein regression test ke saath theek
karunga — dobara generalized backend audit nahi, jab tak baat data-loss / galat
approval / timing-corruption ki na ho.

## Note: M5.0-A mein #5, #8-#12 ka daayra

- #5 (order/trim/reuse): **missing-media** wale (upload/approve/reuse) abhi render
  ko affect karte hain aur reload ke baad bache rehte hain — ye M5.0-A mein testable
  hai. Editor ke **crop/trim** transform EDL mein bachte hain par render EDL se M5.0-B
  mein judega.
- #8-#12 poora final export ke through hain — wo aapke asli media aane ke baad
  (jo internet par nahi mila) chalega. Backend ye sab M4.2.1 mein prove kar chuka;
  yahan UI ke through dohrana hai.
