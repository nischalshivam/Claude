// ============================================================
//  Stage 4 — DOWNLOAD (sirf zaroori range) + ALTERNATE fallback + resume-safe.
//   - raw_file (relative) + raw_offset resolved.json mein PERSIST hote hain,
//     taaki alag process se cut resume ho (P0-2 fix).
//   - url range cache MS-exact key + manifest + probe-before-reuse (P1-6 fix).
//   - candidate order: download 403/unavailable -> agla candidate.
//  NOTE: sandbox mein YouTube proxy-blocked; url path Windows par. local_file yahan bhi.
// ============================================================
const fs = require('fs');
const path = require('path');
const U = require('./util.js');

// entry.raw_file/raw_kind se absolute path banao (resume par reconstruct)
function resolveRaw(id, e) {
  if (!e.raw_file) return null;
  if (e.raw_kind === 'local') return path.isAbsolute(e.raw_file) ? e.raw_file : path.join(U.ROOT, e.raw_file);
  return U.p(id, e.raw_file);   // 'job' relative (cache/_raw/...)
}

// MS-exact, collision-proof cache key (10.1-20.1 vs 10.9-20.9 => alag files)
function rangeKey(sourceId, segStart, segEnd, minH) {
  return `${sourceId}__${Math.round(segStart * 1000)}_${Math.round(segEnd * 1000)}__h${minH}.mp4`;
}

// ---------------- PER-SOURCE BANK (M2-B) ----------------
// Ek source ko BAAR-BAAR range-download karne ke bajaye EK BAAR poora (<=720p)
// laakar local se saare moments cut karo. Nicole run: 53 downloads -> ~13.
// Sirf chhoti/reused sources ke liye; lambi source ke liye range download hi.
function bankPath(id, sourceId) { return U.p(id, 'cache', '_bank', `${sourceId}.mp4`); }

function acquireFullSource(id, cfg, cand, meta) {
  const bank = bankPath(id, cand.source_id);
  const man = bank + '.json';
  U.ensureDir(path.dirname(bank));
  if (fs.existsSync(bank) && fs.existsSync(man)) {
    const pr = U.probe(bank);
    if (pr.ok) return { ok: true, file: bank, duration: pr.duration, width: pr.width, height: pr.height, via: 'bank-cache' };
    try { fs.rmSync(bank, { force: true }); fs.rmSync(man, { force: true }); } catch {}
  }
  const maxH = (cfg.acquire && cfg.acquire.maxHeight) || 720;
  const fmt = `bv*[height<=${maxH}][ext=mp4]+ba/b[height<=${maxH}][ext=mp4]/b[height<=${maxH}]/bv*[height<=${maxH}]/b`;
  const r = U.ytdlp(['-f', fmt, '--merge-output-format', 'mp4', ...U.ytRuntimeArgs(cfg),
    '-o', bank, '--no-playlist', '--no-warnings', cand.url],
    { timeout: (cfg.acquire && cfg.acquire.timeoutMs) || 900000 });
  if (!r.ok || !fs.existsSync(bank)) {
    try { if (fs.existsSync(bank)) fs.rmSync(bank, { force: true }); } catch {}
    return { ok: false, error: (r.stderr || 'full-source download fail').replace(/\s+/g, ' ').slice(0, 180) };
  }
  const pr = U.probe(bank);
  if (!pr.ok) { try { fs.rmSync(bank, { force: true }); } catch {}; return { ok: false, error: `full source invalid: ${pr.error}` }; }
  fs.writeFileSync(man, JSON.stringify({ url: cand.url, source_id: cand.source_id, maxH, duration: pr.duration, width: pr.width, height: pr.height, at: Date.now() }));
  return { ok: true, file: bank, duration: pr.duration, width: pr.width, height: pr.height, via: 'yt-dlp-full' };
}

// kaunse sources ko poora laana hai? (chhote + reuse hone wale)
function planAcquisition(cfg, resolved, metaOf) {
  const acq = cfg.acquire || {};
  const maxFullSec = acq.fullDownloadMaxSeconds || 900;      // <=15 min sources
  const minUses = acq.fullDownloadMinUses || 2;
  const uses = {};
  for (const e of resolved) {
    if (e.kind !== 'video') continue;
    for (const c of candList(e)) if (c.url) uses[c.source_id] = (uses[c.source_id] || 0) + 1;
  }
  const plan = {};
  for (const sid of Object.keys(uses)) {
    const meta = metaOf(sid);
    const dur = meta && meta.duration || 0;
    plan[sid] = (dur > 0 && dur <= maxFullSec && uses[sid] >= minUses) || (dur > 0 && dur <= (acq.alwaysFullUnderSeconds || 420));
  }
  return { plan, uses };
}

