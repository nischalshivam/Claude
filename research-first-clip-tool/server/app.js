#!/usr/bin/env node
// ============================================================
//  M5 LOCAL SERVER (M5.0-A) — editor ka backend.
//
//  Design faisle (jaan-boojh kar):
//   * SIRF Node ka apna http — koi npm install nahi, koi framework nahi.
//     Wajah: is tool ki poori jaan "bina account, bina internet, bina
//     dependency chal jaye" hai. React+Vite ka toolchain (~200MB, network
//     chahiye) us waade ko tod deta, aur main use is environment mein
//     runtime-test bhi nahi kar sakta. Isliye UI ek single self-contained
//     page hai jo isi server se serve hoti hai. API poori tarah React-ready
//     hai — kal koi bhi framework isi contract par baith sakta hai.
//     (Ye deviation KNOWN_LIMITATIONS.md mein saaf likha hai.)
//   * Sara filesystem/process kaam SERVER karta hai. Browser ko kabhi raw
//     path ya shell string nahi milti — sirf opaque token.
//   * Readiness/approval/state kabhi browser mein dobara calculate nahi hote.
//     Ek hi sach: src/readiness.js. UI wahi dikhati hai jo gate karega.
//
//    node server/app.js            -> http://127.0.0.1:7900
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const U = require(path.join(ROOT, 'src', 'util.js'));
const manual = require(path.join(ROOT, 'src', 'manual.js'));
const readiness = require(path.join(ROOT, 'src', 'readiness.js'));
const approval = require(path.join(ROOT, 'src', 'approval.js'));
const timebase = require(path.join(ROOT, 'src', 'timebase.js'));
const edlMod = require(path.join(ROOT, 'src', 'edl.js'));
const validate = require(path.join(ROOT, 'src', 'validate.js'));

const DATA = U.dataRoot();
const PORT = Number((process.argv.find(a => a.startsWith('--port=')) || '').slice(7)) || 7900;
const TOKEN = process.env.RFC_UI_TOKEN || crypto.randomBytes(16).toString('hex');
const OPEN = !process.argv.includes('--no-open');
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch {}

// test/prod dono ke liye override-able roots (default: tool ke andar)
const INPUT_DIR = () => process.env.RFC_INPUT_DIR ? path.resolve(process.env.RFC_INPUT_DIR) : path.join(ROOT, 'input');
const PROJ = () => process.env.RFC_PROJECT_DIR ? path.resolve(process.env.RFC_PROJECT_DIR) : ROOT;

// ---------- inputs + job id (run.js jaisa hi, taaki warm downloads reuse hon) ----------
function inputInfo() {
  const dir = INPUT_DIR();
  const pick = names => { for (const n of names) { const f = path.join(dir, n); if (fs.existsSync(f)) return f; } return null; };
  const pack = pick(['scene-research.json', 'research-pack.json', 'pack.json']);
  const srt = pick(['voiceover.srt', 'narration.srt']);
  const audio = pick(['voiceover.mp3', 'voiceover.m4a', 'voiceover.wav']);
  return { dir, pack, srt, audio };
}
function jobId() {
  const { pack, dir } = inputInfo();
  if (!pack) return null;
  try { const v = JSON.parse(fs.readFileSync(pack, 'utf8')); return U.slug(v.project_title || path.basename(dir)); }
  catch { return U.slug(path.basename(dir)); }
}
function jobArtifacts(id) {
  if (!id) return {};
  const has = f => { try { return fs.existsSync(U.p(id, f)); } catch { return false; } };
  return {
    draft: has('draft.mp4'), final: has('final.mp4'),
    gap_plan: has('gap-plan.json'), timeline: has('timeline.json'),
    manifest: has('render-manifest.json'), shot_review: has('shot-review.html'),
    run_log: has('run.log'), needs_source: has('NEEDS_SOURCE.csv'),
  };
}

