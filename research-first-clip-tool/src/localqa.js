// ============================================================
//  Stage 6 — LOCAL QA (deterministic, koi API nahi) + candidate fallback.
//   - stderr ab capture hota hai (spawnSync) -> blackdetect/freezedetect kaam.
//   - SOURCE raw resolution check (cut ke upscale SE PEHLE).
//   - hard QA fail (undecodable/black/frozen/low-res) -> AGLA candidate
//     (download+cut+qa) try; sab fail -> NEEDS_SOURCE. (P1-7, P1-10)
//   - duplicate (perceptual aHash; flat frame skip) -> review flag.
// ============================================================
const fs = require('fs');
const U = require('./util.js');
const DL = require('./download.js');
const CUT = require('./cut.js');

function aHash(clip, midSec) {
  const tmp = clip + '.ah.gray';
  const r = U.ffmpeg(['-ss', Math.max(0, midSec).toFixed(2), '-i', clip, '-frames:v', '1', '-vf', 'scale=8:8,format=gray', '-f', 'rawvideo', tmp]);
  if (!r.ok || !fs.existsSync(tmp)) return null;
  const buf = fs.readFileSync(tmp); fs.rmSync(tmp, { force: true });
  if (buf.length < 64) return null;
  let sum = 0; for (let i = 0; i < 64; i++) sum += buf[i];
  const avg = sum / 64;
  let variance = 0; for (let i = 0; i < 64; i++) variance += (buf[i] - avg) ** 2; variance /= 64;
  if (variance < 25) return null;   // flat frame -> perceptual hash bekaar
  const bits = new Uint8Array(64); for (let i = 0; i < 64; i++) bits[i] = buf[i] >= avg ? 1 : 0;
  return bits;
}
const hamming = (a, b) => { let d = 0; for (let i = 0; i < 64; i++) if (a[i] !== b[i]) d++; return d; };

function blackFreeze(clip, dur) {
  const r = U.ffmpegRaw(['-i', clip, '-vf', 'blackdetect=d=0.1:pix_th=0.10,freezedetect=n=-60dB:d=0.5', '-an', '-f', 'null', '-']);
  const txt = r.stderr || '';
  let black = 0, freeze = 0, m;
  const bre = /black_duration:(\d+\.?\d*)/g; while ((m = bre.exec(txt))) black += parseFloat(m[1]);
  const fre = /freeze_duration:\s*(\d+\.?\d*)/g; while ((m = fre.exec(txt))) freeze += parseFloat(m[1]);
  return { blackRatio: dur ? black / dur : 0, freezeRatio: dur ? freeze / dur : 0 };
}

// ek clip par QA. { hard, flags[] }  hard=true => reject (alternate try karo).
function qaOne(id, cfg, e) {
  const qc = cfg.qa;
  const clipAbs = U.p(id, e.clip);
  const flags = [];
  const pr = U.probe(clipAbs);
  if (!pr.ok) return { hard: true, flags: ['undecodable'] };

  const wantDur = e.cut.dur || (e.cut.end - e.cut.start);
  if (Math.abs(pr.duration - wantDur) > (qc.durationTolerance || 0.5)) flags.push(`duration ${pr.duration.toFixed(2)}s vs ${wantDur.toFixed(2)}s`);

  // SOURCE raw resolution (upscale se pehle) — e.src_h download se persist.
  // M2-A4: exact/official 360p cartoon clip diagnostic card se BEHTAR hai. Isliye
  // 360p+ = warning (accept + report flag), sirf bahut chhoti (<288p) hard reject.
  const srcH = e.src_h || 0;
  const hardFloor = qc.hardMinHeight || 288;
  if (srcH && srcH < hardFloor) flags.push(`unusably low-res source ${e.src_w || '?'}x${srcH}`);
  else if (srcH && srcH < (qc.minHeight || 480)) flags.push(`low-res source ${e.src_w || '?'}x${srcH} (accepted, upscaled)`);

  const bf = blackFreeze(clipAbs, pr.duration);
  if (bf.blackRatio > (qc.blackFrameMaxRatio || 0.5)) flags.push(`black ${Math.round(bf.blackRatio * 100)}%`);
  if (bf.freezeRatio > 0.8) flags.push(`frozen ${Math.round(bf.freezeRatio * 100)}%`);

  const hard = flags.some(f => /undecodable|black \d|frozen|unusably low-res/.test(f));
  return { hard, flags, black: +bf.blackRatio.toFixed(2), freeze: +bf.freezeRatio.toFixed(2), mid: pr.duration / 2 };
}

