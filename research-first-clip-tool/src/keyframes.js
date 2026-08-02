// ============================================================
//  KEYFRAME BANK (M2) — card-killer.
//
//  Idea: jo source hum PEHLE HI download kar chuke hain (Genspark-approved,
//  sahi show/episode), uske frames hi sabse behtar "image" hain — sahi show,
//  sahi character, sahi era, koi API nahi, koi rights ka naya sawaal nahi,
//  koi galat image nahi.
//
//  Har approved source se har N second par ek frame nikalte hain, black/flat
//  frames chhod dete hain, aur jis beat par clip nahi bani wahan scope-correct
//  still (Ken Burns motion ke sath) ya 2-3 frames ka montage laga dete hain.
//
//  Scope safety: frame sirf USI pack/source se aata hai jise research ne us
//  moment ke liye approve kiya. Cross-show mixing kabhi nahi.
// ============================================================
const fs = require('fs');
const path = require('path');
const U = require('./util.js');

const bankDir = id => U.ensureDir(U.p(id, 'cache', '_keyframes'));

// source media se SAARE keyframes EK ffmpeg pass mein (per-frame spawn bahut slow tha).
// Detail-score ke liye JPEG file size proxy: flat/black frame chhota compress hota hai,
// detail wali frame badi — koi extra ffmpeg call nahi.
function buildForSource(id, cfg, sourceId, mediaAbs) {
  const dir = path.join(bankDir(id), sourceId);
  const idx = path.join(dir, 'index.json');
  if (fs.existsSync(idx)) { try { return JSON.parse(fs.readFileSync(idx, 'utf8')); } catch {} }
  U.ensureDir(dir);
  const pr = U.probe(mediaAbs);
  if (!pr.ok) return { source_id: sourceId, frames: [] };

  const fb = cfg.fallback || {};
  const maxN = fb.maxKeyframesPerSource || 60;
  const W = (cfg.canvas && cfg.canvas.width) || 1920;
  // FULL-DURATION sampling: interval source ki apni length se aata hai, isliye
  // aakhiri scenes bhi cover hote hain. (M2 bug: fixed 4s x 60 = sirf pehle 240s.)
  const every = Math.max(fb.keyframeEverySeconds || 4, pr.duration / maxN);

  const pat = path.join(dir, 'kf_%04d.jpg');
  const r = U.ffmpeg(['-i', mediaAbs, '-vf', `fps=1/${every.toFixed(3)},scale=${W}:-2:flags=lanczos`,
    '-frames:v', String(maxN), '-q:v', '3', pat], { timeout: 300000 });
  if (!r.ok) return { source_id: sourceId, duration: pr.duration, frames: [] };

  const files = fs.readdirSync(dir).filter(f => /^kf_\d+\.jpg$/.test(f)).sort();
  const stats = files.map(f => ({ f, size: fs.statSync(path.join(dir, f)).size }));
  const sizes = stats.map(s => s.size).sort((a, b) => a - b);
  const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
  const floor = Math.max(6000, median * 0.35);          // bahut flat/black frames hatao

  const frames = [];
  for (let k = 0; k < stats.length; k++) {
    const s = stats[k];
    const t = +(( k + 0.5) * every).toFixed(2);
    if (s.size < floor) { try { fs.rmSync(path.join(dir, s.f), { force: true }); } catch {}; continue; }
    frames.push({ t, file: path.relative(U.jobDir(id), path.join(dir, s.f)), score: Math.round(s.size / 1024) });
  }
  const index = { source_id: sourceId, duration: pr.duration, width: pr.width, height: pr.height, frames };
  fs.writeFileSync(idx, JSON.stringify(index, null, 1));
  return index;
}

// job ke saare available source media (bank + local_file) se keyframes banao
function buildBank(spec, cfg, id, resolved) {
  const DL = require('./download.js');
  const SRC = require('./sources.js');
  const sources = SRC.indexSources(spec.pack);
  const built = {};
  const wanted = new Set();
  for (const e of resolved) {
    if (e.kind !== 'video') continue;
    for (const c of (e.candidates && e.candidates.length ? e.candidates : [e])) if (c.source_id) wanted.add(c.source_id);
  }
  for (const sid of wanted) {
    const s = sources[sid];
    if (!s) continue;
    let media = null;
    const bank = DL.bankPath(id, sid);
    if (fs.existsSync(bank) && U.probe(bank).ok) media = bank;
    else if (s.local_file) {
      const abs = path.isAbsolute(s.local_file) ? s.local_file : path.join(U.ROOT, s.local_file);
      if (fs.existsSync(abs) && U.probe(abs).ok) media = abs;
    }
    if (!media) continue;   // is source ki poori file nahi hai (sirf ranges) -> skip
    const idx = buildForSource(id, cfg, sid, media);
    if (idx.frames && idx.frames.length) built[sid] = idx;
  }
  return built;
}