// ---------- media index: token -> absolute path (allow-list) ----------
//  Browser ko sirf token milta hai. Server yahi token allow-list ke against
//  resolve karta hai — DATA aur maujooda job ke andar hi, kahin aur nahi.
const MEDIA_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.jpg', '.jpeg', '.png', '.webp']);
const sha1 = s => crypto.createHash('sha1').update(String(s)).digest('hex');
function walkMedia(dir, roots, out, depth = 0) {
  if (depth > 6) return;
  let names = []; try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = path.join(dir, n);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) walkMedia(p, roots, out, depth + 1);
    else if (MEDIA_EXT.has(path.extname(n).toLowerCase())) out[sha1(p)] = p;
  }
}
function mediaIndex() {
  const out = {};
  const roots = [DATA];
  const id = jobId();
  if (id) { try { roots.push(U.jobDir(id)); } catch {} }
  for (const r of roots) { try { if (fs.existsSync(r)) walkMedia(r, roots, out); } catch {} }
  return { map: out, roots };
}
function resolveToken(token) {
  if (!token) return null;
  const { map, roots } = mediaIndex();
  const p = map[token];
  if (!p) return null;
  // aakhri suraksha: allow-list roots ke ANDAR hi
  if (!roots.some(r => U.isInside(r, p))) return null;
  return p;
}

// ---------- running job (check-pack -> draft/final, ek hi log mein) ----------
let running = null;         // { id, kind, log:[], done, exit, listeners, proc }

// pack report is pack/SRT ka taaza hai ya nahi (run.js ka STALE gate isi par ruk ta hai)
function packReportFresh() {
  const inp = inputInfo();
  if (!inp.pack || !inp.srt) return false;
  try {
    const rep = JSON.parse(fs.readFileSync(path.join(ROOT, 'output', 'pack-report.json'), 'utf8'));
    return rep.pack_sha256 === U.hashFile(inp.pack) && rep.srt_sha256 === U.hashFile(inp.srt);
  } catch { return false; }
}

function startJob(kind) {
  if (running && !running.done) return { ok: false, error: 'ek kaam pehle se chal raha hai' };
  const id = jobId();
  if (!id) return { ok: false, error: 'input/scene-research.json nahi mila' };
  const inp = inputInfo();

  // Steps: pack report purana ho to pehle check-pack (run.js ka STALE gate isi ke
  // bina exit 3 de deta hai — wahi START_HERE option 2 pehle chalane wali baat).
  const steps = [];
  if (!packReportFresh() && inp.pack && inp.srt) {
    steps.push({ label: 'pack check', args: ['tools/check-pack.js', inp.pack, inp.srt, '--apply-probe'] });
  }
  // run.js ko SAAF-SAAF input dir batao. Production mein ye ROOT/input hi hai,
  // par run.js RFC_INPUT_DIR nahi padhta — isliye --input zaroori hai (warna
  // server temp/alag input par draft chalane par asli ROOT/input padh leta).
  const runArgs = ['src/run.js', `--input=${inp.dir}`];
  steps.push({ label: kind, args: kind === 'final' ? runArgs : [...runArgs, '--draft', '--redo'] });

  const job = { id, kind, log: [`> ${kind} shuru (${new Date().toLocaleTimeString()})`], startedAt: Date.now(), done: false, exit: null, listeners: new Set(), proc: null };
  const emit = l => { job.log.push(l); if (job.log.length > 3000) job.log.splice(0, job.log.length - 3000); for (const fn of job.listeners) { try { fn(l); } catch {} } };
  const push = b => { for (const l of String(b).split('\n')) if (l.length) emit(l); };

  let i = 0;
  const runNext = () => {
    if (i >= steps.length) { finish(0); return; }
    const step = steps[i++];
    emit(`> ${step.label} …`);
    const proc = spawn('node', step.args.map(a => (a === step.args[0] ? path.join(ROOT, a) : a)), { cwd: ROOT, env: process.env });
    job.proc = proc;
    proc.stdout.on('data', push); proc.stderr.on('data', push);
    proc.on('close', c => {
      emit(`> ${step.label} exit ${c}`);
      // check-pack exit 2 ka matlab "pack weak" — draft phir bhi banta hai (draft
      // diagnostic hai). Sirf exit 1 (tool toota) par ruk jao.
      if (c === 1) return finish(c);
      runNext();
    });
    proc.on('error', e => { emit('> spawn error: ' + e.message); finish(1); });
  };
  const finish = c => {
    job.done = true; job.exit = c;
    emit(`> khatam (exit ${c})`);
    for (const fn of job.listeners) { try { fn('__DONE__'); } catch {} }
  };
  running = job;
  runNext();
  return { ok: true, id, kind };
}

