// ============================================================
//  TIMEBASE (M4.2.1) — poore project ki lambai par EK faisla, SABSE PEHLE.
//
//  Kyun ye bana:
//  M4.2 tak audio ka hisaab sirf AAKHIR mein (mux ke waqt) lagta tha. Nateeja
//  asli Candace run mein ye tha —
//    timeline.json          : 896.1s
//    gap-plan.json          : 896.1s tak ke liye media maanga
//    final.mp4              : 894.7s
//  Yaani user se 1.4 second ka aisa media manga gaya jo baad mein kaat diya
//  jata. Shot-review ke coordinates bhi asli video se aage nikal jate the.
//  Aur sabse khatarnak: 30 SECOND tak ka farak chup-chaap kaat diya jata tha.
//  30 second ka matlab ho sakta hai "voiceover file adhoori hai" — use chup-chaap
//  kaat dena narration kho dena hai.
//
//  Ab usool ek hi hai: VOICEOVER AUDIO HI SACH HAI.
//    project_duration = audio ki lambai
//    SRT sirf uska naksha hai — thoda aage-peeche ho sakta hai
//
//  Farak ka policy:
//    <= 2.0s   apne aap theek kar dete hain (manifest mein likha jata hai)
//    >  2.0s   RUK jate hain — ye "chhoti si tail" nahi, ye asli gadbad hai
//
//  Preview alag cheez hai: wahan window jaan-boojh kar chhoti hai (offset +
//  duration), isliye ye check preview par nahi lagta.
// ============================================================
'use strict';
const fs = require('fs');
const U = require('./util.js');
const SUB = require('./subtitles.js');

const CORRECTION = {
  NONE: 'NONE',                               // audio aur SRT already milte hain
  NO_AUDIO: 'NO_AUDIO',                       // test/silent mode — SRT hi sach
  CLAMPED_SRT_TAIL: 'CLAMPED_SRT_TAIL',       // SRT thoda lamba tha, audio par kaata
  EXTENDED_TO_AUDIO: 'EXTENDED_TO_AUDIO',     // audio thoda lamba tha, aakhri shot bada kiya
  SRT_LONGER_THAN_AUDIO: 'SRT_LONGER_THAN_AUDIO',   // BLOCK
  AUDIO_LONGER_THAN_SRT: 'AUDIO_LONGER_THAN_SRT',   // BLOCK
};

function audioSignature(f) {
  try { const s = fs.statSync(f); return `${s.size}:${Math.round(s.mtimeMs)}`; } catch { return 'na'; }
}

// Subtitle exporters often keep the final cue on screen for a few seconds
// after a long voiceover ends. Use a bounded proportional allowance for only
// that display tail: 0.5% of audio, never over 5 seconds by default.
function tailTolerance(audioDuration, baseTolerance, cfg = {}) {
  const render = cfg.render || {};
  const ratio = Number.isFinite(+render.audioTailClampRatio) ? +render.audioTailClampRatio : 0.005;
  const hardMax = Number.isFinite(+render.audioTailClampMaxSeconds) ? +render.audioTailClampMaxSeconds : 5.0;
  const proportional = Math.max(0, Number(audioDuration) || 0) * Math.max(0, ratio);
  return +Math.max(baseTolerance, Math.min(hardMax, proportional)).toFixed(3);
}

// SRT ki aakhri display timing voiceover se 2–3 second pehle rukna common hai.
// Audio ko kabhi trim nahi karte: bounded gap par last visual audio end tak
// extend hota hai. Bada gap phir bhi block hai, kyunki wahan narration map hi
// missing ho sakta hai.
function leadTolerance(baseTolerance, cfg = {}) {
  const render = cfg.render || {};
  const hardMax = Number.isFinite(+render.audioLeadExtendMaxSeconds) ? +render.audioLeadExtendMaxSeconds : 5.0;
  return +Math.max(baseTolerance, Math.max(0, hardMax)).toFixed(3);
}

/**
 * Ek hi jagah tay karo ki project kitna lamba hai.
 *
 * @param {object} o { srtFile, audioFile, cfg, cues }
 * @returns {{
 *   audio_duration, srt_end, project_duration, correction, difference_sec,
 *   tolerance, ok, reason, audio_signature
 * }}
 */
