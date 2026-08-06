// ============================================================
//  M5.3-FR ACCEPTANCE — Frame + custom background layout (real ffmpeg, pixel).
//
//  Sabit karta hai:
//   F-1  framed layout ~N shots par aata hai (accent, poori video nahi)
//   F-2  DURATION INVARIANT — framed lagne se lambai nahi badalti
//   F-3  PIXEL — framed shot ka CENTER = clip (green), MARGIN = background
//        (non-green) -> sach me frame+background compose hua
//   F-4  framed shots SPREAD hain (do adjacent nahi)
//   F-5  har framed shot ALAG frame-style ya background (non-repetitive)
//   F-6  framed_count=0 => koi framed shot nahi (sirf transitions/motion)
//   F-7  backgrounds folder KHALI ho to blur-self fallback (framed fir bhi bane)
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tests', 'tmp', 'frames_' + process.pid);
const JOBS = path.join(TMP, 'jobs'), PROJ = path.join(TMP, 'proj'), FIX = path.join(TMP, 'fix');
const BGDIR = path.join(PROJ, 'backgrounds');
for (const d of [JOBS, PROJ, FIX, BGDIR]) fs.mkdirSync(d, { recursive: true });
process.env.RFC_JOBS_DIR = JOBS; process.env.RFC_PROJECT_DIR = PROJ;
const FF = process.env.FFMPEG_BIN || 'ffmpeg';
const ff = a => execFileSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', ...a], { timeout: 120000 });

const styleMod = require(path.join(ROOT, 'src', 'style.js'));
const framesMod = require(path.join(ROOT, 'src', 'frames.js'));
const renderStage = require(path.join(ROOT, 'src', 'render.js'));
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok: !!ok }); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${n}${d ? '  — ' + d : ''}`); };

// clip = GREEN still; backgrounds = RED + BLUE images + a RED video (non-green).
// IMPORTANT: backgrounds ko SUBFOLDERS (Images/ Videos/) me rakha — jaisa user
// rakhta hai (Drive jaisa). Ye recursive-discovery bug ko pakadta hai.
const imgSub = path.join(BGDIR, 'Images'), vidSub = path.join(BGDIR, 'Videos');
fs.mkdirSync(imgSub, { recursive: true }); fs.mkdirSync(vidSub, { recursive: true });
const green = path.join(FIX, 'green.png');
ff(['-f', 'lavfi', '-i', 'color=0x00CC00:s=640x360:d=1', '-frames:v', '1', green]);
ff(['-f', 'lavfi', '-i', 'color=0xCC0000:s=1280x720:d=1', '-frames:v', '1', path.join(imgSub, 'red.png')]);
ff(['-f', 'lavfi', '-i', 'color=0x1030CC:s=1280x720:d=1', '-frames:v', '1', path.join(imgSub, 'blue.png')]);
ff(['-f', 'lavfi', '-i', 'color=0xCC0000:s=640x360:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '3', path.join(vidSub, 'redvid.mp4')]);

const NSHOT = 10, SHOT = 2.0, TOTAL = NSHOT * SHOT, W = 640, H = 360, FPS = 30;
const audio = path.join(FIX, 'vo.m4a');
ff(['-f', 'lavfi', '-i', `sine=frequency=220:duration=${TOTAL}`, '-c:a', 'aac', audio]);

function baseCfg() {
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  c.canvas = { width: W, height: H, fps: FPS };
  c.output = { ...(c.output || {}), mode: 'production' };
  c.render = { ...(c.render || {}), burnResearchOverlayText: false };
  return c;
}
function timeline() {
  const slots = [];
  for (let i = 0; i < NSHOT; i++) slots.push({ i, kind: 'still', start: i * SHOT, end: (i + 1) * SHOT, dur: SHOT,
    image: green, asset: 'VERIFIED_SOURCE_STILL', moment_id: 'M' + i, criticality: 'NORMAL' });
  return { total: TOTAL, slots };
}
function renderOnce(id) {
  const spec = { id, audio, previewOffset: 0, isPreview: false,
    timebase: { audio_duration: TOTAL, srt_end: TOTAL, correction: 'NONE', difference_sec: 0 } };
  const out = renderStage(spec, baseCfg(), { meta: {} }, timeline());
  const man = JSON.parse(fs.readFileSync(path.join(JOBS, id, 'render-manifest.json'), 'utf8'));
  return { file: out.file, man };
}
function rgbAt(file, t, xf, yf) {
  const out = file + `.px_${Math.round(xf * 100)}_${Math.round(yf * 100)}.rgb`;
  const x = Math.round(xf * (W - 2)), y = Math.round(yf * (H - 2));
  ff(['-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=2:2:${x}:${y},scale=1:1`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', out]);
  const b = fs.readFileSync(out); fs.rmSync(out, { force: true }); return [b[0], b[1], b[2]];
}
const isGreen = ([r, g, b]) => g > 110 && g > r + 30 && g > b + 30;

