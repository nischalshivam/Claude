// ============================================================
//  M5.0-A UI — single-page, no build step.
//  Ek usool: readiness/state kabhi yahan calculate nahi hote. Server ka
//  PROJECT_STATE hi sach hai; ye page use dikhata hai.
// ============================================================
'use strict';
const TOKEN = (window.__RFC__ || {}).token;
const $ = (s, r = document) => r.querySelector(s);
const el = (t, a = {}, ...kids) => { const n = document.createElement(t);
  for (const k in a) { const v = a[k];
    if (v == null || v === false) continue;                 // null/undefined/false attr = skip (warna disabled=null bhi disable kar deta)
    if (k === 'class') n.className = v; else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); }
  for (const c of kids) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c)); return n; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clock = t => { t = Math.max(0, t || 0); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`; };

async function api(pathname, opts = {}) {
  const sep = pathname.includes('?') ? '&' : '?';
  const r = await fetch(`/api/v1${pathname}${sep}token=${TOKEN}`, {
    ...opts, headers: { 'x-rfc-token': TOKEN, ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) } });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  return { ok: r.ok, status: r.status, data };
}
const mediaUrl = token => `/api/v1/media/${token}?token=${TOKEN}`;
const thumbUrl = (token, t = 0) => `/api/v1/thumb/${token}?t=${t}&token=${TOKEN}`;

function toast(msg, kind = '') { const t = $('#toast'); t.innerHTML = ''; t.append(el('div', { class: `toast ${kind}` }, msg));
  setTimeout(() => { t.innerHTML = ''; }, kind === 'bad' ? 6000 : 3500); }

const STATE_CLASS = {
  NO_INPUTS: 'bad', INPUTS_INVALID: 'bad', READY_TO_RESEARCH: 'warn', READY_TO_DRAFT: 'info',
  DRAFT_RUNNING: 'info', NO_DRAFT: 'warn', NEEDS_MEDIA: 'warn', NEEDS_MORE_MEDIA: 'warn',
  NEEDS_CRITICAL_APPROVAL: 'bad', READY_FOR_CONTENT_REVIEW: 'ok', CONTENT_LOCKED: 'ok',
  STYLE_READY: 'ok', EXPORT_RUNNING: 'info', EXPORT_FAILED: 'bad', FINAL_READY: 'ok',
};
const badgeColor = { ok: '#12351d;#8ce99a;#2f9e44', warn: '#33280f;#ffd8a8;#e8590c', bad: '#33161a;#ffc9c9;#c92a2a', info: '#12283f;#9ecbff;#2f7de1' };

let STATE = null;
let VIEW = 'overview';

async function refreshState() {
  const { data } = await api('/state');
  STATE = data;
  const b = $('#stateBadge');
  b.textContent = data.state;
  const c = STATE_CLASS[data.state] || 'info';
  const [bg, fg, br] = badgeColor[c].split(';');
  b.style.background = bg; b.style.color = fg; b.style.borderColor = br;
  $('#btnFinal').disabled = !data.can_export;
  $('#btnDraft').disabled = !!(data.job && data.job.running);
  return data;
}

// ---------------- OVERVIEW ----------------
function viewOverview() {
  const m = $('#main'); m.className = ''; m.innerHTML = '';
  const s = STATE || {};
  m.append(el('h2', {}, 'Overview'));
  m.append(el('p', { class: 'sub' }, s.human || 'Project ki haalat'));

  const kv = (k, v, cls) => el('div', { class: 'kv' }, el('span', { class: 'k' }, k),
    cls ? el('span', { class: 'pill ' + cls }, v) : el('span', {}, String(v)));

  const inp = s.inputs || {};
  const c1 = el('div', { class: 'card' },
    el('h3', { style: 'margin:0 0 8px' }, 'Inputs'),
    kv('research pack', inp.pack ? 'mila' : 'NAHI mila', inp.pack ? 'ok' : 'bad'),
    kv('voiceover SRT', inp.srt ? 'mila' : 'NAHI mila', inp.srt ? 'ok' : 'bad'),
    kv('voiceover audio', inp.audio ? 'mila' : 'nahi', inp.audio ? 'ok' : 'warn'),
    kv('pack valid', inp.inputs_valid === null ? '—' : (inp.inputs_valid ? 'haan' : 'nahi'), inp.inputs_valid ? 'ok' : (inp.inputs_valid === false ? 'bad' : 'info')),
    kv('pack check taaza', inp.pack_checked ? 'haan' : 'nahi', inp.pack_checked ? 'ok' : 'warn'));

  const tb = s.timebase;
  const c2 = el('div', { class: 'card' }, el('h3', { style: 'margin:0 0 8px' }, 'Timebase (audio hi sach)'),
    tb ? el('div', {},
      kv('voiceover', tb.audio != null ? tb.audio.toFixed(1) + 's' : '—'),
      kv('SRT end', tb.srt_end != null ? tb.srt_end.toFixed(1) + 's' : '—'),
      kv('project duration', tb.project_duration != null ? tb.project_duration.toFixed(1) + 's' : '—'),
      kv('correction', tb.correction || '—', tb.ok ? 'ok' : 'bad'),
      tb.reason ? el('p', { class: 'note' }, tb.reason) : null)
    : el('p', { class: 'muted' }, 'inputs aane par dikhega'));

  const art = s.artifacts || {};
  const artRow = (k, ok) => kv(k, ok ? 'hai' : 'nahi', ok ? 'ok' : 'info');
  const c3 = el('div', { class: 'card' }, el('h3', { style: 'margin:0 0 8px' }, 'Artifacts (job: ' + (s.job_id || '—') + ')'),
    artRow('draft.mp4', art.draft), artRow('final.mp4', art.final), artRow('gap-plan', art.gap_plan),
    artRow('timeline', art.timeline), artRow('render-manifest', art.manifest), artRow('shot-review', art.shot_review),
    el('div', { class: 'kv' }, el('span', { class: 'k' }, 'requests / blocking'), el('span', {}, `${s.total_requests || 0} / ${s.blocking || 0}`)));

  m.append(el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px' }, c1, c2, c3));

  m.append(el('div', { class: 'bar' },
    el('button', { class: 'primary', onclick: () => runJob('draft') }, 'Draft banao (placeholder ke saath)'),
    el('button', { class: 'go', onclick: () => runJob('final'), disabled: s.can_export ? null : 'disabled' }, 'Final banao'),
    el('button', { onclick: refreshAll }, 'Refresh')));

  m.append(el('div', { class: 'card' }, el('h3', { style: 'margin:0 0 8px' }, 'Job progress'),
    el('pre', { class: 'log', id: 'jobLog' }, s.job ? (s.job.running ? 'chal raha hai…' : 'pichhla job khatam') : '(abhi kuch nahi chal raha)')));
  if (s.job && s.job.running) attachJobStream();
}

// ---------------- JOB (SSE) ----------------
let es = null;
function runJob(kind) {
  api(`/${kind === 'final' ? 'export' : 'draft'}`, { method: 'POST' }).then(({ data }) => {
    if (!data.ok) return toast(data.error || 'job start nahi hua', 'bad');
    toast(`${kind} shuru`, 'ok');
    if (VIEW !== 'overview') { setView('overview'); } else { viewOverview(); }
    attachJobStream();
    refreshState();
  });
}
function attachJobStream() {
  if (es) { es.close(); es = null; }
  es = new EventSource(`/api/v1/jobs/events?token=${TOKEN}`);
  const logEl = () => $('#jobLog');
  es.addEventListener('log', e => { const L = logEl(); if (!L) return; const d = JSON.parse(e.data); L.textContent += (L.textContent && !L.textContent.endsWith('\n') ? '\n' : '') + d.line; L.scrollTop = L.scrollHeight; });
  es.addEventListener('done', e => { const d = JSON.parse(e.data); toast(`job khatam (exit ${d.exit})`, d.exit === 0 ? 'ok' : 'bad'); es.close(); es = null; refreshAll(); });
  es.addEventListener('idle', () => { es.close(); es = null; });
  es.onerror = () => { if (es) { es.close(); es = null; } };
}

// ---------------- RESEARCH HEALTH ----------------
async function viewHealth() {
  const m = $('#main'); m.className = ''; m.innerHTML = '<h2>Research Health</h2><p class="sub">Ye imaandar report hai, koi nakli score nahi.</p><div class="muted">loading…</div>';
  const { data } = await api('/research-health');
  m.querySelector('.muted').remove();
  const rep = data.report, v = data.validation;
  if (v) {
    m.append(el('div', { class: 'card' }, el('h3', { style: 'margin:0 0 8px' }, 'Pack validation'),
      el('div', { class: 'kv' }, el('span', { class: 'k' }, 'valid'), el('span', { class: 'pill ' + (v.ok ? 'ok' : 'bad') }, v.ok ? 'haan' : 'nahi')),
      v.stats ? el('div', { class: 'kv' }, el('span', { class: 'k' }, 'packs / moments'), el('span', {}, `${v.stats.packs} / ${v.stats.moments}`)) : null,
      v.stats ? el('div', { class: 'kv' }, el('span', { class: 'k' }, 'EXACT/DIALOGUE %'), el('span', {}, (v.stats.exactOrDialoguePct || 0) + '%')) : null,
      (v.errors || []).length ? el('div', {}, el('p', { class: 'why' }, `${v.errors.length} error:`), ...v.errors.slice(0, 8).map(e => el('p', { class: 'note' }, '• ' + e))) : null));
  }
  m.append(el('div', { class: 'card' }, el('h3', { style: 'margin:0 0 8px' }, 'Pack check report'),
    !rep ? el('p', { class: 'muted' }, 'abhi pack check nahi chala — START_HERE.bat option 2, ya CLI se check-pack.') :
    el('div', {},
      el('div', { class: 'kv' }, el('span', { class: 'k' }, 'taaza'), el('span', { class: 'pill ' + (data.pack_checked ? 'ok' : 'warn') }, data.pack_checked ? 'is pack ka' : 'purana/badla hua')),
      el('div', { class: 'kv' }, el('span', { class: 'k' }, 'pass'), el('span', { class: 'pill ' + (rep.pass ? 'ok' : 'bad') }, String(rep.pass))),
      (rep.failed_checks || []).length ? el('div', {}, el('p', { class: 'why' }, `${rep.failed_checks.length} fail:`), ...rep.failed_checks.slice(0, 10).map(f => el('p', { class: 'note' }, `• ${f.check} — ${f.detail || ''}`))) : el('p', { class: 'note' }, 'koi fail check nahi'))));
}

// ---------------- MISSING MEDIA ----------------
async function viewMissing() {
  const m = $('#main'); m.className = ''; m.innerHTML = '<h2>Missing Media</h2><p class="sub">Jo footage internet par nahi mila, uske liye apni image/video daalo. Audio kabhi nahi badlega.</p><div class="muted">loading…</div>';
  const { data } = await api('/missing');
  m.querySelector('.muted').remove();
  if (!data.requests || !data.requests.length) {
    m.append(el('div', { class: 'card' }, el('p', {}, STATE && STATE.artifacts && STATE.artifacts.gap_plan ? 'Koi khaali jagah nahi — sab bhar chuka.' : 'Abhi koi request nahi. Pehle Draft banao — tool khud bata dega kahan media chahiye.')));
    return;
  }
  for (const r of data.requests) m.append(missingCard(r));
}
function missingCard(r) {
  const card = el('div', { class: 'mcard ' + (r.blocking ? 'block' : 'ready') });
  const head = el('h3', {}, (r.label || r.folder.split('__')[0].replace('_', ' ')),
    el('span', { class: 'pill ' + (r.media_status === 'VALID' ? 'ok' : r.media_status === 'SHORT' ? 'warn' : 'bad') }, r.media_status.toLowerCase()));
  if (r.approval_required) head.append(el('span', { class: 'crit' }, r.criticality.replace('_', ' ')));
  card.append(head);
  card.append(el('div', { class: 'small muted' }, `${clock(r.range.start_sec)} – ${clock(r.range.end_sec)} · ${r.range.duration_sec.toFixed(1)}s` + (r.short_seconds > 0 ? ` · ${r.short_seconds}s aur chahiye` : '')));
  card.append(el('div', { class: 'cue' }, '“' + esc(r.narration) + '”'));
  if (r.must_show && r.must_show.length) card.append(el('div', { class: 'note' }, 'dikhna chahiye: ' + r.must_show.join(', ')));
  if (r.must_not_show && r.must_not_show.length) card.append(el('div', { class: 'why' }, 'NAHI dikhna chahiye: ' + r.must_not_show.join(', ')));
  if (r.search_queries && r.search_queries.length) card.append(el('div', { class: 'search small' },
    ...r.search_queries.slice(0, 2).flatMap(q => [
      el('a', { target: '_blank', href: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q) }, 'YouTube'),
      el('a', { target: '_blank', href: 'https://duckduckgo.com/?iax=images&ia=images&q=' + encodeURIComponent(q) }, 'Images'),
      el('code', {}, q), el('br')])));

  // drop zone
  const drop = el('div', { class: 'drop' }, 'yahan files drag karo (ya click karke chuno)');
  const input = el('input', { type: 'file', multiple: 'multiple', style: 'display:none' });
  drop.append(input);
  drop.onclick = () => input.click();
  input.onchange = () => uploadFiles(r.request_key, [...input.files], drop);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); uploadFiles(r.request_key, [...e.dataTransfer.files], drop); };
  card.append(drop);

  if (r.files && r.files.length) {
    const fl = el('div', { class: 'files' });
    for (const f of r.files) fl.append(el('div', { class: 'thumb' }, el('div', { class: 'n' }, f.file + (f.duration ? ` · ${f.duration.toFixed(1)}s` : ''))));
    card.append(fl);
  } else card.append(el('div', { class: 'note' }, 'abhi koi file nahi'));

  // reuse
  const reuse = el('input', { type: 'checkbox' }); if (r.allow_reuse) reuse.checked = true;
  reuse.onchange = () => api(`/requests/${encodeURIComponent(r.request_key)}/override`, { method: 'POST', body: JSON.stringify({ allow_reuse: reuse.checked }) }).then(() => refreshView());
  card.append(el('label', { class: 'inline' }, reuse, 'media kam pade to files dobara istemal kar lo'));
  for (const n of (r.notes || [])) card.append(el('div', { class: 'note' }, n));

  // approval
  if (r.approval_required) {
    const box = el('div', { class: 'approve ' + (r.approval_status === 'APPROVED' ? 'done' : r.approval_status === 'EXPIRED' ? 'expired' : '') });
    const cb = el('input', { type: 'checkbox' }); if (r.approval_status === 'APPROVED') cb.checked = true;
    cb.onchange = () => api(`/requests/${encodeURIComponent(r.request_key)}/${cb.checked ? 'approve' : 'approval'}`, { method: cb.checked ? 'POST' : 'DELETE' }).then(() => { refreshView(); refreshState(); });
    box.append(cb, el('span', {}, r.approval_status === 'EXPIRED'
      ? 'Manzoori EXPIRE ho gayi — ' + (r.approval_reason || 'media/input badla') + '. Dobara dekh kar tick karo.'
      : 'Maine ye visual dekh liya hai aur is narration ke liye approve karta hoon'));
    card.append(box);
    if (r.approval_status === 'APPROVED' && r.approved_at) card.append(el('div', { class: 'note' }, 'approve kiya: ' + r.approved_at.replace('T', ' ').slice(0, 16)));
  }
  if (r.reasons && r.reasons.length) card.append(el('div', { class: 'why' }, r.reasons.join(' · ')));
  return card;
}
async function uploadFiles(key, files, drop) {
  for (const f of files) {
    drop.textContent = 'bhej raha hoon: ' + f.name;
    const r = await fetch(`/api/v1/requests/${encodeURIComponent(key)}/media?name=${encodeURIComponent(f.name)}&token=${TOKEN}`, { method: 'POST', headers: { 'x-rfc-token': TOKEN }, body: f });
    const d = await r.json().catch(() => ({}));
    if (!d.ok) toast(f.name + ': ' + (d.message || 'upload fail'), 'bad');
  }
  await refreshView(); await refreshState();
}

// ---------------- EDITOR ----------------
let EDL = null, SEL = null;
async function viewEditor() {
  const m = $('#main'); m.className = 'editor'; m.innerHTML = '';
  const { ok, data, status } = await api('/edl');
  if (!ok || !data.edl) {
    m.className = ''; m.innerHTML = '';
    m.append(el('div', { class: 'card', style: 'margin:20px' }, el('p', {}, status === 404 ? 'Abhi koi draft nahi. Pehle Overview se “Draft banao” chalao — phir editor mein har shot dikhega.' : 'EDL load nahi hui.'),
      el('button', { class: 'primary', onclick: () => runJob('draft') }, 'Draft banao')));
    return;
  }
  EDL = data.edl;
  const shots = EDL.tracks.video_main;
  if (!SEL || !shots.find(s => s.shot_id === SEL)) SEL = shots[0] && shots[0].shot_id;

  const left = el('div', { class: 'ed-left' }, el('h3', { style: 'margin:0 0 8px;font-size:13px' }, 'Shots (' + shots.length + ')'));
  for (const s of shots) {
    left.append(el('div', { class: 'kv', style: 'cursor:pointer;' + (s.shot_id === SEL ? 'background:#1b222c' : ''), onclick: () => { SEL = s.shot_id; viewEditor(); } },
      el('span', { class: 'k' }, (s.display_label || s.slot_id.replace('SLOT_', '#'))),
      el('span', { class: 'pill ' + originPill(s) }, shortOrigin(s.provenance.origin))));
  }

  const center = el('div', { class: 'ed-center' });
  const prev = el('div', { class: 'preview' });
  center.append(prev);
  const sel = shots.find(s => s.shot_id === SEL);
  renderPreview(prev, sel);

  const right = el('div', { class: 'ed-right' }, el('h3', { style: 'margin:0 0 8px;font-size:13px' }, 'Inspector'));
  right.append(inspector(sel));

  const top = el('div', { class: 'ed-top' }, left, center, right);
  const timeline = el('div', { class: 'ed-timeline' }, timelineTracks(shots));
  const editor = el('div', { class: 'ed' }, top, timeline);
  m.append(editor);
}
const ORIGIN_COLOR = { AUTO_EXACT: 'var(--green)', AUTO_CONTEXT: 'var(--blue)', AUTO_STILL: 'var(--purple)', AUTO_MONTAGE: 'var(--blue)', AUTO_GRAPHIC: 'var(--teal)', USER: 'var(--orange)', MISSING: 'var(--red)', UNKNOWN: 'var(--grey)' };
const originPill = s => ({ AUTO_EXACT: 'ok', USER: 'warn', MISSING: 'bad' }[s.provenance.origin] || 'info');
const shortOrigin = o => (o || '').replace('AUTO_', '').toLowerCase() || '?';

function renderPreview(prev, s) {
  prev.innerHTML = '';
  if (!s) { prev.append(el('div', { class: 'empty' }, 'koi shot select nahi')); return; }
  const tok = s.asset && s.asset.path_token;
  prev.append(el('div', { class: 'prov', style: 'color:#fff' }, s.provenance.origin + (s.provenance.scope_relation ? ' · ' + s.provenance.scope_relation : '')));
  if (!tok) { prev.append(el('div', { class: 'empty' }, s.missing ? 'MISSING — yahan aapka media chahiye (Missing tab)' : 'is shot ka koi media nahi')); return; }
  if (s.asset.type === 'video') {
    const v = el('video', { src: mediaUrl(tok), controls: 'controls', muted: 'muted' });
    if (s.asset.source_in) v.addEventListener('loadedmetadata', () => { try { v.currentTime = s.asset.source_in; } catch {} });
    prev.append(v);
  } else prev.append(el('img', { src: mediaUrl(tok) }));
}

function inspector(s) {
  const box = el('div', {});
  if (!s) return box;
  const line = (k, v) => el('div', { class: 'kv' }, el('span', { class: 'k' }, k), el('span', { class: 'small' }, v == null || v === '' ? '—' : String(v)));
  box.append(el('div', { class: 'card', style: 'padding:10px' },
    line('cue', s.cue ? '“' + s.cue.slice(0, 80) + '”' : '—'),
    line('range', `${clock(s.timeline.start)}–${clock(s.timeline.end)} (${(s.timeline.end - s.timeline.start).toFixed(1)}s)`),
    line('moments', (s.moment_ids || []).join(', ')),
    line('criticality', s.approval.criticality),
    line('origin', s.provenance.origin),
    line('scope', s.provenance.scope_relation),
    line('source', s.provenance.source_id),
    line('request key', s.request_key || '—'),
    line('media hash', s.asset && s.asset.sha256 ? s.asset.sha256.slice(0, 16) + '…' : '—'),
    s.approval.required ? line('approval', s.approval.status || 'PENDING') : null));

  if (!s.asset || !s.asset.path_token) return box;
  // transform controls -> PATCH edl
  const t = s.transform;
  const field = (label, node) => el('div', { class: 'field' }, el('label', {}, label), node);
  const fit = el('select', {}, ...['fill', 'fit', 'blur', 'original'].map(o => el('option', { value: o, ...(t.fit === o ? { selected: 'selected' } : {}) }, o)));
  fit.onchange = () => patchShot(s.shot_id, { transform: { fit: fit.value } });
  const scale = el('input', { type: 'range', min: '0.5', max: '3', step: '0.05', value: String(t.scale) });
  scale.onchange = () => patchShot(s.shot_id, { transform: { scale: Number(scale.value) } });
  const cx = el('input', { type: 'range', min: '0', max: '1', step: '0.02', value: String(t.crop_x) });
  cx.onchange = () => patchShot(s.shot_id, { transform: { crop_x: Number(cx.value) } });
  const cy = el('input', { type: 'range', min: '0', max: '1', step: '0.02', value: String(t.crop_y) });
  cy.onchange = () => patchShot(s.shot_id, { transform: { crop_y: Number(cy.value) } });
  box.append(el('div', { class: 'card', style: 'padding:10px' }, el('h3', { style: 'margin:0 0 4px;font-size:12px' }, 'Transform'),
    field('fit', fit), field('scale ' + t.scale.toFixed(2), scale), field('crop X', cx), field('crop Y', cy),
    el('div', { class: 'row' }, el('button', { onclick: () => patchShot(s.shot_id, { transform: { fit: 'fill', crop_x: 0.5, crop_y: 0.5, scale: 1, rotation: 0, opacity: 1 } }) }, 'Reset'))));

  if (s.asset.type === 'video') {
    const inN = el('input', { type: 'number', step: '0.1', value: String(s.asset.source_in || 0) });
    const outN = el('input', { type: 'number', step: '0.1', value: s.asset.source_out != null ? String(s.asset.source_out) : '' });
    const apply = el('button', { onclick: () => patchShot(s.shot_id, { trim: { source_in: Number(inN.value), source_out: outN.value === '' ? null : Number(outN.value) } }) }, 'Trim lagao');
    box.append(el('div', { class: 'card', style: 'padding:10px' }, el('h3', { style: 'margin:0 0 4px;font-size:12px' }, 'Trim (source in/out)'),
      field('in (s)', inN), field('out (s)', outN), apply));
  }
  return box;
}

function timelineTracks(shots) {
  const box = el('div', {});
  box.append(el('div', { class: 'legend' },
    ...[['exact', 'AUTO_EXACT'], ['context', 'AUTO_CONTEXT'], ['still', 'AUTO_STILL'], ['user', 'USER'], ['missing', 'MISSING'], ['graphic', 'AUTO_GRAPHIC']]
      .map(([n, o]) => el('span', {}, el('i', { style: 'background:' + ORIGIN_COLOR[o] }), n))));
  const strip = el('div', { class: 'strip' });
  const total = EDL.duration_sec || shots.reduce((a, s) => Math.max(a, s.timeline.end), 0) || 1;
  for (const s of shots) {
    const w = Math.max(22, Math.round((s.timeline.end - s.timeline.start) / total * 1200));
    const clip = el('div', { class: 'clip' + (s.shot_id === SEL ? ' sel' : ''), style: `width:${w}px;background-color:${ORIGIN_COLOR[s.provenance.origin] || '#333'}` });
    if (s.asset && s.asset.path_token) clip.style.backgroundImage = `url(${thumbUrl(s.asset.path_token, s.asset.source_in || 0)})`;
    clip.append(el('div', { class: 'tag' }, s.display_label ? s.display_label.replace('MISSING ', 'M') : clock(s.timeline.start)));
    clip.onclick = () => { SEL = s.shot_id; viewEditor(); };
    strip.append(clip);
  }
  box.append(el('div', { class: 'track-row' }, el('div', { class: 'track-lbl' }, 'V1 video'), strip));
  box.append(el('div', { class: 'track-row' }, el('div', { class: 'track-lbl' }, 'A1 voice'),
    el('div', { class: 'small muted', style: 'padding:8px' }, 'voiceover master track (locked) — ' + clock(total) + ' total')));
  return box;
}

async function patchShot(shot_id, op) {
  const body = { expected_revision: EDL.revision, ops: [{ shot_id, ...op }] };
  const { ok, data, status } = await api('/edl', { method: 'PATCH', body: JSON.stringify(body) });
  if (!ok) { toast(data.message || 'save fail' + (status === 409 ? ' (refresh)' : ''), 'bad'); if (status === 409) viewEditor(); return; }
  EDL = data.edl;
  $('#save').textContent = 'saved · rev ' + data.revision;
  viewEditor();
}

// ---------------- shell ----------------
const VIEWS = { overview: viewOverview, health: viewHealth, missing: viewMissing, editor: viewEditor };
function refreshView() { return VIEWS[VIEW] ? VIEWS[VIEW]() : viewOverview(); }
function setView(v) { VIEW = v; for (const b of document.querySelectorAll('#nav button')) b.classList.toggle('active', b.dataset.view === v); refreshView(); }
async function refreshAll() { await refreshState(); refreshView(); }

document.querySelectorAll('#nav button').forEach(b => b.onclick = () => setView(b.dataset.view));
$('#btnDraft').onclick = () => runJob('draft');
$('#btnFinal').onclick = () => runJob('final');

(async function init() {
  try { await refreshState(); } catch (e) { toast('server se connect nahi hua', 'bad'); }
  setView('overview');
  $('#save').textContent = 'ready';
})();
