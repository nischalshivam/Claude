// ============================================================
//  Stage 9 — REPORT. quality-report.html + NEEDS_SOURCE.csv
//  Har moment ki: thumbnail, narration cue, source, timestamps, locator,
//  decision, score/recall, QA flags, reason. Taaki har faisla transparent ho.
//  NEEDS_SOURCE.csv: sirf fail moments — user wahi replace kare, poora dobara nahi.
// ============================================================
const fs = require('fs');
const path = require('path');
const U = require('./util.js');

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const csvCell = s => `"${String(s == null ? '' : s).replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;

const DEC_COLOR = { RESOLVED: '#1f9d55', NEEDS_REVIEW: '#b7791f', NEEDS_SOURCE: '#e3342f', FALLBACK_GRAPHIC: '#3182ce' };

// thumbnail ko base64 data-URI banate hain -> report.html poori tarah
// self-contained (kahin bhi khulti hai, share ho sakti hai).
function thumb(id, clipRel, momentId) {
  const src = U.p(id, clipRel);
  if (!fs.existsSync(src)) return null;
  const dir = U.ensureDir(U.p(id, 'thumbs'));
  const out = path.join(dir, `${momentId}.jpg`);
  const pr = U.probe(src);
  const mid = pr.ok ? pr.duration / 2 : 0.5;
  const r = U.ffmpeg(['-ss', mid.toFixed(2), '-i', src, '-frames:v', '1', '-vf', 'scale=320:-2', out]);
  if (!r.ok || !fs.existsSync(out)) return null;
  try { return 'data:image/jpeg;base64,' + fs.readFileSync(out).toString('base64'); } catch { return null; }
}

// M2.1: metrics AB RENDER MANIFEST se aate hain (jo sach mein render hua),
// pre-render timeline se nahi. Aur har class alag ginī jaati hai — full-screen
// text graphic ko "0% cards" mein chhupaya NAHI jaata.
function visualMix(id, tl) {
  let shots = null, total = 0;
  const mf = U.p(id, 'render-manifest.json');
  if (fs.existsSync(mf)) {
    try { const m = JSON.parse(fs.readFileSync(mf, 'utf8')); shots = m.shots; total = m.total; } catch {}
  }
  if (!shots) { if (!tl || !tl.slots) return null; shots = tl.slots; total = tl.total; }   // fallback (render se pehle)
  const by = {};
  for (const s of shots) { const k = s.asset || s.kind; by[k] = (by[k] || 0) + (s.dur || 0); }
  total = total || Object.values(by).reduce((a, b) => a + b, 0) || 1;
  const g = k => by[k] || 0;
  const pct = v => Math.round(v / total * 1000) / 10;
  const media = g('EXACT_VIDEO') + g('CONTEXT_VIDEO') + g('VERIFIED_SOURCE_STILL') + g('VERIFIED_WEB_IMAGE') + g('MONTAGE') + g('TEMPLATE_GRAPHIC_MEDIA');
  return {
    total, by, fromManifest: fs.existsSync(mf),
    video: pct(g('EXACT_VIDEO') + g('CONTEXT_VIDEO')),
    still: pct(g('VERIFIED_SOURCE_STILL')),
    montage: pct(g('MONTAGE')),
    graphicMedia: pct(g('TEMPLATE_GRAPHIC_MEDIA')),
    genericText: pct(g('GENERIC_TEXT_GRAPHIC') + g('EDITORIAL_GRAPHIC') + g('text')),
    cards: pct(g('LOW_CONFIDENCE_FALLBACK') + g('needs_source') + g('needs_review')),
    renderFail: pct(g('RENDER_FAILURE_FALLBACK')),
    mediaTotal: pct(media),
  };
}

module.exports = function report(spec, cfg, st, resolved, tl) {
  const id = spec.id;

  // ---- NEEDS_SOURCE.csv (fail + review moments, status column ke sath) ----
  const actionable = resolved.filter(e => e.status === 'NEEDS_SOURCE' || e.status === 'NEEDS_REVIEW');
  const csv = ['status,moment_id,pack_id,script_cue_exact,reason,attempts'];
  for (const e of actionable) {
    const att = (e.attempts || []).map(a => `${a.type}/${a.source_id || ''}:${a.result}`).join(' | ');
    csv.push([csvCell(e.status), csvCell(e.moment_id), csvCell(e.pack_id), csvCell(e.script_cue_exact), csvCell(e.reason || e.review_reason), csvCell(att)].join(','));
  }
  fs.writeFileSync(U.p(id, 'NEEDS_SOURCE.csv'), csv.join('\n'));

  // ---- counts (honest: sirf status RESOLVED = clean accept jo final mein gaya) ----
  const n = { total: resolved.length, resolved: 0, review: 0, graphic: 0, needs: 0 };
  for (const e of resolved) {
    if (e.status === 'RESOLVED' && e.clip) n.resolved++;
    else if (e.status === 'NEEDS_REVIEW') n.review++;
    else if (e.status === 'FALLBACK_GRAPHIC') n.graphic++;
    else n.needs++;   // NEEDS_SOURCE (aur koi bhi RESOLVED bina clip)
  }

  const mix = visualMix(id, tl);

  // ---- HTML rows ----
  const rows = resolved.map(e => {
    const clipRel = e.clip || e.review_clip;
    const th = clipRel ? thumb(id, clipRel, e.moment_id) : null;
    const dec = e.status;
    const color = DEC_COLOR[dec] || '#666';
    const src = e.url ? `<a href="${esc(e.url)}" target="_blank">${esc((e.url).slice(0, 48))}</a>` : (e.local_file ? esc(path.basename(e.local_file)) : '—');
    const ts = e.cut ? `${e.cut.start}s → ${e.cut.end}s (${e.cut.dur}s)` : '—';
    const sc = e.score != null ? `score ${e.score}${e.recall != null ? ' / recall ' + e.recall : ''}` : '';
    const qaFlags = e.qa && e.qa.flags && e.qa.flags.length ? `<div class="qa">QA: ${esc(e.qa.flags.join(', '))}</div>` : '';
    return `<tr>
      <td>${th ? `<img src="${th}" loading="lazy">` : `<div class="nothumb">${esc(e.kind || dec)}</div>`}</td>
      <td><div class="cue">${esc(e.script_cue_exact)}</div>
          <div class="meta">${esc(e.moment_id)} · ${esc(e.pack_id)} · align ${esc(e.align_flag)} (${(e.align_score||0).toFixed(2)})</div>
          ${e.must_show && e.must_show.length ? `<div class="must">must show: ${esc(e.must_show.join(', '))}</div>` : ''}</td>
      <td><span class="badge" style="background:${color}">${esc(dec)}</span>
          <div class="loc">${esc(e.locator_type || '—')}</div>
          <div class="meta">${esc(sc)}</div></td>
      <td>${src}<div class="meta">${esc(ts)}</div></td>
      <td class="reason">${esc(e.reason || '')}${e.review_reason ? `<div class="qa">held out: ${esc(e.review_reason)}</div>` : ''}${qaFlags}</td>
    </tr>`;
  }).join('\n');

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Quality Report — ${esc(spec.pack.project_title || id)}</title>
<style>
body{font-family:system-ui,Segoe UI,Arial,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:24px}
h1{font-size:20px;margin:0 0 4px} .sub{color:#8a94a6;margin-bottom:16px;font-size:13px}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}
.card{background:#1a1e27;border:1px solid #232833;border-radius:10px;padding:12px 16px;min-width:120px}
.card b{font-size:22px;display:block} .card span{color:#8a94a6;font-size:12px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:10px;border-bottom:1px solid #232833;vertical-align:top}
th{color:#8a94a6;font-weight:600;position:sticky;top:0;background:#0f1115}
img{width:200px;border-radius:6px;display:block}
.nothumb{width:200px;height:112px;display:flex;align-items:center;justify-content:center;background:#232833;border-radius:6px;color:#8a94a6;font-size:12px;text-transform:uppercase}
.cue{font-weight:600;margin-bottom:4px} .meta{color:#8a94a6;font-size:11px} .must{color:#9ae6b4;font-size:11px;margin-top:3px}
.badge{color:#fff;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700}
.loc{color:#cbd5e0;font-size:11px;margin-top:4px} .reason{color:#cbd5e0;max-width:340px} .qa{color:#f6ad55;margin-top:4px;font-size:11px}
a{color:#63b3ed}
</style></head><body>
<h1>Quality Report — ${esc(spec.pack.project_title || id)}</h1>
<div class="sub">M2 zero-card engine (deterministic, no API). Har second par asli visual: clip, verified-source still, ya designed graphic. Diagnostic cards sirf review mode mein.</div>
${mix ? `<div class="cards">
  <div class="card"><b style="color:${mix.mediaTotal >= 85 ? '#1f9d55' : '#b7791f'}">${mix.mediaTotal}%</b><span>MEDIA-BACKED total (target &ge;85%)</span></div>
  <div class="card"><b style="color:#1f9d55">${mix.video}%</b><span>video</span></div>
  <div class="card"><b style="color:#63b3ed">${mix.still}%</b><span>verified stills</span></div>
  <div class="card"><b style="color:#4fd1c5">${mix.montage}%</b><span>montage</span></div>
  <div class="card"><b style="color:#9f7aea">${mix.graphicMedia}%</b><span>graphic over media</span></div>
  <div class="card"><b style="color:${mix.genericText > 15 ? '#e3342f' : '#b7791f'}">${mix.genericText}%</b><span>GENERIC full-screen text (target &le;15%)</span></div>
  <div class="card"><b style="color:${mix.cards > 0 ? '#e3342f' : '#1f9d55'}">${mix.cards}%</b><span>diagnostic cards</span></div>
  <div class="card"><b style="color:${mix.renderFail > 0 ? '#e3342f' : '#1f9d55'}">${mix.renderFail}%</b><span>render failures</span></div>
