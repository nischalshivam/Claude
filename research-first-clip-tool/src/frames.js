'use strict';
// ============================================================================
//  src/frames.js — M5.3-FR : "Frame + custom background" LAYOUT variations.
//
//  Kya: kuch shots ko chhota "framed" bana kar unke PEECHE ek custom background
//  (aapke backgrounds/ folder ki image ya video) dikhana. Baaki sab fullscreen.
//  Ye ek OCCASIONAL ACCENT hai — poori video me sirf ~10-15 baar (default 12),
//  chahe video 20 min ki ho ya 40 min ki. Har baar ALAG frame-style + ALAG
//  background (seeded rotation) -> 50-60+ combinations, kabhi repetitive nahi.
//
//  Design rules (transitions jaisa):
//   - Frame BADA hai (~84% width) — background ek border/margin jaisa dikhe.
//   - Sab AUTO: kaunse shots framed, kaunsa background, kaunsa frame-style — tool.
//   - DURATION-EXACT: sirf rendered segment ko compose karta hai, lambai same.
//   - Backgrounds folder khali ho to "blur-self" background (out-of-box chalta).
//   - Editor/other layouts untouched. framed_count=0 => bilkul off.
// ============================================================================

const fs = require('fs');
const path = require('path');
const U = require('./util.js');
const style = require('./style.js');

const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
const VID_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v']);

function backgroundsDir(root) { return path.join(style.baseRoot(root), 'backgrounds'); }

// backgrounds/ se images + videos padho. Nahi mile to khali (blur fallback).
function loadBackgrounds(root) {
  const dir = backgroundsDir(root);
  const images = [], videos = [];
  try {
    for (const f of fs.readdirSync(dir).sort()) {
      if (f.startsWith('.')) continue;
      const p = path.join(dir, f);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (!st.isFile() || st.size < 512) continue;
      const e = path.extname(f).toLowerCase();
      if (IMG_EXT.has(e)) images.push(p);
      else if (VID_EXT.has(e)) videos.push(p);
    }
  } catch {}
  const all = [...images.map(p => ({ type: 'image', path: p })), ...videos.map(p => ({ type: 'video', path: p }))];
  return { dir, images, videos, all };
}

// background folder ka fingerprint (add/remove/replace -> render_sig badle)
function backgroundsSignature(root) {
  const dir = backgroundsDir(root);
  try {
    const parts = fs.readdirSync(dir).sort().filter(f => !f.startsWith('.')).map(f => {
      try { const s = fs.statSync(path.join(dir, f)); return `${f}:${s.size}:${Math.round(s.mtimeMs)}`; } catch { return f; }
    });
    return parts.join('|');
  } catch { return ''; }
}

// ---------- seeded PRNG ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pickDiff(list, prevKey, rnd, keyFn) {
  const k = keyFn || (x => x);
  if (list.length <= 1) return list[0];
  let x, g = 0;
  do { x = list[Math.floor(rnd() * list.length)]; g++; } while (k(x) === prevKey && g < 8);
  return x;
}

// ============================================================================
//  FRAME STYLE palette — auto-vary (rounded + sharp, border, size, shadow).
//  size = clip width / canvas width (BADA: 0.80..0.88). radius sirf round ke liye.
// ============================================================================
const FRAME_STYLES = [
  { id: 'round_soft_xl',   corners: 'round', radius: 36, size: 0.87, border: 0, shadow: { sigma: 26, aa: 0.5 } },
  { id: 'round_border_lg', corners: 'round', radius: 30, size: 0.85, border: 7, borderColor: 'white@0.95', shadow: { sigma: 24, aa: 0.5 } },
  { id: 'sharp_border_xl', corners: 'sharp', size: 0.87, border: 6, borderColor: 'white@0.95', shadow: { sigma: 22, aa: 0.55 } },
  { id: 'sharp_thin_lg',   corners: 'sharp', size: 0.84, border: 4, borderColor: 'white@0.9', shadow: { sigma: 18, aa: 0.6 } },
  { id: 'round_noborder_lg', corners: 'round', radius: 28, size: 0.84, border: 0, shadow: { sigma: 28, aa: 0.45 } },
  { id: 'sharp_grey_lg',   corners: 'sharp', size: 0.85, border: 5, borderColor: '0xd6d6d6@0.9', shadow: { sigma: 20, aa: 0.55 } },
  { id: 'round_border_md', corners: 'round', radius: 40, size: 0.82, border: 8, borderColor: 'white@0.95', shadow: { sigma: 26, aa: 0.5 } },
  { id: 'sharp_noborder_xl', corners: 'sharp', size: 0.88, border: 0, shadow: { sigma: 24, aa: 0.55 } },
  { id: 'round_tight_md',  corners: 'round', radius: 24, size: 0.81, border: 0, shadow: { sigma: 16, aa: 0.6 } },
  { id: 'sharp_border_lg', corners: 'sharp', size: 0.85, border: 6, borderColor: 'white@0.92', shadow: { sigma: 22, aa: 0.5 } },
];
const IMG_MOTIONS = ['static', 'zoom']; // images: static ya slow-zoom; videos apni motion

