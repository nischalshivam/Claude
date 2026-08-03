#!/usr/bin/env node
// ============================================================
//  REVIEW DASHBOARD — teeno preview ek saath.
//
//  Pehle har preview ka apna shot-review page tha, aur agar koi preview FAIL
//  ho jaye to uska page bana hi nahi — yaani sabse zaroori jaankari (kya toota)
//  kahin dikhti hi nahi thi.
//
//  Ye dashboard har job ka status ek jagah dikhata hai: bana ya nahi, kitna
//  exact, kitna udhaar, kaunse critical beats reh gaye — aur seedha link deta
//  hai shot-review ya blocked-report par.
//
//    node tools/review-dashboard.js
// ============================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const U = require(path.join(ROOT, 'src', 'util.js'));

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const jobsRoot = U.jobsRoot();
const WANT = [
  { id: 'preview_hook', label: 'Hook (shuruat)' },
  { id: 'preview_mid', label: 'Beech se' },
  { id: 'preview_weak', label: 'Kamzor hissa' },
];

function readJob(id) {
  const dir = path.join(jobsRoot, id);
  if (!fs.existsSync(dir)) return { id, exists: false };
  const rd = f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } };
  const res = rd('job-result.json');
  const man = rd('render-manifest.json');
  const mix = {};
  let total = 0;
  for (const s of ((man && man.shots) || [])) { mix[s.asset] = (mix[s.asset] || 0) + (s.dur || 0); total += s.dur || 0; }
  const badRel = ((man && man.shots) || []).filter(s => s.scope_relation && !['SAME_EPISODE', 'GRAPHIC', 'NONE'].includes(s.scope_relation));
  return {
    id, exists: true, dir,
    status: res ? res.status : (fs.existsSync(path.join(dir, 'final.mp4')) ? 'SUCCESS' : 'UNKNOWN'),
    message: res ? res.message : '',
    critical: res ? (res.critical_unresolved || []) : [],
    repair: res ? (res.repair || []).length : 0,
    shots: ((man && man.shots) || []).length, total,
    mix, badRel: badRel.length,
    hasReview: fs.existsSync(path.join(dir, 'shot-review.html')),
    hasBlocked: fs.existsSync(path.join(dir, 'blocked-report.html')),
    hasCsv: fs.existsSync(path.join(dir, 'NEEDS_SOURCE.csv')),
  };
}

const COL = { EXACT_VIDEO: '#2f9e44', CONTEXT_VIDEO: '#1971c2', VERIFIED_SOURCE_STILL: '#5f3dc4',
  MONTAGE: '#0c8599', TEMPLATE_GRAPHIC_MEDIA: '#e8590c', GENERIC_TEXT_GRAPHIC: '#c92a2a',
  DIAGNOSTIC_CARD: '#c92a2a', RENDER_FAILURE_FALLBACK: '#c92a2a' };

const jobs = WANT.map(w => ({ ...w, ...readJob(w.id) }));
const allOk = jobs.every(j => j.exists && j.status === 'SUCCESS' && !j.critical.length && !j.badRel);

const cards = jobs.map(j => {
  if (!j.exists) return `<div class="card"><h2>${esc(j.label)}</h2><p class="muted">abhi chalaya nahi gaya — START_HERE mein iska option chalao.</p></div>`;
  const bar = Object.entries(j.mix).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<span style="flex:${v};background:${COL[k] || '#495057'}" title="${esc(k)} ${(v / (j.total || 1) * 100).toFixed(1)}%"></span>`).join('');
  const legend = Object.entries(j.mix).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<span class="lg"><i style="background:${COL[k] || '#495057'}"></i>${esc(k.replace(/_/g, ' ').toLowerCase())} ${(v / (j.total || 1) * 100).toFixed(0)}%</span>`).join('');
  return `<div class="card">
  <h2>${esc(j.label)} <span class="badge ${esc(j.status)}">${esc(j.status)}</span></h2>
  ${j.shots ? `<div class="bar">${bar}</div><div class="lgs">${legend}</div>
  <p class="muted">${j.shots} shots · ${Math.round(j.total)}s</p>` : '<p class="muted">koi shot render nahi hua</p>'}
  ${j.critical.length ? `<p class="bad">${j.critical.length} CRITICAL beats ke paas exact evidence nahi: ${esc(j.critical.slice(0, 5).join(', '))}</p>` : ''}
  ${j.badRel ? `<p class="bad">${j.badRel} shots doosre episode/show se udhaar liye gaye</p>` : ''}
  ${j.repair ? `<p class="warn">${j.repair} moments ko research chahiye</p>` : ''}
  ${j.message ? `<p class="muted">${esc(j.message.slice(0, 200))}</p>` : ''}
  <p>${j.hasReview ? `<a href="${esc(j.id)}/shot-review.html">shot review kholo</a>` : ''}
     ${j.hasBlocked ? `<a href="${esc(j.id)}/blocked-report.html">kya toota hai</a>` : ''}
     ${j.hasCsv ? `<a href="${esc(j.id)}/NEEDS_SOURCE.csv">repair CSV</a>` : ''}</p>
</div>`;
}).join('\n');