// ek candidate materialize karo (download/local). {ok, raw_file, raw_offset, raw_kind, via, error}
function downloadCandidate(id, cfg, cand, opts = {}) {
  if (cand.local_file) {
    const abs = path.isAbsolute(cand.local_file) ? cand.local_file : path.join(U.ROOT, cand.local_file);
    if (!fs.existsSync(abs)) return { ok: false, error: `local_file missing: ${cand.local_file}` };
    const pr = U.probe(abs);
    if (!pr.ok) return { ok: false, error: `local_file unreadable: ${pr.error}` };
    return { ok: true, raw_file: cand.local_file, raw_offset: 0, raw_kind: 'local', src_w: pr.width, src_h: pr.height, via: 'local' };
  }
  if (!cand.url) return { ok: false, error: 'na url na local_file' };

  // --- BANK FIRST: poori source pehle se aayi hui hai to usi se cut hoga (koi download nahi)
  const bank = bankPath(id, cand.source_id);
  if (opts.useBank !== false) {
    let pr = fs.existsSync(bank) ? U.probe(bank) : { ok: false };
    if (!pr.ok && opts.acquireBank) {
      const got = acquireFullSource(id, cfg, cand, opts.meta);
      if (got.ok) pr = { ok: true, width: got.width, height: got.height, duration: got.duration };
      else if (opts.bankOnly) return { ok: false, error: got.error };
    }
    if (pr.ok) {
      if (cand.cut && cand.cut.start >= pr.duration) return { ok: false, error: `requested start ${cand.cut.start}s beyond source ${Math.round(pr.duration)}s` };
      return { ok: true, raw_file: path.relative(U.jobDir(id), bank), raw_offset: 0, raw_kind: 'job', src_w: pr.width, src_h: pr.height, via: 'source-bank' };
    }
  }

  const clip = cfg.clip, guard = clip.downloadGuardSeconds || 3, minH = cfg.qa.minHeight || 480;
  const segStart = Math.max(0, cand.cut.start - guard);
  const segEnd = cand.cut.end + guard;
  const rawDir = U.ensureDir(U.p(id, 'cache', '_raw'));
  const rawFile = path.join(rawDir, rangeKey(cand.source_id, segStart, segEnd, minH));
  const manFile = rawFile + '.json';
  const relRaw = path.relative(U.jobDir(id), rawFile);

  // reuse only if cached file probes ok AND manifest matches request
  if (fs.existsSync(rawFile) && fs.existsSync(manFile)) {
    try {
      const man = JSON.parse(fs.readFileSync(manFile, 'utf8'));
      const pr = U.probe(rawFile);
      if (pr.ok && Math.abs(man.segStart - segStart) < 0.005 && Math.abs(man.segEnd - segEnd) < 0.005 && man.url === cand.url) {
        return { ok: true, raw_file: relRaw, raw_offset: segStart, raw_kind: 'job', src_w: pr.width, src_h: pr.height, via: 'cache' };
      }
    } catch {}
  }

  // cacheOnly: sirf pata karna tha ki cache hai ya nahi (network bilkul nahi)
  if (opts.cacheOnly) return { ok: false, error: 'not cached', cacheMiss: true };

  // stale/mismatch cache file hata do warna yt-dlp "already downloaded" bol ke purane bytes rakh sakta hai
  try { if (fs.existsSync(rawFile)) fs.rmSync(rawFile, { force: true }); if (fs.existsSync(manFile)) fs.rmSync(manFile, { force: true }); } catch {}
  const fmt = `bv*[height>=${minH}][ext=mp4]/bv*[ext=mp4]/bv*/b[height>=${minH}]/b`;
  const args = ['-f', fmt, '--download-sections', `*${segStart.toFixed(3)}-${segEnd.toFixed(3)}`,
    '--force-keyframes-at-cuts', '--merge-output-format', 'mp4', ...U.ytRuntimeArgs(cfg),
    '-o', rawFile, '--no-playlist', '--no-warnings', cand.url];
  const r = U.ytdlp(args, { timeout: (cfg.download && cfg.download.timeoutMs) || 300000 });
  if (!r.ok || !fs.existsSync(rawFile)) {
    const err = (r.stderr || 'download fail').replace(/\s+/g, ' ').slice(0, 200);
    const flag = /403|forbidden|sign in|po.?token|not available|unavailable|requested format/i.test(err) ? '[403/unavailable] ' : '';
    try { if (fs.existsSync(rawFile)) fs.rmSync(rawFile, { force: true }); } catch {}
    return { ok: false, error: flag + err };
  }
  // STRICT: empty/streamless/short download ko kabhi READY mat bolo (M1.3 ka 262-byte bug)
  const pr = U.probe(rawFile);
  if (!pr.ok) {
    try { fs.rmSync(rawFile, { force: true }); if (fs.existsSync(manFile)) fs.rmSync(manFile, { force: true }); } catch {}
    return { ok: false, error: `invalid media: ${pr.error} (quarantined, retry/alternate)`, invalidMedia: true };
  }
  // requested range actually mila? (guard ke saath segment length ~ expected)
  const wantLen = Math.max(0.5, (cand.cut ? cand.cut.dur || (cand.cut.end - cand.cut.start) : 1));
  if (pr.duration + 0.75 < wantLen) {
    try { fs.rmSync(rawFile, { force: true }); } catch {}
    return { ok: false, error: `range short: got ${pr.duration.toFixed(2)}s, need ${wantLen.toFixed(2)}s`, invalidMedia: true };
  }
  fs.writeFileSync(manFile, JSON.stringify({ segStart, segEnd, url: cand.url, minH, at: Date.now(), duration: pr.duration, w: pr.width, h: pr.height }));
  return { ok: true, raw_file: relRaw, raw_offset: segStart, raw_kind: 'job', src_w: pr.width, src_h: pr.height, via: 'yt-dlp' };
}

