// ============================================================
//  util.js — common helpers: logging, config/.env, tool resolution,
//  safe external command runner, media probe (ffprobe -> ffmpeg fallback).
//
//  Design rules (handoff §9):
//   - Sab external commands argument ARRAY se chalte hain (execFile), kabhi
//     shell string concat nahi. Isse spaces/Unicode paths Windows par safe.
//   - ffprobe optional hai: na ho to `ffmpeg -i` stderr parse karke duration/
//     resolution nikaal lete hain (dev sandbox mein ffprobe nahi hota).
// ============================================================
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// ---------- logging (plain, Windows cmd safe) ----------
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

// ---------- tool resolution (config.tools override, warna PATH) ----------
const _toolCache = {};
function tool(name) {
  if (_toolCache[name]) return _toolCache[name];
  const cfg = config();
  const keyMap = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', 'yt-dlp': 'ytDlp' };
  const configured = cfg.tools && cfg.tools[keyMap[name]];
  const resolved = (configured && configured.trim()) ? configured.trim() : name;
  _toolCache[name] = resolved;
  return resolved;
}

// ek external command chalao. { ok, stdout, stderr, code } lautata hai.
// throwOnFail=false rakha hai taaki caller khud decide kare.
function run(bin, args, { timeout = 600000, input = null, throwOnFail = false, maxBuffer = 1 << 27 } = {}) {
  try {
    const stdout = execFileSync(bin, args, {
      timeout, maxBuffer, encoding: 'utf8', input: input || undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: stdout || '', stderr: '', code: 0 };
  } catch (e) {
    const res = { ok: false, stdout: e.stdout ? String(e.stdout) : '', stderr: e.stderr ? String(e.stderr) : (e.message || ''), code: e.status ?? -1 };
    if (throwOnFail) { const err = new Error(res.stderr.slice(0, 400) || `command failed: ${bin}`); err.detail = res; throw err; }
    return res;
  }
}

const ffmpeg = (args, opts) => run(tool('ffmpeg'), ['-y', '-hide_banner', '-loglevel', 'error', ...args], opts);
const ffmpegRaw = (args, opts) => run(tool('ffmpeg'), ['-hide_banner', ...args], opts); // stderr chahiye (probe/blackdetect)
const ytdlp = (args, opts) => run(tool('yt-dlp'), args, opts);

// ---------- media probe: ffprobe pehle, warna ffmpeg -i parse ----------
function probe(file) {
  if (!fs.existsSync(file)) return { ok: false, error: 'file missing' };
  // 1) ffprobe (agar available)
  const r = run(tool('ffprobe'), ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,duration,codec_name:format=duration',
    '-of', 'json', file]);
  if (r.ok && r.stdout.trim()) {
    try {
      const j = JSON.parse(r.stdout);
      const s = (j.streams && j.streams[0]) || {};
      const dur = parseFloat(s.duration) || parseFloat(j.format && j.format.duration) || 0;
      return { ok: true, width: +s.width || 0, height: +s.height || 0, duration: dur, codec: s.codec_name || '', via: 'ffprobe' };
    } catch { /* fall through */ }
  }
  // 2) fallback: ffmpeg -i (stderr parse)
  const f = ffmpegRaw(['-i', file]);
  const txt = f.stderr || '';
  const dm = txt.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  const duration = dm ? (+dm[1] * 3600 + +dm[2] * 60 + parseFloat(dm[3])) : 0;
  const rm = txt.match(/Video:.*?,\s*(\d+)x(\d+)/);
  const width = rm ? +rm[1] : 0, height = rm ? +rm[2] : 0;
  const cm = txt.match(/Video:\s*([a-z0-9]+)/i);
  if (!duration && !width) return { ok: false, error: 'probe failed', raw: txt.slice(0, 200) };
  return { ok: true, width, height, duration, codec: cm ? cm[1] : '', via: 'ffmpeg' };
}

// ---------- paths ----------
const jobDir = id => path.join(ROOT, 'jobs', id);
const outDir = () => path.join(ROOT, 'output');
const p = (id, ...rest) => path.join(jobDir(id), ...rest);
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); return d; }

// slug id from a project title / file
const slug = s => String(s || 'job').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'job';

module.exports = {
  ROOT, log, ok, warn, bad, step,
  config, env, tool, run, ffmpeg, ffmpegRaw, ytdlp, probe,
  jobDir, outDir, p, ensureDir, slug,
};