// ---------- readiness / state ----------
function evalReadiness() {
  const id = jobId();
  const art = jobArtifacts(id);
  const draftExists = !!(art.gap_plan || art.draft || art.final);
  return { ev: readiness.evaluate(DATA, manual, cfg, { draftExists }), draftExists, id, art };
}
function projectState() {
  const inp = inputInfo();
  const id = jobId();
  const art = jobArtifacts(id);
  let tb = null, inputsValid = null, packChecked = null;
  if (inp.pack && inp.srt) {
    try { tb = timebase.resolve({ srtFile: inp.srt, audioFile: inp.audio, cfg }); } catch {}
    try { inputsValid = validate.validateFile(inp.pack).ok; } catch { inputsValid = false; }
    try {
      const rep = JSON.parse(fs.readFileSync(path.join(ROOT, 'output', 'pack-report.json'), 'utf8'));
      packChecked = rep.pack_sha256 === U.hashFile(inp.pack);
    } catch { packChecked = false; }
  }
  const draftExists = !!(art.gap_plan || art.draft);
  const ev = (inp.pack && inp.srt) ? readiness.evaluate(DATA, manual, cfg, { draftExists }) : { state: 'NO_INPUTS', requests: [], can_export: false };
  const state = readiness.projectState({
    hasPack: !!inp.pack, hasSrt: !!inp.srt, inputsValid,
    packChecked, draftExists, everDrafted: draftExists,
    jobRunning: !!(running && !running.done),
    finalExists: art.final,
    media: ev,
  });
  return {
    schema: 'project-state-v1',
    project_id: 'current',
    state,
    human: readiness.HUMAN[ev.state] || '',
    can_export: ev.can_export,
    inputs: { pack: !!inp.pack, srt: !!inp.srt, audio: !!inp.audio, inputs_valid: inputsValid, pack_checked: packChecked },
    timebase: tb ? { audio: tb.audio_duration, srt_end: tb.srt_end, project_duration: tb.project_duration, correction: tb.correction, ok: tb.ok, reason: tb.reason } : null,
    media_state: ev.state,
    total_requests: (ev.requests || []).length,
    blocking: (ev.blocking || []).length,
    job: running ? { kind: running.kind, running: !running.done, exit: running.exit } : null,
    artifacts: art,
    job_id: id,
    project_states: readiness.PROJECT_STATE,
  };
}

// ---------- request (missing media) helpers ----------
function findRequest(key) {
  if (!fs.existsSync(DATA)) return null;
  for (const n of fs.readdirSync(DATA)) {
    if (!/^MISSING_\d{3}__/.test(n)) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(DATA, n, 'request.json'), 'utf8'));
      if (r.request_id === key || manual.requestKey(r) === key) return { dir: path.join(DATA, n), req: r, key: manual.requestKey(r) };
    } catch {}
  }
  return null;
}
function setOverride(key, patch) {
  const hit = findRequest(key);
  const k = hit ? hit.key : key;
  const ov = manual.readOverrides(DATA);
  ov.schema = 'manual-overrides-v2'; ov.requests = ov.requests || [];
  let e = ov.requests.find(r => manual.requestKey(r) === k);
  if (!e) { e = { request_key: k }; ov.requests.push(e); }
  e.request_key = k;
  const approvedPatch = 'approved' in patch ? !!patch.approved : null;
  delete patch.approved;
  Object.assign(e, patch);
  if (approvedPatch !== null) e.approved = approvedPatch;
  manual.writeOverrides(DATA, ov);
  if (approvedPatch !== null && hit) {
    if (approvedPatch) {
      const sr = (manual.scan(DATA, { cfg }).requests || []).find(r => r.request_key === k);
      if (sr && sr.files.length) approval.approve(DATA, k, { scanReq: sr, req: hit.req, source: 'UI' });
    } else {
      approval.revoke(DATA, k);
      try { fs.rmSync(path.join(hit.dir, approval.SENTINEL), { force: true }); } catch {}
    }
  }
  return { ok: true, request_key: k };
}
function safeName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  return base.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '').slice(0, 120) || `file_${Date.now()}`;
}

// ---------- EDL ----------
function edlForClient() {
  const id = jobId();
  let edl = edlMod.read(PROJ());
  if (!edl && id && jobArtifacts(id).timeline) { try { edl = edlMod.rebuild(PROJ(), id, { projectId: 'current' }); } catch {} }
  if (!edl) return null;
  // approval status live chadhao
  const { ev } = evalReadiness();
  const statusByKey = {};
  for (const r of (ev.requests || [])) statusByKey[r.request_key] = r.approval_status;
  edlMod.withApproval(edl, statusByKey);
  // browser ko raw path mat do — sirf token
  const safe = JSON.parse(JSON.stringify(edl));
  for (const s of safe.tracks.video_main) if (s.asset) delete s.asset.path;
  return safe;
}

