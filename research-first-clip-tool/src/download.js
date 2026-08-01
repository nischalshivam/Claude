// ============================================================
//  Stage 4 — DOWNLOAD (sirf zaroori range) + ALTERNATE fallback.
//  Har RESOLVED moment ke candidates ko ORDER mein try karo:
//    - local_file: download nahi; cut seedha local se.
//    - url: yt-dlp --download-sections se guard ke sath chhota range.
//  Ek candidate 403/unavailable/download-fail de to AGLA candidate try karo
//  (clear failure reason ke sath). Sab fail -> NEEDS_SOURCE.
//  Raw ranges source_id + window par cache (repeated source reuse).
//  NOTE: is sandbox mein YouTube proxy-blocked hai; url path Windows par chalega.
// ============================================================
const fs = require('fs');
const path = require('path');
const U = require('./util.js');

function tryLocal(e, cand) {
  const abs = path.isAbsolute(cand.local_file) ? cand.local_file : path.join(U.ROOT, cand.local_file);
  if (!fs.existsSync(abs)) return { ok: false, error: `local_file missing: ${cand.local_file}` };
  return { ok: true, rawFile: abs, rawOffset: 0, via: 'local' };
}

function tryUrl(e, cand, cfg) {
  const clip = cfg.clip, guard = clip.downloadGuardSeconds || 3, minH = cfg.qa.minHeight || 480;
  const segStart = Math.max(0, cand.cut.start - guard);
  const segEnd = cand.cut.end + guard;
  const rawDir = U.ensureDir(U.p(e._id, 'cache', '_raw'));
  const key = `${cand.source_id}__${Math.floor(segStart)}_${Math.floor(segEnd)}.mp4`;
  const rawFile = path.join(rawDir, key);
  if (fs.existsSync(rawFile)) return { ok: true, rawFile, rawOffset: segStart, via: 'cache' };
  const fmt = `bv*[height>=${minH}][ext=mp4]/bv*[ext=mp4]/bv*/b[height>=${minH}]/b`;
  const args = ['-f', fmt, '--download-sections', `*${segStart.toFixed(2)}-${segEnd.toFixed(2)}`,
    '--force-keyframes-at-cuts', '--merge-output-format', 'mp4',
    '-o', rawFile, '--no-playlist', '--no-warnings', cand.url];
  const r = U.ytdlp(args, { timeout: 300000 });
  if (!r.ok || !fs.existsSync(rawFile)) {
    const err = (r.stderr || 'download fail').replace(/\s+/g, ' ').slice(0, 180);
    const is403 = /403|forbidden|sign in|po.?token|not available|unavailable|format/i.test(err);
    return { ok: false, error: (is403 ? '[403/unavailable] ' : '') + err };
  }
  return { ok: true, rawFile, rawOffset: segStart, via: 'yt-dlp' };
}

module.exports = function download(spec, cfg, st, resolved) {
  const id = spec.id;
  let ok = 0, fail = 0, local = 0, switched = 0;

  for (const e of resolved) {
    if (e.kind !== 'video' || e.status !== 'RESOLVED') continue;
    e._id = id;
    const cands = e.candidates && e.candidates.length ? e.candidates
      : [{ source_id: e.source_id, url: e.url, local_file: e.local_file, cut: e.cut, locator_type: e.locator_type, decision: e.decision, score: e.score, recall: e.recall, reason: e.reason, matched: e.matched, source_kind: e.source_kind }];
    const dlAttempts = [];
    let done = false;

    for (let ci = 0; ci < cands.length; ci++) {
      const cand = cands[ci];
      const res = cand.local_file ? tryLocal(e, cand) : (cand.url ? tryUrl(e, cand, cfg) : { ok: false, error: 'na url na local_file' });
      if (res.ok) {
        // chosen candidate ko entry par promote karo
        if (ci > 0) switched++;
        Object.assign(e, {
          source_id: cand.source_id, source_kind: cand.source_kind, url: cand.url || null, local_file: cand.local_file || null,
          locator_type: cand.locator_type, decision: cand.decision, score: cand.score, recall: cand.recall,
          reason: (ci > 0 ? `[alternate #${ci + 1}] ` : '') + cand.reason, matched: cand.matched || null, cut: cand.cut,
        });
        e._rawFile = res.rawFile; e._rawOffset = res.rawOffset;
        e.download = { ok: true, via: res.via, candidate: ci, attempts: dlAttempts };
        if (res.via === 'local') local++;
        ok++; done = true; break;
      }
      dlAttempts.push({ candidate: ci, source_id: cand.source_id, error: res.error });
    }

    if (!done) {
      e.status = 'NEEDS_SOURCE';
      e.reason = `all ${cands.length} candidate(s) failed: ` + dlAttempts.map(a => `${a.source_id}:${a.error}`).join(' | ');
      e.download = { ok: false, attempts: dlAttempts };
      fail++;
    }
  }

  U.ok(`download: ${ok} ready (${local} local, ${switched} via alternate), ${fail} failed -> NEEDS_SOURCE`);
  st.meta.download = { ok, local, switched, fail };
  return resolved;
};
