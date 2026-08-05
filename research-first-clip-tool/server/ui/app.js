// ============================================================
//  Movie Editor UI (M5.1) — single page, no build.
//  Ek usool: readiness/state kabhi yahan calculate nahi hote — server ka
//  PROJECT_STATE hi sach hai; ye page use dikhata hai.
// ============================================================
'use strict';
const TOKEN = (window.__RFC__ || {}).token;
const $ = (s, r = document) => r.querySelector(s);
const el = (t, a = {}, ...kids) => { const n = document.createElement(t);
  for (const k in a) { const v = a[k]; if (v == null || v === false) continue;
    if (k === 'class') n.className = v; else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); }
  for (const c of kids) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c)); return n; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clock = t => { t = Math.max(0, t || 0); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`; };

async function api(p, opts = {}) {
  const sep = p.includes('?') ? '&' : '?';
  const r = await fetch(`/api/v1${p}${sep}token=${TOKEN}`, { ...opts,
    headers: { 'x-rfc-token': TOKEN, ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) } });
  const ct = r.headers.get('content-type') || '';
  return { ok: r.ok, status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
}
async function upload(kind, file) {
  const r = await fetch(`/api/v1/import?kind=${kind}&name=${encodeURIComponent(file.name)}&token=${TOKEN}`,
    { method: 'POST', headers: { 'x-rfc-token': TOKEN }, body: file });
  return r.json().catch(() => ({ ok: false, message: 'upload fail' }));
}
const mediaUrl = t => `/api/v1/media/${t}?token=${TOKEN}`;
const thumbUrl = (t, s = 0) => `/api/v1/thumb/${t}?t=${s}&token=${TOKEN}`;
const previewUrl = (t, s = 0, d = 6) => `/api/v1/preview/${t}?start=${Math.max(0, s)}&duration=${Math.max(.25, d)}&token=${TOKEN}`;
const finalArtifactUrl = () => `/api/v1/artifacts/final?token=${TOKEN}`;
function toast(msg, kind = '') { const t = $('#toast'); t.innerHTML = ''; t.append(el('div', { class: `toast ${kind}` }, msg)); setTimeout(() => { t.innerHTML = ''; }, kind === 'bad' ? 6500 : 3500); }
function downloadText(name, text) { const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
async function copyText(text, ok = 'copy ho gaya') { try { await navigator.clipboard.writeText(text || ''); toast(ok, 'ok'); } catch { toast('clipboard permission nahi mili', 'bad'); } }

const STATE_BADGE = {
  NO_INPUTS: 'b-bad', INPUTS_INVALID: 'b-bad', READY_TO_RESEARCH: 'b-warn', READY_TO_DRAFT: 'b-busy',
  DRAFT_RUNNING: 'b-busy', NO_DRAFT: 'b-warn', NEEDS_MEDIA: 'b-warn', NEEDS_MORE_MEDIA: 'b-warn',
  NEEDS_CRITICAL_APPROVAL: 'b-bad', READY_FOR_CONTENT_REVIEW: 'b-ok', CONTENT_LOCKED: 'b-ok',
  STYLE_READY: 'b-ok', EXPORT_RUNNING: 'b-busy', EXPORT_FAILED: 'b-bad', FINAL_READY: 'b-ok',
};
function badge(state) { return el('span', { class: 'badge ' + (STATE_BADGE[state] || 'b-busy') }, el('span', { class: 'dot' }), state); }

let STATE = null, VIEW = 'newvideo', PRESET = 'auto', START_ERROR = null, VIEW_EPOCH = 0;

async function refreshState() {
  const { data } = await api('/state'); STATE = data;
  const s = $('#statusline');
  if (s) s.textContent = `version: M5.1\nstate: ${data.state}\ninputs: ${data.inputs && data.inputs.pack ? 'pack✓' : 'pack✗'} ${data.inputs && data.inputs.srt ? 'srt✓' : 'srt✗'} ${data.inputs && data.inputs.audio ? 'audio✓' : 'audio✗'}`;
  return data;
}

// ===================== NAV / SHELL =====================
const NAV = [
  { id: 'newvideo', label: 'New Video', ico: '＋' },
  { id: 'missing', label: 'Missing Media', ico: '▦' },
  { id: 'editor', label: 'Editor', ico: '▶' },
  { id: 'queue', label: 'Queue', ico: '≡' },
  { id: 'library', label: 'Library', ico: '▢' },
  { id: 'settings', label: 'Settings', ico: '⚙' },
];
function renderNav() {
  const w = $('#navwrap'); w.innerHTML = '';
  for (const n of NAV) w.append(el('div', { class: 'nav' + (n.id === VIEW ? ' active' : ''), onclick: () => setView(n.id) },
    el('span', { class: 'ico' }, n.ico), n.label));
}
function topBar(title, sub, actions) {
  const t = $('#top'); t.innerHTML = '';
  t.append(el('div', {}, el('h1', {}, title), sub ? el('div', { class: 'sub' }, sub) : null));
  t.append(el('div', { class: 'sp' }));
  if (STATE) t.append(badge(STATE.state));
  for (const a of (actions || [])) t.append(a);
}

// ===================== NEW VIDEO =====================
async function viewNewVideo(epoch = ++VIEW_EPOCH) {
  const v = $('#view'); v.className = ''; v.innerHTML = '';
  const box = el('div', { class: 'wrap' }); v.append(box);
  const { data: inp } = await api('/inputs');
  if (epoch !== VIEW_EPOCH || VIEW !== 'newvideo') return;
  const I = (inp && inp.inputs) || {};

  topBar('New Video', 'Ek script + voiceover do — tool draft bana dega. Sab yahin, folder kholne ki zaroorat nahi.', [
    el('button', { class: 'btn ghost', onclick: showGenspark }, 'Research pack chahiye?'),
    el('button', { class: 'btn', onclick: freshStart }, 'Fresh start'),
    el('button', { class: 'btn primary', id: 'buildBtn', onclick: () => runJob('draft') }, 'Build → Editor'),
  ]);

  // ---- Source card ----
  const src = el('div', { class: 'card' }, el('h3', {}, 'Source'), el('p', { class: 'hint' }, 'Ye teen cheezein chahiye. mp3/m4a/wav — koi bhi chalega.'));

  // research pack
  src.append(inputBlock({
    label: '1. Research pack (.json)  — Genspark se banta hai',
    accept: '.json', kind: 'pack',
    status: I.pack ? (I.pack.valid ? `pack valid — ${I.pack.stats ? I.pack.stats.packs + ' packs · ' + I.pack.stats.moments + ' moments' : ''}` : 'pack INVALID — dobara daalo') : null,
    statusClass: I.pack ? (I.pack.valid ? 'ok' : 'bad') : null,
    errors: I.pack && !I.pack.valid ? I.pack.errors : null,
  }));

  // voiceover
  src.append(inputBlock({
    label: '2. Voiceover (mp3 / m4a / wav)',
    accept: '.mp3,.m4a,.wav', kind: 'audio',
    status: I.audio ? `${I.audio.file} · ${I.audio.duration ? fmtDur(I.audio.duration) : '?'}` : null,
    statusClass: I.audio ? 'ok' : null,
  }));

  // script (paste OR file) + SRT
  const scriptField = el('div', { class: 'field' },
    el('label', {}, '3. Clean script (narration text) — paste karo ya .txt daalo'),
    el('textarea', { id: 'scriptText', placeholder: 'Poori narration yahan paste karo... (isse timing wali .srt ban jayegi)' }),
    el('div', { class: 'mt', style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
      el('button', { class: 'btn', onclick: saveScript }, 'Script save karo'),
      fileBtn('.txt', 'script', '.txt file'),
      el('span', { class: 'muted small' }, I.script ? 'script.txt saved ✓' : 'abhi script nahi')));
  src.append(scriptField);

  // SRT status + make
  const srtStatus = I.srt ? `voiceover.srt hai — ${I.srt.cues} cues (${I.srt.end}s tak)` : 'abhi koi .srt nahi';
  src.append(el('div', { class: 'field' },
    el('label', {}, 'Timing (.srt) — narration ki timing'),
    el('div', { class: 'small muted' }, srtStatus),
    el('div', { class: 'mt', style: 'display:flex;gap:8px;flex-wrap:wrap' },
      el('button', { class: 'btn primary', onclick: makeSrt }, 'Auto-banao (script + audio se)'),
      fileBtn('.srt', 'srt', 'Apni .srt daalo')),
    el('p', { class: 'small muted mt' }, 'Auto-SRT anumaan-timing hai (±kuch second), editor mein fine-tune ho jayegi. Aapke paas asli .srt (TTS/Whisper) ho to wo behtar — wahi daalo.')));

  box.append(src);

  // ---- Look (visual only for now) ----
  const look = el('div', { class: 'card' }, el('h3', {}, 'Look'), el('p', { class: 'hint' }, 'Ye Content Lock ke BAAD lagega (M5.1). Abhi sirf chun ke rakh lo.'));
  const pg = el('div', { class: 'presetgrid' });
  for (const [id, t, d] of [['auto', 'Auto', 'tool khud tay kare'], ['cinematic', 'Cinematic', 'gehra, filmy'], ['tense', 'Tense', 'tez, kasa hua'], ['documentary', 'Documentary', 'saaf, shaant']])
    pg.append(el('div', { class: 'preset' + (PRESET === id ? ' sel' : ''), onclick: () => { PRESET = id; viewNewVideo(); } }, el('div', { class: 't' }, t), el('div', { class: 'd' }, d)));
  look.append(pg);
  box.append(look);

  // ---- readiness strip ----
  box.append(readinessStrip());

  // ---- job result + log ----
  const lastJob = STATE && STATE.job;
  if (START_ERROR || (lastJob && !lastJob.running && lastJob.ok === false)) {
    const er = START_ERROR || lastJob;
    box.append(el('div', { class: 'card', style: 'border-color:var(--bad)' },
      el('h3', { style: 'color:var(--bad)' }, `Build nahi bani${er.code ? ' — ' + er.code : ''}`),
      el('p', { class: 'hint' }, er.message || er.error || 'Progress log mein detail dekho.'),
      er.steps && er.steps.length ? el('pre', { class: 'log mt' }, er.steps.join('\n')) : null));
  }
  const priorLog = lastJob && Array.isArray(lastJob.log_tail) ? lastJob.log_tail.join('\n') : '';
  box.append(el('div', { class: 'card' }, el('h3', {}, 'Progress'),
    el('pre', { class: 'log', id: 'jobLog' }, priorLog || (lastJob && lastJob.running ? 'chal raha hai…' : '(abhi kuch nahi chal raha)'))));
  if (STATE && STATE.job && STATE.job.running) attachJobStream();

  // restore textarea if script saved earlier? (we don't fetch content; leave blank)
  const bb = $('#buildBtn');
  if (bb) bb.disabled = !(I.pack && I.pack.valid && I.srt && I.audio && (!STATE.timebase || STATE.timebase.ok));
}

function inputBlock({ label, accept, kind, status, statusClass, errors }) {
  const drop = el('div', { class: 'drop' }, status ? 'badalna ho to nayi file daalo' : 'yahan file drag karo (ya click karo)');
  const input = el('input', { type: 'file', accept, style: 'display:none' });
  drop.append(input);
  drop.onclick = () => input.click();
  input.onchange = () => doUpload(kind, input.files[0], drop);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); doUpload(kind, e.dataTransfer.files[0], drop); };
  const f = el('div', { class: 'field' }, el('label', {}, label), drop);
  if (status) f.append(el('div', { class: 'small mt', style: `color:var(--${statusClass === 'bad' ? 'bad' : 'ok'})` }, (statusClass === 'bad' ? '✗ ' : '✓ ') + status));
  for (const e of (errors || [])) f.append(el('div', { class: 'small', style: 'color:var(--bad)' }, '• ' + e));
  return f;
}
function fileBtn(accept, kind, label) {
  const input = el('input', { type: 'file', accept, style: 'display:none' });
  const b = el('button', { class: 'btn', onclick: () => input.click() }, label);
  input.onchange = () => doUpload(kind, input.files[0], null);
  b.append(input); return b;
}
async function doUpload(kind, file, drop) {
  if (!file) return;
  if (drop) drop.textContent = 'bhej raha hoon: ' + file.name;
  const r = await upload(kind, file);
  if (!r.ok) { toast((file.name) + ': ' + (r.message || 'fail'), 'bad'); }
  else { START_ERROR = null; toast(file.name + ' aa gaya', 'ok'); }
  await refreshState(); viewNewVideo();
}
async function saveScript() {
  const t = $('#scriptText').value.trim();
  if (!t) return toast('pehle script paste karo', 'bad');
  const r = await fetch(`/api/v1/import?kind=script&name=script.txt&token=${TOKEN}`, { method: 'POST', headers: { 'x-rfc-token': TOKEN }, body: t });
  const d = await r.json().catch(() => ({}));
  toast(d.ok ? 'script save ho gayi' : 'script save fail', d.ok ? 'ok' : 'bad');
  await refreshState(); viewNewVideo();
}
async function makeSrt() {
  toast('SRT bana raha hoon…');
  const { data } = await api('/make-srt', { method: 'POST', body: '{}' });
  if (!data.ok) return toast(data.message || 'SRT fail', 'bad');
  toast(`SRT ban gaya — ${data.cues} cues (${data.from} se)`, 'ok');
  await refreshState(); viewNewVideo();
}
function fmtDur(s) { const m = Math.floor(s / 60), x = Math.round(s % 60); return `${m}m ${String(x).padStart(2, '0')}s`; }

function readinessStrip() {
  const s = STATE || {};
  const c = el('div', { class: 'card' }, el('h3', {}, 'Taiyaari'));
  const tb = s.timebase;
  const line = (ok, txt) => el('div', { class: 'tick' }, el('span', { class: 'm', style: `color:var(--${ok === true ? 'ok' : ok === false ? 'bad' : 'warn'})` }, ok === true ? '✓' : ok === false ? '✗' : '⚠'), el('span', {}, txt));
  c.append(line(s.inputs && s.inputs.pack, 'research pack'));
  c.append(line(s.inputs && s.inputs.srt, 'voiceover timing (.srt)'));
  c.append(line(s.inputs && s.inputs.audio, 'voiceover audio'));
  if (tb) c.append(line(tb.ok, `timebase: audio ${tb.audio ? tb.audio.toFixed(1) + 's' : '?'} vs SRT ${tb.srt_end ? tb.srt_end.toFixed(1) + 's' : '?'}${tb.reason ? ' — ' + tb.reason : ''}`));
  c.append(el('p', { class: 'small muted mt' }, s.human || ''));
  return c;
}

async function freshStart() {
  if (!confirm('Fresh start: abhi ka pack/voiceover/draft sab archive/ mein chala jayega (delete nahi hoga). Nayi video shuru karni hai?')) return;
  const { data } = await api('/new-project', { method: 'POST', body: '{}' });
  if (!data.ok) return toast(data.message || 'fresh start fail', 'bad');
  START_ERROR = null;
  toast('Ho gaya — sab archive\\' + (data.archived_to || '') + ' mein. Ab nayi files daalo.', 'ok');
  await refreshState(); viewNewVideo();
}
async function showGenspark() {
  const epoch = ++VIEW_EPOCH;
  const { data } = await api('/genspark-prompt');
  if (epoch !== VIEW_EPOCH) return;
  const v = $('#view'); v.className = ''; v.innerHTML = '';
  const box = el('div', { class: 'wrap' }); v.append(box);
  topBar('Research pack kaise banaye', 'Ye prompt Genspark (ya kisi bhi LLM) mein daalo — wo scene-research.json de dega.', [el('button', { class: 'btn', onclick: () => setView('newvideo') }, '← wapas')]);
  box.append(el('div', { class: 'card' },
    el('p', { class: 'hint' }, 'Neeche wala poora prompt copy karo, Genspark mein paste karo, apni script saath do. Jo JSON aaye use "New Video → Research pack" mein daal do.'),
    el('button', { class: 'btn primary', onclick: () => { navigator.clipboard.writeText(data.text || '').then(() => toast('copy ho gaya', 'ok')); } }, 'Poora prompt copy karo'),
    el('pre', { class: 'log mt', style: 'max-height:440px' }, data.text || 'prompt nahi mila')));
}

// ===================== JOB (SSE) =====================
let es = null;
let EXPORT_HANDLE = null;
function runJob(kind) {
  api(`/${kind === 'final' ? 'export' : 'draft'}`, { method: 'POST', body: '{}' }).then(({ data }) => {
    if (!data.ok) {
      START_ERROR = { code: data.code, message: data.error || data.message || 'job start nahi hua', steps: data.steps || [] };
      toast(START_ERROR.message, 'bad');
      return refreshState().then(() => viewNewVideo());
    }
    START_ERROR = null;
    toast(`${kind} shuru — pack check + build`, 'ok');
    if (VIEW !== 'newvideo') setView('newvideo'); else viewNewVideo();
    setTimeout(attachJobStream, 200); refreshState();
  });
}
function attachJobStream() {
  if (es) { es.close(); es = null; }
  es = new EventSource(`/api/v1/jobs/events?token=${TOKEN}`);
  const L = () => $('#jobLog');
  es.addEventListener('log', e => { const box = L(); if (!box) return; const d = JSON.parse(e.data); box.textContent += (box.textContent && !box.textContent.endsWith('\n') ? '\n' : '') + d.line; box.scrollTop = box.scrollHeight; });
  es.addEventListener('done', async e => {
    const d = JSON.parse(e.data);
    es.close(); es = null;
    if (!d.ok) {
      START_ERROR = { code: d.code, message: d.message || `Build exit ${d.exit} par ruk gayi.` };
      toast(START_ERROR.message, 'bad');
      return refreshState().then(() => viewNewVideo());
    }
    START_ERROR = null;
    toast(d.message || 'Draft taiyar hai', 'ok');
    if (d.kind === 'final') await saveFinalArtifact();
    refreshState().then(() => { if (d.kind === 'draft') setView('editor'); else if (VIEW === 'newvideo') viewNewVideo(); });
  });
  es.addEventListener('idle', () => { if (es) { es.close(); es = null; } });
  es.onerror = () => { if (es) { es.close(); es = null; } };
}

async function chooseExportHandle() {
  if (!window.showSaveFilePicker) return null;
  const base = ((STATE && STATE.job_id) || 'final-video').replace(/[^a-z0-9_-]+/gi, '-');
  return window.showSaveFilePicker({ suggestedName: `${base}.mp4`,
    types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }] });
}

async function exportFinal() {
  const approvePending = !!(STATE && STATE.media_state === 'NEEDS_CRITICAL_APPROVAL');
  if (approvePending && !confirm(`${STATE.blocking || 'Kuch'} HARD EVIDENCE visuals valid hain, par approval pending hai.\n\nKya aapne sabko dekh liya hai aur final video ke liye approve karte hain?`)) return;
  // Chromium file picker direct click ke andar hi khul sakta hai, isliye pehle.
  let handle = null;
  try { handle = await chooseExportHandle(); }
  catch (e) { if (e && e.name === 'AbortError') return; return toast('Save location select nahi hui: ' + e.message, 'bad'); }

  await refreshState();
  if (STATE && STATE.media_state === 'NEEDS_CRITICAL_APPROVAL') {
    const { data } = await api('/missing');
    const pending = (data.requests || []).filter(r => r.approval_required && r.approval_status !== 'APPROVED' && r.media_status === 'VALID');
    if (!pending.length) return toast('Critical media abhi complete/valid nahi hai — Missing Media dekho.', 'bad');
    const a = await api('/requests/approve-all-ready-critical', { method: 'POST', body: '{}' });
    if (!a.ok || !a.data.ok) return toast(a.data.message || 'critical approval complete nahi hui', 'bad');
    toast(`${a.data.approved} critical scenes approve ho gaye`, 'ok');
    await refreshState();
  }
  if (!STATE || !STATE.can_export) { setView('missing'); return toast('Kuch media/approval abhi bhi pending hai — Missing Media khol diya.', 'bad'); }
  EXPORT_HANDLE = handle;
  runJob('final');
}

async function saveFinalArtifact() {
  try {
    const r = await fetch(finalArtifactUrl(), { headers: { 'x-rfc-token': TOKEN } });
    if (!r.ok) throw new Error('final.mp4 stream nahi mili');
    if (EXPORT_HANDLE && EXPORT_HANDLE.createWritable) {
      const writable = await EXPORT_HANDLE.createWritable();
      if (r.body && r.body.pipeTo) await r.body.pipeTo(writable);
      else { await writable.write(await r.blob()); await writable.close(); }
      toast('Final video aapke selected folder mein save ho gayi.', 'ok');
    } else {
      const a = el('a', { href: finalArtifactUrl(), download: `${(STATE && STATE.job_id) || 'final'}.mp4` });
      document.body.append(a); a.click(); a.remove();
      toast('Final video ready — browser Save As/download khol raha hai.', 'ok');
    }
  } catch (e) { toast(`Video tool ke jobs folder mein safe hai, par selected folder mein copy nahi hui: ${e.message}`, 'bad'); }
  finally { EXPORT_HANDLE = null; }
}

// ===================== MISSING =====================
async function viewMissing(epoch = ++VIEW_EPOCH) {
  const v = $('#view'); v.className = ''; v.innerHTML = '';
  const box = el('div', { class: 'wrap' }); v.append(box);
  topBar('Missing Media', 'Jo footage internet par nahi mila — apni image/video daalo. Audio kabhi nahi badlega.', [
    el('button', { class: 'btn', onclick: () => openResearchKit('stage1') }, 'ChatGPT prompt 1'),
    el('button', { class: 'btn', onclick: () => openResearchKit('stage2') }, 'ChatGPT prompt 2'),
    el('button', { class: 'btn', onclick: refreshView }, 'Refresh')]);
  const { data } = await api('/missing');
  if (epoch !== VIEW_EPOCH || VIEW !== 'missing') return;
  box.append(el('div', { class: 'card evidence-help' },
    el('h3', {}, 'HARD EVIDENCE ka matlab'),
    el('p', { class: 'hint', style: 'margin:4px 0 0' }, 'Narration koi factual ya scene-specific claim kar rahi hai. Yahan generic character photo ya random B-roll kaafi nahi: literal event, person ya object dikhna chahiye. Isi liye tool human approval maangta hai. NORMAL scenes mein ye extra tick nahi aata.')));
  box.append(el('div', { class: 'research-actions' },
    el('button', { class: 'btn primary', onclick: () => openResearchKit('note') }, 'Missing-scenes note dekho / copy'),
    el('button', { class: 'btn', onclick: downloadResearchNote }, 'Note .txt download'),
    el('button', { class: 'btn', onclick: syncEditor }, 'Media editor mein lagao')));
  const pendingCritical = (data.requests || []).filter(r => r.approval_required
    && r.approval_status !== 'APPROVED' && r.media_status === 'VALID');
  if (pendingCritical.length) box.append(el('div', { class: 'card approval-banner' },
    el('h3', {}, `${pendingCritical.length} critical visuals upload ho chuke hain — sirf aapki approval baaki hai`),
    el('p', { class: 'hint' }, 'Files missing nahi hain. Ek baar thumbnails dekh lo; phir ye button sab ready HARD EVIDENCE scenes ko approve karega. Empty/short file approve nahi hogi.'),
    el('button', { class: 'btn primary', onclick: approveAllCritical }, `Maine sab dekh liye — ${pendingCritical.length} approve karo`)));
  if (!data.requests || !data.requests.length) {
    box.append(el('div', { class: 'card' }, el('p', {}, STATE && STATE.artifacts && STATE.artifacts.gap_plan ? 'Koi khaali jagah nahi — sab bhar chuka.' : 'Abhi koi request nahi. Pehle New Video se Draft banao.')));
    return;
  }
  for (const r of data.requests) box.append(missingCard(r));
}
async function approveAllCritical() {
  if (!confirm('Kya aapne sab ready HARD EVIDENCE thumbnails dekh liye hain aur unhe final video ke liye approve karte hain?')) return;
  const { ok, data } = await api('/requests/approve-all-ready-critical', { method: 'POST', body: '{}' });
  if (!ok || !data.ok) return toast(data.message || 'bulk approval fail', 'bad');
  toast(`${data.approved} critical scenes approve — state: ${data.state}`, 'ok');
  await refreshState(); refreshView();
}
async function getResearchKit() { const { data } = await api('/missing/research-kit'); return data || {}; }
async function openResearchKit(which) {
  const epoch = ++VIEW_EPOCH;
  const data = await getResearchKit();
  if (epoch !== VIEW_EPOCH) return;
  const text = which === 'stage1' ? data.stage1_prompt : which === 'stage2' ? data.stage2_prompt : data.note;
  const title = which === 'stage1' ? 'Prompt 1 — clean-script research map' : which === 'stage2' ? 'Prompt 2 — missing-scenes exact research' : 'Missing scenes — ready-to-copy note';
  const v = $('#view'); v.className = ''; v.innerHTML = ''; const box = el('div', { class: 'wrap' }); v.append(box);
  topBar(title, 'Isse seedha ChatGPT chat mein copy kar sakte ho.', [el('button', { class: 'btn', onclick: () => setView('missing') }, '← Missing Media')]);
  box.append(el('div', { class: 'card' },
    el('div', { class: 'research-actions' }, el('button', { class: 'btn primary', onclick: () => copyText(text) }, 'Poora copy karo'), el('button', { class: 'btn', onclick: () => downloadText(which + '.txt', text) }, '.txt download')),
    el('pre', { class: 'log', style: 'max-height:65vh' }, text || 'abhi note nahi bana')));
}
async function downloadResearchNote() { const d = await getResearchKit(); downloadText('MISSING_MEDIA_RESEARCH_NOTE.txt', d.note || ''); }
async function syncEditor() {
  const { ok, data } = await api('/edl/sync-manual', { method: 'POST', body: '{}' });
  if (!ok) return toast(data.message || 'pehle draft banao', 'bad');
  toast(`${data.applied || 0} missing ranges editor mein update ho gaye`, 'ok');
  await refreshState(); setView('editor');
}
function missingCard(r) {
  const card = el('div', { class: 'card' });
  card.append(el('div', { style: 'display:flex;align-items:center;gap:8px' },
    el('h3', { style: 'margin:0' }, r.label || r.folder.split('__')[0].replace('_', ' ')),
    el('span', { class: 'badge ' + (r.media_status === 'VALID' ? 'b-ok' : r.media_status === 'SHORT' ? 'b-warn' : 'b-bad') }, el('span', { class: 'dot' }), r.media_status.toLowerCase()),
    r.approval_required ? el('span', { class: 'badge b-bad' }, r.criticality.replace('_', ' ')) : null));
  card.append(el('div', { class: 'small muted mt' }, `${clock(r.range.start_sec)} – ${clock(r.range.end_sec)} · ${r.range.duration_sec.toFixed(1)}s` + (r.short_seconds > 0 ? ` · ${r.short_seconds}s aur chahiye` : '')));
  card.append(el('div', { style: 'font-style:italic;margin:8px 0' }, '“' + esc(r.narration) + '”'));
  if (r.must_show && r.must_show.length) card.append(el('div', { class: 'small', style: 'color:var(--ok)' }, 'dikhna chahiye: ' + r.must_show.join(', ')));
  if (r.must_not_show && r.must_not_show.length) card.append(el('div', { class: 'small', style: 'color:var(--bad)' }, 'NAHI dikhna: ' + r.must_not_show.join(', ')));
  if (r.search_queries && r.search_queries.length) { const sr = el('div', { class: 'small mt' });
    for (const q of r.search_queries.slice(0, 2)) sr.append(el('a', { target: '_blank', href: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q) }, 'YouTube'), document.createTextNode(' '), el('a', { target: '_blank', href: 'https://duckduckgo.com/?iax=images&ia=images&q=' + encodeURIComponent(q) }, 'Images'), document.createTextNode('  ' + q), el('br'));
    card.append(sr); }

  const drop = el('div', { class: 'drop mt' }, 'yahan images/videos drag karo (ya click)');
  const input = el('input', { type: 'file', multiple: 'multiple', style: 'display:none' }); drop.append(input);
  drop.onclick = () => input.click();
  input.onchange = () => uploadMedia(r.request_key, [...input.files], drop);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); uploadMedia(r.request_key, [...e.dataTransfer.files], drop); };
  card.append(drop);
  if (r.files && r.files.length) {
    const grid = el('div', { class: 'media-grid' });
    r.files.forEach((f, i) => {
      const item = el('div', { class: 'media-item' });
      if (f.token) item.append(f.type === 'VIDEO'
        ? el('video', { src: previewUrl(f.token, f.trim_start_sec || 0, Math.min(12, f.duration || 6)), controls: 'controls', muted: 'muted', preload: 'metadata' })
        : el('img', { src: mediaUrl(f.token), loading: 'lazy' }));
      item.append(el('div', { class: 'media-meta' }, el('b', { title: f.file }, `${i + 1}. ${f.file}`), f.duration ? `${f.duration.toFixed(1)}s video` : `${f.width || '?'}×${f.height || '?'} image`));
      item.append(el('div', { class: 'media-actions' },
        el('button', { class: 'btn', disabled: i === 0 ? 'disabled' : null, onclick: () => moveMedia(r, i, -1) }, '↑'),
        el('button', { class: 'btn', disabled: i === r.files.length - 1 ? 'disabled' : null, onclick: () => moveMedia(r, i, 1) }, '↓'),
        el('button', { class: 'btn danger', onclick: () => removeMedia(r.request_key, f.file) }, 'Remove')));
      grid.append(item);
    });
    card.append(grid);
    card.append(el('div', { class: 'small mt muted' }, `${r.files.length} file: tool inhe isi order mein poore ${r.range.duration_sec.toFixed(1)}s gap par barabar baantega. Ek file ho to wahi poora gap bharegi.`));
  }

  const reuse = el('input', { type: 'checkbox' }); if (r.allow_reuse) reuse.checked = true;
  reuse.onchange = () => api(`/requests/${encodeURIComponent(r.request_key)}/override`, { method: 'POST', body: JSON.stringify({ allow_reuse: reuse.checked }) }).then(refreshView);
  card.append(el('label', { style: 'display:flex;gap:7px;align-items:center;margin-top:10px;color:var(--muted);font-size:12.5px' }, reuse, 'media kam pade to files dobara istemal karo'));
  for (const n of (r.notes || [])) card.append(el('div', { class: 'small muted' }, n));

  if (r.approval_required) {
    const st = r.approval_status;
    const cb = el('input', { type: 'checkbox' }); if (st === 'APPROVED') cb.checked = true;
    cb.onchange = () => api(`/requests/${encodeURIComponent(r.request_key)}/${cb.checked ? 'approve' : 'approval'}`, { method: cb.checked ? 'POST' : 'DELETE' }).then(() => { refreshView(); refreshState(); });
    const box2 = el('div', { style: `display:flex;gap:8px;align-items:flex-start;margin-top:10px;padding:9px 11px;border-radius:9px;border:1px solid var(--${st === 'APPROVED' ? 'ok' : 'bad'}-line);background:var(--${st === 'APPROVED' ? 'ok' : 'bad'}-soft)` },
      cb, el('span', { class: 'small' }, st === 'EXPIRED' ? 'Manzoori EXPIRE ho gayi — ' + (r.approval_reason || 'media badla') + '. Dobara dekh kar tick karo.' : 'Maine ye visual dekh liya hai aur approve karta hoon (zaroori beat)'));
    card.append(box2);
  }
  if (r.reasons && r.reasons.length) card.append(el('div', { class: 'small mt', style: 'color:var(--warn)' }, r.reasons.join(' · ')));
  return card;
}
async function uploadMedia(key, files, drop) {
  for (const f of files) { drop.textContent = 'bhej raha hoon: ' + f.name;
    const r = await fetch(`/api/v1/requests/${encodeURIComponent(key)}/media?name=${encodeURIComponent(f.name)}&token=${TOKEN}`, { method: 'POST', headers: { 'x-rfc-token': TOKEN }, body: f });
    const d = await r.json().catch(() => ({})); if (!d.ok) toast(f.name + ': ' + (d.message || 'fail'), 'bad'); }
  await refreshView(); await refreshState();
}
async function moveMedia(r, index, delta) {
  const files = r.files.map((f, i) => ({ file: f.file, relative_path: f.file, order: i, trim_start_sec: f.trim_start_sec, trim_end_sec: f.trim_end_sec }));
  const j = index + delta; if (j < 0 || j >= files.length) return;
  [files[index], files[j]] = [files[j], files[index]]; files.forEach((f, i) => { f.order = i; });
  const { data } = await api(`/requests/${encodeURIComponent(r.request_key)}/override`, { method: 'POST', body: JSON.stringify({ files }) });
  if (!data.ok) return toast(data.message || 'order save nahi hua', 'bad');
  refreshView();
}
async function removeMedia(key, file) {
  if (!confirm(`${file} ko is scene se hataana hai? File recoverable .trash mein jayegi.`)) return;
  const { ok, data } = await api(`/requests/${encodeURIComponent(key)}/media/${encodeURIComponent(file)}`, { method: 'DELETE' });
  if (!ok) return toast(data.message || 'remove fail', 'bad');
  toast('media hata di — .trash se recover ho sakti hai', 'ok'); refreshView(); refreshState();
}

// ===================== EDITOR =====================
let EDL = null, SEL = null;
const PLAYER = { time: 0, playing: false, raf: 0, audio: null, media: null, shotId: null, startedAt: 0, startedTime: 0 };
const ORIGIN_COLOR = { AUTO_EXACT: 'var(--ok)', AUTO_CONTEXT: 'var(--busy)', AUTO_STILL: 'var(--accent)', AUTO_MONTAGE: 'var(--busy)', AUTO_GRAPHIC: 'var(--warn)', USER: 'var(--warn)', USER_REPLACEMENT: 'var(--warn)', MISSING: 'var(--bad)', UNKNOWN: 'var(--faint)' };
let SHOT_MENU = null;
function closeShotMenu() { if (SHOT_MENU) SHOT_MENU.remove(); SHOT_MENU = null; }
function showShotMenu(e, s) {
  e.preventDefault(); e.stopPropagation(); SEL = s.shot_id; seekEditor(s.timeline.start); closeShotMenu();
  const menu = el('div', { class: 'shot-menu' },
    el('button', { onclick: () => { closeShotMenu(); chooseShotReplacement(s); } }, 'Change Clip / Image…'),
    s.user_replaced ? el('button', { onclick: () => { closeShotMenu(); undoShotReplacement(s); } }, 'Original clip wapas lao') : null,
    el('div', { class: 'shot-menu-note mono' }, `${clockFine(s.timeline.start)}–${clockFine(s.timeline.end)} · ${(s.timeline.end - s.timeline.start).toFixed(1)}s`));
  document.body.append(menu); SHOT_MENU = menu;
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8)}px`;
}
window.addEventListener('click', closeShotMenu);
window.addEventListener('blur', closeShotMenu);