// ---------- http plumbing ----------
const json = (res, obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const err = (res, code, message, http = 400) => json(res, { ok: false, code, message, artifacts: [] }, http);
function readBody(req, limit = 600 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('file bahut badi hai')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function checkToken(u, req) {
  const t = u.searchParams.get('token') || req.headers['x-rfc-token'];
  return t === TOKEN;
}

const CT = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

function serveFileRange(req, res, file) {
  let st; try { st = fs.statSync(file); } catch { res.writeHead(404); return res.end('not found'); }
  const ct = CT[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range && /^bytes=/.test(range)) {
    const [a, b] = range.replace('bytes=', '').split('-');
    const start = parseInt(a, 10) || 0;
    const end = b ? parseInt(b, 10) : st.size - 1;
    if (start >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { 'content-type': ct, 'content-range': `bytes ${start}-${end}/${st.size}`,
      'accept-ranges': 'bytes', 'content-length': end - start + 1, 'cache-control': 'no-store' });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'content-type': ct, 'content-length': st.size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  }
}

// thumbnail cache (project/cache/thumbnails/<token>.jpg)
function thumbFor(token, at) {
  const src = resolveToken(token);
  if (!src) return null;
  const dir = path.join(edlMod.projectRoot(PROJ()), 'cache', 'thumbnails');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${token}_${Math.round((at || 0) * 10)}.jpg`);
  if (fs.existsSync(out)) return out;
  const isImg = ['.jpg', '.jpeg', '.png', '.webp'].includes(path.extname(src).toLowerCase());
  const args = isImg
    ? ['-i', src, '-vf', 'scale=320:-2', '-frames:v', '1', out]
    : ['-ss', String(at || 0), '-i', src, '-vf', 'scale=320:-2', '-frames:v', '1', out];
  const r = U.ffmpeg(args);
  return (r.ok && fs.existsSync(out)) ? out : null;
}

// ---------- in-UI inputs (upload / srt / fresh-start) ----------
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.wav']);
function importInput(kind, filename, buf) {
  const dir = INPUT_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (kind === 'pack') {
    // pehle validate — toota pack save nahi karna
    let obj; try { obj = JSON.parse(buf.toString()); } catch { return { ok: false, code: 'BAD_JSON', message: 'ye valid JSON nahi hai' }; }
    const dest = path.join(dir, 'scene-research.json');
    const tmp = dest + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 2)); fs.renameSync(tmp, dest);
    let v = null; try { v = validate.validateFile(dest); } catch {}
    return { ok: true, saved: 'scene-research.json', valid: v ? v.ok : null, stats: v ? v.stats : null,
      errors: v && !v.ok ? (v.errors || []).slice(0, 8) : [] };
  }
  if (kind === 'audio') {
    if (!AUDIO_EXT.has(ext)) return { ok: false, code: 'BAD_AUDIO', message: `sirf mp3/m4a/wav (${ext || 'koi ext nahi'})` };
    // purani voiceover.* hata do taaki loadSpec sahi file uthaye (mp3/m4a/wav koi bhi)
    for (const e of AUDIO_EXT) { try { fs.rmSync(path.join(dir, 'voiceover' + e), { force: true }); } catch {} }
    const dest = path.join(dir, 'voiceover' + ext);
    fs.writeFileSync(dest, buf);
    const pr = U.probe(dest, { strict: false });
    if (!pr || !(pr.duration > 0)) { fs.rmSync(dest, { force: true }); return { ok: false, code: 'BAD_AUDIO', message: 'ye audio khul nahi rahi ya lambai pata nahi chali' }; }
    return { ok: true, saved: 'voiceover' + ext, duration: +pr.duration.toFixed(2) };
  }
  if (kind === 'srt') {
    const dest = path.join(dir, 'voiceover.srt'); fs.writeFileSync(dest, buf);
    return { ok: true, saved: 'voiceover.srt' };
  }
  if (kind === 'script') {
    const dest = path.join(dir, 'script.txt'); fs.writeFileSync(dest, buf);
    return { ok: true, saved: 'script.txt', chars: buf.length };
  }
  return { ok: false, code: 'BAD_KIND', message: 'kind pack|audio|srt|script hona chahiye' };
}

function inputsSummary() {
  const inp = inputInfo();
  const out = { pack: null, audio: null, srt: null, script: !!(fs.existsSync(path.join(inp.dir, 'script.txt'))) };
  if (inp.pack) {
    try { const v = validate.validateFile(inp.pack); out.pack = { valid: v.ok, stats: v.stats, errors: (v.errors || []).slice(0, 6) }; } catch { out.pack = { valid: false }; }
  }
  if (inp.audio) { const pr = U.probe(inp.audio, { strict: false }); out.audio = { file: path.basename(inp.audio), duration: pr && pr.duration ? +pr.duration.toFixed(2) : null }; }
  if (inp.srt) { try { const SUB = require(path.join(ROOT, 'src', 'subtitles.js')); const c = SUB.parseFile(inp.srt); out.srt = { cues: c.length, end: c.length ? +c[c.length - 1].end.toFixed(1) : 0 }; } catch { out.srt = { cues: 0 }; } }
  return out;
}

// FRESH START — kuch delete nahi, sab archive/<timestamp> mein le jao
function newProject() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const arch = path.join(PROJ(), 'archive', stamp);
  const moved = [];
  const moveDirContents = (srcName) => {
    const src = srcName === 'input' ? INPUT_DIR() : srcName === 'jobs' ? U.jobsRoot() : srcName === 'DATA' ? DATA : path.join(PROJ(), srcName);
    if (!fs.existsSync(src)) return;
    // input ke andar .gitkeep chhod do
    fs.mkdirSync(path.join(arch, srcName), { recursive: true });
    for (const n of fs.readdirSync(src)) {
      if (srcName === 'input' && n === '.gitkeep') continue;
      try { fs.renameSync(path.join(src, n), path.join(arch, srcName, n)); moved.push(`${srcName}/${n}`); } catch {}
    }
  };
  for (const s of ['input', 'DATA', 'jobs', 'project']) moveDirContents(s);
  // output/pack-report.json bhi purana — hata do (archive mein)
  try {
    const rep = path.join(ROOT, 'output', 'pack-report.json');
    if (fs.existsSync(rep)) { fs.mkdirSync(path.join(arch, 'output'), { recursive: true }); fs.renameSync(rep, path.join(arch, 'output', 'pack-report.json')); }
  } catch {}
  return { ok: true, archived_to: path.relative(ROOT, arch), moved: moved.length };
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname;
  try {
    // ---- static UI (no token needed to load the shell; shell fetches with token) ----
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = fs.readFileSync(path.join(__dirname, 'ui', 'index.html'), 'utf8').replace('%%SESSION_TOKEN%%', TOKEN);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }
    if (req.method === 'GET' && p === '/app.js') {
      return serveFileRange(req, res, path.join(__dirname, 'ui', 'app.js'));
    }
    if (req.method === 'GET' && p === '/api/v1/health') {
      return json(res, { ok: true, name: 'research-first-clip-tool', ui: 'M5.0-A.2', node: process.version });
    }

    // ---- everything below needs the session token ----
    if (!checkToken(u, req)) return err(res, 'UNAUTHORIZED', 'session token galat/missing', 401);

    if (req.method === 'GET' && p === '/api/v1/state') return json(res, projectState());

    // ---- in-UI inputs ----
    if (req.method === 'GET' && p === '/api/v1/inputs') return json(res, { ok: true, inputs: inputsSummary() });

    if (req.method === 'POST' && p === '/api/v1/import') {
      const kind = u.searchParams.get('kind');
      const name = u.searchParams.get('name') || '';
      const buf = await readBody(req);
      if (!buf.length) return err(res, 'EMPTY', 'file khaali hai', 400);
      const r = importInput(kind, name, buf);
      return json(res, r, r.ok ? 200 : 400);
    }

    if (req.method === 'POST' && p === '/api/v1/make-srt') {
      const inp = inputInfo();
      if (!inp.audio) return err(res, 'NO_AUDIO', 'pehle voiceover (mp3/m4a/wav) daalo', 400);
      const scriptFile = fs.existsSync(path.join(inp.dir, 'script.txt')) ? path.join(inp.dir, 'script.txt') : null;
      if (!scriptFile && !inp.pack) return err(res, 'NO_TEXT', 'clean script ya research pack chahiye', 400);
      try {
        const M = require(path.join(ROOT, 'tools', 'make-srt.js'));
        const r = M.build({ audioFile: inp.audio, scriptFile, packFile: scriptFile ? null : inp.pack, wpm: 150 });
        const out = path.join(inp.dir, 'voiceover.srt');
        const tmp = out + '.tmp'; fs.writeFileSync(tmp, M.toSrt(r.cues)); fs.renameSync(tmp, out);
        return json(res, { ok: true, cues: r.cues.length, total: +r.total.toFixed(1), estimated: true, from: scriptFile ? 'script' : 'pack' });
      } catch (e) { return err(res, 'MAKE_SRT_FAIL', String(e && e.message || e), 400); }
    }

    if (req.method === 'POST' && p === '/api/v1/new-project') {
      if (running && !running.done) return err(res, 'JOB_RUNNING', 'pehle chal raha job rukne do', 409);
      return json(res, newProject());
    }

    if (req.method === 'GET' && p === '/api/v1/genspark-prompt') {
      const f = path.join(ROOT, 'prompts', 'GENSPARK_M2_5_ONE_SHOT_SCENE_RESEARCH_PROMPT.txt');
      let text = ''; try { text = fs.readFileSync(f, 'utf8'); } catch { text = 'prompt file nahi mili'; }
      return json(res, { ok: true, file: 'prompts/GENSPARK_M2_5_ONE_SHOT_SCENE_RESEARCH_PROMPT.txt', text });
    }

    if (req.method === 'GET' && p === '/api/v1/research-health') {
      const inp = inputInfo();
      let rep = null; try { rep = JSON.parse(fs.readFileSync(path.join(ROOT, 'output', 'pack-report.json'), 'utf8')); } catch {}
      let v = null; try { v = inp.pack ? validate.validateFile(inp.pack) : null; } catch {}
      return json(res, { ok: true, report: rep, validation: v ? { ok: v.ok, stats: v.stats, errors: (v.errors || []).slice(0, 20), warnings: (v.warnings || []).slice(0, 20) } : null,
        pack_checked: rep && inp.pack ? rep.pack_sha256 === U.hashFile(inp.pack) : false });
    }

    if (req.method === 'GET' && p === '/api/v1/missing') {
      const { ev } = evalReadiness();
      return json(res, { ok: true, state: ev.state, can_export: ev.can_export,
        requests: (ev.requests || []).map(r => {
          const q = (() => { try { return JSON.parse(fs.readFileSync(path.join(r.dir, 'request.json'), 'utf8')); } catch { return {}; } })();
          return { request_key: r.request_key, label: r.label, folder: r.folder, criticality: r.criticality,
            range: r.range, narration: r.narration_exact, media_status: r.media_status,
            approval_required: r.approval_required, approval_status: r.approval_status, approval_reason: r.approval_reason,
            approved_at: r.approved_at, allow_reuse: r.allow_reuse, short_seconds: r.short_seconds,
            blocking: r.blocking, reasons: r.reasons, notes: r.notes || [],
            must_show: q.must_show || [], must_not_show: q.must_not_show || [], search_queries: q.search_queries || [],
            files: r.files.map(f => ({ file: f.file, type: f.type, token: null, duration: f.duration, width: f.width, height: f.height, warnings: f.warnings })) };
        }) });
    }

    if (req.method === 'POST' && p === '/api/v1/draft') { const r = startJob('draft'); return json(res, r, r.ok ? 200 : 409); }
    if (req.method === 'POST' && p === '/api/v1/export') { const r = startJob('final'); return json(res, r, r.ok ? 200 : 409); }
    if (req.method === 'POST' && p === '/api/v1/jobs/cancel') {
      if (running && !running.done) { try { running.proc.kill('SIGTERM'); } catch {} return json(res, { ok: true }); }
      return json(res, { ok: false, code: 'NO_JOB', message: 'koi job nahi chal raha' });
    }

    // SSE job progress
    if (req.method === 'GET' && p === '/api/v1/jobs/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
      const job = running;
      if (!job) { send('idle', { running: false }); return res.end(); }
      for (const l of job.log) send('log', { line: l });
      if (job.done) { send('done', { exit: job.exit, state: projectState() }); return res.end(); }
      const onLine = l => { if (l === '__DONE__') { send('done', { exit: running && running.exit, state: projectState() }); res.end(); } else send('log', { line: l }); };
      job.listeners.add(onLine);
      req.on('close', () => { job.listeners.delete(onLine); });
      return;
    }

    // ---- missing-media mutations ----
    let m;
    if (req.method === 'POST' && (m = p.match(/^\/api\/v1\/requests\/([^/]+)\/media$/))) {
      const key = decodeURIComponent(m[1]);
      const hit = findRequest(key);
      if (!hit) return err(res, 'NO_REQUEST', 'ye request nahi mili', 404);
      const mediaDir = path.join(hit.dir, 'media'); fs.mkdirSync(mediaDir, { recursive: true });
      const name = safeName(u.searchParams.get('name'));
      const dest = path.join(mediaDir, name);
      if (!U.isInside(mediaDir, dest)) return err(res, 'BAD_PATH', 'galat path', 400);
      const buf = await readBody(req);
      if (!buf.length) return err(res, 'EMPTY', 'file khaali hai', 400);
      fs.writeFileSync(dest, buf);
      const info = manual.inspectFile(dest);
      if (!info.ok) { fs.rmSync(dest, { force: true }); return err(res, 'BAD_MEDIA', info.problem, 400); }
      return json(res, { ok: true, file: name, type: info.type });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/v1\/requests\/([^/]+)\/override$/))) {
      const body = JSON.parse((await readBody(req, 1e6)).toString() || '{}');
      const patch = {};
      if ('allow_reuse' in body) patch.allow_reuse = !!body.allow_reuse;
      return json(res, setOverride(decodeURIComponent(m[1]), patch));
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/v1\/requests\/([^/]+)\/approve$/))) {
      return json(res, setOverride(decodeURIComponent(m[1]), { approved: true }));
    }
    if (req.method === 'DELETE' && (m = p.match(/^\/api\/v1\/requests\/([^/]+)\/approval$/))) {
      return json(res, setOverride(decodeURIComponent(m[1]), { approved: false }));
    }

    // ---- EDL ----
    if (req.method === 'GET' && p === '/api/v1/edl') {
      const edl = edlForClient();
      if (!edl) return err(res, 'NO_EDL', 'abhi koi draft nahi — pehle Draft banao', 404);
      return json(res, { ok: true, edl });
    }
    if (req.method === 'PATCH' && p === '/api/v1/edl') {
      const body = JSON.parse((await readBody(req, 4e6)).toString() || '{}');
      const r = edlMod.patch(PROJ(), body);
      if (!r.ok) return json(res, r, r.code === 'REVISION_CONFLICT' ? 409 : 400);
      const edl = edlForClient();
      return json(res, { ok: true, revision: r.revision, edl });
    }
    if (req.method === 'POST' && p === '/api/v1/edl/rebuild') {
      const id = jobId();
      if (!id || !jobArtifacts(id).timeline) return err(res, 'NO_DRAFT', 'pehle draft banao', 400);
      edlMod.rebuild(PROJ(), id, { projectId: 'current' });
      return json(res, { ok: true, edl: edlForClient() });
    }

    // ---- media + thumbnails (token allow-list) ----
    if (req.method === 'GET' && (m = p.match(/^\/api\/v1\/media\/([a-f0-9]+)$/))) {
      const file = resolveToken(m[1]);
      if (!file) return err(res, 'NO_MEDIA', 'media nahi mila', 404);
      return serveFileRange(req, res, file);
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/v1\/thumb\/([a-f0-9]+)$/))) {
      const at = Number(u.searchParams.get('t') || 0);
      const t = thumbFor(m[1], at);
      if (!t) return err(res, 'NO_THUMB', 'thumbnail nahi bana', 404);
      return serveFileRange(req, res, t);
    }

    return err(res, 'NOT_FOUND', `route nahi mila: ${req.method} ${p}`, 404);
  } catch (e) {
    return err(res, 'SERVER_ERROR', String(e && e.message || e), 500);
  }
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}/?token=${TOKEN}`;
    console.log('='.repeat(66));
    console.log('  RESEARCH-FIRST CLIP TOOL — EDITOR (M5.0-A)');
    console.log('='.repeat(66));
    console.log(`  ${url}`);
    console.log('  (sirf is computer par — na internet, na account, na key)');
    console.log('  band karne ke liye ye window band karo ya Ctrl+C dabao.');
    console.log('='.repeat(66));
    if (OPEN) {
      const o = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      try { spawn(o[0], o[1], { detached: true, stdio: 'ignore' }).unref(); } catch {}
    }
  });
}

module.exports = { server, projectState, edlForClient, resolveToken, jobId, TOKEN, PORT };
