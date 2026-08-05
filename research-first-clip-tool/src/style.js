'use strict';
// ============================================================================
//  src/style.js — M5.2-TX : Transitions + Animations "style pass".
//
//  MAKSAD: har video AI-generated / repetitive na lage. Isliye shot-ke-andar
//  halki motion (Ken Burns: zoom/pan) aur shot-ke-boundary par transitions
//  (dip to black/white, blur dissolve, flash...) — dono ka VARIED, non-repeat
//  mix. 8 style-pack + "auto" + explicit "none".
//
//  SABSE ZAROORI DESIGN RULE (kyunki editor system mushkil se bana hai):
//   1. Ye pass poori tarah NON-DESTRUCTIVE hai. Ye sirf pehle se render ho chuke
//      per-shot segments par, concat se THEEK pehle, chalta hai.
//   2. pack === 'none'  => ye kuch NAHI karta. Render output byte-for-byte wahi
//      rehta hai jo pehle tha. (User ka "koi transition nahi chahiye" wala option.)
//   3. HAR effect DURATION-EXACT hai — per-segment fade / gblur / zoompan. Kisi
//      segment ki length nahi badalti, isliye master timeline aur narration
//      kabhi drift nahi hote. (Ye cross-dissolve/overlap wale drift se bachne ka
//      jaan-boojh kar liya faisla hai — dip+motion se variety milti hai bina
//      voiceover ko chhote kiye.)
//   4. Kisi ek segment par style-filter fail ho to hum us segment ka ORIGINAL
//      use karte hain (video banta rehta hai) aur manifest mein sach likhte hain.
//
//  Store: project/style.json  (EDL revisions se alag — style badalna EDL history
//  ko churn nahi karta). Render is file ko padh kar plan banata hai.
// ============================================================================

const fs = require('fs');
const path = require('path');
const U = require('./util.js');

// ---------- project root + persisted choice ----------
function baseRoot(root) {
  return root || (process.env.RFC_PROJECT_DIR ? path.resolve(process.env.RFC_PROJECT_DIR) : U.ROOT);
}
function projectRoot(root) { return path.join(baseRoot(root), 'project'); }
function stylePath(root) { return path.join(projectRoot(root), 'style.json'); }

const DEFAULT_CHOICE = { enabled: false, pack: 'none', seed: 1, transition_ms: 450, intensity: 1.0 };

function clamp(x, lo, hi) { x = Number(x); if (!isFinite(x)) return lo; return Math.max(lo, Math.min(hi, x)); }

function normalizeChoice(j) {
  j = j || {};
  const pack = PACKS[j.pack] ? j.pack : 'none';
  const enabled = pack !== 'none' && j.enabled !== false;
  const seed = Math.max(1, Math.floor(Number(j.seed) || 1));
  const transition_ms = Math.round(clamp(j.transition_ms != null ? j.transition_ms : 450, 120, 1200));
  const intensity = clamp(j.intensity != null ? j.intensity : 1.0, 0.3, 1.5);
  return { enabled, pack, seed, transition_ms, intensity };
}

function loadChoice(root) {
  try { return normalizeChoice(JSON.parse(fs.readFileSync(stylePath(root), 'utf8'))); }
  catch { return { ...DEFAULT_CHOICE }; }
}
function saveChoice(root, choice) {
  const c = normalizeChoice(choice);
  const dir = projectRoot(root); fs.mkdirSync(dir, { recursive: true });
  const tmp = stylePath(root) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, stylePath(root));
  return c;
}
// stable signature for render_sig — style badle to render dobara ho
function signature(root) {
  const c = loadChoice(root);
  if (!c.enabled) return 'style:none';
  return 'style:' + U.hashStr([c.pack, c.seed, c.transition_ms, c.intensity].join('|'));
}