</div>
<div class="sub">Metrics ${mix.fromManifest ? '<b>render manifest</b> se (jo sach mein render hua)' : 'pre-render timeline se (render abhi baaki)'} — full-screen text graphic ko cards mein chhupaya nahi gaya.</div>` : ''}
<div class="cards">
  <div class="card"><b>${n.total}</b><span>moments</span></div>
  <div class="card"><b style="color:#1f9d55">${n.resolved}</b><span>RESOLVED (in final)</span></div>
  <div class="card"><b style="color:#b7791f">${n.review}</b><span>NEEDS_REVIEW</span></div>
  <div class="card"><b style="color:#3182ce">${n.graphic}</b><span>graphic/text</span></div>
  <div class="card"><b style="color:#e3342f">${n.needs}</b><span>NEEDS_SOURCE</span></div>
</div>
<table><thead><tr><th>Clip</th><th>Narration cue</th><th>Decision</th><th>Source · time</th><th>Reason / QA</th></tr></thead>
<tbody>${rows}</tbody></table>
</body></html>`;
  fs.writeFileSync(U.p(id, 'quality-report.html'), html);

  U.ok(`report: quality-report.html (${n.resolved} resolved, ${n.review} review, ${n.needs} NEEDS_SOURCE) + NEEDS_SOURCE.csv`);
  st.meta.report = n;
  return n;
};
