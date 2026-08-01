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
  return { ok: true, clip: outRel };
}

module.exports = function cut(spec, cfg, st, resolved) {
  const id = spec.id;
  let ok = 0, fail = 0;
  for (const e of resolved) {
    if (e.kind !== 'video' || (e.status !== 'RESOLVED' && e.status !== 'NEEDS_REVIEW')) continue;
    const outRel = `clips/clip_${e.moment_id}.mp4`;
    if (fs.existsSync(U.p(id, outRel)) && U.probe(U.p(id, outRel)).ok) { e.clip = outRel; ok++; continue; }  // resume
    const res = cutClip(id, cfg, e);
    if (res.ok) { e.clip = res.clip; ok++; }
    else { e.clip = null; e.status = 'NEEDS_SOURCE'; e.reason = res.error; fail++; }
  }
  U.ok(`cut: ${ok} clips (preferred length, muted), ${fail} failed -> NEEDS_SOURCE`);
  st.meta.cut = { ok, fail };
  return resolved;
};

module.exports.cutClip = cutClip;