const html = `<meta charset="utf-8"><title>Preview review dashboard</title>
<style>
body{font:14px/1.55 system-ui,Segoe UI,sans-serif;background:#0f1115;color:#e6e9ef;margin:0;padding:22px;max-width:1100px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:0 0 10px}
.verdict{padding:12px 16px;border-radius:9px;margin:14px 0;font-weight:600}
.go{background:#12351d;color:#8ce99a;border:1px solid #2f9e44}
.stop{background:#33161a;color:#ffc9c9;border:1px solid #c92a2a}
.card{background:#161b24;border:1px solid #232b39;border-radius:10px;padding:14px 16px;margin:12px 0}
.badge{font-size:10.5px;font-weight:700;padding:3px 8px;border-radius:5px;vertical-align:2px}
.SUCCESS{background:#2f9e44}.FAILED,.BLOCKED{background:#c92a2a}.UNKNOWN{background:#666}
.bar{display:flex;height:9px;border-radius:5px;overflow:hidden;margin:6px 0}
.lgs{margin:6px 0}
.lg{display:inline-flex;align-items:center;gap:5px;margin-right:12px;font-size:11px;color:#8b95a5}
.lg i{width:10px;height:10px;border-radius:3px}
.muted{color:#8b95a5;font-size:12px;margin:6px 0}
.bad{color:#ffa8a8;font-size:12.5px;margin:6px 0}
.warn{color:#ffd43b;font-size:12.5px;margin:6px 0}
a{color:#74c0fc;margin-right:14px;font-size:12.5px}
</style>
<h1>Preview review dashboard</h1>
<div class="muted">${esc(new Date().toLocaleString())}</div>
<div class="verdict ${allOk ? 'go' : 'stop'}">
  ${allOk
    ? 'Teeno preview bane, koi critical beat khaali nahi, koi galat-episode footage nahi. Ab poora render (option 8) chalaya ja sakta hai.'
    : 'Abhi poora render mat chalao. Neeche jo lal mein hai wo pehle theek karo — 45 minute ka render usi problem ko badi shakl mein dohrayega.'}
</div>
${cards}
<div class="card"><h2>Ye page kyun hai</h2>
<p class="muted">Percentages ye nahi bata sakte ki screen par sahi character hai ya nahi. Har preview ka
"shot review" kholo aur thumbnails par ek nazar daalo — 2 minute lagte hain. Jo shot galat lage
uspar tick lagao aur CSV nikaal lo; sirf un moments ki research dobara karani hogi.</p></div>`;

const out = path.join(jobsRoot, 'review-dashboard.html');
fs.mkdirSync(jobsRoot, { recursive: true });
fs.writeFileSync(out, html);
console.log('='.repeat(60));
for (const j of jobs) {
  const line = j.exists ? `${j.status.padEnd(8)} ${j.shots} shots${j.critical.length ? `, ${j.critical.length} CRITICAL khaali` : ''}${j.badRel ? `, ${j.badRel} udhaar shots` : ''}`
    : 'abhi chalaya nahi gaya';
  console.log(`  ${j.label.padEnd(18)} ${line}`);
}
console.log('='.repeat(60));
console.log(allOk ? '  Teeno preview theek hain — option 8 (poora render) chala sakte ho.'
                  : '  Abhi option 8 mat chalao. Dashboard mein lal wali cheezein pehle theek karo.');
console.log(`  ${path.relative(ROOT, out)}`);
console.log('='.repeat(60));
process.exit(allOk ? 0 : 2);