// ranges se bhi still nikal sakte hain (jab poori source na ho): cut clip se frame
function stillFromClip(id, cfg, clipRel, atFraction = 0.5) {
  const src = U.p(id, clipRel);
  if (!fs.existsSync(src)) return null;
  const pr = U.probe(src);
  if (!pr.ok) return null;
  const dir = U.ensureDir(path.join(bankDir(id), '_fromclips'));
  const out = path.join(dir, path.basename(clipRel).replace(/\.mp4$/i, '') + `_${Math.round(atFraction * 100)}.jpg`);
  if (!fs.existsSync(out)) {
    const r = U.ffmpeg(['-ss', (pr.duration * atFraction).toFixed(2), '-i', src, '-frames:v', '1', '-q:v', '3', out]);
    if (!r.ok || !fs.existsSync(out)) return null;
  }
  return path.relative(U.jobDir(id), out);
}

// ek beat ke liye best frames chuno — STRICT SCOPE LOCK.
//  allowedSources: SIRF ye source IDs (research/scope se aaye). Khaali list =
//    koi frame nahi (poore project ke bank se uthana STRICTLY forbidden hai —
//    warna Show A ka frame Show B ke beat mein chala jata tha).
//  hints: [{source_id, time_sec}] — deterministic selector, sabse pehli priority.
//  nearSec: us moment ka source-time (aas-paas ke frames prefer).
//  used: pehle use ho chuke frames (variety); pool khatam ho to controlled REUSE
//    hoti hai — generic card se behtar hai.
function pickFrames(bank, allowedSources, used, n = 1, nearSec = null, hints = []) {
  const allow = Array.isArray(allowedSources) ? allowedSources.filter(Boolean) : [];
  if (!allow.length) return [];                       // scope-lock: no allow-list => no frames
  const allowSet = new Set(allow);
  const out = [];

  // 1) explicit frame_hints (sirf allowed sources ke)
  for (const h of (hints || [])) {
    if (out.length >= n) break;
    if (!h || !allowSet.has(h.source_id)) continue;
    const idx = bank[h.source_id];
    if (!idx || !idx.frames.length) continue;
    let best = null;
    for (const f of idx.frames) { const d = Math.abs(f.t - h.time_sec); if (!best || d < best.d) best = { f, d }; }
    if (best) out.push({ ...best.f, source_id: h.source_id, why: `frame_hint ${h.time_sec}s${h.reason ? ' — ' + h.reason : ''}` });
  }

  const pool = [];
  for (const sid of allow) {
    const idx = bank[sid];
    if (!idx) continue;
    for (const f of idx.frames) pool.push({ ...f, source_id: sid });
  }
  if (!pool.length) return out;

  const rank = arr => arr.sort((a, b) => {
    if (nearSec != null) {
      const da = Math.abs(a.t - nearSec), db = Math.abs(b.t - nearSec);
      if (Math.abs(da - db) > 1) return da - db;       // moment ke aas-paas pehle
    }
    return b.score - a.score;
  });

  // 2) pehle un-used frames
  const fresh = rank(pool.filter(f => !used.has(f.file) && !out.some(o => o.file === f.file)));
  for (const f of fresh) {
    if (out.length >= n) break;
    if (out.some(o => o.source_id === f.source_id && Math.abs(o.t - f.t) < 6)) continue;   // variety
    out.push({ ...f, why: nearSec != null ? `nearest frame to ${Math.round(nearSec)}s in ${f.source_id}` : `best frame in ${f.source_id}` });
  }
  // 3) pool khatam -> CONTROLLED REUSE (galat show ya card se behtar)
  if (out.length < n) {
    for (const f of rank(pool.filter(f => !out.some(o => o.file === f.file)))) {
      if (out.length >= n) break;
      out.push({ ...f, reused: true, why: `reused frame from ${f.source_id} (scope-correct pool exhausted)` });
    }
  }
  return out;
}

module.exports = { buildBank, buildForSource, pickFrames, stillFromClip, bankDir };
