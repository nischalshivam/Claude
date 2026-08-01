// ============================================================
//  Stage 6 — LOCAL QA (sasti, deterministic, koi API nahi).
//  Har clip par: decodable? sahi duration? mostly-black/frozen to nahi?
//  doosri clip ka duplicate to nahi (perceptual average-hash)?
//  Fail -> status NEEDS_SOURCE (render mein nahi jayegi).
// ============================================================
const fs = require('fs');
const U = require('./util.js');

function aHash(clip, midSec) {
  const tmp = clip + '.ah.gray';
  const r = U.ffmpeg(['-ss', Math.max(0, midSec).toFixed(2), '-i', clip, '-frames:v', '1',
    '-vf', 'scale=8:8,format=gray', '-f', 'rawvideo', tmp]);
  if (!r.ok || !fs.existsSync(tmp)) return null;
  const buf = fs.readFileSync(tmp); fs.rmSync(tmp, { force: true });
  if (buf.length < 64) return null;
  let sum = 0; for (let i = 0; i < 64; i++) sum += buf[i];
  const avg = sum / 64;
  // flat/uniform frame (solid color, fade) ka perceptual hash bekaar hota hai —
  // har flat frame ek jaisa hash dega -> jhoothe duplicates. Aise frame skip.
  let variance = 0; for (let i = 0; i < 64; i++) variance += (buf[i] - avg) ** 2;
  variance /= 64;
  if (variance < 25) return null;   // std < 5 => flat, dedup skip
  const bits = new Uint8Array(64); for (let i = 0; i < 64; i++) bits[i] = buf[i] >= avg ? 1 : 0;
  return bits;
}
const hamming = (a, b) => { let d = 0; for (let i = 0; i < 64; i++) if (a[i] !== b[i]) d++; return d; };

function blackFreeze(clip, dur) {
  const r = U.ffmpegRaw(['-i', clip, '-vf', 'blackdetect=d=0.1:pix_th=0.10,freezedetect=n=-60dB:d=0.5',
    '-an', '-f', 'null', '-']);
  const txt = r.stderr || '';
  let black = 0, freeze = 0, m;
  const bre = /black_duration:(\d+\.?\d*)/g; while ((m = bre.exec(txt))) black += parseFloat(m[1]);
  const fre = /freeze_duration:\s*(\d+\.?\d*)/g; while ((m = fre.exec(txt))) freeze += parseFloat(m[1]);
  return { blackRatio: dur ? black / dur : 0, freezeRatio: dur ? freeze / dur : 0 };
}

module.exports = function localqa(spec, cfg, st, resolved) {
  const id = spec.id;
  const qc = cfg.qa;
  const hashes = [];
  let pass = 0, reject = 0, dup = 0;

  for (const e of resolved) {
    if (e.kind !== 'video' || e.status !== 'RESOLVED' || !e.clip) continue;
    const clipAbs = U.p(id, e.clip);
    const pr = U.probe(clipAbs);
    const flags = [];
    if (!pr.ok) { e.qa = { ok: false, flags: ['undecodable'] }; e.status = 'NEEDS_SOURCE'; e.reason = 'QA: undecodable clip'; reject++; continue; }

    const wantDur = e.cut.dur || (e.cut.end - e.cut.start);
    if (Math.abs(pr.duration - wantDur) > (qc.durationTolerance || 0.5)) flags.push(`duration ${pr.duration.toFixed(2)}s vs ${wantDur.toFixed(2)}s`);
    if (pr.height && pr.height < (qc.minHeight || 480)) flags.push(`low-res ${pr.width}x${pr.height}`);

    const bf = blackFreeze(clipAbs, pr.duration);
    if (bf.blackRatio > (qc.blackFrameMaxRatio || 0.5)) flags.push(`black ${Math.round(bf.blackRatio * 100)}%`);
    if (bf.freezeRatio > 0.8) flags.push(`frozen ${Math.round(bf.freezeRatio * 100)}%`);

    // duplicate (perceptual)
    const h = aHash(clipAbs, pr.duration / 2);
    let isDup = false;
    if (h) {
      for (const prev of hashes) {
        if (hamming(h, prev.bits) <= (qc.duplicateHammingMax ?? 6)) { isDup = true; flags.push(`duplicate of ${prev.moment_id}`); break; }
      }
      hashes.push({ moment_id: e.moment_id, bits: h });
    }

    // hard rejects vs soft (review)
    const hard = flags.some(f => /undecodable|black|frozen/.test(f));
    if (hard) { e.qa = { ok: false, flags, black: +bf.blackRatio.toFixed(2) }; e.status = 'NEEDS_SOURCE'; e.reason = 'QA reject: ' + flags.join(', '); reject++; continue; }
    if (isDup) { e.qa = { ok: true, review: true, flags }; if (e.decision === 'ACCEPT') e.decision = 'REVIEW'; dup++; }
    else e.qa = { ok: true, flags };
    if (flags.length && !isDup) e.qa.review = true;
    pass++;
  }

  U.ok(`local QA: ${pass} pass, ${dup} duplicate-flagged, ${reject} reject->NEEDS_SOURCE`);
  st.meta.qa = { pass, dup, reject };
  return resolved;
};
