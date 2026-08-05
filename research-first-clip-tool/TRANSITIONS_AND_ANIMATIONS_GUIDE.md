# Transitions & Animations — poori guide (M5.2-TX)

Ye feature aapki har video ko **alag** dikhata hai — taaki 2 video ek jaise,
repetitive, "AI-made" na lagein. Do cheezein milti hain:

- **Animations** = shot ke *andar* halki motion (Ken Burns: dheere zoom / pan).
- **Transitions** = do clip ke *beech* effect (dip to black/white, blur dissolve,
  flash, warm dip...).

Tool inhe har video par **VARY** karke lagata hai (seeded) — isliye consecutive
shots ek jaise nahi dikhte, aur do videos ka look bhi alag hota hai.

> **Sabse zaroori guarantee:** Transitions/animations lagne se aapki video ki
> **lambai NAHI badalti** aur **voiceover kabhi chhoti nahi hoti**. Har effect
> shot ke andar hi lagta hai (duration-exact). Ye pixel + duration test se
> proven hai (RAW-STYLE-PARITY-LOG.txt).

---

## Kaha se chunein — 2 options + OFF

### Option 1 — New Video page (video banane se PEHLE)
`New Video` screen par ek **"Transitions & Animations"** card hai. Voice + script +
pack dene ke saath hi yahan ek style chun lo. Jab draft/final banega, wahi style
lag jayega. Baad me editor se badal bhi sakte ho.

**Kab use karo:** jab aapko pehle se pata ho ki is video ka mood kya hai
(cinematic / energetic / soft). Ek click, aur aage sab automatic.

### Option 2 — Editor → "🎬 Transitions" (clips lag jaane ke BAAD)
Jab saari missing clips lag jayein aur aap editor me shots se khush ho, upar
**"🎬 Transitions"** button dabao. Wahan:
- koi bhi pack chuno (Auto ya 1-2-3 apne hisaab se),
- **Motion strength** slider se zoom/pan ki taakat ghatao-badhao,
- **🔀 Shuffle variety** dabao to *wahi* pack naye combination ke saath (jab tak
  pasand na aaye),
- phir **Export / Save As** — final me yahi transitions/motion lagega.

**Kab use karo:** jab clips final ho gayi hain aur ab sirf "look" lock karna hai.
Yahi aapka "lock ke baad variation chuno" wala flow hai.

> Dono option ek hi jagah (`project/style.json`) likhte hain — **jo aakhri baar
> chuna, wahi final me lagta hai.** Confusion nahi.

### OFF — koi transition/animation NAHI chahiye
Kisi bhi screen par pack list me **"None"** chuno. Isse bilkul saaf hard-cuts
banenge — koi dip, koi zoom, koi motion nahi. (Default bhi None hai — jab tak
aap khud koi pack na chuno, kuch nahi lagega.)

---

## Style Packs (ready-made presets)

| Pack | Animations (motion) | Transitions (boundary) | Feel |
|---|---|---|---|
| **None** | — | — | bilkul saaf cuts, kuch nahi |
| **Auto** (recommended) | zoom in/out, pan L/R/U/D, punch-in | dip black/white, blur, flash, soft, warm | tool khud varied mix banata hai |
| **Cinematic Doc** | gentle zoom + slow pan | dip to black, soft dip | gehra, filmy, documentary |
| **Energetic** | punch-in, zoom, pan | white flash, dip white, soft | tez, high-energy |
| **Soft** | breathing zoom | blur dissolve, dip black | shaant, smooth |
| **Clean cuts** | halki zoom/pan | *koi dip nahi* (hard cut) | motion hai, transition nahi |
| **Motion only** | zoom in/out, pan up/down, punch-in | *koi transition nahi* | sirf Ken Burns |
| **Transitions only** | *koi motion nahi* (static frame) | dip black/white, blur, flash | sirf boundary effects |

---

## Building blocks (inhi ke combinations se 20+ variations)

**Animations (8):**
`none`, `zoom_in`, `zoom_out`, `push_in` (faster zoom), `pan_left`, `pan_right`,
`pan_up`, `pan_down`.

**Transitions (7):**
`none` (hard cut), `dip_black`, `dip_white`, `dip_warm` (warm tint dip),
`soft_cut` (fast black dip), `flash` (fast white flash), `blur_dissolve`.

Auto/har pack in blocks ko **seeded rotation** se chunta hai taaki koi do adjacent
shot same na ho. `seed` badalte hi (Shuffle) pura naya combination — same seed =
same result (reproducible). Aur bhi variations future me add hote rahenge.

---

## Sawaal-jawaab

**Q: Transitions se narration/timing gadbad to nahi hogi?**
Nahi. Har transition shot ke andar hi (tail/head par) lagta hai; total lambai
same rehti hai. Test: styled aur non-styled dono ki length bilkul barabar
(RAW-STYLE-PARITY-LOG.txt me `DURATION INVARIANT`).

**Q: Transitions dekhne ke liye render karna padega?**
Haan — ye final export me lagti hain. Export ke baad player me `final.mp4` chala
kar dekh lo. (Editor ka live preview base framing dikhata hai; styled look final
me aata hai.)

**Q: Existing editor / crop / replace kaam par asar?**
Bilkul nahi. Style pass **poori tarah alag layer** hai jo render ke aakhir me,
concat se pehle chalta hai. Pack = None ho to render byte-for-byte purana jaisa.
Aapka crop/scale/replace/approval sab waise ka waisa.

**Q: Ek shot par style-filter fail ho gaya to?**
Us ek shot ka original use ho jata hai (video fir bhi banti hai) aur
`render-manifest.json` ke `style` block me sach likha hota hai — kabhi chup-chaap
galat output nahi.
