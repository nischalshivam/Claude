// ============================================================
//  JOB RESULT — har run ka sach, chahe wo fail hi kyun na ho.
//
//  Asli run mein ye hua tha: weak preview ka render fail hua, error ne kaha
//  "NEEDS_SOURCE.csv dekho" — par wo file bani hi nahi thi, kyunki report stage
//  render ke BAAD chalta hai. User ke paas na video thi, na koi repair file,
//  aur launcher ne upar se "Ho gaya" bhi likh diya.
//
//  Ab har job — SUCCESS, FAILED ya BLOCKED — ye chhodta hai:
//    job-result.json      status + kya bana + kya nahi bana + kya karna hai
//    NEEDS_SOURCE.csv     jin moments ko research chahiye (fail par bhi)
//    blocked-report.html  padhne layak version, exact repair list ke saath
// ============================================================
const fs = require('fs');
const path = require('path');
const U = require('./util.js');

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const csvCell = s => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;

// jin moments par kaam chahiye — resolved.json + timeline dono se
function repairList(resolved, tl) {
  const out = [];
  for (const e of (resolved || [])) {
    const st = e.status;
    if (st === 'RESOLVED') continue;
    let need = 'locator ya frame_hints chahiye';
    if (st === 'NEEDS_REVIEW') need = 'dialogue/alignment kamzor hai — cue ya dialogue theek karao';
    else if (st === 'NEEDS_SOURCE') need = (e.candidates && e.candidates.length)
      ? 'source mila par download/cut fail — naya URL do' : 'koi usable locator nahi — locator ya frame_hints do';
    else if (st === 'FALLBACK_GRAPHIC') need = 'sirf text plan hai — frame_hints do taaki asli frame par text aaye';
    out.push({
      moment_id: e.moment_id, pack_id: e.pack_id, status: st,
      criticality: e.criticality || 'NORMAL',
      planned_source: e.source_id || (e.locator_source_ids || [])[0] || '',
      reason: String(e.reason || e.review_reason || '').slice(0, 160),
      cue: String(e.script_cue_exact || '').slice(0, 120),
      need,
    });
  }
  // timeline ke wo slots jinke paas media hai hi nahi (render inhi par rukta hai)
  for (const s of ((tl && tl.slots) || [])) {
    if (s.asset !== 'GENERIC_TEXT_GRAPHIC' && s.asset !== 'LOW_CONFIDENCE_FALLBACK') continue;
    if (out.some(o => o.moment_id === s.moment_id)) continue;
    out.push({ moment_id: s.moment_id, pack_id: s.pack_id, status: 'NO_MEDIA_PLANNED',
      criticality: 'NORMAL', planned_source: s.source_id || '', reason: 'is beat ke liye koi media plan nahi tha',
      cue: String(s.cue || '').slice(0, 120), need: 'allowed_pack_ids + frame_hints do' });
  }
  return out;
}

function writeCsv(id, rows) {
  const head = ['moment_id', 'pack_id', 'status', 'criticality', 'planned_source', 'kya_chahiye', 'wajah', 'narration'];
  const lines = [head.join(',')];
  for (const r of rows) lines.push([r.moment_id, r.pack_id, r.status, r.criticality, r.planned_source, r.need, r.reason, r.cue].map(csvCell).join(','));
  fs.writeFileSync(U.p(id, 'NEEDS_SOURCE.csv'), lines.join('\n'));
}

