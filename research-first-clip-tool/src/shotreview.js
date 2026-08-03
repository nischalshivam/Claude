// ============================================================
//  Stage 9b — SHOT REVIEW (contact sheet).
//
//  Kyun: percentage kabhi nahi bata sakta ki screen par SAHI character hai ya
//  nahi, reaction-host to nahi aa gaya, ya scene ka matlab sahi hai. Ye engine
//  deterministic hai — wo ye semantically samajh hi nahi sakta. Isliye final
//  video ke HAR shot ka ek thumbnail nikaal kar ek page par rakh dete hain,
//  narration cue + must_show/must_not_show + source/time + hint delta ke saath.
//  2 minute mein poori video ki visual audit ho jati hai.
//
//  Thumbnails FINAL RENDER se aate hain (plan se nahi) — yaani jo dikh raha hai
//  wahi audit ho raha hai.
//
//  Galat shot dikhe to "mark wrong" dabao -> review-fixes.csv download ho jati
//  hai, jisme sirf wahi moments hote hain. Poora job dobara nahi chalana padta.
// ============================================================
const fs = require('fs');
const path = require('path');
const U = require('./util.js');

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// har shot ke beech se ek thumbnail — FINAL video se
function grabThumbs(id, finalPath, shots, cfg) {
  const dir = U.ensureDir(U.p(id, 'thumbs'));
  const out = [];
  const w = (cfg && cfg.report && cfg.report.thumbWidth) || 384;
  for (const s of shots) {
    const at = Math.max(0, s.start + Math.min(1.0, s.dur / 2));
    const f = path.join(dir, `shot_${String(s.i).padStart(4, '0')}.jpg`);
    if (!fs.existsSync(f)) {
      const r = U.ffmpeg(['-ss', at.toFixed(3), '-i', finalPath, '-frames:v', '1',
        '-vf', `scale=${w}:-2`, '-q:v', '5', f], { timeout: 60000 });
      if (!r.ok || !fs.existsSync(f)) { out.push(null); continue; }
    }
    out.push(path.relative(U.jobDir(id), f));
  }
  return out;
}

const CLASS_COLOR = {
  EXACT_VIDEO: '#2f9e44', CONTEXT_VIDEO: '#1971c2', VERIFIED_SOURCE_STILL: '#5f3dc4',
  MONTAGE: '#0c8599', TEMPLATE_GRAPHIC_MEDIA: '#e8590c',
  GENERIC_TEXT_GRAPHIC: '#c92a2a', DIAGNOSTIC_CARD: '#c92a2a', RENDER_FAILURE_FALLBACK: '#c92a2a',
};