function resolve(o = {}) {
  const cfg = o.cfg || {};
  const tol = Number((cfg.render && cfg.render.audioClampSeconds) != null
    ? cfg.render.audioClampSeconds : 2.0);

  let cues = o.cues;
  if (!cues) { try { cues = SUB.parseFile(o.srtFile); } catch { cues = []; } }
  const srt_end = cues.length ? +Number(cues[cues.length - 1].end).toFixed(3) : 0;

  // NOTE: U.probe video stream dhoondhta hai, isliye ek audio-only file par
  // wo hamesha ok:false deta hai — par duration phir bhi bhar deta hai.
  // Yahan sirf duration chahiye, video stream nahi.
  let audio_duration = null;
  if (o.audioFile && fs.existsSync(o.audioFile)) {
    const p = U.probe(o.audioFile, { strict: false });
    if (p && p.duration > 0) audio_duration = +Number(p.duration).toFixed(3);
  }

  const tailTol = audio_duration == null ? tol : tailTolerance(audio_duration, tol, cfg);
  const leadTol = leadTolerance(tol, cfg);
  const base = {
    srt_end, tolerance: tol, tail_tolerance: tailTol, lead_tolerance: leadTol,
    audio_signature: o.audioFile ? audioSignature(o.audioFile) : 'none',
  };

  if (audio_duration == null) {
    return { ...base, audio_duration: null, project_duration: srt_end,
      correction: CORRECTION.NO_AUDIO, difference_sec: 0, ok: true, reason: null };
  }

  const diff = +(srt_end - audio_duration).toFixed(3);   // + = SRT lamba
  const project_duration = audio_duration;

  if (Math.abs(diff) <= 0.02) {
    return { ...base, audio_duration, project_duration, correction: CORRECTION.NONE,
      difference_sec: diff, ok: true, reason: null };
  }
  if (diff > 0 && diff <= tailTol) {
    return { ...base, audio_duration, project_duration, correction: CORRECTION.CLAMPED_SRT_TAIL,
      difference_sec: diff, ok: true,
      reason: `SRT ${srt_end.toFixed(1)}s tak jati hai par voiceover ${audio_duration.toFixed(1)}s ka hai — sirf aakhri subtitle ki ${diff.toFixed(1)}s display-tail audio end par clamp ki` };
  }
  if (diff < 0 && -diff <= leadTol) {
    return { ...base, audio_duration, project_duration, correction: CORRECTION.EXTENDED_TO_AUDIO,
      difference_sec: diff, ok: true,
      reason: `voiceover ${audio_duration.toFixed(1)}s ka hai par SRT ${srt_end.toFixed(1)}s par khatam — aakhri shot ${(-diff).toFixed(1)}s bada kar diya` };
  }
  if (diff > tailTol) {
    return { ...base, audio_duration, project_duration, correction: CORRECTION.SRT_LONGER_THAN_AUDIO,
      difference_sec: diff, ok: false,
      reason: `voiceover sirf ${audio_duration.toFixed(1)}s ka hai par SRT ${srt_end.toFixed(1)}s tak likhi hai — ${diff.toFixed(1)}s ki narration audio mein hai hi nahi` };
  }
  return { ...base, audio_duration, project_duration, correction: CORRECTION.AUDIO_LONGER_THAN_SRT,
    difference_sec: diff, ok: false,
    reason: `voiceover ${audio_duration.toFixed(1)}s ka hai par SRT ${srt_end.toFixed(1)}s par hi khatam ho jati hai — ${(-diff).toFixed(1)}s ke liye koi narration text nahi` };
}

/** Cues ko project ki lambai par kaato — jo poori tarah bahar hain wo hat jate hain. */
function clampCues(cues, total) {
  if (!total) return cues;
  const out = [];
  for (const c of cues) {
    if (c.start >= total - 0.01) continue;
    out.push(c.end > total ? { ...c, end: +total.toFixed(3) } : c);
  }
  return out;
}

/** Blocked hone par user ko kya karna hai — ek hi jagah likha hua. */
function blockSteps(tb) {
  const steps = [];
  if (tb.correction === CORRECTION.SRT_LONGER_THAN_AUDIO) {
    steps.push(`voiceover file: ${tb.audio_duration.toFixed(1)}s     SRT: ${tb.srt_end.toFixed(1)}s`);
    steps.push('');
    steps.push('Aam wajahein:');
    steps.push('  - voiceover render adhoora reh gaya (aakhir ka hissa export hi nahi hua)');
    steps.push('  - SRT purane/lambe script ka hai aur naya voiceover chhota hai');
    steps.push('');
    steps.push('Theek karo:');
    steps.push('  - poora voiceover dobara export karke input\\voiceover.mp3 mein rakho, YA');
    steps.push('  - us hisse ki lines SRT se hata do');
  } else {
    steps.push(`voiceover file: ${tb.audio_duration.toFixed(1)}s     SRT: ${tb.srt_end.toFixed(1)}s`);
    steps.push('');
    steps.push('Audio SRT se lamba hai — aakhir mein aisi narration hai jiska text hi nahi.');
    steps.push('Bina text ke tool wahan kuch plan nahi kar sakta (aur aakhri frame ko');
    steps.push('freeze karke chipkana imaandari nahi hai).');
    steps.push('');
    steps.push('Theek karo:');
    steps.push('  - SRT dobara banao (poore voiceover se), YA');
    steps.push('  - audio ka aakhri khaali/extra hissa kaat do');
  }
  steps.push('');
  steps.push(`Abhi ki chhoot: audio lambi ho to ${Number(tb.lead_tolerance || tb.tolerance).toFixed(1)}s; sirf SRT display-tail ho to ${Number(tb.tail_tolerance || tb.tolerance).toFixed(1)}s tak`);
  steps.push('(config.json -> render.audioLeadExtendMaxSeconds / audioTailClampMaxSeconds).');
  steps.push('');
  steps.push('Sirf dekhna hai, export nahi? command ke aage --accept-audio-mismatch lagao.');
  return steps;
}

module.exports = { resolve, clampCues, blockSteps, audioSignature, tailTolerance, leadTolerance, CORRECTION };
