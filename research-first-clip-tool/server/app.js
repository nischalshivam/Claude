#!/usr/bin/env node
// ============================================================
//  M5 LOCAL SERVER (M5.1) — editor ka backend.
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
const INSTANCE_ID = crypto.createHash('sha256').update(ROOT.toLowerCase()).digest('hex').slice(0, 20);
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
const MEDIA_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.jpg', '.jpeg', '.png', '.webp', '.mp3', '.m4a', '.wav']);
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
  // Voiceover is a first-class editor track, so the current input directory
  // belongs to the same token allow-list as DATA and job media.
  // Per-shot editor replacements bhi isi opaque-token allow-list ke andar hain.
  const roots = [DATA, INPUT_DIR(), path.join(edlMod.projectRoot(PROJ()), 'replacements')];
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

function missingCriticalityCount(packFile) {
  try {
    const p = JSON.parse(fs.readFileSync(packFile, 'utf8'));
    let n = 0;
    for (const pk of (p.packs || [])) for (const m of (pk.moments || [])) if (!m.criticality) n++;
    return n;
  } catch { return 0; }
}

function criticalityStrategy(kind, hasTimeline, missingCrit, canExport) {
  const legacyDraft = kind === 'final' && !!hasTimeline;
  return {
    migrate_now: missingCrit > 0 && !legacyDraft,
    legacy_waiver: legacyDraft && missingCrit > 0 && !!canExport,
  };
}

function readJobResult(id) {
  if (!id) return null;
  try { return JSON.parse(fs.readFileSync(U.p(id, 'job-result.json'), 'utf8')); }
  catch { return null; }
}

function failureDetails(job, exitCode) {
  const result = readJobResult(job.id);
  const logLine = [...job.log].reverse().find(l => /\[FAIL\]|PRODUCTION GATE|fatal:|error:/i.test(l));
  const blocked = result && (result.blocked_reason || result.reason || result.message);
  return {
    code: result && result.blocked_reason ? result.blocked_reason
      : exitCode === 3 ? 'PRODUCTION_GATE_BLOCKED' : exitCode === 2 ? 'BUILD_BLOCKED' : 'TOOL_ERROR',
    message: String(blocked || logLine || `${job.kind} build exit ${exitCode} par ruk gayi`),
    report: result || null,
  };
}

function preflightJob(kind) {
  if (!['draft', 'final'].includes(kind)) return { ok: false, code: 'BAD_JOB_KIND', error: 'unknown job type' };
  const inp = inputInfo();
  if (!inp.pack) return { ok: false, code: 'NO_PACK', error: 'Research pack (.json) pehle daalo.' };
  if (!inp.srt) return { ok: false, code: 'NO_SRT', error: 'Voiceover timing (.srt) pehle daalo ya Auto-banao.' };
  if (!inp.audio && !(cfg.render && cfg.render.allowSilent)) return { ok: false, code: 'NO_AUDIO', error: 'Voiceover audio (mp3/m4a/wav) pehle daalo.' };
  try {
    const v = validate.validateFile(inp.pack);
    if (!v.ok) return { ok: false, code: 'PACK_INVALID', error: 'Research pack valid nahi hai. New Video screen par errors dekho.' };
  } catch (e) { return { ok: false, code: 'PACK_INVALID', error: String(e && e.message || e) }; }
  const tb = timebase.resolve({ srtFile: inp.srt, audioFile: inp.audio, cfg });
  if (!tb.ok) return { ok: false, code: 'AUDIO_TIMEBASE_MISMATCH', error: tb.reason, steps: timebase.blockSteps(tb) };
  return { ok: true, inp, timebase: tb };
}

function stepExitAccepted(step, exitCode) {
  return (step.accepted || [0]).includes(exitCode);
}

function expectedArtifact(kind) {
  return kind === 'final' ? 'final.mp4' : 'draft.mp4';
}