function writeHtml(id, res) {
  const rows = res.repair.map(r => `<tr class="${r.criticality === 'HOOK' || r.criticality === 'HARD_EVIDENCE' ? 'crit' : ''}">
    <td><b>${esc(r.moment_id)}</b><div class="s">${esc(r.pack_id)}</div></td>
    <td>${esc(r.status)}${r.criticality !== 'NORMAL' ? `<div class="s crit">${esc(r.criticality)}</div>` : ''}</td>
    <td>${esc(r.need)}<div class="s">${esc(r.reason)}</div></td>
    <td class="cue">${esc(r.cue)}</td></tr>`).join('\n');
  const html = `<meta charset="utf-8"><title>${esc(res.status)} — ${esc(id)}</title>
<style>
body{font:14px/1.5 system-ui,Segoe UI,sans-serif;background:#0f1115;color:#e6e9ef;margin:0;padding:20px}
h1{font-size:19px;margin:0 0 4px}
.badge{display:inline-block;padding:4px 12px;border-radius:6px;font-weight:700;font-size:12px;letter-spacing:.5px}
.FAILED,.BLOCKED{background:#c92a2a;color:#fff}.SUCCESS{background:#2f9e44;color:#fff}
.box{background:#161b24;border:1px solid #232b39;border-radius:9px;padding:14px 16px;margin:14px 0}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #232b39;vertical-align:top}
th{color:#8b95a5;font-weight:600;font-size:11px;letter-spacing:.4px;text-transform:uppercase}
tr.crit td{background:#2a1416}
.s{font-size:11px;color:#8b95a5;margin-top:2px}
.crit{color:#ff8787}
.cue{color:#aab3c2;max-width:420px}
code{background:#0b0e14;padding:2px 6px;border-radius:4px;color:#74c0fc}
li{margin:4px 0}
</style>
<h1>${esc(id)} — <span class="badge ${esc(res.status)}">${esc(res.status)}</span></h1>
<div class="s">${esc(res.generated_at)}</div>
<div class="box"><b>Kya hua</b><br>${esc(res.message)}</div>
<div class="box"><b>Ab kya karna hai</b><ol>${res.next_steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol></div>
<div class="box"><b>Kya bana</b><br>${res.artifacts.length ? res.artifacts.map(a => `<code>${esc(a)}</code>`).join(' ') : '<i>kuch nahi</i>'}
${res.missing.length ? `<br><br><b>Kya nahi bana</b><br>${res.missing.map(a => `<code>${esc(a)}</code>`).join(' ')}` : ''}</div>
${res.repair.length ? `<div class="box"><b>${res.repair.length} moments ko kaam chahiye</b> — yahi <code>NEEDS_SOURCE.csv</code> mein bhi hai
<table><tr><th>moment</th><th>status</th><th>kya chahiye</th><th>narration</th></tr>${rows}</table></div>` : ''}`;
  fs.writeFileSync(U.p(id, 'blocked-report.html'), html);
}

// status: SUCCESS | FAILED | BLOCKED
module.exports = function jobResult(spec, st, { status, message, stage = null, resolved = null, tl = null, nextSteps = [], blockedReason = null }) {
  const id = spec.id;
  U.ensureDir(U.jobDir(id));   // gate se pehle bhi call ho sakta hai
  const want = ['final.mp4', 'shot-review.html', 'quality-report.html', 'NEEDS_SOURCE.csv', 'timeline.json', 'resolved.json', 'run.log'];
  const artifacts = [], missing = [];
  for (const f of want) (fs.existsSync(U.p(id, f)) ? artifacts : missing).push(f);

  const repair = repairList(resolved, tl);
  const res = {
    schema: 'job-result-v1', job: id, status, stage, message, blocked_reason: blockedReason,
    generated_at: new Date().toISOString(),
    is_preview: !!spec.isPreview,
    preview_offset: spec.previewOffset || 0,
    artifacts, missing,
    counts: {
      moments: (resolved || []).length,
      resolved: (resolved || []).filter(e => e.status === 'RESOLVED').length,
      needs_review: (resolved || []).filter(e => e.status === 'NEEDS_REVIEW').length,
      needs_source: (resolved || []).filter(e => e.status === 'NEEDS_SOURCE').length,
      shots: ((tl && tl.slots) || []).length,
      repair_items: repair.length,
    },
    critical_unresolved: repair.filter(r => r.criticality === 'HOOK' || r.criticality === 'HARD_EVIDENCE').map(r => r.moment_id),
    next_steps: nextSteps.length ? nextSteps : (status === 'SUCCESS'
      ? [`jobs/${id}/shot-review.html kholo aur har shot dekho`]
      : ['NEEDS_SOURCE.csv kholo — usme har moment ke aage likha hai ki kya chahiye',
         'Stage-2 prompt banao (START_HERE option 3) aur wo moments theek karao',
         'phir option 2 (pack check) aur uske baad yahi preview dobara chalao']),
    repair,
  };

  // CSV pehle likho — HTML usme se link karta hai, aur render fail hone par bhi
  // user ke paas ek actionable file honi chahiye.
  try { writeCsv(id, repair); if (!artifacts.includes('NEEDS_SOURCE.csv')) { artifacts.push('NEEDS_SOURCE.csv'); res.missing = missing.filter(m => m !== 'NEEDS_SOURCE.csv'); } } catch (e) { U.warn('CSV likhne mein dikkat: ' + e.message.slice(0, 60)); }
  try { writeHtml(id, res); } catch (e) { U.warn('report likhne mein dikkat: ' + e.message.slice(0, 60)); }
  fs.writeFileSync(U.p(id, 'job-result.json'), JSON.stringify(res, null, 2));
  if (st && st.meta) st.meta.job_result = { status, stage, repair_items: repair.length };
  return res;
};
