// ============================================================
//  Stage 5 — CUT (frame-accurate) + resume-safe.
//   - raw_file (persisted) se abs path reconstruct; missing/corrupt ho to
//     re-download (silent skip NAHI — P0-2 fix).
//   - precise -ss/-t re-encode, source audio MUTE, canvas scale+crop.
//   - cut window ko source duration par re-clamp.
//  Output: clips/clip_<moment_id>.mp4. cutClip() helper QA-fallback reuse karta hai.
// ============================================================
const fs = require('fs');
const path = require('path');
const U = require('./util.js');
const DL = require('./download.js');

// clip kis source/range/canvas se bani — manifest. Reuse sirf exact match par.
function clipManifest(cfg, e) {
  return {
    source_id: e.source_id || null, url: e.url || null, local_file: e.local_file || null,
    raw_file: e.raw_file || null, raw_offset: e.raw_offset || 0,
    start: e.cut && e.cut.start, end: e.cut && e.cut.end, dur: e.cut && e.cut.dur,
    W: cfg.canvas.width, H: cfg.canvas.height, FPS: cfg.canvas.fps, crf: cfg.render.crf, preset: cfg.render.preset,
  };
}
const manPath = (id, mid) => U.p(id, `clips/clip_${mid}.json`);
function manifestMatches(id, cfg, e) {
  const f = manPath(id, e.moment_id);
  if (!fs.existsSync(f)) return false;
  try { return JSON.stringify(JSON.parse(fs.readFileSync(f, 'utf8'))) === JSON.stringify(clipManifest(cfg, e)); } catch { return false; }
}

// entry ka final clip banao. { ok, clip(rel), error }
function cutClip(id, cfg, e) {
  const W = cfg.canvas.width, H = cfg.canvas.height, FPS = cfg.canvas.fps;
  let raw = DL.resolveRaw(id, e);
  // resume: raw missing/corrupt -> re-download current candidate
  if (!raw || !fs.existsSync(raw) || !U.probe(raw).ok) {
    const cands = DL.candList(e);
    const cand = cands[e.candidate_index || 0] || cands[0];
    const res = DL.downloadCandidate(id, cfg, cand);
    if (!res.ok) return { ok: false, error: `raw missing & re-download failed: ${res.error}` };
    DL.promote(e, cand, e.candidate_index || 0, res);
    raw = DL.resolveRaw(id, e);
    if (!raw || !fs.existsSync(raw)) return { ok: false, error: 'raw still missing after re-download' };
  }

  const pr = U.probe(raw);
  const rawDur = pr.ok ? pr.duration : 0;
  let ss = Math.max(0, e.cut.start - (e.raw_offset || 0));
  let dur = e.cut.dur || (e.cut.end - e.cut.start);
  // re-clamp to available raw
  if (rawDur && ss >= rawDur) return { ok: false, error: `cut start ${ss.toFixed(2)}s beyond raw ${rawDur.toFixed(2)}s` };
  if (rawDur && ss + dur > rawDur) dur = Math.max(0.3, rawDur - ss);

  const outRel = `clips/clip_${e.moment_id}.mp4`;
  const out = U.p(id, outRel);
  U.ensureDir(U.p(id, 'clips'));
  const vf = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1`;
  const r = U.ffmpeg(['-ss', ss.toFixed(3), '-i', raw, '-t', dur.toFixed(3), '-an',
    '-vf', vf, '-c:v', 'libx264', '-preset', cfg.render.preset || 'veryfast', '-crf', String(cfg.render.crf || 21),
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { timeout: 300000 });
  if (!r.ok || !fs.existsSync(out)) return { ok: false, error: `ffmpeg cut fail: ${(r.stderr || '').slice(0, 140)}` };
  e.cut.dur = +dur.toFixed(3);
  fs.writeFileSync(manPath(id, e.moment_id), JSON.stringify(clipManifest(cfg, e)));   // dependency manifest
  return { ok: true, clip: outRel };
}

module.exports = function cut(spec, cfg, st, resolved) {
  const id = spec.id;
  let ok = 0, fail = 0, recovered = 0;
  for (const e of resolved) {
    if (e.kind !== 'video' || (e.status !== 'RESOLVED' && e.status !== 'NEEDS_REVIEW')) continue;
    const outRel = `clips/clip_${e.moment_id}.mp4`;
    // resume: reuse SIRF tab jab clip probeable ho AUR manifest (source/range/canvas) match kare
    if (fs.existsSync(U.p(id, outRel)) && U.probe(U.p(id, outRel)).ok && manifestMatches(id, cfg, e)) { e.clip = outRel; ok++; continue; }
    let res = cutClip(id, cfg, e);
    // ALTERNATE RETRY: pehle ek cut fail = seedha NEEDS_SOURCE, chahe research ne
    // doosra verified candidate diya ho. Ab har viable candidate try hota hai —
    // download aur QA stage pehle se aisa karte the, cut nahi karta tha.
    const attempts = [{ source_id: e.source_id, error: res.ok ? null : res.error }];
    if (!res.ok && Array.isArray(e.candidates) && e.candidates.length > 1) {
      for (const c of e.candidates) {
        if (c.source_id === e.source_id && c.locator_type === e.locator_type) continue;
        const alt = { ...e, source_id: c.source_id, source_kind: c.source_kind, url: c.url,
          local_file: c.local_file, locator_type: c.locator_type, decision: c.decision,
          score: c.score, recall: c.recall, reason: c.reason, matched: c.matched, cut: c.cut };
        const r2 = cutClip(id, cfg, alt);
        attempts.push({ source_id: c.source_id, error: r2.ok ? null : r2.error });
        if (r2.ok) {
          U.log(`   cut retry OK: ${e.moment_id} -> alternate ${c.source_id} (${c.locator_type})`);
          Object.assign(e, { source_id: c.source_id, source_kind: c.source_kind, url: c.url,
            local_file: c.local_file, locator_type: c.locator_type, decision: c.decision,
            score: c.score, recall: c.recall, reason: c.reason, matched: c.matched, cut: c.cut });
          res = r2; break;
        }
      }
    }
    e.cut_attempts = attempts;
    if (res.ok) { e.clip = res.clip; ok++; if (attempts.length > 1) recovered++; }
    else { e.clip = null; e.status = 'NEEDS_SOURCE'; e.reason = res.error; fail++; }
  }
  U.ok(`cut: ${ok} clips (preferred length, muted)${recovered ? `, ${recovered} alternate se bache` : ''}, ${fail} failed -> NEEDS_SOURCE`);
  st.meta.cut = { ok, fail, recovered };
  return resolved;
};

module.exports.cutClip = cutClip;
