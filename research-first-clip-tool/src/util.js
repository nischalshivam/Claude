// ============================================================
//  util.js — common helpers: logging, config/.env, tool resolution,
//  safe command runner (spawnSync: SUCCESS par bhi stderr capture),
//  media probe (ffprobe -> ffmpeg fallback), path-safety, hashing.
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// ---------- logging ----------
const log = (...a) => console.log(...a);
const ok = m => console.log(`  [OK]   ${m}`);
const warn = m => console.log(`  [WARN] ${m}`);
const bad = m => console.log(`  [FAIL] ${m}`);
const step = m => console.log(`\n>>> ${m}`);

// ---------- config + env ----------
let _cfg = null;
function config() {
  if (_cfg) return _cfg;
  _cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  return _cfg;
}
let _env = null;
function env() {
  if (_env) return _env;
  _env = { ...process.env };
  const f = path.join(ROOT, '.env');
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) _env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return _env;
}

// ---------- tool resolution ----------
const _toolCache = {};
function tool(name) {
  if (_toolCache[name]) return _toolCache[name];
  // env override (testing/CI): RFC_FFMPEG / RFC_FFPROBE / RFC_YTDLP
  const envMap = { ffmpeg: 'RFC_FFMPEG', ffprobe: 'RFC_FFPROBE', 'yt-dlp': 'RFC_YTDLP' };
  const envVal = process.env[envMap[name]];
  if (envVal && envVal.trim()) { _toolCache[name] = envVal.trim(); return _toolCache[name]; }
  const cfg = config();
  const keyMap = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', 'yt-dlp': 'ytDlp' };
  const configured = cfg.tools && cfg.tools[keyMap[name]];
  _toolCache[name] = (configured && configured.trim()) ? configured.trim() : name;
  return _toolCache[name];
}

// ek external command chalao. spawnSync => stdout AUR stderr dono hamesha milte
// hain (SUCCESS par bhi) — blackdetect/freezedetect stderr par likhte hain.
function run(bin, args, { timeout = 600000, input = null, throwOnFail = false, maxBuffer = 1 << 27 } = {}) {
  const r = spawnSync(bin, args, { timeout, maxBuffer, encoding: 'utf8', input: input || undefined });
  const res = {
    ok: !r.error && r.status === 0,
    stdout: r.stdout || '',
    stderr: r.stderr || (r.error ? r.error.message : ''),
    code: r.status == null ? -1 : r.status,
  };
  if (!res.ok && throwOnFail) { const e = new Error((res.stderr || `command failed: ${bin}`).slice(0, 400)); e.detail = res; throw e; }
  return res;
}

const ffmpeg = (args, opts) => run(tool('ffmpeg'), ['-y', '-hide_banner', '-loglevel', 'error', ...args], opts);
// stderr chahiye (probe/blackdetect/freezedetect) — loglevel info rakhо
const ffmpegRaw = (args, opts) => run(tool('ffmpeg'), ['-hide_banner', ...args], opts);
const ytdlp = (args, opts) => run(tool('yt-dlp'), args, opts);

// ---------- media probe ----------
// STRICT: ek video asset tabhi valid hai jab usme asli video stream ho, w/h > 0,
// duration > minDuration, aur file size sensible ho. (M1.3 bug: 262-byte empty
// download ko `ok:true` mil jata tha -> READY print hota tha -> cut fail.)
const MIN_MEDIA_BYTES = 4096;
const MIN_MEDIA_SECONDS = 0.3;