// ---------- placement plan: kaun se shots framed, kaunse style/bg/motion ----------
// count shots ko poori timeline me FAILA kar chunta hai (spread), kabhi 2 aas-paas
// nahi. Missing/placeholder aur bahut chhoti shots skip. Deterministic (seed).
function planFramed(slots, choice, backgrounds) {
  const c = style.normalizeChoice(choice);
  const map = new Map();
  const count = c.framed_count | 0;
  if (!c.enabled || count <= 0) return map;
  const rnd = mulberry32((c.seed >>> 0 || 1) ^ 0x9e3779b9);
  const eligible = [];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const dur = s.dur || (s.end - s.start) || 0;
    if (s.missing_label) continue;        // draft placeholder ko frame nahi
    if (dur < 1.3) continue;              // frame padhne ke liye kam se kam ~1.3s
    eligible.push(i);
  }
  if (!eligible.length) return map;
  const n = Math.min(count, eligible.length);
  // spread: eligible ko n buckets me baanto, har bucket se ek (non-adjacent)
  const bucket = eligible.length / n;
  const chosen = [];
  let lastPos = -99;
  for (let k = 0; k < n; k++) {
    const start = Math.floor(k * bucket);
    const end = Math.max(start + 1, Math.floor((k + 1) * bucket));
    let pos = start + Math.floor(rnd() * (end - start));
    if (pos <= lastPos) pos = Math.min(eligible.length - 1, lastPos + 1);
    if (eligible[pos] === undefined) continue;
    // adjacency guard: pichhle chune shot se kam se kam 1 shot door
    if (chosen.length && Math.abs(eligible[pos] - chosen[chosen.length - 1]) < 2) continue;
    chosen.push(eligible[pos]); lastPos = pos;
  }
  // assign non-repeating style + background + motion
  const bgPool = backgrounds.all.length ? backgrounds.all : [{ type: 'blur' }];
  let pStyle = null, pBg = null, pMotion = null;
  for (const si of chosen) {
    const st = pickDiff(FRAME_STYLES, pStyle, rnd, x => x.id); pStyle = st.id;
    const bg = pickDiff(bgPool, pBg, rnd, x => x.path || x.type); pBg = bg.path || bg.type;
    const motion = bg.type === 'video' ? 'loop' : (bg.type === 'blur' ? 'static' : pickDiff(IMG_MOTIONS, pMotion, rnd)); pMotion = motion;
    map.set(si, { style: st, bg, motion });
  }
  return map;
}

// ---------- rounded-rect alpha mask (cache per geometry) ----------
function ensureMask(workDir, fw, fh, r) {
  const mp = path.join(workDir, `_framemask_${fw}x${fh}_r${r}.png`);
  if (fs.existsSync(mp)) return mp;
  const dx = `max(max(0\\,${r}-X)\\,X-(${fw}-${r}))`;
  const dy = `max(max(0\\,${r}-Y)\\,Y-(${fh}-${r}))`;
  const r2 = r * r;
  const g = `format=gray,geq=lum='if(lte((${dx})*(${dx})+(${dy})*(${dy})\\,${r2})\\,255\\,0)'`;
  const out = U.ffmpeg(['-f', 'lavfi', '-i', `color=black:s=${fw}x${fh}`, '-frames:v', '1', '-vf', g, mp]);
  return (out.ok && fs.existsSync(mp)) ? mp : null;
}

