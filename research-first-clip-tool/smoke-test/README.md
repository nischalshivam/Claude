# Windows Real-World Smoke Test

Ye Milestone 1 ko **real YouTube** par verify karne ke liye hai (sandbox mein YT
blocked tha, isliye ye step aapke PC par hota hai).

## Setup (ek baar)

1. Install: Node 20+/22, FFmpeg+FFprobe (PATH mein), yt-dlp (latest), aur **Deno**
   (yt-dlp ko YouTube ke liye JS runtime chahiye — dekho main README).
2. `CHECK.bat` chalao — sab green/ok hona chahiye (js-runtime bhi).

## Mini pack banao (4-6 real moments)

`prompts/research-pack-generator.txt` ko Genspark/Gemini Pro mein paste karke ek
chhota pack banwao jismein ye cases hon (GPT ke smoke-test spec ke mutabiq):

- kam se kam **1 EXACT_TIME**
- kam se kam **2 DIALOGUE**
- **1 repeated source** (ek hi video 2 moments)
- **1 overlapping/repeated dialogue** (wahi line 2 baar — nearby_context_terms se disambiguate)
- **1 missing-caption** case (aisa source jiske captions na hon)
- **1 dead URL + alternate** (pehla URL galat/unavailable, doosra sahi)
- test dir ka path **space/Unicode** wala rakho (ye bhi verify karna hai)

`scene-research.template.json` skeleton hai — usme real URLs/timestamps bharo
(placeholders `<<FILL...>>` replace karo). **URL/timestamp invent mat karna** — jo
actually verify ho wahi.

## Chalao

```
input\scene-research.json      (aapka bhara hua pack)
input\voiceover.srt            (narration timing)
input\voiceover.mp3            (voiceover)
```

```
START.bat
```

## Wapas bhejo (debugging ke liye)

`jobs\<project>\` se: `run.log` (console output), `resolved.json`, `timeline.json`,
`quality-report.html`, `NEEDS_SOURCE.csv`, aur `clips\` — taaki main dekh ke fix karun.

> Milestone 2 (Gemini/ASR/discovery/UI) tab tak start nahi hoga jab tak ye real
> YouTube smoke test pass na ho jaye.
