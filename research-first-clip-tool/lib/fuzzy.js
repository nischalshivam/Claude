// ============================================================
//  fuzzy.js — text normalize + similarity scoring.
//  Yehi accuracy ka core hai: LLM ka timestamp guess use karne ke bajaye
//  dialogue ko asli caption mein DHOONDHTE hain fuzzy match se.
//
//  Score (handoff Stage 4):
//    core = (0.45*tokenF1 + 0.30*orderedLCS + 0.15*charTrigram)   // 0..1
//    + neighbour-anchor bonus jab context terms diye hon.
// ============================================================

const CONTRACTIONS = {
  "i'm": 'i am', "you're": 'you are', "he's": 'he is', "she's": 'she is', "it's": 'it is',
  "we're": 'we are', "they're": 'they are', "that's": 'that is', "there's": 'there is',
  "what's": 'what is', "who's": 'who is', "here's": 'here is', "let's": 'let us',
  "isn't": 'is not', "aren't": 'are not', "wasn't": 'was not', "weren't": 'were not',
  "don't": 'do not', "doesn't": 'does not', "didn't": 'did not', "can't": 'can not',
  "couldn't": 'could not', "wouldn't": 'would not', "shouldn't": 'should not',
  "won't": 'will not', "haven't": 'have not', "hasn't": 'has not', "hadn't": 'had not',
  "i've": 'i have', "you've": 'you have', "we've": 'we have', "they've": 'they have',
  "i'll": 'i will', "you'll": 'you will', "he'll": 'he will', "she'll": 'she will',
  "we'll": 'we will', "they'll": 'they will', "i'd": 'i would', "you'd": 'you would',
  "gonna": 'going to', "wanna": 'want to', "gotta": 'got to', "gimme": 'give me',
  "'cause": 'because', "cause": 'because', "em": 'them',
};

// Bounded memo: alignment/locate ek hi caption-window ko har moment ke liye
// dobara normalize+tokenize karte hain (82 moments x ~6000 windows). Pure
// functions hain, isliye string->result cache bilkul safe hai aur ~10x tez.
function memo1(fn, cap = 20000) {
  const m = new Map();
  return (arg) => {
    const k = typeof arg === 'string' ? arg : String(arg);
    if (m.has(k)) return m.get(k);
    const v = fn(arg);
    if (m.size >= cap) m.clear();
    m.set(k, v);
    return v;
  };
}

function normalizeRaw(text) {
  let s = String(text || '').toLowerCase();
  s = s.replace(/<[^>]+>/g, ' ');                     // <i> tags
  s = s.replace(/\[[^\]]*\]/g, ' ');                  // [music], [applause]
  s = s.replace(/\([^)]*\)/g, ' ');                   // (laughs)
  s = s.replace(/^[a-z0-9 .'-]{1,20}:\s/i, ' ');      // leading "SPEAKER: "
  s = s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"'); // smart quotes
  // expand contractions
  s = s.replace(/[a-z']+/g, w => CONTRACTIONS[w] || w);
  s = s.replace(/[^a-z0-9 ]+/g, ' ');                 // strip remaining punctuation
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

const normalize = memo1(normalizeRaw);
const tokens = memo1(text => normalize(text).split(' ').filter(Boolean));

// token F1 (multiset overlap: precision & recall)
function tokenF1(a, b) {
  if (!a.length || !b.length) return { f1: 0, recall: 0, precision: 0 };
  const count = arr => { const m = new Map(); for (const t of arr) m.set(t, (m.get(t) || 0) + 1); return m; };
  const ma = count(a), mb = count(b);
  let overlap = 0;
  for (const [t, c] of ma) overlap += Math.min(c, mb.get(t) || 0);
  const precision = overlap / a.length;
  const recall = overlap / b.length;
  const f1 = (precision + recall) ? (2 * precision * recall) / (precision + recall) : 0;
  return { f1, recall, precision };
}

// longest-common-subsequence length (token level)
function lcsLen(a, b) {
  if (!a.length || !b.length) return 0;
  const n = a.length, m = b.length;
  let prev = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1).fill(0);
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[m];
}
// ordered LCS normalized by max length (generic similarity)
function orderedLCS(a, b) {
  if (!a.length || !b.length) return 0;
  return lcsLen(a, b) / Math.max(a.length, b.length);
}

const trigrams = memo1(function (str) {
  const s = '  ' + String(str).replace(/\s+/g, ' ') + '  ';
  const g = new Set();
  for (let i = 0; i < s.length - 2; i++) g.add(s.slice(i, i + 3));
  return g;
});
function charTrigram(sa, sb) {
  const A = trigrams(sa), B = trigrams(sb);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);   // Jaccard (symmetric)
}
// target ke trigrams candidate mein kitne present (containment) — lambi caption
// mein choti phrase ko penalize nahi karta.
function triContainment(cand, target) {
  const A = trigrams(cand), B = trigrams(target);
  if (!B.size) return 0;
  let inter = 0;
  for (const g of B) if (A.has(g)) inter++;
  return inter / B.size;
}

// candidate (matched caption/narration window) vs target (dialogue/cue we want).
// CONTAINMENT-oriented: "target phrase kitna, order mein, is window mein hai?"
// Isse choti phrase lambi caption line ke andar bhi sahi score paati hai
// (candidate ke extra words se penalty nahi — wo to caption line hi hai).
//   containment = LCS(candidate,target)/|target|   (order + completeness)
//   recall      = overlap/|target|
//   trigram     = target-trigram coverage (typo/variant safety)
//   precision   = brevity: extra caption words ko halka penalize -> tight
//                 window (sahi lamha) wider joined window ko jeete
//   score = 0.45*containment + 0.25*recall + 0.15*trigram + 0.15*precision
// anchors: optional context terms jinka window mein hona thoda strengthen kare.
function score(candidateText, targetText, anchors = []) {
  const ca = tokens(candidateText), ta = tokens(targetText);
  if (!ta.length) return { score: 0, recall: 0, containment: 0, trigram: 0, precision: 0 };
  const { recall, precision } = tokenF1(ca, ta);
  const containment = lcsLen(ca, ta) / ta.length;
  const tri = triContainment(normalize(candidateText), normalize(targetText));
  let final = 0.45 * containment + 0.25 * recall + 0.15 * tri + 0.15 * precision;
  if (anchors && anchors.length) {
    const candNorm = normalize(candidateText);
    let hit = 0;
    for (const a of anchors) if (candNorm.includes(normalize(a))) hit++;
    final = 0.9 * final + 0.1 * (hit / anchors.length);
  }
  return { score: +final.toFixed(4), recall: +recall.toFixed(4), containment: +containment.toFixed(4), trigram: +tri.toFixed(4), precision: +precision.toFixed(4) };
}

// simple similarity for alignment (script_cue vs SRT text)
function similarity(a, b) { return score(a, b).score; }

module.exports = { normalize, tokens, tokenF1, orderedLCS, charTrigram, score, similarity };