function probe(file, { strict = true } = {}) {
  if (!file || !fs.existsSync(file)) return { ok: false, error: 'file missing' };
  let bytes = 0;
  try { bytes = fs.statSync(file).size; } catch {}

  const finish = (res) => {
    if (!strict) return res;
    if (!res.ok) return res;
    if (bytes < MIN_MEDIA_BYTES) return { ok: false, error: `empty/truncated media (${bytes} bytes)`, bytes, ...res, ok: false };
    if (!res.width || !res.height) return { ok: false, error: `no usable video stream (${res.width}x${res.height})`, bytes, width: res.width, height: res.height, duration: res.duration };
    if (!(res.duration > MIN_MEDIA_SECONDS)) return { ok: false, error: `duration too small (${res.duration}s)`, bytes, width: res.width, height: res.height, duration: res.duration };
    return { ...res, bytes };
  };

  const r = run(tool('ffprobe'), ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,duration,codec_name:format=duration', '-of', 'json', file]);
  if (r.ok && r.stdout.trim()) {
    try {
      const j = JSON.parse(r.stdout);
      const streams = Array.isArray(j.streams) ? j.streams : [];
      const s = streams[0] || {};
      const dur = parseFloat(s.duration) || parseFloat(j.format && j.format.duration) || 0;
      if (!streams.length) return finish({ ok: false, error: 'ffprobe: zero video streams', width: 0, height: 0, duration: dur });
      return finish({ ok: true, width: +s.width || 0, height: +s.height || 0, duration: dur, codec: s.codec_name || '', via: 'ffprobe' });
    } catch { /* fall through */ }
  }
  const f = ffmpegRaw(['-i', file]);
  const txt = f.stderr || '';
  const dm = txt.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  const duration = dm ? (+dm[1] * 3600 + +dm[2] * 60 + parseFloat(dm[3])) : 0;
  const rm = txt.match(/Video:.*?,\s*(\d+)x(\d+)/);
  const width = rm ? +rm[1] : 0, height = rm ? +rm[2] : 0;
  const cm = txt.match(/Video:\s*([a-z0-9]+)/i);
  if (!duration && !width) return { ok: false, error: 'probe failed (no stream/duration)', bytes, raw: txt.slice(0, 200) };
  return finish({ ok: true, width, height, duration, codec: cm ? cm[1] : '', via: 'ffmpeg' });
}

// ---------- yt-dlp JS runtime (EJS) — ek shared builder (meta+subs+download) ----------
// Official option: --js-runtimes deno[:path] | node | bun. Deno 2.3+ preferred.
let _jsSpec;
function jsRuntimeSpec(cfg) {
  if (_jsSpec !== undefined) return _jsSpec;
  cfg = cfg || config();
  const configured = cfg.tools && cfg.tools.jsRuntime;
  if (configured && String(configured).trim()) { _jsSpec = String(configured).trim(); return _jsSpec; }
  const d = run('deno', ['--version'], { timeout: 15000 });   // Deno 2.3+ ?
  if (d.ok) { const m = String(d.stdout).match(/deno\s+(\d+)\.(\d+)\.(\d+)/i); if (m && (+m[1] > 2 || (+m[1] === 2 && +m[2] >= 3))) { _jsSpec = 'deno'; return _jsSpec; } }
  const nodeMajor = parseInt(String(process.versions.node).split('.')[0], 10) || 0;   // Node 22+ ?
  if (nodeMajor >= 22) { _jsSpec = 'node'; return _jsSpec; }
  _jsSpec = null; return _jsSpec;
}
function ytRuntimeArgs(cfg) { const s = jsRuntimeSpec(cfg); return s ? ['--js-runtimes', s] : []; }

// ---------- paths + safety ----------
// jobs root override (test isolation): RFC_JOBS_DIR set ho to wahi, warna ROOT/jobs
function jobsRoot() { const e = process.env.RFC_JOBS_DIR; return (e && e.trim()) ? path.resolve(e.trim()) : path.join(ROOT, 'jobs'); }
const jobDir = id => path.join(jobsRoot(), id);
const outDir = () => path.join(ROOT, 'output');
const p = (id, ...rest) => path.join(jobDir(id), ...rest);
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); return d; }

// ID safe hai? (job/pack/source/moment). Path traversal/separators/absolute reject.
const ID_RE = /^[A-Za-z0-9_-]+$/;
function isSafeId(id) { return typeof id === 'string' && id.length > 0 && id.length <= 80 && ID_RE.test(id) && id !== '.' && id !== '..'; }
function assertSafeId(id, what = 'id') { if (!isSafeId(id)) throw new Error(`unsafe ${what}: ${JSON.stringify(id)} (allowed: A-Z a-z 0-9 _ -)`); return id; }

// target, root ke ANDAR hai? (resolve karke prefix check) — delete/write se pehle.
function isInside(root, target) {
  const r = path.resolve(root) + path.sep;
  const t = path.resolve(target);
  return (t + path.sep).startsWith(r) || t === path.resolve(root);
}
function assertInside(root, target, what = 'path') { if (!isInside(root, target)) throw new Error(`refusing to touch ${what} outside ${root}: ${target}`); return target; }

const slug = s => String(s || 'job').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'job';

// ---------- hashing (fingerprints) ----------
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function hashFile(file) { try { return sha256(fs.readFileSync(file)); } catch { return 'na'; } }
function hashStr(s) { return sha256(Buffer.from(String(s))); }

module.exports = {
  ROOT, log, ok, warn, bad, step,
  config, env, tool, run, ffmpeg, ffmpegRaw, ytdlp, probe,
  jobDir, jobsRoot, outDir, p, ensureDir, slug,
  isSafeId, assertSafeId, isInside, assertInside,
  sha256, hashFile, hashStr,
  jsRuntimeSpec, ytRuntimeArgs,
};
