// ============================================================
//  sources.js — source metadata + subtitles, per-job CACHE.
//
//  Ek hi source (episode/video) kai moments use kar sakte hain — isliye
//  metadata aur subtitles source_id ke hisaab se cache hote hain (dobara
//  fetch nahi). Cross-show packs independent rehte hain; koi permanent
//  library nahi (handoff §14).
//
//  local_file / local_subs support: offline test + local-source feature.
// ============================================================
const fs = require('fs');
const path = require('path');
const U = require('./util.js');
const SUB = require('./subtitles.js');

function cacheDir(id, sourceId) { return U.ensureDir(U.p(id, 'cache', sourceId)); }

// pack ki saari sources ka index (reuse across packs)
function indexSources(pack) {
  const map = {};
  for (const pk of pack.packs) for (const s of (pk.sources || [])) if (s.source_id) map[s.source_id] = s;
  return map;
}

// ---------- metadata ----------
function getMeta(id, source, cfg) {
  const dir = cacheDir(id, source.source_id);
  const cacheF = path.join(dir, 'meta.json');
  if (fs.existsSync(cacheF)) { try { return JSON.parse(fs.readFileSync(cacheF, 'utf8')); } catch {} }

  let meta;
  if (source.local_file) {
    const abs = path.isAbsolute(source.local_file) ? source.local_file : path.join(U.ROOT, source.local_file);
    if (!fs.existsSync(abs)) meta = { ok: false, available: false, error: `local_file missing: ${source.local_file}`, kind: 'local' };
    else {
      const pr = U.probe(abs);
      meta = pr.ok
        ? { ok: true, available: true, kind: 'local', abs, duration: pr.duration, width: pr.width, height: pr.height, title: source.title || path.basename(abs) }
        : { ok: false, available: false, error: `local_file probe fail: ${pr.error}`, kind: 'local', abs };
    }
  } else if (source.url) {
    const r = U.ytdlp(['--dump-single-json', '--no-warnings', '--no-playlist', ...U.ytRuntimeArgs(cfg), source.url], { timeout: 90000 });
    if (!r.ok) {
      meta = { ok: false, available: false, kind: 'url', error: (r.stderr || 'yt-dlp fail').slice(0, 200) };
    } else {
      try {
        const j = JSON.parse(r.stdout);
        meta = {
          ok: true, available: true, kind: 'url', url: source.url, video_id: j.id,
          duration: j.duration || 0, title: j.title || '', channel: j.channel || j.uploader || '',
          subLangs: Object.keys(j.subtitles || {}), autoSubLangs: Object.keys(j.automatic_captions || {}),
        };
      } catch (e) { meta = { ok: false, available: false, kind: 'url', error: 'meta parse fail: ' + e.message.slice(0, 120) }; }
    }
  } else {
    meta = { ok: false, available: false, error: 'na url na local_file' };
  }
  fs.writeFileSync(cacheF, JSON.stringify(meta, null, 2));
  return meta;
}

// ---------- subtitles (cues[]) ----------
function getSubs(id, source, cfg) {
  const dir = cacheDir(id, source.source_id);
  const cacheF = path.join(dir, 'subs.json');
  if (fs.existsSync(cacheF)) { try { return JSON.parse(fs.readFileSync(cacheF, 'utf8')); } catch {} }

  let cues = [];
  let via = 'none';
  if (source.local_subs) {
    const abs = path.isAbsolute(source.local_subs) ? source.local_subs : path.join(U.ROOT, source.local_subs);
    cues = SUB.parseFile(abs); via = 'local_subs';
  } else if (source.url) {
    // yt-dlp se manual subs pehle, phir auto-captions. (YT reachable ho tabhi.)
    const stem = path.join(dir, 'sub');
    const args = ['--skip-download', '--write-subs', '--write-auto-subs',
      '--sub-langs', 'en.*,en', '--sub-format', 'srt/vtt/best',
      '--convert-subs', 'srt', '-o', stem + '.%(ext)s', '--no-warnings', '--no-playlist',
      ...U.ytRuntimeArgs(cfg), source.url];
    const r = U.ytdlp(args, { timeout: 120000 });
    // koi bhi .srt/.vtt file jo bani ho
    if (fs.existsSync(dir)) {
      const cand = fs.readdirSync(dir).filter(f => /\.(srt|vtt)$/i.test(f)).map(f => path.join(dir, f));
      // manual (en.srt) ko auto (en.auto/en-orig) par tarjeeh
      cand.sort((a, b) => (/auto|orig/i.test(a) ? 1 : 0) - (/auto|orig/i.test(b) ? 1 : 0));
      for (const c of cand) { const parsed = SUB.parseFile(c); if (parsed.length) { cues = parsed; via = path.basename(c); break; } }
    }
    if (!cues.length && !r.ok) via = 'fetch-fail';
  }
  const result = { via, count: cues.length, cues };
  fs.writeFileSync(cacheF, JSON.stringify(result, null, 2));
  return result;
}

module.exports = { indexSources, getMeta, getSubs, cacheDir };