module.exports = function localqa(spec, cfg, st, resolved) {
  const id = spec.id;
  const hashes = [];
  let pass = 0, reject = 0, dup = 0, recovered = 0;

  for (const e of resolved) {
    if (e.kind !== 'video' || (e.status !== 'RESOLVED' && e.status !== 'NEEDS_REVIEW') || !e.clip) continue;

    let res = qaOne(id, cfg, e);

    // hard fail -> agla candidate try (download+cut+qa)
    if (res.hard) {
      const cands = DL.candList(e);
      let start = (e.candidate_index || 0) + 1;
      let fixed = false;
      const failFlags = res.flags.slice();
      for (let ci = start; ci < cands.length; ci++) {
        const dl = DL.downloadCandidate(id, cfg, cands[ci]);
        if (!dl.ok) { failFlags.push(`cand${ci}:dl ${dl.error}`); continue; }
        DL.promote(e, cands[ci], ci, dl);
        const cutRes = CUT.cutClip(id, cfg, e);
        if (!cutRes.ok) { failFlags.push(`cand${ci}:cut ${cutRes.error}`); continue; }
        e.clip = cutRes.clip;
        res = qaOne(id, cfg, e);
        if (!res.hard) { fixed = true; recovered++; break; }
        failFlags.push(`cand${ci}:qa ${res.flags.join(',')}`);
      }
      if (!fixed) { e.qa = { ok: false, flags: failFlags }; e.status = 'NEEDS_SOURCE'; e.reason = 'QA reject (all candidates): ' + failFlags.join(' | '); reject++; continue; }
    }

    // ---- duplicate: ab DEFAULT soft hai (M2-A) ----
    // Purana behavior: ek middle-frame 8x8 aHash match -> clip NEEDS_REVIEW -> production
    // card. Cartoon close-ups aasani se false-positive dete hain (Nicole run mein 6 valid
    // clips isi wajah se card ban gaye). Ab: SAME source ka OVERLAPPING range hi asli
    // duplicate hai; sirf visual similarity = diversity warning (clip final mein rehti hai).
    const flags = res.flags.slice();
    const clipAbsNow = U.p(id, e.clip);
    // 3 frames se compare (ek frame se zyada bharosemand)
    const pr2 = U.probe(clipAbsNow);
    const D = pr2.ok ? pr2.duration : 3;
    const sig = [0.25, 0.5, 0.75].map(f => aHash(clipAbsNow, D * f)).filter(Boolean);

    let hardDup = null, softDup = null;
    for (const prev of hashes) {
      // (a) HARD: wahi source + overlapping source-range = sach mein wahi footage
      const sameSrc = prev.source_id && e.source_id && prev.source_id === e.source_id;
      const overlap = sameSrc && e.cut && prev.cut && !(e.cut.end <= prev.cut.start || e.cut.start >= prev.cut.end);
      if (overlap) { hardDup = prev; break; }
      // (b) SOFT: sab sampled frames similar (sirf diversity warning)
      if (sig.length && prev.sig.length) {
        const pairs = Math.min(sig.length, prev.sig.length);
        let sim = 0; for (let k = 0; k < pairs; k++) if (hamming(sig[k], prev.sig[k]) <= (cfg.qa.duplicateHammingMax ?? 6)) sim++;
        if (sim === pairs && pairs >= 2) softDup = prev;
      }
    }
    hashes.push({ moment_id: e.moment_id, sig, source_id: e.source_id, cut: e.cut });

    if (hardDup) {
      flags.push(`same-source overlapping range as ${hardDup.moment_id}`);
      dup++;
      if ((cfg.qa.duplicateAction || 'warn') === 'holdout' && e.status === 'RESOLVED') { e.status = 'NEEDS_REVIEW'; e.review_reason = 'duplicate range'; }
    } else if (softDup) {
      flags.push(`looks similar to ${softDup.moment_id} (diversity warning only)`);
      dup++;
    }
    e.qa = { ok: true, flags, review: flags.length > 0, black: res.black, freeze: res.freeze };
    pass++;
  }

  U.ok(`local QA: ${pass} pass (${dup} duplicate-flagged, ${recovered} recovered via alternate), ${reject} reject -> NEEDS_SOURCE`);
  st.meta.qa = { pass, dup, recovered, reject };
  return resolved;
};
