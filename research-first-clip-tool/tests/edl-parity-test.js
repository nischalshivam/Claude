// ============================================================
//  P0-A ACCEPTANCE — EDL edit ASLI final render mein lagta hai (M5.0-B)
//
//  Ye woh gap tha jo GPT ne saaf-saaf chhoda: editor mein crop/scale/trim
//  dikhta tha par final.mp4 mein nahi jaata tha. Ye test end-to-end (asli
//  ffmpeg) sabit karta hai ki ab jaata hai — pixel dekh kar.
//
//  Tareeka:
//   1. ek gap wali draft banao
//   2. gap mein ek do-rang wali image daalo (BAAYAAN laal, DAAYAAN neela)
//   3. EDL mein us shot par scale=2 + crop_x=0 (baayaan) set karo
//   4. final render karo
//   5. rendered frame ka center pixel LAAL hona chahiye (baayaan half zoom hua)
//      aur render-manifest edl_parity.ok + shot.edl_applied true
//   6. crop_x=1 (daayaan) par wahi test -> center NEELA
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tests', 'tmp', 'parity_' + process.pid);
const INPUT = path.join(TMP, 'input'), DATA = path.join(TMP, 'DATA'), JOBS = path.join(TMP, 'jobs'), PROJ = path.join(TMP, 'proj');
for (const d of [INPUT, DATA, JOBS, PROJ]) fs.mkdirSync(d, { recursive: true });
// in-process edlMod calls bhi TMP jobs/DATA hi dekhein (util env se padhta hai)
process.env.RFC_JOBS_DIR = JOBS; process.env.RFC_DATA_DIR = DATA; process.env.RFC_PROJECT_DIR = PROJ;
const FF = process.env.FFMPEG_BIN || 'ffmpeg';
const ff = a => execFileSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', ...a], { timeout: 120000 });
const edlMod = require(path.join(ROOT, 'src', 'edl.js'));
const renderStage = require(path.join(ROOT, 'src', 'render.js'));
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok: !!ok }); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${n}${d ? '  — ' + d : ''}`); };
const ts = s => { const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = Math.floor(s % 60), ms = Math.round((s % 1) * 1000); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')},${String(ms).padStart(3, '0')}`; };

