#!/usr/bin/env node
// ============================================================
//  run.js — ORCHESTRATOR (M1.3)
//   node src/run.js                    poori pipeline (input/ se)
//   node src/run.js --only=check       sirf setup check
//   node src/run.js --only=align,locate
//   node src/run.js --from=5           stage 5 se aage (resume)
//   node src/run.js --redo             sab dobara (sirf generated files clear)
//   node src/run.js --input=<dir> --job=<safe-id>
//
//  Resume: har stage state.json mein checkpoint; intermediate data disk par
//  (aligned/resolved/timeline json) taaki alag process mein bhi resume ho.
//  Inputs (pack/SRT/audio/config) change hon to fingerprint mismatch par
//  affected+downstream stages invalidate.
// ============================================================
const fs = require('fs');
const path = require('path');
const U = require('./util.js');
const ST = require('./state.js');

const check = require('./check.js');
const validate = require('./validate.js');
const align = require('./align.js');
const locate = require('./locate.js');
const download = require('./download.js');
const cut = require('./cut.js');
const localqa = require('./localqa.js');
const timeline = require('./timeline.js');
const render = require('./render.js');
const report = require('./report.js');

// ---------- console tee -> run.log ----------
const logLines = [];
const origLog = console.log.bind(console);
console.log = (...a) => { logLines.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); origLog(...a); };
function flushLog(id) { try { if (id) fs.writeFileSync(U.p(id, 'run.log'), logLines.join('\n')); } catch {} }

const arg = (name, def = null) => {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=').replace(/^["']|["']$/g, '') : def;
};
const flag = name => process.argv.includes(`--${name}`);

const STAGES = ['align', 'locate', 'download', 'cut', 'qa', 'timeline', 'render', 'report'];
const STAGE_N = { align: 2, locate: 3, download: 4, cut: 5, qa: 6, timeline: 7, render: 8, report: 9 };
const DOWNSTREAM = STAGES;   // order = downstream order

function loadSpec() {
  const inputDir = path.resolve(arg('input', path.join(U.ROOT, 'input')));
  const pick = names => { for (const nm of names) { const f = path.join(inputDir, nm); if (fs.existsSync(f)) return f; } return null; };
  const packFile = pick(['scene-research.json', 'research-pack.json', 'pack.json']);
  const srt = pick(['voiceover.srt', 'narration.srt']);
  const audio = pick(['voiceover.mp3', 'voiceover.m4a', 'voiceover.wav']);
  const script = pick(['script.txt']);
  if (!packFile) throw new Error(`scene-research.json nahi mila (${inputDir})`);
  if (!srt) throw new Error(`voiceover.srt nahi mila (${inputDir})`);

  const v = validate.validateFile(packFile);
  U.step('1. research pack validation');
  (v.warnings || []).forEach(w => U.warn(w));
  if (!v.ok) { (v.errors || []).forEach(e => U.bad(e)); throw new Error(`research pack invalid (${v.errors.length} errors)`); }
  U.ok(`pack valid — ${v.stats.packs} packs, ${v.stats.moments} moments, ${v.stats.exactOrDialoguePct}% EXACT/DIALOGUE`);

  // coverage readiness (configurable)
  const cfg = U.config();
  if (cfg.validation && cfg.validation.requireEntireScriptCoverage && v.pack.coverage_check && v.pack.coverage_check.entire_script_covered === false) {
    const uncov = (v.pack.coverage_check.uncovered_script_cues || []).length;
    U.warn(`coverage_check.entire_script_covered=false (${uncov} uncovered cues) — un beats par NEEDS_SOURCE aayega`);
  }

  // job id — sanitize (path traversal safe)
  let id = arg('job', U.slug(v.pack.project_title || path.basename(inputDir)));
  U.assertSafeId(id, 'job id');
  return { id, inputDir, packFile, srt, audio, script, pack: v.pack, validation: v };
}

