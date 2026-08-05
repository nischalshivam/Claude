// ============================================================
//  M5.2-TX ACCEPTANCE — Transitions/Animations ASLI final render mein lagti
//  hain, aur narration KABHI drift nahi karti. (Real ffmpeg, pixel proof.)
//
//  Ye woh do dava hain jinpar poora feature khada hai:
//   A. DURATION INVARIANT — style ON ya OFF, master ki lambai bilkul same
//      (per-shot duration-exact effects). Voiceover kabhi chhoti nahi hoti.
//   B. ASLI PIXEL — jis boundary par dip_black assign hua wahan tail KAALA,
//      dip_white/flash par SAFED, blur par abhi bhi HARA (media zinda) hota hai.
//   + none/disabled => bilkul kuch nahi lagta (styled_shots 0), lambai same.
//   + buildPlan reproducible (same seed = same plan) aur varied (adjacent alag).
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tests', 'tmp', 'style_' + process.pid);
const JOBS = path.join(TMP, 'jobs'), PROJ = path.join(TMP, 'proj'), FIX = path.join(TMP, 'fix');
for (const d of [JOBS, PROJ, FIX]) fs.mkdirSync(d, { recursive: true });
process.env.RFC_JOBS_DIR = JOBS; process.env.RFC_PROJECT_DIR = PROJ;
const FF = process.env.FFMPEG_BIN || 'ffmpeg';
const ff = a => execFileSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', ...a], { timeout: 120000 });