// ---- fixture: ep video for the auto moment ----
const ep = path.join(INPUT, 'ep.mp4'), epsrt = path.join(INPUT, 'ep.srt');
ff(['-f', 'lavfi', '-i', 'color=c=0x228B22:s=640x360:r=30:d=8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-t', '8', ep]);
fs.writeFileSync(epsrt, `1\n${ts(1)} --> ${ts(5)}\nthe hero enters\n`);
// voiceover 12s + narration (2 moments; 2nd = gap)
fs.writeFileSync(path.join(INPUT, 'voiceover.srt'), [{ s: 0, e: 6, t: 'the hero enters' }, { s: 6, e: 12, t: 'the lost city appears' }].map((c, i) => `${i + 1}\n${ts(c.s)} --> ${ts(c.e)}\n${c.t}\n`).join('\n'));
ff(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=12', '-c:a', 'aac', path.join(INPUT, 'voiceover.m4a')]);
fs.writeFileSync(path.join(INPUT, 'scene-research.json'), JSON.stringify({ schema_version: 'scene-research-pack-v1', project_title: 'Parity', packs: [
  { pack_id: 'P1', scope: { kind: 'SERIES', title: 'Show P', year: 2011, season: 1, episode_number: 1 }, sources: [{ source_id: 'S1', local_file: ep, local_subs: epsrt, inspection_status: 'VERIFIED_WATCHED' }], moments: [{ moment_id: 'M1', script_cue_exact: 'the hero enters', criticality: 'NORMAL', locators: [{ source_id: 'S1', locator_type: 'EXACT_TIME', start_sec: 1, end_sec: 5, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } }] },
  { pack_id: 'P2', scope: { kind: 'FILM', title: 'No Upload City', year: 2020 }, sources: [], moments: [{ moment_id: 'M2', script_cue_exact: 'the lost city appears', criticality: 'NORMAL', locators: [], fallback: { type: 'NEEDS_SOURCE' } }] },
] }, null, 2));

const env = { ...process.env, RFC_DATA_DIR: DATA, RFC_JOBS_DIR: JOBS, RFC_PROJECT_DIR: PROJ, FFMPEG_BIN: FF };
const runRfc = extra => spawnSync('node', [path.join(ROOT, 'src', 'run.js'), `--input=${INPUT}`, '--diagnostic-override', ...extra], { cwd: ROOT, encoding: 'utf8', timeout: 900000, env });
const jobDir = path.join(JOBS, 'parity');
// center pixel RGB of a rendered video at time t
function centerRGB(file, t) {
  const out = file + `.px.rgb`;
  ff(['-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'crop=2:2:(iw-2)/2:(ih-2)/2,scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', out]);
  const b = fs.readFileSync(out); fs.rmSync(out, { force: true }); return [b[0], b[1], b[2]];
}
const near = (a, b, tol = 60) => Math.abs(a - b) <= tol;

function run() {
  // 1. draft -> gap-plan + DATA folder for M2
  const d = runRfc(['--draft', '--redo']);
  const gapDir = fs.existsSync(DATA) ? fs.readdirSync(DATA).find(n => /^MISSING_/.test(n)) : null;
  check('P-1 draft creates a gap request for the missing film beat', d.status === 0 && !!gapDir, `exit=${d.status} gap=${gapDir}`);
  if (!gapDir) return;

  // 2. two-colour image: LEFT half red, RIGHT half blue (crop position verifiable)
  const img = path.join(DATA, gapDir, 'media', '01_lr.png');
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=1000x720:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=1000x720:d=1',
    '-filter_complex', '[0:v][1:v]hstack=inputs=2', '-frames:v', '1', img]);
  // ab gap bhar gaya — dobara draft taaki M2 slot ek manual STILL ban jaye (placeholder nahi)
  const d2 = runRfc(['--draft', '--redo']);
  let tl2 = null; try { tl2 = JSON.parse(fs.readFileSync(path.join(jobDir, 'timeline.json'), 'utf8')); } catch {}
  const hasManual = tl2 && tl2.slots.some(s => s.manual && s.start >= 5.9);
  check('P-1b after adding one image, the gap becomes a manual still shot',
    d2.status === 0 && hasManual, `exit=${d2.status} manual=${hasManual}`);

  // helper: build EDL from this draft, set the manual shot's transform, final render, sample
  function renderWithCrop(cropX) {
    // fresh EDL from the draft job
    const edl = edlMod.rebuild(PROJ, 'parity', { projectId: 'current' });
    // the manual/user still that fills the gap (origin USER)
    const target = edl.tracks.video_main.find(s => s.provenance && s.provenance.origin === 'USER')
      || edl.tracks.video_main.find(s => s.timeline.start >= 5.9);
    const r = edlMod.patch(PROJ, { expected_revision: edl.revision, ops: [{ shot_id: target.shot_id, transform: { fit: 'fill', scale: 2.0, crop_x: cropX, crop_y: 0.5 } }] });
    if (!r.ok) return { ok: false, reason: 'patch fail: ' + r.message };
    // final render (production) — reconcile should apply the edit
    const fin = runRfc([]);
    let man = null; try { man = JSON.parse(fs.readFileSync(path.join(jobDir, 'render-manifest.json'), 'utf8')); } catch {}
    const final = path.join(jobDir, 'final.mp4');
    return { ok: fin.status === 0 && fs.existsSync(final), man, final, fin, target };
  }

  // 3. crop_x = 0 (LEFT) -> center pixel should be RED
  let a = renderWithCrop(0.0);
  const applA = a.man && (a.man.edl_parity || {}).ok && (a.man.shots || []).some(s => s.edl_applied && s.edl_transform && s.edl_transform.scale === 2);
  const pxA = a.ok ? centerRGB(a.final, 8) : [0, 0, 0];
  check('P-2 EDL edit is recorded as applied in the render manifest (parity ok)',
    a.ok && applA, `exit=${a.fin && a.fin.status} parity=${a.man && JSON.stringify(a.man.edl_parity)}`);
  check('P-3 crop_x=0 (+scale2) actually renders the LEFT half — centre pixel is RED',
    a.ok && near(pxA[0], 200, 80) && pxA[2] < 120, `rgb=${pxA.join(',')}`);

  // 4. crop_x = 1 (RIGHT) -> center pixel should be BLUE
  let b = renderWithCrop(1.0);
  const pxB = b.ok ? centerRGB(b.final, 8) : [0, 0, 0];
  check('P-4 crop_x=1 (+scale2) actually renders the RIGHT half — centre pixel is BLUE',
    b.ok && pxB[2] > 120 && pxB[0] < 120, `rgb=${pxB.join(',')}`);

  // 5. duration parity preserved (edit changed framing, not timing)
  const man = b.man || a.man;
  const dur = man && man.duration ? man.duration : {};
  check('P-5 editing framing never changed narration timing (rendered ~ audio)',
    dur.rendered != null && dur.audio != null && Math.abs(dur.rendered - dur.audio) <= 0.6,
    `rendered=${dur.rendered} audio=${dur.audio}`);

  // 6. Right-click Change Clip contract, actual exported pixels par. First
  // automatic shot green hai; use solid magenta image se replace karo.
  const replacement = path.join(TMP, 'solid-magenta.png');
  ff(['-f', 'lavfi', '-i', 'color=c=magenta:s=1280x720:d=1', '-frames:v', '1', replacement]);
  const edlNow = edlMod.rebuild(PROJ, 'parity', { projectId: 'current' });
  const firstShot = edlNow.tracks.video_main.find(s => s.timeline.start < 0.1);
  const rep = edlMod.replaceAsset(PROJ, { expected_revision: edlNow.revision, shot_id: firstShot.shot_id,
    path: replacement, type: 'image', sha256: 'solid-magenta-test' });
  const finRep = runRfc([]);
  const repFinal = path.join(jobDir, 'final.mp4');
  let repMan = null; try { repMan = JSON.parse(fs.readFileSync(path.join(jobDir, 'render-manifest.json'), 'utf8')); } catch {}
  const repPx = finRep.status === 0 && fs.existsSync(repFinal) ? centerRGB(repFinal, 2) : [0, 0, 0];
  const replacementRecorded = repMan && (repMan.shots || []).some(s => s.start < 0.1 && s.edl_replacement === true && s.edl_applied === true);
  check('P-6 per-shot replacement is recorded as applied in final render manifest',
    rep.ok && finRep.status === 0 && replacementRecorded,
    `replace=${rep.ok} exit=${finRep.status} recorded=${replacementRecorded}`);
  check('P-7 Change Clip actually changes exported pixels (green auto shot -> magenta user image)',
    finRep.status === 0 && repPx[0] > 170 && repPx[2] > 170 && repPx[1] < 100,
    `rgb=${repPx.join(',')}`);

  // 7. Voiceover 12s, SRT 9s: full audio rahe aur last mapped visual 12s tak.
  fs.writeFileSync(path.join(INPUT, 'voiceover.srt'), [
    { s: 0, e: 6, t: 'the hero enters' }, { s: 6, e: 9, t: 'the lost city appears' },
  ].map((c, i) => `${i + 1}\n${ts(c.s)} --> ${ts(c.e)}\n${c.t}\n`).join('\n'));
  const tailRun = runRfc(['--redo']);
  let tailMan = null, tailAligned = null;
  try { tailMan = JSON.parse(fs.readFileSync(path.join(jobDir, 'render-manifest.json'), 'utf8')); } catch {}
  try { tailAligned = JSON.parse(fs.readFileSync(path.join(jobDir, 'aligned.json'), 'utf8')); } catch {}
  const tailMoment = tailAligned && tailAligned.moments && tailAligned.moments.find(m => m.moment_id === 'M2');
  const tailDur = tailMan && tailMan.duration || {};
  check('P-8 voiceover is never cut when SRT ends 3s early; last visual extends to exact audio end',
    tailRun.status === 0 && tailMan && tailMan.total === 12
      && tailDur.correction === 'EXTENDED_TO_AUDIO' && Math.abs(tailDur.audio - 12) < 0.05
      && Math.abs(tailDur.rendered - 12) < 0.1 && tailMoment && Math.abs(tailMoment.beat_end - 12) < 0.01,
    `exit=${tailRun.status} total=${tailMan && tailMan.total} dur=${JSON.stringify(tailDur)} beatEnd=${tailMoment && tailMoment.beat_end}`);

  // 8. Old/cached timeline defense. Even if a legacy timeline still says
  // kind=graphic + text, default production must render the underlying image
  // CLEAN (no dim layer, blue bar or research hint text).
  const guardImage = path.join(TMP, 'overlay-guard-green.png');
  const guardAudio = path.join(TMP, 'overlay-guard-2s.m4a');
  ff(['-f', 'lavfi', '-i', 'color=c=0x00FF00:s=640x360:d=1', '-frames:v', '1', guardImage]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-c:a', 'aac', guardAudio]);
  const guardCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  guardCfg.canvas = { width: 640, height: 360, fps: 30 };
  guardCfg.output = { ...(guardCfg.output || {}), mode: 'production' };
  guardCfg.render = { ...(guardCfg.render || {}), burnResearchOverlayText: false };
  const guardSpec = { id: 'overlay_guard', audio: guardAudio, previewOffset: 0, isPreview: false,
    timebase: { audio_duration: 2, srt_end: 2, correction: 'NONE', difference_sec: 0 } };
  const guardTl = { total: 2, slots: [{ i: 0, kind: 'graphic', start: 0, end: 2, dur: 2,
    image: guardImage, text: 'INTERNAL RESEARCH HINT — DO NOT BURN', asset: 'TEMPLATE_GRAPHIC_MEDIA',
    moment_id: 'OVERLAY_GUARD', criticality: 'NORMAL' }] };
  let guardOut = null, guardMan = null, guardErr = null;
  try {
    guardOut = renderStage(guardSpec, guardCfg, { meta: {} }, guardTl);
    guardMan = JSON.parse(fs.readFileSync(path.join(JOBS, 'overlay_guard', 'render-manifest.json'), 'utf8'));
  } catch (e) { guardErr = e; }
  const guardPx = guardOut && fs.existsSync(guardOut.file) ? centerRGB(guardOut.file, 1) : [0, 0, 0];
  const guardShot = guardMan && guardMan.shots && guardMan.shots[0];
  check('P-9 cached GRAPHIC timeline renders clean media by default (no dim/text layer)',
    !guardErr && guardPx[1] > 190 && guardPx[0] < 60 && guardPx[2] < 60,
    `rgb=${guardPx.join(',')} error=${guardErr ? guardErr.message : 'none'}`);
  check('P-10 manifest proves research overlay suppression and contains no graphic-overlay asset',
    guardShot && guardShot.asset === 'VERIFIED_SOURCE_STILL' && guardShot.research_overlay_suppressed === true
      && guardMan.research_overlay_policy && guardMan.research_overlay_policy.enabled === false
      && guardMan.research_overlay_policy.suppressed_shots === 1,
    `shot=${guardShot && guardShot.asset} policy=${guardMan && JSON.stringify(guardMan.research_overlay_policy)}`);
}

try { run(); } catch (e) { check('parity-test crashed', false, String(e && e.stack || e).slice(0, 300)); }
finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  const pass = results.filter(r => r.ok).length, fail = results.length - pass;
  console.log('\n' + '='.repeat(62));
  console.log(`  EDL PARITY SUMMARY: ${pass} PASS, ${fail} FAIL`);
  console.log('='.repeat(62));
  process.exit(fail ? 1 : 0);
}
