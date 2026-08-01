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

// consecutive cues ka best-matching window dhoondo target dialogue ke liye.
function locateDialogue(cues, dialogue, { variants = [], anchors = [] } = {}) {
  if (!cues || !cues.length) return { found: false, reason: 'no captions' };
  const targets = [dialogue, ...(variants || [])].filter(Boolean);
  if (!targets.length) return { found: false, reason: 'no dialogue text' };

  let best = null;
  for (const target of targets) {
    const N = Math.max(1, F.tokens(target).length);
    for (let i = 0; i < cues.length; i++) {
      let joined = '';
      let tokCount = 0;
      for (let j = i; j < cues.length && j < i + 12; j++) {
        joined = joined ? joined + ' ' + cues[j].text : cues[j].text;
        tokCount = F.tokens(joined).length;
        const sc = F.score(joined, target, anchors);
        if (!best || sc.score > best.score) {
          best = { ...sc, start_sec: cues[i].start, end_sec: cues[j].end, i, j, matched: joined.slice(0, 200), target: target.slice(0, 120) };
        }
        if (tokCount >= N * 1.8 + 3) break;   // window kaafi bada ho gaya, aage na badho
      }
    }
  }
  return best ? { found: true, ...best } : { found: false, reason: 'no match' };
}

// config.dialogue thresholds se accept/review/reject faisla
function decide(match, dcfg) {
  if (!match || !match.found) return { decision: 'REJECT', reason: match && match.reason ? match.reason : 'no match' };
  const { score, recall } = match;
  if (score >= dcfg.acceptScore && recall >= dcfg.acceptRecall)
    return { decision: 'ACCEPT', reason: `score ${score} recall ${recall}` };
  if (score >= dcfg.reviewFloor)
    return { decision: 'REVIEW', reason: `borderline score ${score} recall ${recall} (episode+context evidence chahiye)` };
  if (score >= dcfg.rejectFloor)
    return { decision: 'ASR_NEEDED', reason: `weak caption match ${score} (M2: local ASR)` };
  return { decision: 'REJECT', reason: `low match ${score}` };
}

module.exports = { parse, parseFile, locateDialogue, decide };