function audioSig(f) { try { const s = fs.statSync(f); return `${s.size}:${Math.round(s.mtimeMs)}`; } catch { return 'na'; } }
function fingerprint(spec, cfg, chk) {
  const toolSig = (chk.results || []).map(r => `${r.bin}=${r.version || (r.ok ? 'ok' : 'no')}`).join(',');
  return {
    pack: U.hashFile(spec.packFile),
    srt: U.hashFile(spec.srt),
    audio: spec.audio ? audioSig(spec.audio) : 'none',
    config: U.hashStr(JSON.stringify(cfg)),
    tool: U.hashStr(toolSig + '|node=' + process.version),
  };
}

async function main() {
  U.log('='.repeat(60)); U.log('  RESEARCH-FIRST CLIP TOOL — M1.3'); U.log('='.repeat(60));

  const cfg = U.config();
  const only = arg('only');

  if (only === 'check') { const r = check(); process.exit(r.ok ? 0 : 1); }

  const chk = check();

  const spec = loadSpec();

  // --- preflight: URL project ke liye yt-dlp/runtime zaroori (misleading DONE se bachne ko) ---
  const hasUrlSource = spec.pack.packs.some(pk => (pk.sources || []).some(s => s.url && !s.local_file));
  if (hasUrlSource) {
    const ytOk = chk.results.find(r => r.key === 'ytdlp' && r.ok);
    const jsOk = chk.results.find(r => r.key === 'jsruntime' && r.ok);
    if (!ytOk) { U.bad('URL sources hain par yt-dlp nahi mila — preflight STOP (misleading DONE se bachne ko).'); flushLog(spec.id); process.exit(2); }
    if (!jsOk) { U.bad('URL sources hain par koi usable JS runtime nahi (Deno 2.3+ ya Node 22+) — preflight STOP (yt-dlp YouTube EJS chahiye).'); flushLog(spec.id); process.exit(2); }
  }

  // --- redo: containment-safe cleanup ---
  if (flag('redo')) cleanJob(spec.id, spec.inputDir);
  U.ensureDir(U.jobDir(spec.id));
  U.assertInside(U.jobsRoot(), U.jobDir(spec.id), 'job dir');

  let st = flag('redo') ? { done: {}, meta: {} } : ST.load(spec.id);

  // --- fingerprint: input/config/tool change -> generated ARTIFACTS + state dono
  //     invalidate (sirf state.done nahi — warna stale clip/final reuse ho jata tha)
  //     aur full rerun force (invalidated prerequisite ke upar --from/--only na chale)
  const fp = fingerprint(spec, cfg, chk);
  let invalidated = false;
  if (!flag('redo') && st.fingerprint) {
    const changed = Object.keys(fp).filter(k => st.fingerprint[k] !== fp[k]);
    if (changed.length) {
      U.warn(`input change detected (${changed.join(', ')}) — generated artifacts wipe + full rerun (stale media reuse nahi)`);
      cleanJob(spec.id, spec.inputDir);   // clips/segments/cache/final/json sab wipe (inputs safe)
      U.ensureDir(U.jobDir(spec.id));
      st = { done: {}, meta: {} };
      invalidated = true;
    }
  }
  st.fingerprint = fp;
  ST.save(spec.id, st);

  U.log(`\n  job: ${spec.id}  ->  ${path.relative(U.ROOT, U.jobDir(spec.id))}/`);

  const from = Number(arg('from', 0));
  let toRun = STAGES.slice();
  if (invalidated) {
    if (only || from) U.warn('input change ke baad --from/--only override — full rerun (stale prerequisite se bachne ko)');
  } else if (only) toRun = only.split(',').map(s => s.trim()).filter(k => STAGES.includes(k));
  else if (from) toRun = STAGES.filter(k => STAGE_N[k] >= from);

  const pending = k => flag('redo') || !ST.isDone(st, k);
  const jf = f => { const pp = U.p(spec.id, f); return fs.existsSync(pp) ? JSON.parse(fs.readFileSync(pp, 'utf8')) : null; };
  let aligned = null, resolved = null, tl = null;

  const runStage = async (key, fn) => {
    U.step(`${STAGE_N[key]}. ${key}`);
    const t0 = Date.now();
    await fn();
    ST.markDone(st, key, { seconds: Math.round((Date.now() - t0) / 1000) });
    ST.save(spec.id, st);
    flushLog(spec.id);
  };

  for (const key of toRun) {
    if (!pending(key)) { U.log(`\n  -- ${STAGE_N[key]}. ${key} (pehle ho chuka, skip)`); continue; }
    try {
      if (key === 'align') await runStage(key, () => { aligned = align(spec, cfg, st); });
      else if (key === 'locate') await runStage(key, () => { aligned = aligned || jf('aligned.json'); resolved = locate(spec, cfg, st, aligned); });
      else if (key === 'download') await runStage(key, () => { resolved = resolved || jf('resolved.json'); resolved = download(spec, cfg, st, resolved); saveResolved(spec.id, resolved); });
      else if (key === 'cut') await runStage(key, () => { resolved = resolved || jf('resolved.json'); resolved = cut(spec, cfg, st, resolved); saveResolved(spec.id, resolved); });
      else if (key === 'qa') await runStage(key, () => { resolved = resolved || jf('resolved.json'); resolved = localqa(spec, cfg, st, resolved); saveResolved(spec.id, resolved); });
      else if (key === 'timeline') await runStage(key, () => { resolved = resolved || jf('resolved.json'); aligned = aligned || jf('aligned.json'); tl = timeline(spec, cfg, st, resolved, aligned && aligned.total); });
      else if (key === 'render') await runStage(key, () => { tl = tl || jf('timeline.json'); render(spec, cfg, st, tl); });
      else if (key === 'report') await runStage(key, () => { resolved = resolved || jf('resolved.json'); tl = tl || jf('timeline.json'); report(spec, cfg, st, resolved, tl); });
    } catch (e) {
      U.bad(`stage ${key} fail: ${e.message}`);
      ST.save(spec.id, st); flushLog(spec.id);
      U.log(`\n  resume: node src/run.js --from=${STAGE_N[key]} --job=${spec.id}`);
      flushLog(spec.id);
      process.exit(1);
    }
  }

  U.log('\n' + '='.repeat(60));
  U.log(`  DONE — ${path.relative(U.ROOT, U.jobDir(spec.id))}/`);
  U.log('   final.mp4, timeline.json, quality-report.html, NEEDS_SOURCE.csv, run.log, clips/');
  U.log('='.repeat(60));
  flushLog(spec.id);
}