function run() {
  // baseline (no style)
  try { fs.rmSync(styleMod.stylePath(), { force: true }); } catch {}
  const base = renderOnce('base');
  const baseDur = base.man.duration.rendered;

  // framed on: 3 accents, with backgrounds present
  styleMod.saveChoice(undefined, { pack: 'cinematic', enabled: true, seed: 3, framed_count: 3 });
  const st = renderOnce('framed');
  const style = st.man.style || {};
  const framedShots = (style.shots || []).filter(s => s.layout === 'framed' && s.styled);

  check('F-1 framed layout appears on ~N accent shots (not the whole video)',
    style.framed_shots >= 2 && style.framed_shots <= 4 && framedShots.length === style.framed_shots,
    `framed=${style.framed_shots}/${NSHOT} bg={img:${style.backgrounds && style.backgrounds.images},vid:${style.backgrounds && style.backgrounds.videos}}`);

  check('F-2 DURATION INVARIANT: framed shots never change total length',
    Math.abs(st.man.duration.rendered - baseDur) <= (1 / FPS + 0.02) && st.man.total === base.man.total,
    `base=${baseDur} framed=${st.man.duration.rendered}`);

  // pixel: for each framed shot, center=green(clip), left-margin=non-green(bg)
  let pxOk = true, det = [];
  for (const s of framedShots) {
    const slot = timeline().slots[framedShots.indexOf(s) === -1 ? 0 : 0];
    // find the slot index i -> time mid
    const idx = s.i;
    const t = idx * SHOT + SHOT / 2;
    const center = rgbAt(st.file, t, 0.5, 0.5);
    const margin = rgbAt(st.file, t, 0.02, 0.5); // far-left edge = background margin
    const ok = isGreen(center) && !isGreen(margin);
    det.push(`i${idx}:C${center.join(',')}/M${margin.join(',')}${ok ? '' : '(X)'}`);
    if (!ok) pxOk = false;
  }
  check('F-3 PIXEL: framed shot center = clip (green), margin = background (non-green)',
    framedShots.length > 0 && pxOk, det.join(' '));

  // spread: no two framed shots adjacent
  const idxs = framedShots.map(s => s.i).sort((a, b) => a - b);
  let adj = false; for (let i = 1; i < idxs.length; i++) if (idxs[i] - idxs[i - 1] < 2) adj = true;
  check('F-4 framed shots are spread across the video (never two adjacent)',
    idxs.length >= 2 && !adj, `indices=${idxs.join(',')}`);

  // variety: each framed shot differs in style or background
  const combos = framedShots.map(s => s.frame_style + '|' + s.bg);
  const uniq = new Set(combos);
  check('F-5 each framed shot uses a distinct frame-style/background combo',
    uniq.size === combos.length, `combos=${combos.join('  ')}`);

  // F-8: subfolders (Images/ Videos/) se asli backgrounds use hue (blur-self NAHI)
  const usedBgs = framedShots.map(s => s.bg);
  const realBgUsed = usedBgs.length > 0 && usedBgs.every(b => b !== 'blur-self') &&
    usedBgs.some(b => /red\.png|blue\.png|redvid\.mp4/.test(b));
  check('F-8 backgrounds in subfolders (Images/ Videos/) are discovered and actually used',
    style.backgrounds.images === 2 && style.backgrounds.videos === 1 && realBgUsed,
    `found={img:${style.backgrounds.images},vid:${style.backgrounds.videos}} used=${usedBgs.join(',')}`);

  // framed_count = 0 -> none
  styleMod.saveChoice(undefined, { pack: 'cinematic', enabled: true, seed: 3, framed_count: 0 });
  const off = renderOnce('nof');
  check('F-6 framed_count=0 applies no framed shots (transitions/motion still fine)',
    (off.man.style.framed_shots || 0) === 0 && off.man.style.styled_shots > 0,
    `framed=${off.man.style.framed_shots} styled=${off.man.style.styled_shots}`);

  // backgrounds empty -> blur-self fallback (framed still built)
  const moved = path.join(TMP, 'bg_moved'); fs.renameSync(BGDIR, moved);
  styleMod.saveChoice(undefined, { pack: 'cinematic', enabled: true, seed: 3, framed_count: 3 });
  const blur = renderOnce('blur');
  const blurFramed = (blur.man.style.shots || []).filter(s => s.layout === 'framed' && s.styled);
  fs.renameSync(moved, BGDIR);
  check('F-7 empty backgrounds folder falls back to blur-self (framed still works)',
    blur.man.style.framed_shots >= 2 && blurFramed.every(s => s.bg === 'blur-self'),
    `framed=${blur.man.style.framed_shots} bg=${blurFramed.map(s => s.bg).join(',')}`);
}

try { run(); } catch (e) { check('frames-test crashed', false, String(e && e.stack || e).slice(0, 400)); }
finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  const pass = results.filter(r => r.ok).length, fail = results.length - pass;
  console.log('\n' + '='.repeat(62));
  console.log(`  FRAMES SUMMARY: ${pass} PASS, ${fail} FAIL`);
  console.log('='.repeat(62));
  process.exit(fail ? 1 : 0);
}
