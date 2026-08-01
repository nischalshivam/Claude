// ============================================================
//  subtitles.js — SRT/VTT parse + DIALOGUE locator.
//
//  DIALOGUE locator: source ke asli captions mein diye hue dialogue_exact ko
//  fuzzy-match karke uska exact time window nikalta hai. Yehi wo cheez hai jo
//  LLM ke guessed timestamp ki jagah GROUND-TRUTH deti hai.
// ============================================================
const fs = require('fs');
const F = require('../lib/fuzzy.js');

const toSec = (h, m, s, ms) => (+h) * 3600 + (+m) * 60 + (+s) + (+ms) / 1000;

function parse(txt) {
  const cues = [];
  const t = String(txt).replace(/\r/g, '');
  // dono formats: , (srt) ya . (vtt) millis
  const re = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})([^\n]*)\n([\s\S]*?)(?=\n\s*\n|\n\d+\s*\n|\n\d{1,2}:\d{2}:\d{2}|$)/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const start = toSec(m[1], m[2], m[3], m[4].padEnd(3, '0'));
    const end = toSec(m[5], m[6], m[7], m[8].padEnd(3, '0'));
    let text = m[10].split('\n').map(l => l.trim()).filter(Boolean).join(' ').trim();
    text = text.replace(/<[^>]+>/g, '');
    if (text && end > start) cues.push({ start, end, text });
  }
  // merge exact-duplicate consecutive cues (YouTube auto-caps aksar repeat karte hain)
  const out = [];
  for (const c of cues) {
    const prev = out[out.length - 1];
    if (prev && F.normalize(prev.text) === F.normalize(c.text) && c.start - prev.end < 0.6) { prev.end = c.end; continue; }
    out.push(c);
  }
  return out;
}

function parseFile(file) {
  if (!file || !fs.existsSync(file)) return [];
  return parse(fs.readFileSync(file, 'utf8'));
}

// match ke aas-paas (±ctxSec seconds) anchor terms kitne present — repeated
// dialogue disambiguate karne ko (sirf same caption line ke andar nahi).
// Time-based context: dense real captions mein nearby lines pakadta hai, aur
// door wali doosri occurrence ka context nahi milata.
function anchorFraction(cues, i, j, anchors, ctxSec = 8) {
  if (!anchors || !anchors.length) return 0;
  const lo = cues[i].start - ctxSec, hi = cues[j].end + ctxSec;
  let txt = '';
  for (const c of cues) if (c.end > lo && c.start < hi) txt += ' ' + c.text;
  const norm = F.normalize(txt);
  let hit = 0; for (const a of anchors) if (norm.includes(F.normalize(a))) hit++;
  return hit / anchors.length;
}

// consecutive cues ka best + genuinely-separate runner-up window.
// final = base(F.score) + 0.2*anchorFraction(context window).  Anchor present hone
// se sahi occurrence clearly jeetta hai (repeated dialogue ke liye zaroori).
function locateDialogue(cues, dialogue, { variants = [], anchors = [] } = {}) {
  if (!cues || !cues.length) return { found: false, reason: 'no captions' };
  const targets = [dialogue, ...(variants || [])].filter(Boolean);
  if (!targets.length) return { found: false, reason: 'no dialogue text' };

  const windows = [];   // har start-index ka best window
  for (const target of targets) {
    const N = Math.max(1, F.tokens(target).length);
    for (let i = 0; i < cues.length; i++) {
      let joined = '', tok = 0, local = null;
      for (let j = i; j < cues.length && j < i + 12; j++) {
        joined = joined ? joined + ' ' + cues[j].text : cues[j].text;
        tok = F.tokens(joined).length;
        const base = F.score(joined, target);
        const anchorFrac = anchorFraction(cues, i, j, anchors);
        // raw (UNCAPPED) ranking ke liye — anchor perfect exact-match ko bhi
        // beat sake (do occurrences: sahi wale ke paas anchor). score = capped (report).
        const raw = +(base.score + 0.25 * anchorFrac).toFixed(4);
        if (!local || raw > local.raw) local = { raw, score: Math.min(1, raw), base: base.score, recall: base.recall, anchorFrac, start_sec: cues[i].start, end_sec: cues[j].end, i, j, matched: joined.slice(0, 200), target: target.slice(0, 120) };
        if (tok >= N * 1.8 + 3) break;
      }
      if (local) windows.push(local);
    }
  }
  if (!windows.length) return { found: false, reason: 'no match' };
  windows.sort((a, b) => b.raw - a.raw);
  const best = windows[0];
  // runner-up = genuinely alag occurrence. Cue-RANGE disjointness se tay hota hai,
  // start-index distance se nahi (align.js jaisa hi fix — same bug class):
  //  - overlapping sliding window ab jhootha runner-up nahi banega (false REVIEW gaya)
  //  - paas-paas ki asli repetition ab miss nahi hogi (false ACCEPT gaya)
  const isDisjoint = (a, b) => a.j < b.i || a.i > b.j;
  let runnerUp = null;
  for (const w of windows.slice(1)) { if (isDisjoint(w, best)) { runnerUp = w; break; } }
  return { found: true, ...best, runnerUp: runnerUp ? { score: runnerUp.score, raw: runnerUp.raw, start_sec: runnerUp.start_sec, i: runnerUp.i } : null };
}

// accept tabhi jab score, recall AUR best-minus-runnerUp margin teeno pass hon.
function decide(match, dcfg) {
  if (!match || !match.found) return { decision: 'REJECT', reason: match && match.reason ? match.reason : 'no match' };
  const { score, recall } = match;
  const ruRaw = match.runnerUp ? (match.runnerUp.raw ?? match.runnerUp.score) : 0;
  const margin = +((match.raw ?? score) - ruRaw).toFixed(4);   // uncapped ranking gap
  if (score >= dcfg.acceptScore && recall >= dcfg.acceptRecall && margin >= dcfg.acceptMargin)
    return { decision: 'ACCEPT', reason: `score ${score} recall ${recall} margin ${margin}` };
  if (score >= dcfg.acceptScore && recall >= dcfg.acceptRecall && margin < dcfg.acceptMargin)
    return { decision: 'REVIEW', reason: `ambiguous: margin ${margin} < ${dcfg.acceptMargin} (repeated/close dialogue) — context chahiye` };
  if (score >= dcfg.reviewFloor)
    return { decision: 'REVIEW', reason: `borderline score ${score} recall ${recall}` };
  if (score >= dcfg.rejectFloor)
    return { decision: 'ASR_NEEDED', reason: `weak caption match ${score} (M2: local ASR)` };
  return { decision: 'REJECT', reason: `low match ${score}` };
}

module.exports = { parse, parseFile, locateDialogue, decide };
