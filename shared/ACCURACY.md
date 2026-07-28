# Scenes sahi lagane ke liye kya dena hai

Ye file ek hi sawaal ka jawab hai: **footage sahi kaise aaye.**

Har cheez sabse zyada asar wale se sabse kam asar wale order me likhi hai.
Pehli do cheezein kar lo to baaki ki zaroorat shayad hi padegi.

---

## 0. Pehle samjho ki galti kahan hoti hai

Tool har shot ke liye ye sawaal poochta hai: *episode ke kis second par ye
shot hai?* Uske paas jawab dhoondne ke chaar tareeke hain, sabse pakke se
sabse kamzor tak:

| # | Tareeka | Kitna pakka |
|---|---|---|
| 1 | **Tumne time bata diya** (`Scene timings`) | 100% — koi guess nahi |
| 2 | **Script ne line quote ki** aur wo subtitle me mili | millisecond tak sahi |
| 3 | **Picture match** — description se frame dhoondna | kamzor. Ek real episode par 84 me se sirf **2** descriptions ne sanyog se behtar score kiya |
| 4 | **Filler** — sahi episode, jagah ka pata nahi | sirf isliye ki khaali screen se behtar hai |

Jo build kharab aayi thi usme 85 shots — poori video ka pehla half — sirf
#4 par chal rahe the. **Isliye clips random lag rahi thi.** Model aur tuning
se ye theek nahi hota; #1 se hota hai.

---

## 1. Scene timings — sabse zaroori (2 minute ka kaam)

New Video page par **Scene timings** ka box hai. Har episode ki ek line:

```
S04E01 29:30-33:40
S03E13 30:05-30:35
S04E08 43:40-46:30
```

Bas itna. Iska matlab: "is episode se jo bhi shots hain, wo isi stretch me
hain." Tool phir un shots ko **script ke order me** us stretch par bichha
deta hai — scene chalta hai, kudta nahi.

**Kaise nikalo:** apne player me episode kholo, scene par jao, upar jo time
dikh raha hai wo likh do. Bas.

Kuch baatein:

- **Range thoda bada rakho, chhota nahi.** 4-minute scene ke liye
  `28:00-35:00` likhne me kuch nahi bigadta. `31:00-31:30` likh doge to
  aadha scene chala jaayega.
- Sirf ek time bhi chalega — `S04E01 31:00` — tool uske aage-peeche 90
  second khud le lega.
- `29:30-33:40`, `29:30 - 33:40`, `29:30 to 33:40`, `4x01 29:30` — sab
  chalte hain.
- **Check chalao.** Panel me niche list aayegi ki kis episode ki line abhi
  baaki hai, aur usme kitne shots hain. Sabse upar wale se shuru karo.

**Box apne aap bhar jaata hai.** Script me `scene_range` hai to script
choose karte hi box me lines aa jaati hain, sabse bade run ki line sabse
upar. Wo model ke *anumaan* hain — isliye box me dikhte hain, chupke se lag
nahi jaate. Do-teen jo galat lagen, unhe apne player me dekh ke theek kar
do.

Check panel ab do cheezein bataata hai:
- kis episode ki line **hai hi nahi**
- kis episode ki line **itni chaudi hai ki fayda kam hai** — jaise 6 shots
  ke liye 7 minute ka range. Ise scene ke barabar + 2 minute kar do.

Box aur script dono ho to **box jeetta hai**. Naya script chunoge to box
apne aap naye script wali lines se badal jaayega — bas tab nahi jab tumne
khud kuch type kiya ho.

Ek shot ka exact time bhi de sakte ho — `"at": "31:07"` — lekin ye tabhi
karo jab tumne player me us frame tak scrub kiya ho. Ye anchor ban jaata
hai, quoted line ke barabar.

---

## 2. Genspark ka naya prompt

`PROMPT_VISUAL_SCRIPT.md` update ho chuki hai. Naya kya hai:

- **Rule 1B — `scene_range`**: ab model se har run ke liye approximate range
  maanga jaata hai, aur saaf bola gaya hai ki **na pata ho to field chhod
  do, banao mat**. Ek banaya hua range poore run ko galat jagah le jaata
  hai.
- **Rule 6 — `characters`**: pehle ye sirf sajawat thi. Ab ye padha jaata hai
  (neeche point 3). Model ko bola gaya hai ki har shot me jo log **screen
  par dikh rahe hain** unke naam likhe — jiske baare me baat ho rahi hai wo
  nahi.