function saveResolved(id, resolved) {
  // internal (underscore) fields hata kar likho. raw_file/raw_offset NON-underscore
  // hain -> persist honge (resume ke liye zaroori).
  const clean = resolved.map(e => { const o = {}; for (const k in e) if (!k.startsWith('_')) o[k] = e[k]; return o; });
  fs.writeFileSync(U.p(id, 'resolved.json'), JSON.stringify(clean, null, 2));
}

// --redo: sirf GENERATED artifacts delete. Containment-safe: ROOT/jobs/<safe-id>
// ke bahar kuch nahi. Inputs (input/ dir) ko kabhi haath nahi.
function cleanJob(id, inputDir) {
  U.assertSafeId(id, 'job id');
  const dir = U.jobDir(id);
  U.assertInside(U.jobsRoot(), dir, 'job dir');
  if (path.resolve(dir) === path.resolve(inputDir || '')) { U.warn('--redo skip: job dir == input dir (inputs safe)'); return; }
  const items = ['clips', 'segments', 'cache', 'thumbs', 'resolved.json', 'aligned.json', 'timeline.json',
    'state.json', 'final.mp4', 'video_master.mp4', 'quality-report.html', 'NEEDS_SOURCE.csv', 'run.log'];
  for (const it of items) { const pp = path.join(dir, it); if (fs.existsSync(pp) && U.isInside(dir, pp)) fs.rmSync(pp, { recursive: true, force: true }); }
}

main().catch(e => { U.bad('fatal: ' + e.message); try { flushLog(U.slug(arg('job') || '')); } catch {} process.exit(1); });
