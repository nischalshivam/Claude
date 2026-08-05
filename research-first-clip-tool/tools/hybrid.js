#!/usr/bin/env node
// ============================================================
//  HYBRID (M4) — "jo automatic nahi mila, wo insaan de dega" wala hissa.
//
//  Kyun: kuch footage public internet par hai hi nahi. Candace project mein
//  movie (P03) ke dono uploads mar chuke hain — 21 moments, ~162 second. Koi AI
//  us scene ka clip nahi bana sakta. Ab tak iska nateeja ye tha ki poori video
//  hi atak jati thi.
//
//  Ab: tool jo bana sakta hai wo bana deta hai (draft), baaki jagah ke liye
//  DATA folder mein saaf-saaf maang rakh deta hai, aur aapke daale hue media se
//  video poori kar deta hai.
//
//    node tools/hybrid.js status         kya-kya baaki hai
//    node tools/hybrid.js analyze        draft ke baad DATA folders (dobara) banao
//    node tools/hybrid.js ingest         DATA folder ki files check karo
//    node tools/hybrid.js draft          poora draft banao (placeholder ke saath)
//    node tools/hybrid.js final          final video (sirf jab sab bhar chuka ho)
// ============================================================
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const U = require(path.join(ROOT, 'src', 'util.js'));
const manual = require(path.join(ROOT, 'src', 'manual.js'));
// M4.2.1: status aur final ab WAHI evaluator poochte hain jo production gate
// poochta hai. Pehle ye sirf manual.scan() dekhta tha — yaani "sab taiyaar hai"
// bol deta tha aur turant baad gate critical approval par rok deta tha.
const readiness = require(path.join(ROOT, 'src', 'readiness.js'));

const DATA = path.join(ROOT, 'DATA');
const cmd = (process.argv[2] || 'status').toLowerCase();
const jobArg = process.argv.find(a => a.startsWith('--job=')) || '';
const line = (c = '=') => console.log(c.repeat(72));
const clock = t => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch {}

function runRfc(args) {
  const r = spawnSync('node', [path.join('src', 'run.js'), ...args],
    { cwd: ROOT, stdio: 'inherit', env: process.env, windowsHide: true });
  return r.status == null ? 1 : r.status;
}

function draftExists() {
  try {
    const jobs = path.join(ROOT, 'jobs');
    return fs.readdirSync(jobs).some(j =>
      ['gap-plan.json', 'draft.mp4', 'final.mp4'].some(f => fs.existsSync(path.join(jobs, j, f))));
  } catch { return false; }
}

function status() {
  line(); console.log('  HYBRID STATUS — kitna ban chuka, kitna baaki'); line();
  const ev = readiness.evaluate(DATA, manual, cfg, { draftExists: draftExists() });
  const s = manual.scan(DATA, { cfg });
  if (!s.requests.length) {
    console.log('  DATA folder mein koi request nahi hai.');
    console.log('');
    console.log('  Matlab do mein se ek baat hai:');
    console.log('   1. Draft abhi banaya hi nahi  -> node tools/hybrid.js draft');
    console.log('   2. Draft bana aur har jagah automatic media mil gaya (mubarak ho)');
    line();
    return 0;
  }
  const need = ev.requests.filter(r => r.blocking);
  console.log(`  ${ev.total} jagah aapke media ki zaroorat thi. ${ev.ready} ho chuki, ${need.length} baaki.`);
  console.log(`  ${ev.human}\n`);
  for (const r of ev.requests) {
    const mark = !r.blocking ? '[OK ]' : (r.media_status === 'SHORT' ? '[ADD]'
      : (r.approval_status === 'PENDING' || r.approval_status === 'EXPIRED' ? '[HAAN?]' : '[   ]'));
    console.log(`  ${mark} ${r.folder}`);
    console.log(`        ${clock(r.range.start_sec)} - ${clock(r.range.end_sec)}  (${r.range.duration_sec.toFixed(1)}s)  ${r.files.length} file`);
    if (r.media_status === 'EMPTY') console.log(`        "${String(r.narration_exact).slice(0, 68)}..."`);
    for (const x of r.reasons) console.log(`        ${x}`);
    for (const x of (r.notes || [])) console.log(`        (${x})`);
  }
  console.log('');
  if (!need.length) {
    console.log('  SAB TAIYAAR HAI — HYBRID_READY.');
    console.log('  Ab final video bana sakte ho:  node tools/hybrid.js final');
  } else {
    console.log('  Baaki jagah ke liye: DATA\\<folder>\\WHAT_IS_MISSING.txt kholo,');
    console.log('  usme likhe search words se media dhoondho, aur DATA\\<folder>\\media\\ mein daal do.');
  }
  line();
  return need.length ? 2 : 0;
}