function chooseShotReplacement(s) {
  const input = el('input', { type: 'file', accept: 'video/mp4,video/webm,video/quicktime,video/x-matroska,image/jpeg,image/png,image/webp', style: 'display:none' });
  document.body.append(input);
  input.onchange = async () => {
    const f = input.files && input.files[0]; input.remove(); if (!f) return;
    toast(`${s.slot_id}: ${f.name} laga raha hoon…`);
    const url = `/api/v1/edl/${encodeURIComponent(s.shot_id)}/replace?name=${encodeURIComponent(f.name)}&expected_revision=${EDL.revision}&token=${TOKEN}`;
    const r = await fetch(url, { method: 'POST', headers: { 'x-rfc-token': TOKEN }, body: f });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) { toast(data.message || 'clip replace nahi hui', 'bad'); if (r.status === 409) viewEditor(); return; }
    EDL = data.edl; SEL = s.shot_id; toast('Clip change save ho gaya — final export mein bhi yahi lagega.', 'ok'); viewEditor();
  };
  input.click();
}

async function undoShotReplacement(s) {
  if (!confirm('Is shot par original automatic clip wapas laani hai?')) return;
  const { ok, data, status } = await api(`/edl/${encodeURIComponent(s.shot_id)}/replacement?expected_revision=${EDL.revision}`, { method: 'DELETE' });
  if (!ok) { toast(data.message || 'replacement undo nahi hui', 'bad'); if (status === 409) viewEditor(); return; }
  EDL = data.edl; SEL = s.shot_id; toast('Original clip wapas aa gayi.', 'ok'); viewEditor();
}
async function viewEditor(epoch = ++VIEW_EPOCH) {
  stopPlayer(false);
  const v = $('#view'); v.className = 'editorwrap'; v.innerHTML = '';
  $('#top').innerHTML = ''; topBar('Editor', 'Voiceover-synced content preview · Space = play/pause · ←/→ = 2s seek', [
    el('button', { class: 'btn', onclick: () => setView('missing') }, 'Missing Media'),
    el('button', { class: 'btn', onclick: syncEditor }, 'Refresh media'),
    el('button', { class: 'btn primary', onclick: exportFinal,
      disabled: STATE && (STATE.can_export || STATE.media_state === 'NEEDS_CRITICAL_APPROVAL') ? null : 'disabled' }, 'Export / Save As')]);
  const { ok, data, status } = await api('/edl');
  if (epoch !== VIEW_EPOCH || VIEW !== 'editor') return;
  if (!ok || !data.edl) {
    v.className = ''; v.innerHTML = '';
    v.append(el('div', { class: 'wrap' }, el('div', { class: 'card' }, el('p', {}, status === 404 ? 'Abhi koi draft nahi. New Video se Draft banao — phir har shot yahan dikhega.' : 'EDL load nahi hui.'), el('button', { class: 'btn primary', onclick: () => setView('newvideo') }, '→ New Video'))));
    return;
  }
  EDL = data.edl; const shots = EDL.tracks.video_main;
  if (!SEL || !shots.find(s => s.shot_id === SEL)) SEL = shots[0] && shots[0].shot_id;
  const sel = shots.find(s => s.shot_id === SEL);

  const left = el('div', { class: 'ed-col l', id: 'shotList' }, el('div', { class: 'tlbl', style: 'width:auto;margin-bottom:8px' }, 'Shots (' + shots.length + ')'));
  for (const s of shots) left.append(el('div', { class: 'rowline shot-row', 'data-shot': s.shot_id, style: 'cursor:pointer;' + (s.shot_id === SEL ? 'background:var(--raised);' : ''),
    onclick: () => seekEditor(s.timeline.start), oncontextmenu: e => showShotMenu(e, s) },
    el('div', {}, el('div', { class: 'shot-name' }, s.display_label || s.slot_id.replace('SLOT_', '#')),
      el('div', { class: 'shot-time mono' }, `${clockFine(s.timeline.start)}–${clockFine(s.timeline.end)} · ${(s.timeline.end - s.timeline.start).toFixed(1)}s`)),
    el('span', { style: 'color:' + (ORIGIN_COLOR[s.provenance.origin] || 'var(--muted)') }, (s.provenance.origin || '').replace('AUTO_', '').toLowerCase() || '?')));

  const center = el('div', { class: 'ed-center' });
  const prev = el('div', { class: 'preview', id: 'masterPreview' }, el('div', { class: 'preview-stage', id: 'previewStage' }));
  const back = el('button', { class: 'round', title: 'Previous shot', onclick: prevShot }, '◀');
  const play = el('button', { class: 'round main', id: 'playBtn', title: 'Play / Pause', onclick: togglePlayer }, '▶');
  const next = el('button', { class: 'round', title: 'Next shot', onclick: nextShot }, '▶|');
  const scrub = el('input', { type: 'range', id: 'masterScrub', min: '0', max: String(EDL.duration_sec || 0), step: '0.01', value: String(Math.min(PLAYER.time, EDL.duration_sec || 0)) });
  scrub.oninput = () => seekEditor(+scrub.value, true);
  const transport = el('div', { class: 'transport' }, back, play, next, el('span', { class: 'timecode', id: 'timecode' }), scrub);
  center.append(prev, transport);
  const right = el('div', { class: 'ed-col r insp', id: 'inspectorPanel' }, el('div', { class: 'tlbl', style: 'width:auto;margin-bottom:8px' }, 'Inspector'), inspector(sel));
  const top = el('div', { class: 'ed-top' }, left, center, right);
  const tl = el('div', { class: 'ed-tl' }, timelineTracks(shots));
  v.append(el('div', { class: 'ed' }, top, tl));
  initEditorPlayer();
}
function renderPreview(prev, s) {
  prev.innerHTML = '';
  if (!s) return prev.append(el('div', { class: 'muted' }, 'koi shot select nahi'));
  prev.append(el('div', { class: 'prov' }, s.provenance.origin + (s.provenance.scope_relation ? ' · ' + s.provenance.scope_relation : '')));
  const tok = s.asset && s.asset.path_token;
  if (!tok) return prev.append(el('div', { class: 'muted' }, s.missing ? 'MISSING — Missing tab mein media daalo' : 'is shot ka media nahi'));
  if (s.asset.type === 'video') { const vid = el('video', { src: mediaUrl(tok), controls: 'controls', muted: 'muted' });
    if (s.asset.source_in) vid.addEventListener('loadedmetadata', () => { try { vid.currentTime = s.asset.source_in; } catch {} }); prev.append(vid);
  } else prev.append(el('img', { src: mediaUrl(tok) }));
}
function shotAt(t) {
  const shots = EDL && EDL.tracks && EDL.tracks.video_main || [];
  return shots.find(s => t >= s.timeline.start - .001 && t < s.timeline.end - .001) || shots[shots.length - 1] || null;
}
function stopPlayer(resetButton = true) {
  PLAYER.playing = false; cancelAnimationFrame(PLAYER.raf); PLAYER.raf = 0;
  if (PLAYER.audio) { try { PLAYER.audio.pause(); } catch {} }
  if (PLAYER.media && PLAYER.media.tagName === 'VIDEO') { try { PLAYER.media.pause(); } catch {} }
  if (resetButton && $('#playBtn')) $('#playBtn').textContent = '▶';
}
function initEditorPlayer() {
  const vo = EDL.tracks.voiceover && EDL.tracks.voiceover[0];
  PLAYER.audio = vo && vo.path_token ? new Audio(mediaUrl(vo.path_token)) : null;
  if (PLAYER.audio) { PLAYER.audio.preload = 'auto'; PLAYER.audio.addEventListener('ended', () => { PLAYER.time = EDL.duration_sec; stopPlayer(); updatePlayerUI(true); }); }
  PLAYER.time = Math.max(0, Math.min(PLAYER.time || 0, EDL.duration_sec || 0));
  updatePlayerUI(true);
}
function mountShot(s) {
  const stage = $('#previewStage'); if (!stage) return;
  stage.innerHTML = ''; PLAYER.media = null; PLAYER.shotId = s && s.shot_id;
  if (!s) return stage.append(el('div', { class: 'muted' }, 'koi shot nahi'));
  const wrap = $('#masterPreview');
  wrap.querySelectorAll('.prov,.proxy-note').forEach(n => n.remove());
  wrap.append(el('div', { class: 'prov' }, s.provenance.origin + (s.provenance.scope_relation ? ' · ' + s.provenance.scope_relation : '')));
  const tok = s.asset && s.asset.path_token;
  if (!tok) return stage.append(el('div', { class: 'muted' }, s.missing ? `${s.display_label || 'MISSING'} — Missing Media mein file daalo` : 'is shot ka media nahi'));
  const tr = s.transform || {};
  const style = `object-fit:${tr.fit === 'fit' || tr.fit === 'original' ? 'contain' : 'cover'};object-position:${(tr.crop_x == null ? .5 : tr.crop_x) * 100}% ${(tr.crop_y == null ? .5 : tr.crop_y) * 100}%;transform:scale(${tr.scale || 1}) rotate(${tr.rotation || 0}deg);opacity:${tr.opacity == null ? 1 : tr.opacity}`;
  if (s.asset.type === 'video') {
    const d = Math.max(.25, s.timeline.end - s.timeline.start);
    const vid = el('video', { src: previewUrl(tok, s.asset.source_in || 0, d), muted: 'muted', playsinline: 'playsinline', preload: 'auto', style });
    vid.addEventListener('canplay', () => { if (PLAYER.playing) vid.play().catch(() => {}); });
    vid.addEventListener('error', () => { stage.innerHTML = ''; stage.append(el('div', { class: 'muted' }, 'Browser preview proxy nahi bani — source/render log check karo')); });
    stage.append(vid); PLAYER.media = vid;
    wrap.append(el('div', { class: 'proxy-note' }, 'browser-safe shot proxy'));
  } else { const img = el('img', { src: mediaUrl(tok), style }); stage.append(img); PLAYER.media = img; }
}
function updatePlayerUI(forceMount = false) {
  if (!EDL) return;
  const total = EDL.duration_sec || 0; PLAYER.time = Math.max(0, Math.min(PLAYER.time, total));
  const s = shotAt(PLAYER.time);
  if (forceMount || (s && s.shot_id !== PLAYER.shotId)) mountShot(s);
  if (s) { SEL = s.shot_id; updateSelectionUI(s); }
  const scrub = $('#masterScrub'); if (scrub) scrub.value = String(PLAYER.time);
  const tc = $('#timecode'); if (tc) tc.textContent = `${clockFine(PLAYER.time)} / ${clockFine(total)}`;
  const ph = $('#timelinePlayhead'); if (ph) ph.style.left = `${PLAYER.time * +(ph.dataset.zoom || 6)}px`;
  if (PLAYER.media && PLAYER.media.tagName === 'VIDEO' && s) {
    const local = Math.max(0, PLAYER.time - s.timeline.start);
    if (Math.abs((PLAYER.media.currentTime || 0) - local) > .35) { try { PLAYER.media.currentTime = local; } catch {} }
  }
}
function updateSelectionUI(s) {
  document.querySelectorAll('.shot-row').forEach(n => { n.style.background = n.dataset.shot === s.shot_id ? 'var(--raised)' : ''; });
  document.querySelectorAll('.timeline-shot').forEach(n => n.classList.toggle('sel', n.dataset.shot === s.shot_id));
  const p = $('#inspectorPanel'); if (p && p.dataset.shot !== s.shot_id) { p.dataset.shot = s.shot_id; p.innerHTML = ''; p.append(el('div', { class: 'tlbl', style: 'width:auto;margin-bottom:8px' }, 'Inspector'), inspector(s)); }
}
function clockFine(t) { t = Math.max(0, t || 0); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}.${Math.floor((t % 1) * 10)}`; }
function seekEditor(t, keepPlaying = false) {
  PLAYER.time = Math.max(0, Math.min(+t || 0, EDL.duration_sec || 0));
  if (PLAYER.audio) { try { PLAYER.audio.currentTime = PLAYER.time; } catch {} }
  PLAYER.startedAt = performance.now(); PLAYER.startedTime = PLAYER.time;
  updatePlayerUI(true);
  if (!keepPlaying && !PLAYER.playing) stopPlayer();
}
function togglePlayer() { PLAYER.playing ? pausePlayer() : playPlayer(); }
function playPlayer() {
  if (!EDL || PLAYER.time >= EDL.duration_sec - .02) PLAYER.time = 0;
  PLAYER.playing = true; PLAYER.startedAt = performance.now(); PLAYER.startedTime = PLAYER.time;
  if ($('#playBtn')) $('#playBtn').textContent = '❚❚';
  if (PLAYER.audio) { PLAYER.audio.currentTime = PLAYER.time; PLAYER.audio.play().catch(() => {}); }
  if (PLAYER.media && PLAYER.media.tagName === 'VIDEO') PLAYER.media.play().catch(() => {});
  tickPlayer();
}
function pausePlayer() { if (PLAYER.audio && !PLAYER.audio.paused) PLAYER.time = PLAYER.audio.currentTime; stopPlayer(); updatePlayerUI(); }
function tickPlayer() {
  if (!PLAYER.playing) return;
  PLAYER.time = PLAYER.audio && !PLAYER.audio.paused ? PLAYER.audio.currentTime : PLAYER.startedTime + (performance.now() - PLAYER.startedAt) / 1000;
  if (PLAYER.time >= EDL.duration_sec) { PLAYER.time = EDL.duration_sec; stopPlayer(); updatePlayerUI(); return; }
  updatePlayerUI(); PLAYER.raf = requestAnimationFrame(tickPlayer);
}
function prevShot() { const ss = EDL.tracks.video_main, at = shotAt(PLAYER.time), pos = ss.findIndex(s => at && s.shot_id === at.shot_id), i = Math.max(0, pos - 1); seekEditor(ss[i].timeline.start); }
function nextShot() { const ss = EDL.tracks.video_main, at = shotAt(PLAYER.time), pos = ss.findIndex(s => at && s.shot_id === at.shot_id), i = Math.min(ss.length - 1, Math.max(0, pos + 1)); seekEditor(ss[i].timeline.start); }

function inspector(s) {
  const box = el('div', {}); if (!s) return box;
  const L = (k, val) => el('div', { class: 'rowline' }, el('span', { class: 'k' }, k), el('span', { class: 'small' }, val == null || val === '' ? '—' : String(val)));
  box.append(el('div', { class: 'card', style: 'padding:12px' },
    L('cue', s.cue ? '“' + s.cue.slice(0, 80) + '”' : '—'), L('range', `${clockFine(s.timeline.start)}–${clockFine(s.timeline.end)} (${(s.timeline.end - s.timeline.start).toFixed(1)}s)`),
    L('moments', (s.moment_ids || []).join(', ')), L('criticality', s.approval.criticality), L('origin', s.provenance.origin),
    L('scope', s.provenance.scope_relation), L('source', s.provenance.source_id), L('request key', s.request_key || '—'),
    L('media hash', s.asset && s.asset.sha256 ? s.asset.sha256.slice(0, 16) + '…' : '—'),
    s.approval.required ? L('approval', s.approval.status || 'PENDING') : null));
  box.append(el('div', { class: 'card', style: 'padding:12px' },
    el('h3', { style: 'font-size:12.5px' }, 'Shot media'),
    el('p', { class: 'hint', style: 'margin:4px 0 9px' }, s.user_replaced ? `Manual: ${(s.replacement && s.replacement.file) || 'replacement'}` : 'Right-click shot ya neeche button se is clip ko badlo.'),
    el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
      el('button', { class: 'btn primary', onclick: () => chooseShotReplacement(s) }, 'Change Clip'),
      s.user_replaced ? el('button', { class: 'btn', onclick: () => undoShotReplacement(s) }, 'Use Original') : null)));
  if (!s.asset || !s.asset.path_token) return box;
  const t = s.transform;
  const fld = (lab, node) => el('div', { class: 'field', style: 'margin:8px 0' }, el('label', {}, lab), node);
  const fit = el('select', {}, ...['fill', 'fit', 'blur', 'original'].map(o => el('option', { value: o, ...(t.fit === o ? { selected: 'selected' } : {}) }, o)));
  fit.onchange = () => patchShot(s.shot_id, { transform: { fit: fit.value } });
  const scale = el('input', { class: 'slider', type: 'range', min: '0.5', max: '3', step: '0.05', value: String(t.scale) }); scale.onchange = () => patchShot(s.shot_id, { transform: { scale: +scale.value } });
  const cx = el('input', { class: 'slider', type: 'range', min: '0', max: '1', step: '0.02', value: String(t.crop_x) }); cx.onchange = () => patchShot(s.shot_id, { transform: { crop_x: +cx.value } });
  const cy = el('input', { class: 'slider', type: 'range', min: '0', max: '1', step: '0.02', value: String(t.crop_y) }); cy.onchange = () => patchShot(s.shot_id, { transform: { crop_y: +cy.value } });
  box.append(el('div', { class: 'card', style: 'padding:12px' }, el('h3', { style: 'font-size:12.5px' }, 'Transform'),
    fld('fit', fit), fld('scale ' + t.scale.toFixed(2), scale), fld('crop X', cx), fld('crop Y', cy),
    el('button', { class: 'btn', onclick: () => patchShot(s.shot_id, { transform: { fit: 'fill', crop_x: 0.5, crop_y: 0.5, scale: 1, rotation: 0, opacity: 1 } }) }, 'Reset')));
  if (s.asset.type === 'video') { const inN = el('input', { class: 'input', type: 'number', step: '0.1', value: String(s.asset.source_in || 0) });
    const outN = el('input', { class: 'input', type: 'number', step: '0.1', value: s.asset.source_out != null ? String(s.asset.source_out) : '' });
    box.append(el('div', { class: 'card', style: 'padding:12px' }, el('h3', { style: 'font-size:12.5px' }, 'Trim (source in/out)'),
      fld('in (s)', inN), fld('out (s)', outN), el('button', { class: 'btn', onclick: () => patchShot(s.shot_id, { trim: { source_in: +inN.value, source_out: outN.value === '' ? null : +outN.value } }) }, 'Trim lagao')));
  }
  return box;
}
function timelineTracks(shots) {
  const box = el('div', {});
  box.append(el('div', { class: 'legend' }, ...[['exact', 'AUTO_EXACT'], ['context', 'AUTO_CONTEXT'], ['still', 'AUTO_STILL'], ['user', 'USER'], ['missing', 'MISSING'], ['graphic', 'AUTO_GRAPHIC']].map(([n, o]) => el('span', {}, el('i', { style: 'background:' + ORIGIN_COLOR[o] }), n))));
  const total = EDL.duration_sec || shots.reduce((a, s) => Math.max(a, s.timeline.end), 0) || 1;
  const zoom = total > 1200 ? 4 : total > 600 ? 6 : 9;
  const width = Math.max(1200, Math.ceil(total * zoom));
  const canvas = el('div', { class: 'timeline-canvas', style: `width:${width}px` });
  const tick = total > 900 ? 60 : total > 300 ? 30 : 10;
  for (let t = 0; t <= total; t += tick) canvas.append(el('div', { class: 'ruler-mark', style: `left:${t * zoom}px` }, clock(t)));
  for (const s of shots) { const w = Math.max(8, Math.round((s.timeline.end - s.timeline.start) * zoom));
    const clip = el('div', { class: 'timeline-shot' + (s.shot_id === SEL ? ' sel' : ''), 'data-shot': s.shot_id,
      style: `left:${s.timeline.start * zoom}px;width:${w}px;background-color:${ORIGIN_COLOR[s.provenance.origin] || '#333'}` });
    if (s.asset && s.asset.path_token) clip.style.backgroundImage = `url(${thumbUrl(s.asset.path_token, s.asset.source_in || 0)})`;
    clip.append(el('div', { class: 'tg' }, s.display_label ? s.display_label.replace('MISSING ', 'M') : clock(s.timeline.start)));
    clip.onclick = e => { e.stopPropagation(); seekEditor(s.timeline.start); };
    clip.oncontextmenu = e => showShotMenu(e, s); canvas.append(clip); }
  canvas.onclick = e => { const r = canvas.getBoundingClientRect(); seekEditor((e.clientX - r.left) / zoom); };
  canvas.append(el('div', { class: 'playhead', id: 'timelinePlayhead', 'data-zoom': String(zoom), style: `left:${PLAYER.time * zoom}px` }));
  const scroll = el('div', { class: 'timeline-scroll' }, canvas);
  box.append(el('div', { class: 'trow' }, el('div', { class: 'tlbl' }, 'Shots'), scroll));
  const voice = el('div', { class: 'voice-bar', style: `width:${width}px` });
  box.append(el('div', { class: 'trow' }, el('div', { class: 'tlbl' }, 'Voice'), el('div', { class: 'timeline-scroll' }, voice)));
  return box;
}
async function patchShot(shot_id, op) {
  const { ok, data, status } = await api('/edl', { method: 'PATCH', body: JSON.stringify({ expected_revision: EDL.revision, ops: [{ shot_id, ...op }] }) });
  if (!ok) { toast(data.message || 'save fail', 'bad'); if (status === 409) viewEditor(); return; }
  EDL = data.edl; toast('saved · rev ' + data.revision, 'ok'); viewEditor();
}

// ===================== simple views =====================
function viewQueue() {
  ++VIEW_EPOCH;
  const v = $('#view'); v.className = ''; v.innerHTML = ''; topBar('Queue', 'Ek saath kai videos — abhi coming soon');
  v.append(el('div', { class: 'wrap' }, el('div', { class: 'card' },
    el('h3', {}, 'Queue (aa raha hai)'),
    el('p', { class: 'hint' }, 'Aage: 5-10 videos ek saath queue mein bhejo — sab ek saath check hon, phir ek-ek edit karke final export. Abhi ek waqt mein ek project (New Video) chalta hai.'),
    el('p', { class: 'small muted' }, 'Jab tak: New Video se ek video banao → editor → export → phir Fresh start se agli.'))));
}
function viewLibrary() {
  ++VIEW_EPOCH;
  const v = $('#view'); v.className = ''; v.innerHTML = ''; topBar('Library', 'Sourcing abhi research-pack se hoti hai');
  v.append(el('div', { class: 'wrap' }, el('div', { class: 'card' },
    el('h3', {}, 'Library (aa raha hai)'),
    el('p', { class: 'hint' }, 'Design mein Library apni downloaded movies ko index karti hai. Abhi ye tool research-pack (Genspark) + online sources se chalta hai — wahi aapka asli flow hai. Local-movie library indexing baad ke milestone mein.'),
    el('button', { class: 'btn', onclick: showGenspark }, 'Research pack kaise banaye'))));
}
async function viewSettings(epoch = ++VIEW_EPOCH) {
  const v = $('#view'); v.className = ''; v.innerHTML = ''; topBar('Settings', null);
  const box = el('div', { class: 'wrap' }); v.append(box);
  const { data } = await api('/health');
  if (epoch !== VIEW_EPOCH || VIEW !== 'settings') return;
  box.append(el('div', { class: 'card' }, el('h3', {}, 'Tool'),
    el('div', { class: 'rowline' }, el('span', { class: 'k' }, 'version'), el('span', {}, (data && data.ui) || '?')),
    el('div', { class: 'rowline' }, el('span', { class: 'k' }, 'node'), el('span', {}, (data && data.node) || '?')),
    el('div', { class: 'rowline' }, el('span', { class: 'k' }, 'server'), el('span', {}, '127.0.0.1 (sirf is computer par)'))));
  box.append(el('div', { class: 'card' }, el('h3', {}, 'Theme'),
    el('div', { style: 'display:flex;gap:8px' }, el('button', { class: 'btn', onclick: () => setTheme('dark') }, 'Dark'), el('button', { class: 'btn', onclick: () => setTheme('light') }, 'Light'))));
  box.append(el('div', { class: 'card' }, el('h3', {}, 'Fresh start'),
    el('p', { class: 'hint' }, 'Abhi ka sab kaam archive\\ mein bhej kar naya project shuru karo (kuch delete nahi hota).'),
    el('button', { class: 'btn danger', onclick: freshStart }, 'Fresh start')));
}

// ===================== shell wiring =====================
const VIEWS = { newvideo: viewNewVideo, missing: viewMissing, editor: viewEditor, queue: viewQueue, library: viewLibrary, settings: viewSettings };
function refreshView() { return (VIEWS[VIEW] || viewNewVideo)(); }
function setView(v) { VIEW = v; renderNav(); refreshView(); }
function setTheme(t) { document.documentElement.setAttribute('data-theme', t); try { localStorage.setItem('rfc-theme', t); } catch {} }
$('#themeBtn').onclick = () => setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
window.addEventListener('keydown', e => {
  if (VIEW !== 'editor' || /INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '')) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlayer(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); seekEditor(PLAYER.time - 2, PLAYER.playing); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); seekEditor(PLAYER.time + 2, PLAYER.playing); }
});

(async function init() {
  const bootEpoch = VIEW_EPOCH;
  try { setTheme(localStorage.getItem('rfc-theme') || 'dark'); } catch {}
  renderNav();
  try { await refreshState(); } catch { toast('server se connect nahi hua', 'bad'); }
  // User server response se pehle nav click kar de to boot us choice ko wapas
  // New Video par overwrite na kare.
  if (VIEW_EPOCH === bootEpoch) setView('newvideo');
  else refreshView(); // early nav choice rakho, ab loaded STATE ke saath dobara paint
})();