- Summary block me do naye counters hain jisse model khud check kar le ki
  kitne runs ka range diya.

Purani script bhi chalegi — kuch tootega nahi, bas ye do fayde nahi milenge.

---

## 3. Characters — reference photos

Ye us shikayat ka jawab hai: *baat ho rahi hai Walter aur Gus ki, screen par
Skyler aur Walt Jr.*

Ek folder banao:

```
cast\
  Gus\      1.jpg  2.jpg  3.jpg
  Walter\   1.jpg  2.jpg
  Jesse\    1.jpg
  Mike\     1.jpg  2.jpg
```

Folder ka naam = character ka naam. New Video page ke **Characters** field
me us `cast` folder ka path do. Turant dikh jaayega kitne log mile aur
kitni photos.

**Kaisi photos:**
- usi show ke screenshots — Google se poster ya promo photo nahi
- **close-up**, chehra bada. Wide shot mat do
- 3 se 10 per character, alag-alag scenes se
- alag-alag kapde/lighting achhe hain — isse tool "ye aadmi" seekhta hai,
  "ye kamra" nahi

**Imaandari se limitation:** ye face recognition nahi hai. Ye poochta hai
"kya ye frame in photos jaisa dikhta hai" — jo thoda wider sawaal hai. Gus
ke office wali photo doge to tool office dhoondh lega, Gus nahi. Isliye
close-ups.

Aur ye **jitna chunta hai usse zyada hataata hai** — yahi iska kaam hai. Ye
kabhi bhi quoted line ya tumhari di hui timing ko override nahi kar sakta;
sirf barabar wale frames me se sahi wala chunta hai.

Koi cast folder na do to sab kuch pehle jaisa chalta hai.

---

## 3.5 Clean narration script

New Video page par ab **Clean narration script** ka field hai — wahi .txt jo
tumne voiceover banane ke liye diya tha.

Isse fayda ye hai: tool har scene ka time nikaalne ke liye visual script ke
`narration` text ko voiceover se match karta hai. Par wo text model ne copy
kiya hota hai, aur copy karte waqt shabd badalte hain. Jitne shabd badle,
utni scene boundary khiskati hai.

Asli narration script de doge to har beat **usi text me** dhoonda jaayega jo
awaaz bol rahi hai. Agar file match nahi karti (galti se dusri video ki de
di), tool bata dega aur purane tareeke se hi time karega — chupke se kuch
galat nahi karega.

Optional hai, par de dena — 10 second ka kaam hai.

---

## 4. Script me quoted lines

Purana rule, ab bhi sach: **har run me kam se kam 2 lines quote honi
chahiye**, aur 20+ shots wale run me 3 — ek shuru me, ek beech me, ek ant
me.

Word for word matlab word for word. Paraphrase kuch nahi dhoondta.

Agar scene me koi bolta hi nahi (box cutter scene), to us **se pehle** wali
aakhri line aur us **ke baad** wali pehli line quote karo. Do lines beech ka
sab kuch pakad leti hain. Ya phir — jo asaan hai — us run ka `scene_range`
de do.

---

## Kya kya theek hua is update me

- **18 khaali scenes** — ek run ka window sirf ek placed shot ke aas-paas
  simat gaya tha (240 second), usme 100 filler moments fit nahi hue, aur beat
  khaali chala gaya. Renderer ne padosi shot ko us gap par khinch diya — 6:15
  wala galat yellow shot isi wajah se aaya tha. Ab window kabhi run ki apni
  zaroorat se chhota nahi hota.
- **Bikhre hue clips** — jis run ka koi shot place nahi hota tha, uske sab
  shots filler ban jaate the, aur filler jaanbujhkar episode me bikharta hai.
  Ab agar run ka stretch pata ho, shots **script ke order me** bichhte hain.
- **Stated timings** — sab kuch ke upar.
- **Characters** — reference photos se frame chunav.

## Agar script open hi na ho

`Extra data: line 2104 column 1` — ye ab nahi aayega. Wo file kharab nahi
thi: prompt hi model se bolta hai ki array ke baad ek summary object aur ek
note likhe, matlab file me teen cheezein hoti hain. Reader ab teeno padhta
hai, aur note ko New Video page par dikha bhi deta hai — usme model khud
bata deta hai kaunse ranges uska anumaan hain.

Jo file sach me kharab hai (JSON tuta hua), wo ab bhi error degi, usi line
number ke saath.

---

## Ek line me

**Scene timings ka box bhar do. Baaki sab uske baad ki baat hai.**