// entry ko candidate se promote (chosen fields set)
function promote(e, cand, ci, res) {
  Object.assign(e, {
    source_id: cand.source_id, source_kind: cand.source_kind, url: cand.url || null, local_file: cand.local_file || null,
    locator_type: cand.locator_type, decision: cand.decision, score: cand.score, recall: cand.recall,
    reason: (ci > 0 ? `[alternate #${ci + 1}] ` : '') + cand.reason, matched: cand.matched || null, cut: cand.cut,
    candidate_index: ci, raw_file: res.raw_file, raw_offset: res.raw_offset, raw_kind: res.raw_kind,
    src_w: res.src_w || null, src_h: res.src_h || null,
  });
}

const candList = e => (e.candidates && e.candidates.length ? e.candidates
  : [{ source_id: e.source_id, url: e.url, local_file: e.local_file, cut: e.cut, locator_type: e.locator_type, decision: e.decision, score: e.score, recall: e.recall, reason: e.reason, matched: e.matched, source_kind: e.source_kind }]);

module.exports = function download(spec, cfg, st, resolved) {
  const id = spec.id;
  let ok = 0, fail = 0, local = 0, switched = 0, reused = 0;

  const todo = resolved.filter(e => e.kind === 'video' && (e.status === 'RESOLVED' || e.status === 'NEEDS_REVIEW'));
  const secs = t0 => ((Date.now() - t0) / 1000).toFixed(1);

  // ---- Stage 4a: SOURCE BANK — har unique source EK BAAR (<=720p) ----
  const SRC = require('./sources.js');
  const sources = SRC.indexSources(spec.pack);
  const metaOf = sid => { const s = sources[sid]; return s ? SRC.getMeta(id, s, cfg) : null; };
  const { plan, uses } = planAcquisition(cfg, resolved, metaOf);
  // ---- LAZY: pehle dekho kaunse moments ke paas PEHLE SE valid cached range hai
  //      (M1.3 ka cache bhi isi mein aa jata hai). Jitne already cached hain,
  //      unke liye full source download karne ki zaroorat NAHI. ----
  const missingBySource = {};
  for (const e of todo) {
    for (const c of candList(e)) {
      if (!c.url) continue;
      const probeOnly = downloadCandidate(id, cfg, c, { useBank: true, acquireBank: false, cacheOnly: true });
      if (!probeOnly.ok) missingBySource[c.source_id] = (missingBySource[c.source_id] || 0) + 1;
      break;   // sirf primary candidate dekho
    }
  }
  const minMissing = (cfg.acquire && cfg.acquire.lazyMinMissing) || 2;
  const wanted = Object.keys(plan).filter(sid => plan[sid] && (missingBySource[sid] || 0) >= minMissing);
  const skipped = Object.keys(plan).filter(sid => plan[sid] && !wanted.includes(sid));
  // ---- ACQUISITION PLAN LOG (network se pehle) ----
  U.log(`   acquisition plan: ${Object.keys(uses).length} unique URL source(s) | cache se mil rahe: ${Object.keys(uses).length - Object.keys(missingBySource).length} | naye full downloads: ${wanted.length}`);
  if (skipped.length) U.log(`   skip full-download (cache kaafi hai): ${skipped.join(', ')}`);
  const bankState = {};
  if (wanted.length) {
    U.log(`   source bank: ${wanted.length} unique source(s) ek-ek baar poore aayenge (<=${(cfg.acquire && cfg.acquire.maxHeight) || 720}p), phir sab clips local se katenge.`);
    let bi = 0;
    for (const sid of wanted) {
      bi++;
      const anyCand = todo.flatMap(e => candList(e)).find(c => c.source_id === sid && c.url);
      if (!anyCand) continue;
      const meta = metaOf(sid);
      const t0 = Date.now();
      U.log(`   [source ${bi}/${wanted.length}] ${sid} (${Math.round((meta && meta.duration) || 0)}s, ${uses[sid]} moments) downloading...`);
      const got = acquireFullSource(id, cfg, anyCand, meta);
      bankState[sid] = got.ok;
      U.log(got.ok ? `   [source ${bi}/${wanted.length}] ${sid} OK via ${got.via} in ${secs(t0)}s — is source ke ${uses[sid]} clips ab bina download ke katenge`
                   : `   [source ${bi}/${wanted.length}] ${sid} FAILED in ${secs(t0)}s — ${String(got.error).slice(0, 100)} (per-moment range par gir jayenge)`);
    }
  }

  U.log(`   ${todo.length} video moments — ab cut ke liye media taiyaar ho raha hai.`);
  U.log(`   note: ek yt-dlp attempt zyada se zyada ${Math.round((cfg.download && cfg.download.timeoutMs || 300000) / 1000)}s tak chup reh sakta hai — ye normal hai, hang nahi.`);

  let n = 0;
  for (const e of todo) {
    n++;
    const label = `[download ${n}/${todo.length}] ${e.moment_id} | source ${e.source_id || '-'}`;

    // resume: pehle se valid raw hai to skip
    const t0 = Date.now();
    const existing = resolveRaw(id, e);
    if (existing && fs.existsSync(existing) && U.probe(existing).ok) {
      e.download = { ok: true, via: 'resume-cache' }; ok++; reused++;
      U.log(`${label} | RESUME-CACHE (pehle se maujood, dobara download nahi) ${secs(t0)}s`);
      continue;
    }

    const cands = candList(e);
    U.log(`${label} | starting (${cands.length} candidate${cands.length > 1 ? 's' : ''})`);
    const dlAttempts = [];
    let done = false;
    for (let ci = 0; ci < cands.length; ci++) {
      const t1 = Date.now();
      U.log(`     attempt ${ci + 1}/${cands.length} ${cands[ci].source_id}${cands[ci].url ? ' (yt-dlp range)' : ' (local file)'} ...`);
      const res = downloadCandidate(id, cfg, cands[ci]);
      if (res.ok) {
        if (ci > 0) switched++;
        promote(e, cands[ci], ci, res);
        e.download = { ok: true, via: res.via, candidate: ci, attempts: dlAttempts };
        if (res.via === 'local') local++;
        const tag = res.via === 'cache' ? 'RANGE-CACHE (pehle se download, reuse)' : (ci > 0 ? `ALTERNATE ok via ${res.via}` : `READY via ${res.via}`);
        U.log(`     ${tag} in ${secs(t1)}s`);
        ok++; done = true; break;
      }
      dlAttempts.push({ candidate: ci, source_id: cands[ci].source_id, error: res.error });
      const more = ci + 1 < cands.length;
      U.log(`     FAILED in ${secs(t1)}s — ${String(res.error).slice(0, 110)}`);
      if (more) U.log(`     -> agla alternate candidate try kar rahe hain`);
    }
    if (!done) {
      e.status = 'NEEDS_SOURCE';
      e.reason = `all ${cands.length} candidate(s) failed: ` + dlAttempts.map(a => `${a.source_id}:${a.error}`).join(' | ');
      e.download = { ok: false, attempts: dlAttempts };
      fail++;
      U.log(`${label} | NEEDS_SOURCE (saare candidates fail — random footage NAHI lagayi jayegi)`);
    }
  }

  U.ok(`download: ${ok} ready (${local} local, ${switched} via alternate, ${reused} resume-cache), ${fail} failed -> NEEDS_SOURCE`);
  st.meta.download = { ok, local, switched, reused, fail };
  return resolved;
};

module.exports.downloadCandidate = downloadCandidate;
module.exports.resolveRaw = resolveRaw;
module.exports.promote = promote;
module.exports.candList = candList;
module.exports.rangeKey = rangeKey;
module.exports.bankPath = bankPath;
module.exports.acquireFullSource = acquireFullSource;
module.exports.planAcquisition = planAcquisition;
