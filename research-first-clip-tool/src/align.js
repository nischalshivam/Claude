// ============================================================
//  Stage 2 — NARRATION ALIGNMENT
//  voiceover.srt = narration ki timing (source of truth).
//  Har moment ke script_cue_exact ko SRT mein dhoondh kar uska time-window
//  nikalte hain — yehi window final timeline par us visual ki jagah hai.
//
//  Ambiguity guard (handoff Stage 2): best >= acceptSimilarity AND
//  (best - runnerUp) >= runnerUpMargin. Warna align_flag=REVIEW (galat line
//  par attach hone se bachne ko).
// ============================================================
const fs = require('fs');
const U = require('./util.js');
const SUB = require('./subtitles.js');
const F = require('../lib/fuzzy.js');

// best + runner-up (door wala) window dhoondo
function bestWindows(cues, target) {
  const N = Math.max(1, F.tokens(target).length);
  const perStart = [];   // { i, j, score, start, end }
  for (let i = 0; i < cues.length; i++) {
    let joined = '', tok = 0, local = null;
    for (let j = i; j < cues.length && j < i + 12; j++) {
      joined = joined ? joined + ' ' + cues[j].text : cues[j].text;
      tok = F.tokens(joined).length;
      const sc = F.score(joined, target).score;
      if (!local || sc > local.score) local = { i, j, score: sc, start: cues[i].start, end: cues[j].end };
      if (tok >= N * 1.8 + 3) break;
    }
    if (local) perStart.push(local);
  }
  perStart.sort((a, b) => b.score - a.score);
  const best = perStart[0] || null;
  let runnerUp = null;
  for (const w of perStart.slice(1)) { if (!best || Math.abs(w.i - best.i) > 3) { runnerUp = w; break; } }
  return { best, runnerUp };
}

module.exports = function align(spec, cfg, st) {
  const id = spec.id;
  const srtFile = spec.srt;
  if (!srtFile || !fs.existsSync(srtFile)) throw new Error(`voiceover.srt nahi mila: ${srtFile}`);
  const cues = SUB.parseFile(srtFile);
  if (!cues.length) throw new Error('voiceover.srt khaali/parse-fail');
  const total = cues[cues.length - 1].end;

  const A = cfg.align || {};
  const acc = A.acceptSimilarity ?? 0.92;
  const margin = A.runnerUpMargin ?? 0.08;

  // flatten moments (pack info ke sath)
  const moments = [];
  for (const pk of spec.pack.packs) {
    for (const m of (pk.moments || [])) {
      moments.push({ ...m, _packId: pk.pack_id, _scope: pk.scope, _pack: pk });
    }
  }

  const aligned = [];
  let okCount = 0, reviewCount = 0;
  for (const m of moments) {
    const { best, runnerUp } = bestWindows(cues, m.script_cue_exact);
    let flag = 'OK';
    if (!best) flag = 'UNMATCHED';
    else {
      const ruScore = runnerUp ? runnerUp.score : 0;
      if (best.score < acc) flag = 'REVIEW';
      else if ((best.score - ruScore) < margin) flag = 'AMBIGUOUS';
    }
    if (flag === 'OK') okCount++; else reviewCount++;
    aligned.push({
      ...m,
      beat_start: best ? +best.start.toFixed(2) : null,
      beat_end: best ? +best.end.toFixed(2) : null,
      align_score: best ? best.score : 0,
      align_runnerup: runnerUp ? runnerUp.score : 0,
      align_flag: flag,
    });
  }

  // coverage: kitni narration moments se cover hui (informational)
  aligned.sort((a, b) => (a.beat_start ?? 1e9) - (b.beat_start ?? 1e9));
  let covered = 0;
  for (const a of aligned) if (a.beat_start != null) covered += Math.max(0, (a.beat_end - a.beat_start));
  const coveragePct = total ? Math.round(Math.min(100, covered / total * 100)) : 0;

  const outFile = U.p(id, 'aligned.json');
  fs.writeFileSync(outFile, JSON.stringify({ total, coveragePct, moments: aligned }, null, 2));

  U.ok(`aligned ${aligned.length} moments — ${okCount} clean, ${reviewCount} review/ambiguous`);
  U.log(`   narration length ${total.toFixed(1)}s | moment-coverage ~${coveragePct}%`);
  st.meta.align = { total: +total.toFixed(1), moments: aligned.length, clean: okCount, review: reviewCount, coveragePct };
  return { total, moments: aligned };
};