const styleMod = require(path.join(ROOT, 'src', 'style.js'));
const renderStage = require(path.join(ROOT, 'src', 'render.js'));
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok: !!ok }); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${n}${d ? '  — ' + d : ''}`); };

// green still + N-second audio
const green = path.join(FIX, 'green.png');
ff(['-f', 'lavfi', '-i', 'color=c=0x00CC00:s=640x360:d=1', '-frames:v', '1', green]);
const NSHOT = 4, SHOT = 2.0, TOTAL = NSHOT * SHOT;
const audio = path.join(FIX, 'vo.m4a');
ff(['-f', 'lavfi', '-i', `sine=frequency=220:duration=${TOTAL}`, '-c:a', 'aac', audio]);

function baseCfg() {
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  c.canvas = { width: 640, height: 360, fps: 30 };
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
function centerRGB(file, t) {
  const out = file + '.px.rgb';
  ff(['-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'crop=2:2:(iw-2)/2:(ih-2)/2,scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', out]);
  const b = fs.readFileSync(out); fs.rmSync(out, { force: true }); return [b[0], b[1], b[2]];
}
function probeDur(file) {
  const j = execFileSync(FF.replace(/ffmpeg$/, 'ffmpeg'), ['-hide_banner', '-i', file], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 });
  return j; // not used; we read from manifest.duration instead
}

function run() {
  // baseline: no style.json => none
  try { fs.rmSync(styleMod.stylePath(), { force: true }); } catch {}
  const base = renderOnce('base');
  const baseDur = base.man.duration && base.man.duration.rendered;
  check('S-1 baseline (no style) renders and style block reports none/0',
    baseDur != null && base.man.style && (base.man.style.styled_shots || 0) === 0,
    `dur=${baseDur} style=${JSON.stringify(base.man.style)}`);

  // enable a transitions-only style with a fixed seed
  styleMod.saveChoice(undefined, { pack: 'transitions_only', enabled: true, seed: 7, transition_ms: 500, intensity: 1.0 });
  const plan = styleMod.buildPlan(styleMod.loadChoice(), timeline().slots);
  const st = renderOnce('styled');
  const styDur = st.man.duration && st.man.duration.rendered;

  check('S-2 style pass applies transitions to the final render (styled_shots > 0)',
    st.man.style && st.man.style.pack === 'transitions_only' && st.man.style.styled_shots > 0,
    `style=${JSON.stringify({ pack: st.man.style.pack, styled: st.man.style.styled_shots })}`);

  // A. DURATION INVARIANT — style ne timing nahi badli (voiceover safe)
  check('S-3 DURATION INVARIANT: styled total == baseline total (narration never drifts)',
    baseDur != null && styDur != null && Math.abs(styDur - baseDur) <= (1 / 30 + 0.02) && st.man.total === base.man.total,
    `base=${baseDur} styled=${styDur} total=${st.man.total}`);

  // B. PIXEL — har boundary par assigned transition ka asli rang
  let pxPass = true, pxDetail = [];
  for (let i = 0; i < NSHOT - 1; i++) {
    const tOut = plan[i].transOut;
    if (tOut === 'none') continue;
    const bt = (i + 1) * SHOT - 0.02; // shot i ka tail (boundary se thoda pehle)
    const px = centerRGB(st.file, bt);
    const [r, g, b] = px;
    let ok;
    if (tOut === 'dip_black') ok = r < 95 && g < 95 && b < 95;
    else if (tOut === 'dip_white' || tOut === 'flash') ok = r > 160 && g > 160 && b > 160;
    else if (tOut === 'blur_dissolve') ok = g > r && g > b && g > 60; // blurred green still green-dominant
    else ok = true;
    pxDetail.push(`b${i}:${tOut}=${r},${g},${b}${ok ? '' : '(X)'}`);
    if (!ok) pxPass = false;
  }
  check('S-4 each boundary shows its assigned transition colour (dip_black=dark, white/flash=bright, blur=green)',
    pxPass, pxDetail.join(' '));

  // mid-shot media zinda hai (hara), style ne source nahi mitaya
  const mid = centerRGB(st.file, SHOT * 0.5);
  check('S-5 mid-shot still shows the source media (green) — style never erased the clip',
    mid[1] > 120 && mid[1] > mid[0] && mid[1] > mid[2], `rgb=${mid.join(',')}`);

  // C. none/disabled => bilkul kuch nahi
  styleMod.saveChoice(undefined, { pack: 'none', enabled: false });
  const off = renderOnce('off');
  check('S-6 pack=none/disabled applies nothing (styled_shots 0) and keeps the same length',
    (off.man.style.styled_shots || 0) === 0 && Math.abs((off.man.duration.rendered) - baseDur) <= (1 / 30 + 0.02),
    `styled=${off.man.style.styled_shots} dur=${off.man.duration.rendered}`);

  // D. reproducible + varied plan (no ffmpeg)
  const slots8 = []; for (let i = 0; i < 8; i++) slots8.push({ i, dur: 2.0, start: i * 2, end: i * 2 + 2 });
  const ch = { pack: 'auto', enabled: true, seed: 42, transition_ms: 450, intensity: 1 };
  const p1 = styleMod.buildPlan(ch, slots8), p2 = styleMod.buildPlan(ch, slots8);
  const same = JSON.stringify(p1) === JSON.stringify(p2);
  let adjSame = 0; for (let i = 1; i < p1.length; i++) if (p1[i].anim === p1[i - 1].anim) adjSame++;
  check('S-7 plan is reproducible (same seed) and varied (adjacent animations rarely repeat)',
    same && adjSame <= 1, `reproducible=${same} adjacentRepeats=${adjSame}/${p1.length - 1}`);

  // boundary transIn matches previous shot transOut (seamless dip both sides)
  const seamless = p1.every((s, i) => i === 0 ? s.transIn === 'none' : s.transIn === p1[i - 1].transOut);
  check('S-8 each boundary uses the same transition on both sides (seamless dip)',
    seamless, `ok=${seamless}`);
}

try { run(); } catch (e) { check('style-parity-test crashed', false, String(e && e.stack || e).slice(0, 400)); }
finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  const pass = results.filter(r => r.ok).length, fail = results.length - pass;
  console.log('\n' + '='.repeat(62));
  console.log(`  STYLE PARITY SUMMARY: ${pass} PASS, ${fail} FAIL`);
  console.log('='.repeat(62));
  process.exit(fail ? 1 : 0);
}
