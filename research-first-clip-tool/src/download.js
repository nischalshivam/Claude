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

// ek candidate materialize karo (download/local). {ok, raw_file, raw_offset, raw_kind, via, error}
function downloadCandidate(id, cfg, cand) {
  if (cand.local_file) {
    const abs = path.isAbsolute(cand.local_file) ? cand.local_file : path.join(U.ROOT, cand.local_file);
    if (!fs.existsSync(abs)) return { ok: false, error: `local_file missing: ${cand.local_file}` };
    const pr = U.probe(abs);
    if (!pr.ok) return { ok: false, error: `local_file unreadable: ${pr.error}` };
    return { ok: true, raw_file: cand.local_file, raw_offset: 0, raw_kind: 'local', src_w: pr.width, src_h: pr.height, via: 'local' };
  }
  if (!cand.url) return { ok: false, error: 'na url na local_file' };

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

  // stale/mismatch cache file hata do warna yt-dlp "already downloaded" bol ke purane bytes rakh sakta hai
  try { if (fs.existsSync(rawFile)) fs.rmSync(rawFile, { force: true }); if (fs.existsSync(manFile)) fs.rmSync(manFile, { force: true }); } catch {}
  const fmt = `bv*[height>=${minH}][ext=mp4]/bv*[ext=mp4]/bv*/b[height>=${minH}]/b`;
  const args = ['-f', fmt, '--download-sections', `*${segStart.toFixed(3)}-${segEnd.toFixed(3)}`,
    '--force-keyframes-at-cuts', '--merge-output-format', 'mp4', ...U.ytRuntimeArgs(cfg),
    '-o', rawFile, '--no-playlist', '--no-warnings', cand.url];
  const r = U.ytdlp(args, { timeout: 300000 });
  if (!r.ok || !fs.existsSync(rawFile)) {
    const err = (r.stderr || 'download fail').replace(/\s+/g, ' ').slice(0, 200);
    const flag = /403|forbidden|sign in|po.?token|not available|unavailable|requested format/i.test(err) ? '[403/unavailable] ' : '';
    return { ok: false, error: flag + err };
  }
  const pr = U.probe(rawFile);
  fs.writeFileSync(manFile, JSON.stringify({ segStart, segEnd, url: cand.url, minH, at: Date.now() }));
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

  for (const e of resolved) {
    if (e.kind !== 'video' || (e.status !== 'RESOLVED' && e.status !== 'NEEDS_REVIEW')) continue;

    // resume: pehle se valid raw hai to skip
    const existing = resolveRaw(id, e);
    if (existing && fs.existsSync(existing) && U.probe(existing).ok) { e.download = { ok: true, via: 'resume-cache' }; ok++; reused++; continue; }

    const cands = candList(e);
    const dlAttempts = [];
    let done = false;
    for (let ci = 0; ci < cands.length; ci++) {
      const res = downloadCandidate(id, cfg, cands[ci]);
      if (res.ok) {
        if (ci > 0) switched++;
        promote(e, cands[ci], ci, res);
        e.download = { ok: true, via: res.via, candidate: ci, attempts: dlAttempts };
        if (res.via === 'local') local++;
        ok++; done = true; break;
      }
      dlAttempts.push({ candidate: ci, source_id: cands[ci].source_id, error: res.error });
    }
    if (!done) {
      e.status = 'NEEDS_SOURCE';
      e.reason = `all ${cands.length} candidate(s) failed: ` + dlAttempts.map(a => `${a.source_id}:${a.error}`).join(' | ');
      e.download = { ok: false, attempts: dlAttempts };
      fail++;
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