// ---------- seeded PRNG (reproducible variety) ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
//  ANIMATION registry — per-shot motion. Sab zoompan se, global output-frame
//  expr `on` par (poore shot par smooth). Zoom hamesha >=1 (zoompan zoom-out
//  ko 1 se neeche allow nahi karta — zoom_out 1.12 -> 1.0 karta hai).
// ============================================================================
function kb(W, H, F, D, o) {
  const total = Math.max(1, Math.round(D * F));
  const denom = total > 1 ? total - 1 : 1;
  const z0 = o.z0 != null ? o.z0 : 1.0, z1 = o.z1 != null ? o.z1 : 1.0;
  const x0 = o.x0 != null ? o.x0 : 0.5, x1 = o.x1 != null ? o.x1 : 0.5; // margin fraction 0..1 (0.5 = center)
  const y0 = o.y0 != null ? o.y0 : 0.5, y1 = o.y1 != null ? o.y1 : 0.5;
  const p = `min(on/${denom}\\,1)`;
  const z = `${z0.toFixed(4)}+(${(z1 - z0).toFixed(4)})*${p}`;
  const x = `(iw-iw/zoom)*(${x0.toFixed(4)}+(${(x1 - x0).toFixed(4)})*${p})`;
  const y = `(ih-ih/zoom)*(${y0.toFixed(4)}+(${(y1 - y0).toFixed(4)})*${p})`;
  // pre-scale thoda upar taaki zoom karte waqt softness kam ho, phir zoompan.
  return `scale=${Math.round(W * 1.35 / 2) * 2}:-2,zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${W}x${H}:fps=${F}`;
}

const ANIMATIONS = {
  none:      { label: 'No motion (static frame)', build: null },
  zoom_in:   { label: 'Slow zoom in',    build: (D, W, H, F, I) => kb(W, H, F, D, { z0: 1.0, z1: 1.0 + 0.12 * I }) },
  zoom_out:  { label: 'Slow zoom out',   build: (D, W, H, F, I) => kb(W, H, F, D, { z0: 1.0 + 0.12 * I, z1: 1.0 }) },
  push_in:   { label: 'Punch-in (faster zoom)', build: (D, W, H, F, I) => kb(W, H, F, D, { z0: 1.0, z1: 1.0 + 0.20 * I }) },
  pan_right: { label: 'Pan left to right', build: (D, W, H, F, I) => kb(W, H, F, D, { z0: 1.08, z1: 1.08, x0: 0.0, x1: 1.0 }) },
  pan_left:  { label: 'Pan right to left', build: (D, W, H, F, I) => kb(W, H, F, D, { z0: 1.08, z1: 1.08, x0: 1.0, x1: 0.0 }) },
  pan_up:    { label: 'Pan bottom to top', build: (D, W, H, F, I) => kb(W, H, F, D, { z0: 1.08, z1: 1.08, y0: 1.0, y1: 0.0 }) },
  pan_down:  { label: 'Pan top to bottom', build: (D, W, H, F, I) => kb(W, H, F, D, { z0: 1.08, z1: 1.08, y0: 0.0, y1: 1.0 }) },
};

// ============================================================================
//  TRANSITION registry — boundary effects. HAR ek duration-exact hai: outgoing
//  shot ka tail aur incoming shot ka head independently fade/blur hote hain.
//  Boundary ke dono taraf same transition lagti hai (transIn[i] = transOut[i-1]),
//  isliye cut par dono black/white/blur "milte" hain — seamless dip.
//  d = per-side seconds. head()/tail() ffmpeg filter strings ka array lautate hain.
// ============================================================================
function fadeColor(color) {
  return {
    head: (d, D) => [`fade=t=in:st=0:d=${d.toFixed(3)}:color=${color}`],
    tail: (d, D) => [`fade=t=out:st=${Math.max(0, D - d).toFixed(3)}:d=${d.toFixed(3)}:color=${color}`],
  };
}
// blur dissolve — 3-step nested gblur -> sigma cut ki taraf ramp karta hai.
function blurRamp(baseSigma) {
  const s = baseSigma;
  return {
    head: (d, D) => [
      `gblur=sigma=${s}:enable='between(t,0,${d.toFixed(3)})'`,
      `gblur=sigma=${s}:enable='between(t,0,${(d * 0.66).toFixed(3)})'`,
      `gblur=sigma=${s}:enable='between(t,0,${(d * 0.33).toFixed(3)})'`,
    ],
    tail: (d, D) => [
      `gblur=sigma=${s}:enable='between(t,${Math.max(0, D - d).toFixed(3)},${D.toFixed(3)})'`,
      `gblur=sigma=${s}:enable='between(t,${Math.max(0, D - d * 0.66).toFixed(3)},${D.toFixed(3)})'`,
      `gblur=sigma=${s}:enable='between(t,${Math.max(0, D - d * 0.33).toFixed(3)},${D.toFixed(3)})'`,
    ],
  };
}