module.exports = function shotReview(spec, cfg, st) {
  const id = spec.id;
  const manFile = U.p(id, 'render-manifest.json');
  const finalPath = U.p(id, 'final.mp4');
  if (!fs.existsSync(manFile) || !fs.existsSync(finalPath)) return null;
  let man; try { man = JSON.parse(fs.readFileSync(manFile, 'utf8')); } catch { return null; }
  const shots = man.shots || [];
  if (!shots.length) return null;

  const thumbs = grabThumbs(id, finalPath, shots, cfg);
  const total = shots.reduce((a, s) => a + (s.dur || 0), 0) || 1;
  const bySec = {};
  for (const s of shots) bySec[s.asset] = (bySec[s.asset] || 0) + (s.dur || 0);

  const cards = shots.map((s, k) => {
    const col = CLASS_COLOR[s.asset] || '#495057';
    const hint = s.hint_time != null ? `hint ${s.hint_time}s → ${s.image_time != null ? s.image_time + 's' : '?'} (Δ${s.hint_delta ?? '?'}s)` : '';
    const src = [s.source_id, s.media_start != null ? `@${Math.round(s.media_start)}s` : (s.image_time != null ? `@${Math.round(s.image_time)}s` : '')].filter(Boolean).join(' ');
    return `<div class="card" data-moment="${esc(s.moment_id)}" data-shot="${s.i}">
  <div class="thumbwrap">${thumbs[k] ? `<img loading="lazy" src="${esc(thumbs[k])}">` : '<div class="nothumb">no frame</div>'}
    <span class="badge" style="background:${col}">${esc(s.asset)}</span>
    <span class="tc">${fmt(s.start)} · ${(s.dur || 0).toFixed(1)}s</span></div>
  <div class="meta">
    <div class="cue">${esc((s.cue || '').slice(0, 150))}</div>
    <div class="row"><b>${esc(s.moment_id || '')}</b> ${esc(s.pack_id || '')} ${src ? '· ' + esc(src) : ''}</div>
    ${hint ? `<div class="row hint">${esc(hint)}</div>` : ''}
    ${(s.must_show || []).length ? `<div class="row ok">must show: ${esc((s.must_show || []).join(', '))}</div>` : ''}
    ${(s.must_not_show || []).length ? `<div class="row no">must NOT show: ${esc((s.must_not_show || []).join(', '))}</div>` : ''}
    ${s.asset_note ? `<div class="row warn">${esc(s.asset_note)}</div>` : ''}
    <div class="row why">${esc((s.why || '').slice(0, 160))}</div>
    ${s.url ? `<a class="row" href="${esc(s.url)}" target="_blank">source video</a>` : ''}
    <label class="flag"><input type="checkbox" class="wrong"> ye shot galat hai</label>
  </div></div>`;
  }).join('\n');

  const legend = Object.entries(bySec).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<span class="lg"><i style="background:${CLASS_COLOR[k] || '#495057'}"></i>${esc(k)} ${(v / total * 100).toFixed(1)}%</span>`).join('');

  const html = `<meta charset="utf-8"><title>Shot review — ${esc(spec.id)}</title>
<style>
:root{color-scheme:light dark}
body{font:14px/1.45 system-ui,Segoe UI,Roboto,sans-serif;margin:0;background:#0f1115;color:#e6e9ef}
header{position:sticky;top:0;z-index:9;background:#151922;padding:14px 18px;border-bottom:1px solid #263041}
h1{font-size:17px;margin:0 0 6px}
.lg{display:inline-flex;align-items:center;gap:6px;margin-right:14px;font-size:12px;color:#aab3c2}
.lg i{width:11px;height:11px;border-radius:3px;display:inline-block}
.bar{display:flex;height:8px;border-radius:4px;overflow:hidden;margin:8px 0 4px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px;padding:16px}
.card{background:#161b24;border:1px solid #232b39;border-radius:10px;overflow:hidden}
.card.flagged{border-color:#c92a2a;box-shadow:0 0 0 1px #c92a2a inset}
.thumbwrap{position:relative;background:#000;aspect-ratio:16/9}
.thumbwrap img{width:100%;height:100%;object-fit:cover;display:block}
.nothumb{display:grid;place-items:center;height:100%;color:#5c6675;font-size:12px}
.badge{position:absolute;left:8px;top:8px;font-size:10px;font-weight:700;letter-spacing:.4px;padding:3px 7px;border-radius:5px;color:#fff}
.tc{position:absolute;right:8px;bottom:8px;font-size:11px;background:#000a;padding:2px 6px;border-radius:4px;color:#cfd6e2}
.meta{padding:10px 12px}
.cue{color:#dfe5ef;margin-bottom:7px;font-size:13px}
.row{font-size:11.5px;color:#93a0b3;margin:3px 0;word-break:break-word}
.row.ok{color:#69db7c}.row.no{color:#ffa8a8}.row.hint{color:#74c0fc}.row.warn{color:#ffd43b}.row.why{color:#7b8798;font-style:italic}
a.row{color:#74c0fc;text-decoration:none}
.flag{display:flex;gap:7px;align-items:center;margin-top:9px;font-size:12px;color:#aab3c2;cursor:pointer}
button{background:#2b6cb0;color:#fff;border:0;padding:8px 14px;border-radius:7px;cursor:pointer;font-size:13px}
</style>
<header>
  <h1>Shot review — ${esc(spec.id)} · ${shots.length} shots · ${fmt(total)}</h1>
  <div class="bar">${shots.map(s => `<span style="flex:${(s.dur || 0.1)};background:${CLASS_COLOR[s.asset] || '#495057'}" title="${esc(s.asset)}"></span>`).join('')}</div>
  <div>${legend}</div>
  <p style="font-size:12px;color:#8b95a5;margin:8px 0 0">
    Ye thumbnails FINAL video se hain — jo screen par hai wahi. Engine ye nahi samajh sakta ki
    character sahi hai ya nahi, isliye ek nazar yahan daalna zaroori hai.
    Galat shot par tick lagao, phir neeche se CSV nikaal lo — sirf un moments ki research dobara karani hogi.
  </p>
  <p style="margin:10px 0 0"><button id="exp">galat shots ki CSV nikaalo</button> <span id="cnt" style="color:#8b95a5;font-size:12px"></span></p>
</header>
<div class="grid">${cards}</div>
<script>
const cnt=document.getElementById('cnt');
function upd(){const n=document.querySelectorAll('.wrong:checked').length;cnt.textContent=n?n+' flagged':'';}
document.addEventListener('change',e=>{if(e.target.classList.contains('wrong')){e.target.closest('.card').classList.toggle('flagged',e.target.checked);upd();}});
document.getElementById('exp').onclick=()=>{
  const rows=[['moment_id','shot','start_sec','asset','source_id','cue']];
  document.querySelectorAll('.wrong:checked').forEach(c=>{const k=c.closest('.card');
    rows.push([k.dataset.moment,k.dataset.shot,k.querySelector('.tc').textContent.split(' · ')[0],
      k.querySelector('.badge').textContent,(k.querySelector('.row b')||{}).textContent||'',
      '"'+(k.querySelector('.cue').textContent||'').replace(/"/g,'""')+'"']);});
  if(rows.length===1){alert('koi shot flag nahi kiya');return;}
  const blob=new Blob([rows.map(r=>r.join(',')).join('\\n')],{type:'text/csv'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='review-fixes.csv';a.click();
};
</script>`;

  const out = U.p(id, 'shot-review.html');
  fs.writeFileSync(out, html);
  st.meta.shot_review = { shots: shots.length, thumbs: thumbs.filter(Boolean).length };
  U.ok(`shot-review.html — ${shots.length} shots ka contact sheet (har shot ka asli frame + evidence)`);
  return out;
};

function fmt(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
