#!/usr/bin/env node
// ============================================================
//  LOCAL UI (M4) — missing media bharne ka dashboard.
//
//  Sirf 127.0.0.1 par chalta hai. Koi account, koi cloud, koi API key,
//  koi npm package. Node ka apna http server hi kaafi hai.
//
//  Yahan wahi core modules chalte hain jo CLI chalata hai — do alag
//  implementations nahi. Isliye jo folder se karoge wahi UI se hoga.
//
//    node tools/ui.js          -> http://127.0.0.1:7801
// ============================================================
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const U = require(path.join(ROOT, 'src', 'util.js'));
const manual = require(path.join(ROOT, 'src', 'manual.js'));

const DATA = path.join(ROOT, 'DATA');
const PORT = Number((process.argv.find(a => a.startsWith('--port=')) || '').slice(7)) || 7801;
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch {}

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clock = t => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const json = (res, obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

// ---- running job log (Build Draft / Build Final) ----
let running = null;
const runLog = [];
function startRun(args, label) {
  if (running) return false;
  runLog.length = 0;
  runLog.push(`> ${label}`);
  running = spawn('node', [path.join('src', 'run.js'), ...args], { cwd: ROOT, env: process.env });
  const push = b => { for (const l of String(b).split('\n')) if (l.trim()) runLog.push(l); if (runLog.length > 600) runLog.splice(0, runLog.length - 600); };
  running.stdout.on('data', push);
  running.stderr.on('data', push);
  running.on('close', c => { runLog.push(`> khatam (exit ${c})`); running = null; });
  return true;
}

// ---- upload target: request folder ke media/ ke ANDAR hi, kahin aur nahi ----
function requestDir(rid) {
  if (!fs.existsSync(DATA)) return null;
  for (const n of fs.readdirSync(DATA)) {
    if (!/^MISSING_\d{3}__/.test(n)) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(DATA, n, 'request.json'), 'utf8'));
      if (r.request_id === rid) return path.join(DATA, n);
    } catch {}
  }
  return null;
}
// filename se har khatarnak cheez nikal do — koi ".." nahi, koi drive letter nahi
function safeName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  const clean = base.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '').slice(0, 120);
  return clean || `file_${Date.now()}`;
}

