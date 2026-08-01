// ============================================================
//  Stage 4 — DOWNLOAD (sirf zaroori range).
//  - local_file source: download nahi; cut seedha local se hoga.
//  - url source: yt-dlp --download-sections se guard ke sath chhota range.
//  Raw ranges source_id + window par cache hote hain (repeated source reuse).
//  NOTE: is sandbox mein YouTube proxy-blocked hai; url path aapke Windows par
//  chalega. local_file path yahan bhi poora chalta hai.
// ============================================================
const fs = require('fs');
const path = require('path');
const U = require('./util.js');

module.exports = function download(spec, cfg, st, resolved) {
  const id = spec.id;
  const clip = cfg.clip;
  const guard = clip.downloadGuardSeconds || 3;
  const minH = cfg.qa.minHeight || 480;
  const rawDir = U.ensureDir(U.p(id, 'cache', '_raw'));

  let ok = 0, fail = 0, local = 0;
  for (const e of resolved) {
    if (e.kind !== 'video' || e.status !== 'RESOLVED') continue;

    if (e.local_file) {
      const abs = path.isAbsolute(e.local_file) ? e.local_file : path.join(U.ROOT, e.local_file);
      if (!fs.existsSync(abs)) { e.download = { ok: false, error: 'local_file missing at cut time' }; e.status = 'NEEDS_SOURCE'; e.reason = 'local_file missing'; fail++; continue; }
      e._rawFile = abs; e._rawOffset = 0; e.download = { ok: true, via: 'local' };
      local++; ok++; continue;
    }

    // url: guard ke sath range
    const segStart = Math.max(0, e.cut.start - guard);
    const segEnd = e.cut.end + guard;
    const key = `${e.source_id}__${Math.floor(segStart)}_${Math.floor(segEnd)}.mp4`;
    const rawFile = path.join(rawDir, key);
    if (!fs.existsSync(rawFile)) {
      const fmt = `bv*[height>=${minH}][ext=mp4]/bv*[ext=mp4]/bv*/b[height>=${minH}]/b`;
      const args = ['-f', fmt, '--download-sections', `*${segStart.toFixed(2)}-${segEnd.toFixed(2)}`,
        '--force-keyframes-at-cuts', '--merge-output-format', 'mp4',
        '-o', rawFile, '--no-playlist', '--no-warnings', '--quiet', e.url];
      const r = U.ytdlp(args, { timeout: 300000 });
      if (!r.ok || !fs.existsSync(rawFile)) {
        e.download = { ok: false, error: (r.stderr || 'download fail').slice(0, 200) };
        e.status = 'NEEDS_SOURCE'; e.reason = `download failed: ${(r.stderr || '').slice(0, 120)}`;
        fail++; continue;
      }
    }
    e._rawFile = rawFile; e._rawOffset = segStart; e.download = { ok: true, via: 'yt-dlp', raw: path.basename(rawFile) };
    ok++;
  }

  U.ok(`download: ${ok} ready (${local} local), ${fail} failed -> NEEDS_SOURCE`);
  st.meta.download = { ok, local, fail };
  return resolved;
};
