#!/usr/bin/env node
// ============================================================
//  PRINT-JOB-RESULT (M4.2) — sirf WOHI batao jo sach mein bana.
//
//  Kyun: draft ke baad launcher likh deta tha "jobs\ folder mein final.mp4 aur
//  shot-review.html dekho" — jabki dono files thi hi nahi. Ye exit code se
//  natija guess karta tha. Ab natija job-result.json + disk se aata hai.
//
//    node tools/print-job-result.js --expect=draft   [--job=<id>]
//    node tools/print-job-result.js --expect=final
//  Exit: 0 = jo expect kiya wo bana | 2 = insaan ka kaam baaki | 1 = fail
// ============================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const U = require(path.join(ROOT, 'src', 'util.js'));

const arg = (n, d = null) => { const a = process.argv.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const expect = (arg('expect', 'final') || 'final').toLowerCase();
const jobsRoot = U.jobsRoot();
const line = (c = '=') => console.log('  ' + c.repeat(58));

function latestJob() {
  if (!fs.existsSync(jobsRoot)) return null;
  const cand = fs.readdirSync(jobsRoot).filter(n => fs.existsSync(path.join(jobsRoot, n, 'job-result.json')));
  if (!cand.length) return null;
  cand.sort((a, b) => fs.statSync(path.join(jobsRoot, b, 'job-result.json')).mtimeMs
                    - fs.statSync(path.join(jobsRoot, a, 'job-result.json')).mtimeMs);
  return cand[0];
}
const job = arg('job') || latestJob();
if (!job) { console.log('  (koi job result nahi mila)'); process.exit(1); }
const dir = path.join(jobsRoot, job);
let jr = null; try { jr = JSON.parse(fs.readFileSync(path.join(dir, 'job-result.json'), 'utf8')); } catch {}
if (!jr) { console.log('  (job-result.json padha nahi ja saka)'); process.exit(1); }

const has = f => fs.existsSync(path.join(dir, f));
const want = expect === 'draft' ? 'draft.mp4' : 'final.mp4';
const madeIt = has(want);
const rel = f => `jobs\\${job}\\${f}`;

console.log('');
line();
if (madeIt && jr.status === 'SUCCESS') {
  console.log(`  [OK] ${want} ban gayi.`);
} else if (madeIt && jr.status === 'DRAFT_NEEDS_HUMAN') {
  console.log(`  [OK] ${want} poori ban gayi — par ye DRAFT hai, final nahi.`);
} else {
  console.log(`  [RUKA] ${want} nahi bani.`);
}
line();
if (jr.message) console.log('  ' + jr.message);

// SIRF wahi files jo sach mein disk par hain
const showList = ['draft.mp4', 'final.mp4', 'shot-review.html', 'quality-report.html',
  'blocked-report.html', 'NEEDS_SOURCE.csv', 'gap-plan.json', 'run.log'].filter(has);
if (showList.length) {
  console.log('');
  console.log('  Ye files sach mein bani hain:');
  for (const f of showList) console.log('     ' + rel(f));
}

// gap plan se agla kaam
let gp = null; try { gp = JSON.parse(fs.readFileSync(path.join(dir, 'gap-plan.json'), 'utf8')); } catch {}
if (gp && gp.requests && gp.requests.length) {
  console.log('');
  console.log(`  ${gp.requests.length} jagah aapka media chahiye (${gp.missing_seconds}s).`);
  console.log('  Aage kya karna hai:');
  console.log('     1. DATA\\ folder kholo — har jagah ka apna folder hai');
  console.log('     2. WHAT_IS_MISSING.txt padho, media\\ mein files daalo');
  console.log('     3. Zaroori beats par APPROVE_MEDIA.txt bhi banao');
  console.log('     4. Ya dashboard se: START_UI.bat');
} else if ((jr.critical_unresolved || []).length) {
  console.log('');
  console.log(`  ${jr.critical_unresolved.length} zaroori beats abhi khaali hain: ${jr.critical_unresolved.slice(0, 6).join(', ')}`);
}
line();
process.exit(madeIt ? (jr.status === 'SUCCESS' ? 0 : 2) : 1);