const TRANSITIONS = {
  none:          { label: 'Hard cut (no transition)', head: () => [], tail: () => [], scale: 0 },
  dip_black:     { label: 'Dip to black',   ...fadeColor('black'), scale: 1.0 },
  dip_white:     { label: 'Dip to white',   ...fadeColor('white'), scale: 1.0 },
  dip_warm:      { label: 'Dip to warm tint', ...fadeColor('0x140b02'), scale: 1.0 },
  soft_cut:      { label: 'Soft quick dip (fast black)', ...fadeColor('black'), scale: 0.5 },
  flash:         { label: 'White flash (very fast)', ...fadeColor('white'), scale: 0.28 },
  blur_dissolve: { label: 'Blur dissolve', ...blurRamp(9), scale: 1.0 },
};

// ============================================================================
//  STYLE PACKS — named presets. Har pack ek animation-list + transition-list
//  deta hai; auto/plan inme se VARY karke chunta hai (adjacent shots alag).
// ============================================================================
const PACKS = {
  none:      { label: 'None — koi transition/motion nahi (bilkul clean)', anims: ['none'], trans: ['none'] },
  auto:      { label: 'Auto — smart varied mix (recommended)',
               anims: ['zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'pan_up', 'pan_down', 'push_in'],
               trans: ['dip_black', 'dip_white', 'blur_dissolve', 'flash', 'soft_cut', 'dip_warm'] },
  cinematic: { label: 'Cinematic Doc — gentle zoom + dip to black',
               anims: ['zoom_in', 'zoom_out', 'pan_right', 'pan_left'],
               trans: ['dip_black', 'soft_cut'] },
  energetic: { label: 'Energetic — punch-in + white flash',
               anims: ['push_in', 'zoom_in', 'pan_right'],
               trans: ['flash', 'dip_white', 'soft_cut'] },
  soft:      { label: 'Soft — breathing zoom + blur dissolve',
               anims: ['zoom_in', 'zoom_out'],
               trans: ['blur_dissolve', 'dip_black'] },
  clean:     { label: 'Clean cuts — halki motion, hard cuts (koi dip nahi)',
               anims: ['zoom_in', 'zoom_out', 'pan_left', 'pan_right'],
               trans: ['none'] },
  motion_only: { label: 'Motion only — sirf Ken Burns, koi transition nahi',
               anims: ['zoom_in', 'zoom_out', 'pan_up', 'pan_down', 'push_in'],
               trans: ['none'] },
  transitions_only: { label: 'Transitions only — sirf dip/flash, static frame',
               anims: ['none'],
               trans: ['dip_black', 'dip_white', 'blur_dissolve', 'flash'] },
};

// ---------- plan builder ----------
// Har shot ko ek animation + boundary transition deta hai, seeded variety ke
// saath (koi do adjacent shot same na ho jitna ho sake). Reproducible: same
// seed => same plan.
function buildPlan(choice, slots) {
  const c = normalizeChoice(choice);
  const pack = PACKS[c.pack] || PACKS.none;
  const rnd = mulberry32(c.seed >>> 0 || 1);
  const pick = (list, prev) => {
    const pool = list.filter(Boolean);
    if (pool.length <= 1) return pool[0] || 'none';
    let x, guard = 0;
    do { x = pool[Math.floor(rnd() * pool.length)]; guard++; } while (x === prev && guard < 8);
    return x;
  };
  const transPool = pack.trans.filter(t => t !== 'none');
  const dSideWanted = c.transition_ms / 1000 / 2; // per-side seconds

  const plan = [];
  let prevAnim = null, prevTrans = null;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const dur = Math.max(0.3, s.dur || (s.end - s.start) || 0.3);
    const anim = pack.anims.length ? pick(pack.anims, prevAnim) : 'none';
    prevAnim = anim;
    let transOut = 'none';
    if (transPool.length && i < slots.length - 1) {
      transOut = pick(transPool, prevTrans);
      prevTrans = transOut;
    }
    plan.push({ i: s.i, idx: i, dur: +dur.toFixed(3), anim, transOut });
  }
  // transIn = pichhle shot ka transOut (boundary dono taraf same)
  for (let i = 0; i < plan.length; i++) {
    plan[i].transIn = i > 0 ? plan[i - 1].transOut : 'none';
    // dip ki lambai ko shot ke 40% se zyada mat hone do (chhoti shot ke liye)
    const cap = Math.max(0.04, Math.min(dSideWanted, plan[i].dur * 0.4));
    plan[i].dSide = +cap.toFixed(3);
  }
  return plan;
}