// ---------- composite ONE framed shot ----------
// segFile (fullscreen rendered clip) -> chhota framed clip on background -> outFile.
// transChain = style.transitionChain(pl) (dip fades) — boundary neighbor se match.
function composite(segFile, outFile, dur, opts, workDir, cfg, W, H, FPS, transChain) {
  const st = opts.style, bg = opts.bg, motion = opts.motion;
  const enc = ['-c:v', 'libx264', '-preset', (cfg.render && cfg.render.preset) || 'veryfast',
    '-crf', String((cfg.render && cfg.render.crf) || 21), '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an'];
  // geometry: frame width = size*W (even), height keeps canvas aspect
  const fw = Math.round(W * st.size / 2) * 2;
  const fh = Math.round(fw * H / W / 2) * 2;
  const mx = Math.floor((W - fw) / 2), my = Math.floor((H - fh) / 2);
  const border = st.border || 0;
  const innerW = fw - 2 * border, innerH = fh - 2 * border;

  const inputs = [];
  const fc = [];
  let idx = 0;
  // input 0: rendered seg
  inputs.push('-i', segFile); const SEG = idx++;
  // background input
  let BGIN = -1, needSplit = false;
  if (bg.type === 'image') { inputs.push('-loop', '1', '-i', bg.path); BGIN = idx++; }
  else if (bg.type === 'video') { inputs.push('-stream_loop', '-1', '-i', bg.path); BGIN = idx++; }
  else { needSplit = true; } // blur: seg itself
  // shadow lavfi
  inputs.push('-f', 'lavfi', '-i', `color=black:s=${fw + 40}x${fh + 40}:r=${FPS}`); const SH = idx++;
  // mask (rounded)
  let MASK = -1;
  if (st.corners === 'round') { const m = ensureMask(workDir, fw, fh, st.radius); if (m) { inputs.push('-i', m); MASK = idx++; } }

  // seg split (blur bg reuses seg)
  let fgSrc = `${SEG}:v`, bgSrc;
  if (needSplit) { fc.push(`[${SEG}:v]split[fgsrc][bgsrc]`); fgSrc = 'fgsrc'; bgSrc = 'bgsrc'; }

  // background chain -> [bgx]
  if (bg.type === 'blur') {
    fc.push(`[${bgSrc}]scale=${W}:${H},gblur=sigma=30,eq=brightness=-0.05,setsar=1[bgx]`);
  } else if (motion === 'zoom') {
    fc.push(`[${BGIN}:v]scale=${Math.round(W * 1.3)}:-2,zoompan=z='min(1+0.0007*on\\,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},eq=brightness=-0.05,setsar=1[bgx]`);
  } else {
    fc.push(`[${BGIN}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},eq=brightness=-0.05,setsar=1[bgx]`);
  }
  // shadow -> [shx]
  fc.push(`[${SH}:v]format=yuva420p,colorchannelmixer=aa=${st.shadow.aa},gblur=sigma=${st.shadow.sigma}[shx]`);
  // foreground clip -> [fgr]
  let fg = `[${fgSrc}]scale=${innerW}:${innerH},setsar=1`;
  if (border) fg += `,pad=${fw}:${fh}:${border}:${border}:${st.borderColor || 'white@0.95'}`;
  if (st.corners === 'round' && MASK >= 0) { fg += `,format=rgba[fgc];[fgc][${MASK}:v]alphamerge[fgr]`; }
  else { fg += `[fgr]`; }
  fc.push(fg);
  // compose: bg + shadow(offset) + fg, then transition fades
  fc.push(`[bgx][shx]overlay=${mx - 20 + 8}:${my - 20 + 14}[b1]`);
  let last = `[b1][fgr]overlay=${mx}:${my}`;
  if (transChain) last += ',' + transChain;
  last += ',format=yuv420p[v]';
  fc.push(last);

  const r = U.ffmpeg([...inputs, '-t', dur.toFixed(3), '-filter_complex', fc.join(';'), '-map', '[v]', ...enc, outFile],
    { timeout: 300000 });
  return { ok: r.ok && fs.existsSync(outFile), err: r.ok ? '' : (r.stderr || '').slice(0, 160) };
}

// catalog for UI/guide
function catalog() {
  return { frame_styles: FRAME_STYLES.map(s => ({ id: s.id, corners: s.corners, size: s.size, border: s.border })),
    image_motions: IMG_MOTIONS };
}

module.exports = {
  backgroundsDir, loadBackgrounds, backgroundsSignature,
  planFramed, composite, ensureMask, catalog,
  FRAME_STYLES,
};