function readBody(req, limit = 400 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('file bahut badi hai')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function setOverride(rid, patch) {
  const ov = manual.readOverrides(DATA);
  ov.schema = 'manual-overrides-v1';
  ov.requests = ov.requests || [];
  let e = ov.requests.find(r => r.request_id === rid);
  if (!e) { e = { request_id: rid }; ov.requests.push(e); }
  Object.assign(e, patch);
  manual.writeOverrides(DATA, ov);
}

// ---------------- page ----------------
function page() {
  const s = manual.scan(DATA, { cfg });
  const done = s.requests.filter(r => r.status === 'READY').length;
  const ready = s.requests.length > 0 && done === s.requests.length;
  const state = !s.requests.length ? 'AUTO_READY' : (ready ? 'HYBRID_READY' : 'NEEDS_HUMAN_MEDIA');
  const STATE_TEXT = {
    AUTO_READY: 'Koi khaali jagah nahi — video automatic hi poori ban sakti hai.',
    NEEDS_HUMAN_MEDIA: `${s.requests.length - done} jagah abhi aapke media ka intezaar hai. Neeche har jagah ke liye likha hai kya chahiye.`,
    HYBRID_READY: 'Sab jagah bhar chuki. Ab final video bana sakte ho.',
  };

  const cards = s.requests.map(r => {
    const q = (() => { try { return JSON.parse(fs.readFileSync(path.join(r.dir, 'request.json'), 'utf8')); } catch { return {}; } })();
    const files = r.files.map(f => `<li><b>${esc(f.file)}</b> <span class="t">${esc(f.type)}${f.duration ? ' · ' + f.duration.toFixed(1) + 's' : ''}${f.width ? ' · ' + f.width + 'x' + f.height : ''}</span>
      ${f.warnings.map(w => `<div class="warn">${esc(w)}</div>`).join('')}</li>`).join('');
    const bad = r.invalid.map(b => `<li class="bad"><b>${esc(b.file)}</b> — ${esc(b.problem)}</li>`).join('');
    const searches = (q.search_queries || []).map(x =>
      `<a target="_blank" href="https://www.youtube.com/results?search_query=${encodeURIComponent(x)}">YouTube</a>
       <a target="_blank" href="https://duckduckgo.com/?iax=images&ia=images&q=${encodeURIComponent(x)}">Images</a>
       <code>${esc(x)}</code>`).join('<br>');
    return `<div class="card ${esc(r.status)}" data-rid="${esc(r.request_id)}">
  <h3>${esc(r.folder.split('__')[0].replace('_', ' '))} <span class="badge">${esc(r.status.replace(/_/g, ' ').toLowerCase())}</span></h3>
  <div class="rng">${clock(r.range.start_sec)} – ${clock(r.range.end_sec)} &nbsp;·&nbsp; ${r.range.duration_sec.toFixed(1)}s${r.short_seconds > 0 ? ` &nbsp;·&nbsp; <span class="need">${r.short_seconds}s aur chahiye</span>` : ''}</div>
  <p class="cue">"${esc(r.narration_exact)}"</p>
  ${(q.reason_text || []).length ? `<p class="why">Kyun nahi mila: ${esc(q.reason_text.join('; '))}</p>` : ''}
  ${(q.must_show || []).length ? `<p class="ms">dikhna chahiye: ${esc(q.must_show.join(', '))}</p>` : ''}
  ${(q.must_not_show || []).length ? `<p class="mn">NAHI dikhna chahiye: ${esc(q.must_not_show.join(', '))}</p>` : ''}
  ${searches ? `<div class="search">${searches}</div>` : ''}
  <div class="drop" data-rid="${esc(r.request_id)}">yahan files drag karo (ya click karke chuno)
    <input type="file" multiple hidden></div>
  ${files || bad ? `<ul class="files">${files}${bad}</ul>` : '<p class="t">abhi koi file nahi</p>'}
  <label><input type="checkbox" class="reuse" ${r.allow_reuse ? 'checked' : ''}> media kam pade to files dobara istemal kar lo</label>
  <p class="t">order badalna ho to file ke naam ke aage 01_, 02_, 03_ laga do</p>
</div>`;
  }).join('\n');

  return `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Missing media — clip tool</title>
<style>
body{font:14px/1.6 system-ui,Segoe UI,sans-serif;background:#0f1115;color:#e6e9ef;margin:0;padding:20px;max-width:1000px}
h1{font-size:21px;margin:0 0 6px}h3{font-size:15px;margin:0 0 6px}
.state{padding:13px 16px;border-radius:9px;margin:14px 0;font-weight:600}
.HYBRID_READY,.AUTO_READY{background:#12351d;color:#8ce99a;border:1px solid #2f9e44}
.NEEDS_HUMAN_MEDIA{background:#33280f;color:#ffd8a8;border:1px solid #e8590c}
.bar{display:flex;gap:9px;margin:14px 0;flex-wrap:wrap}
button{background:#2b6cb0;color:#fff;border:0;padding:9px 15px;border-radius:7px;cursor:pointer;font-size:13.5px}
button:disabled{background:#39414f;color:#8b95a5;cursor:not-allowed}
button.go{background:#2f9e44}
.card{background:#161b24;border:1px solid #232b39;border-radius:10px;padding:14px 16px;margin:12px 0}
.card.READY{border-color:#2f9e44}.card.WAITING_FOR_MEDIA{border-color:#e8590c}.card.NEEDS_MORE_MEDIA{border-color:#e8590c}
.badge{font-size:10.5px;font-weight:700;padding:3px 8px;border-radius:5px;background:#39414f;vertical-align:2px}
.card.READY .badge{background:#2f9e44}
.rng{color:#8b95a5;font-size:12.5px}.need{color:#ffd43b}
.cue{color:#dfe5ef;margin:8px 0}
.why{color:#ffa8a8;font-size:12.5px;margin:4px 0}
.ms{color:#69db7c;font-size:12.5px;margin:2px 0}.mn{color:#ffa8a8;font-size:12.5px;margin:2px 0}
.search{font-size:12px;margin:8px 0;color:#8b95a5}.search a{color:#74c0fc;margin-right:8px}
.search code{background:#0b0e14;padding:2px 6px;border-radius:4px;color:#aab3c2}
.drop{border:2px dashed #39414f;border-radius:9px;padding:18px;text-align:center;color:#8b95a5;margin:10px 0;cursor:pointer}
.drop.over{border-color:#2b6cb0;color:#74c0fc;background:#141c28}
.files{margin:8px 0;padding-left:20px;font-size:12.5px}
.files .t{color:#8b95a5}.files .bad{color:#ffa8a8}
.warn{color:#ffd43b;font-size:11.5px}
.t{color:#8b95a5;font-size:12px}
label{display:block;margin:8px 0;font-size:12.5px;color:#aab3c2}
pre{background:#0b0e14;border:1px solid #232b39;border-radius:8px;padding:12px;max-height:280px;overflow:auto;font-size:11.5px;color:#aab3c2}
</style>
<h1>Missing media</h1>
<div class="t">Jo footage internet par mil hi nahi raha, uske liye tool yahan aapse media maang raha hai. Audio kabhi nahi badlega.</div>
<div class="state ${state}">${esc(STATE_TEXT[state])}</div>
<div class="bar">
  <button id="draft">Draft banao (placeholder ke saath)</button>
  <button id="final" class="go" ${ready ? '' : 'disabled'}>Final video banao</button>
  <button id="refresh">Refresh</button>
</div>
<pre id="log">${esc(runLog.join('\n')) || '(abhi kuch nahi chal raha)'}</pre>
${cards || '<div class="card"><p>Abhi koi request nahi. Pehle draft banao — tool khud bata dega kahan media chahiye.</p></div>'}
<script>
const post=(u,b)=>fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})});
document.getElementById('draft').onclick=()=>post('/api/run',{what:'draft'}).then(()=>poll());
document.getElementById('final').onclick=()=>post('/api/run',{what:'final'}).then(()=>poll());
document.getElementById('refresh').onclick=()=>location.reload();
document.querySelectorAll('.reuse').forEach(c=>c.onchange=e=>{
  const rid=e.target.closest('.card').dataset.rid;
  post('/api/override',{request_id:rid,allow_reuse:e.target.checked}).then(()=>location.reload());
});
document.querySelectorAll('.drop').forEach(d=>{
  const input=d.querySelector('input');
  d.onclick=()=>input.click();
  input.onchange=()=>send(d.dataset.rid,[...input.files]);
  d.ondragover=e=>{e.preventDefault();d.classList.add('over');};
  d.ondragleave=()=>d.classList.remove('over');
  d.ondrop=e=>{e.preventDefault();d.classList.remove('over');send(d.dataset.rid,[...e.dataTransfer.files]);};
});
async function send(rid,files){
  for(const f of files){
    const t=document.querySelector('.drop[data-rid="'+rid+'"]');
    t.textContent='bhej raha hoon: '+f.name;
    await fetch('/api/upload?rid='+encodeURIComponent(rid)+'&name='+encodeURIComponent(f.name),
      {method:'POST',body:f});
  }
  location.reload();
}
let timer=null;
function poll(){ if(timer) return; timer=setInterval(async()=>{
  const r=await fetch('/api/log').then(x=>x.json());
  document.getElementById('log').textContent=r.log.join('\\n');
  if(!r.running){clearInterval(timer);timer=null;setTimeout(()=>location.reload(),800);}
},1200); }
</script>`;
}

// ---------------- server ----------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page());
    }
    if (u.pathname === '/api/log') return json(res, { running: !!running, log: runLog });
    if (req.method === 'POST' && u.pathname === '/api/run') {
      const body = JSON.parse((await readBody(req, 1e6)).toString() || '{}');
      if (running) return json(res, { ok: false, error: 'ek kaam already chal raha hai' }, 409);
      const started = body.what === 'final'
        ? startRun([], 'final video')
        : startRun(['--draft', '--redo'], 'draft');
      return json(res, { ok: started });
    }
    if (req.method === 'POST' && u.pathname === '/api/override') {
      const body = JSON.parse((await readBody(req, 1e6)).toString() || '{}');
      if (!body.request_id) return json(res, { ok: false }, 400);
      const patch = {};
      if ('allow_reuse' in body) patch.allow_reuse = !!body.allow_reuse;
      if ('approved' in body) patch.approved = !!body.approved;
      if (Array.isArray(body.files)) patch.files = body.files;
      setOverride(body.request_id, patch);
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && u.pathname === '/api/upload') {
      const rid = u.searchParams.get('rid');
      const dir = requestDir(rid);
      if (!dir) return json(res, { ok: false, error: 'ye request nahi mili' }, 404);
      const mediaDir = path.join(dir, 'media');
      fs.mkdirSync(mediaDir, { recursive: true });
      const name = safeName(u.searchParams.get('name'));
      const dest = path.join(mediaDir, name);
      // aakhri suraksha: likhna SIRF isi request ke media folder ke andar
      if (!U.isInside(mediaDir, dest)) return json(res, { ok: false, error: 'galat path' }, 400);
      const buf = await readBody(req);
      if (!buf.length) return json(res, { ok: false, error: 'file khaali hai' }, 400);
      fs.writeFileSync(dest, buf);
      const info = manual.inspectFile(dest);
      if (!info.ok) { fs.rmSync(dest, { force: true }); return json(res, { ok: false, error: info.problem }, 400); }
      return json(res, { ok: true, file: name, type: info.type });
    }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
  } catch (e) {
    json(res, { ok: false, error: String(e.message || e) }, 500);
  }
});

// SIRF localhost. Ye machine ke bahar se kabhi reachable nahi hona chahiye.
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log('='.repeat(66));
  console.log('  MISSING MEDIA DASHBOARD');
  console.log('='.repeat(66));
  console.log(`  ${url}`);
  console.log('  (sirf is computer par khulta hai — na internet, na account, na key)');
  console.log('  band karne ke liye ye window band kar do ya Ctrl+C dabao.');
  console.log('='.repeat(66));
  const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref(); } catch {}
});