// ---------- filter chain for ONE segment ----------
function buildFilterChain(pl, W, H, FPS, intensity) {
  const parts = [];
  const anim = ANIMATIONS[pl.anim];
  if (anim && anim.build) parts.push(anim.build(pl.dur, W, H, FPS, intensity));
  const tin = TRANSITIONS[pl.transIn];
  if (tin && pl.transIn !== 'none') {
    const d = Math.max(0.04, pl.dSide * (tin.scale || 1));
    for (const f of tin.head(d, pl.dur)) parts.push(f);
  }
  const tout = TRANSITIONS[pl.transOut];
  if (tout && pl.transOut !== 'none') {
    const d = Math.max(0.04, pl.dSide * (tout.scale || 1));
    for (const f of tout.tail(d, pl.dur)) parts.push(f);
  }
  return parts.length ? parts.join(',') : null;
}

// ---------- apply pass ----------
// segFiles: ordered rendered segment paths. Returns { files:[...styled or original...],
// applied:[{...proof}], styledCount }. Kabhi throw nahi karta — fail-safe.
function applyStyle(slots, segFiles, choice, cfg, W, H, FPS) {
  const c = normalizeChoice(choice);
  const plan = buildPlan(c, slots.map((s, k) => ({ ...s, i: (segFiles[k] ? s.i : s.i) })));
  const enc = ['-c:v', 'libx264', '-preset', (cfg.render && cfg.render.preset) || 'veryfast',
    '-crf', String((cfg.render && cfg.render.crf) || 21), '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an'];
  const outFiles = [];
  const applied = [];
  let styledCount = 0;
  for (let k = 0; k < segFiles.length; k++) {
    const src = segFiles[k];
    const pl = plan[k] || { anim: 'none', transIn: 'none', transOut: 'none', dur: 0, dSide: 0 };
    const chain = buildFilterChain(pl, W, H, FPS, c.intensity);
    if (!chain || !fs.existsSync(src)) {
      outFiles.push(src);
      applied.push({ i: pl.i, anim: pl.anim, transIn: pl.transIn, transOut: pl.transOut, styled: false, reason: chain ? 'src-missing' : 'no-effect' });
      continue;
    }
    const out = src.replace(/\.mp4$/i, '') + '_sty.mp4';
    const r = U.ffmpeg(['-i', src, '-vf', chain, ...enc, out]);
    if (!r.ok || !fs.existsSync(out)) {
      // fail-safe: original segment rakho, sach likho
      outFiles.push(src);
      applied.push({ i: pl.i, anim: pl.anim, transIn: pl.transIn, transOut: pl.transOut, styled: false, reason: 'ffmpeg-fail', err: (r.stderr || '').slice(0, 140) });
      continue;
    }
    outFiles.push(out);
    styledCount++;
    applied.push({ i: pl.i, anim: pl.anim, transIn: pl.transIn, transOut: pl.transOut, dSide: pl.dSide, styled: true, file: path.basename(out) });
  }
  return { files: outFiles, applied, styledCount, pack: c.pack, seed: c.seed, transition_ms: c.transition_ms, intensity: c.intensity };
}

// ---------- catalog (UI + guide) ----------
function catalog() {
  return {
    packs: Object.keys(PACKS).map(id => ({ id, label: PACKS[id].label, anims: PACKS[id].anims, trans: PACKS[id].trans })),
    animations: Object.keys(ANIMATIONS).map(id => ({ id, label: ANIMATIONS[id].label })),
    transitions: Object.keys(TRANSITIONS).map(id => ({ id, label: TRANSITIONS[id].label })),
  };
}

module.exports = {
  projectRoot, stylePath, DEFAULT_CHOICE, normalizeChoice,
  loadChoice, saveChoice, signature,
  buildPlan, buildFilterChain, applyStyle, catalog,
  PACKS, ANIMATIONS, TRANSITIONS,
};