function ingest() {
  line(); console.log('  INGEST — aapki di hui files check kar raha hoon'); line();
  const s = manual.scan(DATA, { cfg });
  if (!s.requests.length) { console.log('  DATA mein koi request nahi.'); line(); return 1; }
  let bad = 0, ok = 0;
  for (const r of s.requests) {
    console.log(`  ${r.folder}`);
    if (!r.files.length && !r.invalid.length) { console.log('     (abhi koi file nahi daali)'); continue; }
    for (const f of r.files) {
      ok++;
      const size = f.type === 'VIDEO' ? `${(f.duration || 0).toFixed(1)}s` : `${f.width}x${f.height}`;
      console.log(`     [ok] ${f.file.padEnd(30)} ${f.type.padEnd(6)} ${size}`);
      for (const w of f.warnings) console.log(`          note: ${w}`);
    }
    for (const b of r.invalid) { bad++; console.log(`     [NO] ${b.file.padEnd(30)} ${b.problem}`); }
    if (r.short_seconds > 0) console.log(`     [ADD] ${r.short_seconds}s aur chahiye`);
  }
  console.log('');
  console.log(`  ${ok} file theek hain, ${bad} nahi chal sakti.`);
  if (s.ready) console.log('  Sab jagah bhar chuki — node tools/hybrid.js final');
  line();
  return s.ready ? 0 : 2;
}

function analyze() {
  // Draft ke manifest se DATA folders dobara banao (bina render kiye).
  const jobs = U.jobsRoot();
  const job = jobArg ? jobArg.slice(6) : pickLatestJob(jobs);
  if (!job) { console.log('  [FAIL] koi job nahi mila — pehle draft banao: node tools/hybrid.js draft'); return 1; }
  const man = path.join(jobs, job, 'render-manifest.json');
  const gp = path.join(jobs, job, 'gap-plan.json');
  if (!fs.existsSync(gp)) { console.log(`  [FAIL] ${job} mein gap-plan.json nahi — pehle draft chalao.`); return 1; }
  const plan = JSON.parse(fs.readFileSync(gp, 'utf8'));
  const gapplan = require(path.join(ROOT, 'src', 'gapplan.js'));
  const w = gapplan.writeDataFolders(DATA, plan);
  line();
  console.log(`  ${plan.requests.length} request folders taiyaar (job: ${job}, manifest: ${fs.existsSync(man) ? 'mila' : 'nahi'})`);
  w.made.forEach(n => console.log('     DATA\\' + n));
  if (w.orphaned.length) console.log(`  ${w.orphaned.length} purane folder DATA\\_ORPHANED mein — aapki files surakshit hain.`);
  line();
  return 0;
}

function pickLatestJob(jobs) {
  if (!fs.existsSync(jobs)) return null;
  const cand = fs.readdirSync(jobs).filter(n => fs.existsSync(path.join(jobs, n, 'gap-plan.json')));
  if (!cand.length) return null;
  cand.sort((a, b) => fs.statSync(path.join(jobs, b, 'gap-plan.json')).mtimeMs - fs.statSync(path.join(jobs, a, 'gap-plan.json')).mtimeMs);
  return cand[0];
}

function draft() {
  line(); console.log('  DRAFT — poori video banao, khaali jagah par numbered placeholder'); line();
  console.log('  Ye ruk kar fail nahi hoti. Jahan media nahi mila wahan MISSING 001, 002 ...');
  console.log('  likha hua laal card aayega, aur uske liye DATA folder ban jayega.\n');
  return runRfc(['--draft', '--redo', ...(jobArg ? [jobArg] : [])]);
}

function final() {
  const ev = readiness.evaluate(DATA, manual, cfg, { draftExists: draftExists() });
  const need = ev.requests.filter(r => r.blocking);
  if (need.length) {
    line();
    console.log(`  [RUKA] ${need.length} jagah abhi taiyaar nahi — final ab nahi banegi.`);
    need.slice(0, 10).forEach(r => console.log(`     ${r.folder}  (${r.reasons.join(' · ')})`));
    console.log('');
    console.log('  node tools/hybrid.js status  se poori list dekho.');
    line();
    return 2;
  }
  line(); console.log('  FINAL — sab jagah media hai, poori video bana raha hoon'); line();
  return runRfc([...(jobArg ? [jobArg] : [])]);
}

const RC = { status, ingest, analyze, draft, final }[cmd];
if (!RC) {
  console.log('  usage: node tools/hybrid.js [status|analyze|ingest|draft|final]');
  process.exit(1);
}
process.exit(RC());
