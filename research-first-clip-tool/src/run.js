#!/usr/bin/env node
// ============================================================
//  run.js — ORCHESTRATOR (Milestone 1)
//   node src/run.js                    poori pipeline (input/ se)
//   node src/run.js --only=check       sirf setup check
//   node src/run.js --from=7           stage 7 se aage
//   node src/run.js --redo             state ignore, sab dobara
//   node src/run.js --input=<dir>      alag input folder
//   node src/run.js --job=<id>         job id override (jobs/<id>/)
//
//  Resume: har completed stage state.json mein. Beech mein ruke to wahin se.
//  Intermediate data disk par (aligned.json, resolved.json, timeline.json)
//  taaki alag process mein bhi resume ho.
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

const arg = (name, def = null) => {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=').replace(/^["']|["']$/g, '') : def;
};
const flag = name => process.argv.includes(`--${name}`);

const STAGES = ['align', 'locate', 'download', 'cut', 'qa', 'timeline', 'render', 'report'];
const STAGE_N = { align: 2, locate: 3, download: 4, cut: 5, qa: 6, timeline: 7, render: 8, report: 9 };

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

  const id = arg('job', U.slug(v.pack.project_title || path.basename(inputDir)));
  return { id, inputDir, packFile, srt, audio, script, pack: v.pack, validation: v };
}

async function main() {
  U.log('='.repeat(60)); U.log('  RESEARCH-FIRST CLIP TOOL — Milestone 1'); U.log('='.repeat(60));

  const cfg = U.config();
  const only = arg('only');

  // --- sirf check ---
  if (only === 'check') { const r = check(); process.exit(r.ok ? 0 : 1); }

  // setup check hamesha pehle (fast)
  const chk = check();
  if (!chk.ok) { U.bad('setup incomplete — upar dekho. (local_file-only test bina yt-dlp bhi chal sakta hai)'); }

  const spec = loadSpec();
  if (flag('redo') && fs.existsSync(U.jobDir(spec.id))) fs.rmSync(U.jobDir(spec.id), { recursive: true, force: true }); // stale clips/segments/cache clear
  U.ensureDir(U.jobDir(spec.id));
  const st = flag('redo') ? { done: {}, meta: {} } : ST.load(spec.id);
  U.log(`\n  job: ${spec.id}  ->  ${path.relative(U.ROOT, U.jobDir(spec.id))}/`);

  // kaunse stages chalane hain
  const from = Number(arg('from', 0));
  let toRun = STAGES.slice();
  if (only) toRun = only.split(',').map(s => s.trim()).filter(k => STAGES.includes(k));
  else if (from) toRun = STAGES.filter(k => STAGE_N[k] >= from);

  const pending = k => flag('redo') || !ST.isDone(st, k);

  // disk loaders (resume ke liye)
  const jf = f => { const p = U.p(spec.id, f); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };
  let aligned = null, resolved = null, tl = null;

  const runStage = async (key, fn) => {
    U.step(`${STAGE_N[key]}. ${key}`);
    const t0 = Date.now();
    await fn();
    ST.markDone(st, key, { seconds: Math.round((Date.now() - t0) / 1000) });
    ST.save(spec.id, st);
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
      ST.save(spec.id, st);
      U.log(`\n  resume: node src/run.js --from=${STAGE_N[key]} --job=${spec.id}`);
      process.exit(1);
    }
  }

  U.log('\n' + '='.repeat(60));
  U.log(`  DONE — jobs/${spec.id}/`);
  U.log('   final.mp4, timeline.json, quality-report.html, NEEDS_SOURCE.csv, clips/');
  U.log('='.repeat(60));
}

function saveResolved(id, resolved) {
  // _rawFile jaise internal fields chhod kar likho (clean)
  fs.writeFileSync(U.p(id, 'resolved.json'), JSON.stringify(resolved, null, 2));
}

main().catch(e => { U.bad('fatal: ' + e.message); process.exit(1); });