function startJob(kind) {
  if (running && !running.done) return { ok: false, error: 'ek kaam pehle se chal raha hai' };
  const preflight = preflightJob(kind);
  if (!preflight.ok) return preflight;
  const id = jobId();
  if (!id) return { ok: false, error: 'input/scene-research.json nahi mila' };
  const inp = preflight.inp;

  // Steps: pack report purana ho to pehle check-pack (run.js ka STALE gate isi ke
  // bina exit 3 de deta hai — wahi START_HERE option 2 pehle chalane wali baat).
  const steps = [];
  // Purane/Genspark packs mein criticality aksar hoti hi nahi. CLI mein user
  // ko alag REPAIR step chalana padta tha aur final 109/109 par block ho jata
  // tha. UI ab safe structural migration khud karti hai (backup ke saath);
  // cross-episode borrow ko kabhi auto-approve nahi karti.
  const missingCrit = missingCriticalityCount(inp.pack);
  const hasTimeline = jobArtifacts(id).timeline;
  const critPlan = criticalityStrategy(kind, hasTimeline, missingCrit, evalReadiness().ev.can_export);
  // Fresh projects migrate BEFORE the first draft. A pre-M5.0-B.2 draft must
  // not change pack hash at Export time: that would stale filled DATA folders
  // and wipe the expensive job cache. Fully completed legacy gaps use a narrow
  // one-time waiver in run.js instead.
  const migrateNow = critPlan.migrate_now;
  if (migrateNow) {
    steps.push({ label: `criticality auto-fix (${missingCrit} moments)`,
      args: ['tools/migrate-pack.js', inp.pack, inp.srt, '--apply'], accepted: [0] });
  }
  if ((migrateNow || !packReportFresh()) && inp.pack && inp.srt) {
    steps.push({ label: 'pack check', args: ['tools/check-pack.js', inp.pack, inp.srt, '--apply-probe'], accepted: [0, 2] });
  }
  // run.js ko SAAF-SAAF input dir batao. Production mein ye ROOT/input hi hai,
  // par run.js RFC_INPUT_DIR nahi padhta — isliye --input zaroori hai (warna
  // server temp/alag input par draft chalane par asli ROOT/input padh leta).
  const runArgs = ['src/run.js', `--input=${inp.dir}`];
  if (critPlan.legacy_waiver) runArgs.push('--legacy-human-complete');
  steps.push({ label: kind, args: kind === 'final' ? runArgs : [...runArgs, '--draft', '--redo'], accepted: [0], expected: expectedArtifact(kind) });

  const job = { id, kind, log: [`> ${kind} shuru (${new Date().toLocaleTimeString()})`], startedAt: Date.now(), done: false, exit: null, ok: null, code: null, message: null, artifact: null, listeners: new Set(), proc: null };
  const emit = l => { job.log.push(l); if (job.log.length > 3000) job.log.splice(0, job.log.length - 3000); for (const fn of job.listeners) { try { fn(l); } catch {} } };
  const push = b => { for (const l of String(b).split('\n')) if (l.length) emit(l); };

  let i = 0;
  const runNext = () => {
    if (i >= steps.length) { finish(0); return; }
    const step = steps[i++];
    emit(`> ${step.label} …`);
    const proc = spawn(process.execPath, step.args.map((a, n) => n === 0 ? path.join(ROOT, a) : a), { cwd: ROOT, env: process.env, windowsHide: true });
    job.proc = proc;
    proc.stdout.on('data', push); proc.stderr.on('data', push);
    proc.on('close', c => {
      emit(`> ${step.label} exit ${c}`);
      // check-pack exit 2 ka matlab "pack weak" — draft phir bhi banta hai (draft
      // diagnostic hai). Sirf exit 1 (tool toota) par ruk jao.
      if (!stepExitAccepted(step, c)) {
        const d = failureDetails(job, c == null ? 1 : c);
        return finish(c == null ? 1 : c, d);
      }
      if (step.expected && !fs.existsSync(U.p(id, step.expected))) {
        return finish(4, { code: 'ARTIFACT_MISSING', message: `${step.label} ne success bola, lekin ${step.expected} bani hi nahi.` });
      }
      runNext();
    });
    proc.on('error', e => { emit('> spawn error: ' + e.message); finish(1, { code: 'SPAWN_ERROR', message: e.message }); });
  };
  const finish = (c, detail = {}) => {
    if (job.done) return;
    const expected = expectedArtifact(kind);
    const artifactExists = fs.existsSync(U.p(id, expected));
    if (c === 0 && !artifactExists) {
      c = 4;
      detail = { code: 'ARTIFACT_MISSING', message: `Process khatam hua, lekin ${expected} nahi bani.` };
    }
    job.done = true; job.exit = c; job.ok = c === 0;
    job.code = job.ok ? 'OK' : (detail.code || 'BUILD_FAILED');
    job.message = job.ok ? `${expected} taiyar hai` : (detail.message || `${kind} fail hui`);
    job.artifact = artifactExists ? expected : null;
    job.report = detail.report || null;
    emit(job.ok ? `> SUCCESS: ${expected} taiyar hai` : `> FAILED [${job.code}]: ${job.message}`);
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
    timebase: tb ? { audio: tb.audio_duration, srt_end: tb.srt_end, project_duration: tb.project_duration,
      correction: tb.correction, ok: tb.ok, reason: tb.reason, tolerance: tb.tolerance,
      tail_tolerance: tb.tail_tolerance, lead_tolerance: tb.lead_tolerance } : null,
    media_state: ev.state,
    total_requests: (ev.requests || []).length,
    blocking: (ev.blocking || []).length,
    job: running ? { kind: running.kind, running: !running.done, exit: running.exit, ok: running.ok,
      code: running.code, message: running.message, artifact: running.artifact,
      log_tail: running.log.slice(-120) } : null,
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

function currentProjectTitle() {
  const inp = inputInfo();
  try {
    const p = JSON.parse(fs.readFileSync(inp.pack, 'utf8'));
    return p.project_title || p.topic || p.title || jobId() || 'Untitled video essay';
  } catch { return jobId() || 'Untitled video essay'; }
}

function missingPayload() {
  const { ev } = evalReadiness();
  return { ok: true, state: ev.state, can_export: ev.can_export,
    requests: (ev.requests || []).map(r => {
      const q = (() => { try { return JSON.parse(fs.readFileSync(path.join(r.dir, 'request.json'), 'utf8')); } catch { return {}; } })();
      return { request_key: r.request_key, label: r.label, folder: r.folder, criticality: r.criticality,
        range: r.range, narration: r.narration_exact, media_status: r.media_status,
        approval_required: r.approval_required, approval_status: r.approval_status, approval_reason: r.approval_reason,
        approved_at: r.approved_at, allow_reuse: r.allow_reuse, short_seconds: r.short_seconds,
        blocking: r.blocking, reasons: r.reasons, notes: r.notes || [],
        must_show: q.must_show || [], must_not_show: q.must_not_show || [], search_queries: q.search_queries || [],
        visual_brief: q.visual_brief || q.what_is_missing || q.description || '',
        files: r.files.map((f, order) => {
          const abs = path.join(r.dir, 'media', f.file);
          return { file: f.file, type: f.type, token: fs.existsSync(abs) ? sha1(abs) : null,
            order, duration: f.duration, width: f.width, height: f.height, warnings: f.warnings,
            trim_start_sec: f.trim_start_sec, trim_end_sec: f.trim_end_sec };
        }) };
    }) };
}

// Bulk approval automatic nahi hai: ye endpoint tabhi call hota hai jab user
// Missing Media banner/Export confirmation par saaf haan karta hai. Sirf VALID
// critical requests approve hoti hain; empty/short/broken media kabhi nahi.
function approveAllReadyCritical() {
  const { ev } = evalReadiness();
  const pending = (ev.requests || []).filter(r => r.approval_required
    && r.approval_status !== 'APPROVED' && r.media_status === 'VALID' && (r.files || []).length);
  const approved = [], skipped = [];
  const ov = manual.readOverrides(DATA); ov.schema = 'manual-overrides-v2'; ov.requests = ov.requests || [];
  for (const r of pending) {
    try {
      const hit = findRequest(r.request_key);
      if (!hit) throw new Error('request folder nahi mila');
      // missingPayload ki files wahi single validated scan se aayi hain; har
      // request par 15 folders dobara ffprobe karna avoid karo.
      approval.approve(DATA, r.request_key, { scanReq: r, req: hit.req, source: 'UI_BULK_REVIEW' });
      let e = ov.requests.find(x => manual.requestKey(x) === r.request_key);
      if (!e) { e = { request_key: r.request_key }; ov.requests.push(e); }
      e.request_key = r.request_key; e.approved = true;
      approved.push(r.request_key);
    }
    catch (e) { skipped.push({ request_key: r.request_key, reason: String(e && e.message || e) }); }
  }
  if (approved.length) manual.writeOverrides(DATA, ov);
  const sync = approved.length ? syncManualEdl() : { ok: true, applied: 0 };
  const after = missingPayload();
  return { ok: skipped.length === 0, approved: approved.length, approved_keys: approved,
    skipped, editor_synced: !!sync.ok, state: after.state, can_export: after.can_export,
    remaining: (after.requests || []).filter(r => r.blocking).length };
}

function buildMissingNote(payload) {
  const reqs = (payload.requests || []).filter(r => r.media_status !== 'VALID' || r.blocking);
  const total = reqs.reduce((n, r) => n + Number((r.range || {}).duration_sec || 0), 0);
  const lines = [
    'MISSING MEDIA RESEARCH NOTE',
    `PROJECT: ${currentProjectTitle()}`,
    `MISSING SCENES: ${reqs.length}`,
    `TOTAL UNFILLED TIME: ${total.toFixed(1)} seconds`,
    '',
    'RULE: Return only real, opened resources. Never invent a URL, video ID, timestamp, image URL, episode, quote or source.',
    '',
  ];
  reqs.forEach((r, i) => {
    const rg = r.range || {};
    lines.push(`SCENE ${String(i + 1).padStart(2, '0')} | ${r.label || r.request_key}`);
    lines.push(`TIME: ${Number(rg.start_sec || 0).toFixed(1)}s - ${Number(rg.end_sec || 0).toFixed(1)}s (${Number(rg.duration_sec || 0).toFixed(1)}s)`);
    lines.push(`CRITICALITY: ${r.criticality || 'NORMAL'}${r.approval_required ? ' - human approval required' : ''}`);
    lines.push(`NARRATION: ${r.narration || ''}`);
    lines.push(`WHAT TO SHOW: ${(r.must_show || []).join(' | ') || r.visual_brief || 'Use narration to infer the most literal, relevant visual.'}`);
    lines.push(`DO NOT SHOW: ${(r.must_not_show || []).join(' | ') || 'reaction hosts, unrelated show/movie, large channel logo, watermark, subtitles covering the subject'}`);
    lines.push(`WHY MISSING: ${(r.reasons || []).join(' | ') || r.media_status || 'source unavailable'}`);
    lines.push(`SEARCH QUERIES: ${(r.search_queries || []).join(' | ') || '(researcher must create precise queries)'}`);
    lines.push(`CURRENT FILES: ${(r.files || []).map(f => f.file).join(' | ') || 'none'}`);
    lines.push('');
  });
  return lines.join('\n').trim() + '\n';
}

function readPrompt(name) {
  try { return fs.readFileSync(path.join(ROOT, 'prompts', name), 'utf8'); }
  catch { return ''; }
}

function researchKit() {
  const payload = missingPayload();
  const note = buildMissingNote(payload);
  const stage1 = readPrompt('CHATGPT_STAGE1_TOPIC_AND_SOURCE_MAP_PROMPT.txt');
  const stage2Base = readPrompt('CHATGPT_STAGE2_MISSING_SCENE_RESEARCH_PROMPT.txt');
  return { ok: true, title: currentProjectTitle(), note, stage1_prompt: stage1,
    stage2_prompt: `${stage2Base.trim()}\n\n--- MISSING SCENES FROM THE TOOL ---\n${note}` };
}

function syncManualEdl() {
  const id = jobId();
  if (!id) return { ok: false, code: 'NO_JOB' };
  let tl = null;
  try { tl = JSON.parse(fs.readFileSync(U.p(id, 'timeline.json'), 'utf8')); } catch {}
  if (!tl || !Array.isArray(tl.slots)) return { ok: false, code: 'NO_DRAFT' };
  const applied = manual.applyToTimeline(tl, DATA, cfg);
  const edl = edlMod.rebuild(PROJ(), id, { projectId: 'current', timelineOverride: applied.tl });
  return { ok: true, applied: applied.applied, edl };
}

// ---------- EDL ----------
function edlForClient() {
  const id = jobId();
  let edl = edlMod.read(PROJ());
  if (!edl && id && jobArtifacts(id).timeline) { try { edl = edlMod.rebuild(PROJ(), id, { projectId: 'current' }); } catch {} }
  if (!edl) return null;
  // M5.0-B.1 ne exact-video path omit kiya aur relative path ko hash kiya tha.
  // Existing project.edl.json ko user se "rebuild" karwaye bina ek baar khud
  // repair karo. Manual DATA media live timeline se dobara lagti hai.
  const brokenMediaIdentity = (edl.tracks.video_main || []).some(s => {
    if (!s.asset || (s.provenance && s.provenance.origin === 'MISSING')) return false;
    const p = s.asset.path;
    return !p || !path.isAbsolute(p) || (fs.existsSync(p) && s.asset.path_token !== sha1(path.normalize(p)));
  });
  if (brokenMediaIdentity && id && jobArtifacts(id).timeline) {
    try { const repaired = syncManualEdl(); if (repaired.ok) edl = repaired.edl; } catch {}
  }
  // approval status live chadhao
  const { ev } = evalReadiness();
  const statusByKey = {};
  for (const r of (ev.requests || [])) statusByKey[r.request_key] = r.approval_status;
  edlMod.withApproval(edl, statusByKey);
  // browser ko raw path mat do — sirf token
  const safe = JSON.parse(JSON.stringify(edl));
  for (let i = 0; i < safe.tracks.video_main.length; i++) {
    const s = safe.tracks.video_main[i];
    const disk = edl.tracks.video_main[i] && edl.tracks.video_main[i].asset;
    if (!s.asset) continue;
    // Token hamesha usi absolute canonical path se nikle jise mediaIndex walk
    // karta hai. Browser ko raw path kabhi nahi diya jata.
    if (disk && disk.path && path.isAbsolute(disk.path) && fs.existsSync(disk.path)) {
      s.asset.path_token = sha1(path.normalize(disk.path));
      s.asset.available = true;
    } else {
      s.asset.path_token = null;
      s.asset.available = false;
    }
    delete s.asset.path;
    if (s.original_asset) delete s.original_asset.path;
    if (s.replacement) delete s.replacement.path;
  }
  const inp = inputInfo();
  safe.tracks.voiceover = inp.audio ? [{
    track_id: 'VOICEOVER_MASTER', path_token: sha1(inp.audio),
    start: 0, end: safe.duration_sec, locked: true,
  }] : [];
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
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav' };

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

// Browser-safe, shot-sized proxy. yt-dlp may deliver MKV/AV1/VP9 files that
// FFmpeg can render but Chromium cannot preview. A short cached H.264 proxy
// removes the black-player problem without transcoding an entire episode.
function previewFor(token, start, duration) {
  const src = resolveToken(token);
  if (!src) return null;
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(path.extname(src).toLowerCase())) return src;
  const st = fs.statSync(src);
  const a = Math.max(0, Math.min(24 * 3600, Number(start) || 0));
  const d = Math.max(0.25, Math.min(90, Number(duration) || 6));
  const sig = sha1(`${src}|${st.size}|${st.mtimeMs}|${a.toFixed(3)}|${d.toFixed(3)}`);
  const dir = path.join(edlMod.projectRoot(PROJ()), 'cache', 'previews');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${sig}.mp4`);
  if (fs.existsSync(out) && fs.statSync(out).size > 1024) return out;
  const tmp = out + '.tmp.mp4';
  try { fs.rmSync(tmp, { force: true }); } catch {}
  const r = U.ffmpeg(['-stream_loop', '-1', '-ss', a.toFixed(3), '-i', src, '-t', d.toFixed(3), '-an',
    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,fps=30,setsar=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '29', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmp], { timeout: 120000 });
  if (!r.ok || !fs.existsSync(tmp) || fs.statSync(tmp).size <= 1024) { try { fs.rmSync(tmp, { force: true }); } catch {} return src; }
  fs.renameSync(tmp, out);
  return out;
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
      return json(res, { ok: true, name: 'research-first-clip-tool', ui: 'M5.1', node: process.version,
        instance_id: INSTANCE_ID, launch_url: `http://127.0.0.1:${PORT}/?token=${TOKEN}` });
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
      return json(res, missingPayload());
    }
    if (req.method === 'GET' && p === '/api/v1/missing/research-kit') return json(res, researchKit());

    if (req.method === 'POST' && p === '/api/v1/requests/approve-all-ready-critical') {
      const out = approveAllReadyCritical();
      return json(res, out, out.ok ? 200 : 409);
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
      const donePayload = () => ({ exit: job.exit, ok: job.ok, code: job.code, message: job.message,
        artifact: job.artifact, kind: job.kind, state: projectState() });
      if (job.done) { send('done', donePayload()); return res.end(); }
      const onLine = l => { if (l === '__DONE__') { send('done', donePayload()); res.end(); } else send('log', { line: l }); };
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
      const sync = syncManualEdl();
      return json(res, { ok: true, file: name, type: info.type, editor_synced: sync.ok });
    }
    if (req.method === 'DELETE' && (m = p.match(/^\/api\/v1\/requests\/([^/]+)\/media\/([^/]+)$/))) {
      const key = decodeURIComponent(m[1]);
      const hit = findRequest(key);
      if (!hit) return err(res, 'NO_REQUEST', 'ye request nahi mili', 404);
      const name = safeName(decodeURIComponent(m[2]));
      const src = path.join(hit.dir, 'media', name);
      if (!U.isInside(path.join(hit.dir, 'media'), src) || !fs.existsSync(src)) return err(res, 'NO_MEDIA', 'file nahi mili', 404);
      const trash = path.join(DATA, '.trash', hit.key); fs.mkdirSync(trash, { recursive: true });
      fs.renameSync(src, path.join(trash, `${Date.now()}_${name}`));
      approval.revoke(DATA, hit.key);
      const sync = syncManualEdl();
      return json(res, { ok: true, recoverable: true, editor_synced: sync.ok });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/v1\/requests\/([^/]+)\/override$/))) {
      const body = JSON.parse((await readBody(req, 1e6)).toString() || '{}');
      const patch = {};
      if ('allow_reuse' in body) patch.allow_reuse = !!body.allow_reuse;
      if (Array.isArray(body.files)) patch.files = body.files.map((f, i) => ({
        relative_path: safeName(f.relative_path || f.file), order: Number.isFinite(+f.order) ? +f.order : i,
        trim_start_sec: f.trim_start_sec == null ? null : Math.max(0, +f.trim_start_sec),
        trim_end_sec: f.trim_end_sec == null ? null : Math.max(0, +f.trim_end_sec),
      }));
      const out = setOverride(decodeURIComponent(m[1]), patch);
      const sync = syncManualEdl();
      return json(res, { ...out, editor_synced: sync.ok });
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
    if (req.method === 'POST' && p === '/api/v1/edl/sync-manual') {
      const r = syncManualEdl();
      if (!r.ok) return err(res, r.code, r.code === 'NO_DRAFT' ? 'pehle draft banao' : 'project nahi mila', 400);
      return json(res, { ok: true, applied: r.applied, edl: edlForClient() });
    }

    // Right-click -> Change Clip. Binary upload validate hota hai, project ke
    // andar save hota hai, phir EDL revision ke saath final render se judta hai.
    if (req.method === 'POST' && (m = p.match(/^\/api\/v1\/edl\/([^/]+)\/replace$/))) {
      const shotId = decodeURIComponent(m[1]);
      const expectedRevision = Number(u.searchParams.get('expected_revision'));
      const name = safeName(u.searchParams.get('name') || 'replacement');
      const dir = path.join(edlMod.projectRoot(PROJ()), 'replacements', safeName(shotId));
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, `${Date.now()}_${name}`);
      if (!U.isInside(dir, dest)) return err(res, 'BAD_PATH', 'galat replacement path', 400);
      const buf = await readBody(req);
      if (!buf.length) return err(res, 'EMPTY', 'file khaali hai', 400);
      fs.writeFileSync(dest, buf);
      const info = manual.inspectFile(dest);
      if (!info.ok) { fs.rmSync(dest, { force: true }); return err(res, 'BAD_MEDIA', info.problem, 400); }
      const out = edlMod.replaceAsset(PROJ(), { shot_id: shotId,
        expected_revision: Number.isFinite(expectedRevision) ? expectedRevision : undefined,
        path: dest, type: info.type === 'VIDEO' ? 'video' : 'image', sha256: info.sha256,
        duration: info.duration || null });
      if (!out.ok) { fs.rmSync(dest, { force: true }); return json(res, out, out.code === 'REVISION_CONFLICT' ? 409 : 400); }
      return json(res, { ok: true, revision: out.revision, edl: edlForClient(), file: name, type: info.type });
    }
    if (req.method === 'DELETE' && (m = p.match(/^\/api\/v1\/edl\/([^/]+)\/replacement$/))) {
      const expectedRevision = Number(u.searchParams.get('expected_revision'));
      const out = edlMod.clearReplacement(PROJ(), { shot_id: decodeURIComponent(m[1]),
        expected_revision: Number.isFinite(expectedRevision) ? expectedRevision : undefined });
      if (!out.ok) return json(res, out, out.code === 'REVISION_CONFLICT' ? 409 : 400);
      return json(res, { ok: true, revision: out.revision, edl: edlForClient() });
    }

    // Save-As UI is endpoint ko streaming mode mein chosen Chrome/Edge file
    // handle par likhti hai; multi-GB export browser memory mein load nahi hota.
    if (req.method === 'GET' && p === '/api/v1/artifacts/final') {
      const id = jobId(); const file = id ? U.p(id, 'final.mp4') : null;
      if (!file || !fs.existsSync(file)) return err(res, 'NO_FINAL', 'final.mp4 abhi nahi bani', 404);
      res.setHeader('content-disposition', `attachment; filename="${safeName(id || 'final')}.mp4"`);
      return serveFileRange(req, res, file);
    }

    // ---- media + thumbnails (token allow-list) ----
    if (req.method === 'GET' && (m = p.match(/^\/api\/v1\/preview\/([a-f0-9]+)$/))) {
      const file = previewFor(m[1], u.searchParams.get('start'), u.searchParams.get('duration'));
      if (!file) return err(res, 'NO_MEDIA', 'preview media nahi mila', 404);
      return serveFileRange(req, res, file);
    }
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
  server.once('error', e => {
    if (e && e.code === 'EADDRINUSE') {
      console.error(`Movie Editor port ${PORT} par pehle se chal raha hai. MOVIE_EDITOR.bat use dobara khol dega; second server ki zaroorat nahi.`);
      process.exit(2);
    }
    console.error('Movie Editor server start nahi hua: ' + String(e && e.message || e));
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}/?token=${TOKEN}`;
    console.log('='.repeat(66));
    console.log('  RESEARCH-FIRST CLIP TOOL — EDITOR (M5.1)');
    console.log('='.repeat(66));
    console.log(`  ${url}`);
    console.log('  (sirf is computer par — na internet, na account, na key)');
    console.log('  band karne ke liye ye window band karo ya Ctrl+C dabao.');
    console.log('='.repeat(66));
    if (OPEN) {
      const o = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      try { spawn(o[0], o[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
    }
  });
}

module.exports = { server, projectState, edlForClient, resolveToken, jobId, TOKEN, PORT, INSTANCE_ID,
  preflightJob, startJob, stepExitAccepted, expectedArtifact, missingCriticalityCount, criticalityStrategy };
