#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rfc-m5b-'));
process.env.RFC_JOBS_DIR = path.join(tmp, 'jobs');
process.env.RFC_PROJECT_DIR = path.join(tmp, 'project-root');
const manual = require('../src/manual.js');
const edl = require('../src/edl.js');

let pass = 0;
function check(name, ok, detail = '') {
  if (!ok) { console.error(`FAIL ${name}${detail ? ': ' + detail : ''}`); process.exitCode = 1; return; }
  pass++; console.log(`PASS ${name}`);
}

const req = { request_key: 'REQ_TEST', request_id: 'MISSING_001__TEST',
  range: { start_sec: 71, end_sec: 89, duration_sec: 18 }, moment_ids: ['M1'], pack_ids: [] };
const img = n => ({ file: `${n}.jpg`, path: `X/${n}.jpg`, type: 'IMAGE', sha256: `sha${n}` });
const video = { file: 'one.mp4', path: 'X/one.mp4', type: 'VIDEO', sha256: 'video', duration: 4 };

for (const [name, files, opts, want] of [
  ['one image fills 18s', [img(1)], {}, 1],
  ['ten assets exactly tile 18s', Array.from({ length: 10 }, (_, i) => img(i + 1)), {}, 10],
  ['one short video fills 18s', [video], {}, 1],
  ['explicit reuse creates pacing shots', [img(1)], { allow_reuse: true }, 4],
]) {
  const out = manual.buildShotsForRequest(req, files, opts);
  const sum = out.shots.reduce((n, s) => n + s.dur, 0);
  check(name, out.shots.length === want && out.short === 0 && Math.abs(sum - 18) < 0.001 && out.shots.at(-1).end === 89,
    JSON.stringify({ shots: out.shots.length, short: out.short, sum }));
}

const job = 'identity-test';
const jobDir = path.join(process.env.RFC_JOBS_DIR, job); fs.mkdirSync(jobDir, { recursive: true });
fs.writeFileSync(path.join(jobDir, 'timeline.json'), JSON.stringify({ total: 6, slots: [] }));
const mk = (i, file) => ({ i, kind: 'still', start: i * 3, end: (i + 1) * 3, dur: 3,
  image: file, manual: true, manual_request_key: 'REQ_SAME', manual_sha256: `sha${i}`, asset: 'USER_IMAGE' });
const live = { total: 6, slots: [mk(0, 'A.jpg'), mk(1, 'B.jpg')] };
let project = edl.rebuild(process.env.RFC_PROJECT_DIR, job, { timelineOverride: live });
edl.patch(process.env.RFC_PROJECT_DIR, { expected_revision: project.revision, ops: [
  { shot_id: 'SHOT_0000', transform: { scale: 1.2 } },
  { shot_id: 'SHOT_0001', transform: { scale: 2.0 } },
] });
project = edl.rebuild(process.env.RFC_PROJECT_DIR, job, { timelineOverride: live });
check('same-request shots preserve independent EDL edits',
  project.tracks.video_main[0].transform.scale === 1.2 && project.tracks.video_main[1].transform.scale === 2.0);

const replacementPath = path.join(tmp, 'manual-replacement.jpg');
fs.writeFileSync(replacementPath, Buffer.from('replacement-fixture'));
let replaceResult = edl.replaceAsset(process.env.RFC_PROJECT_DIR, { expected_revision: project.revision,
  shot_id: 'SHOT_0000', path: replacementPath, type: 'image', sha256: 'replacement-sha' });
let rebuiltReplacement = edl.rebuild(process.env.RFC_PROJECT_DIR, job, { timelineOverride: live });
const renderSlots = JSON.parse(JSON.stringify(live.slots));
const rec = edl.reconcile(rebuiltReplacement, renderSlots);
check('per-shot replacement survives EDL rebuild and reconciles into final timeline by stable slot id',
  replaceResult.ok && rebuiltReplacement.tracks.video_main[0].user_replaced === true
    && rec.applied >= 1 && renderSlots[0].kind === 'still'
    && renderSlots[0].image === replacementPath && renderSlots[0].edl_replacement === true,
  JSON.stringify({ replace: replaceResult.ok, applied: rec.applied, kind: renderSlots[0].kind, image: renderSlots[0].image }));

// Real engine artifacts job-relative paths likhte hain. Exact clips `video`,
// context clips `media_file`, montage `images` mein aate hain. Ye wahi contract
// hai jo M5.0-B.1 mein toot gaya tha aur browser mein 0 auto shots dikhte the.
const relJob = 'relative-media-test';
const relDir = path.join(process.env.RFC_JOBS_DIR, relJob);
for (const d of ['clips', 'cache', 'frames']) fs.mkdirSync(path.join(relDir, d), { recursive: true });
for (const f of ['clips/exact.mp4', 'cache/bank.mp4', 'frames/a.jpg', 'frames/b.jpg']) {
  fs.writeFileSync(path.join(relDir, f), Buffer.from('fixture-' + f));
}
const relShots = [
  { i: 0, start: 0, end: 2, dur: 2, kind: 'video', asset: 'EXACT_VIDEO', video: 'clips/exact.mp4' },
  { i: 1, start: 2, end: 4, dur: 2, kind: 'context_video', asset: 'CONTEXT_VIDEO', media_file: 'cache/bank.mp4' },
  { i: 2, start: 4, end: 6, dur: 2, kind: 'montage', asset: 'MONTAGE', images: ['frames/a.jpg', 'frames/b.jpg'] },
];
fs.writeFileSync(path.join(relDir, 'timeline.json'), JSON.stringify({ total: 6, slots: relShots }));
const relEdl = edl.buildFromJob(relJob);
const relPaths = ['clips/exact.mp4', 'cache/bank.mp4', 'frames/a.jpg'].map(f => path.resolve(relDir, f));
const token = p => crypto.createHash('sha1').update(p).digest('hex');
check('EDL canonicalizes exact/context/montage media and gives montage image type',
  relEdl.tracks.video_main.every((s, i) => s.asset.path === relPaths[i] && s.asset.path_token === token(relPaths[i]))
    && relEdl.tracks.video_main[0].asset.type === 'video'
    && relEdl.tracks.video_main[1].asset.type === 'video'
    && relEdl.tracks.video_main[2].asset.type === 'image',
  JSON.stringify(relEdl.tracks.video_main.map(s => ({ type: s.asset.type, path: s.asset.path }))));

const renderSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'render.js'), 'utf8');
check('short manual video render is loop-safe', renderSource.includes("'-stream_loop', '-1', '-ss', String(s.media_start || 0)"));
const uiSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'ui', 'app.js'), 'utf8');
check('editor exposes right-click replacement, exact shot times and streamed Save-As',
  uiSource.includes('oncontextmenu: e => showShotMenu(e, s)')
    && uiSource.includes('showSaveFilePicker') && uiSource.includes('finalArtifactUrl')
    && uiSource.includes('(s.timeline.end - s.timeline.start).toFixed(1)'));
for (const f of ['CHATGPT_STAGE1_TOPIC_AND_SOURCE_MAP_PROMPT.txt', 'CHATGPT_STAGE2_MISSING_SCENE_RESEARCH_PROMPT.txt']) {
  const text = fs.readFileSync(path.join(__dirname, '..', 'prompts', f), 'utf8');
  check(`${f} forbids invented sources`, /never invent|never fabricate/i.test(text));
}

const timebase = require('../src/timebase.js');
const longTail = timebase.tailTolerance(894.7, 2.0, {});
check('long voiceover gets a bounded minor SRT display-tail allowance',
  longTail > 2.3 && longTail < 5 && timebase.tailTolerance(60, 2.0, {}) === 2
    && timebase.tailTolerance(7200, 2.0, {}) === 5,
  `long=${longTail}`);
check('audio can lead SRT by 2–3s without cutting the voiceover, but allowance stays bounded',
  timebase.leadTolerance(2, {}) === 5 && timebase.leadTolerance(2, { render: { audioLeadExtendMaxSeconds: 3 } }) === 3);

const serverApp = require('../server/app.js');
check('job exit policy is fail-closed (only pack-check may use exit 2)',
  serverApp.stepExitAccepted({ accepted: [0, 2] }, 2)
    && !serverApp.stepExitAccepted({ accepted: [0] }, 2)
    && !serverApp.stepExitAccepted({ accepted: [0] }, 3)
    && serverApp.expectedArtifact('draft') === 'draft.mp4'
    && serverApp.expectedArtifact('final') === 'final.mp4');

const noCritPack = path.join(tmp, 'no-criticality.json');
fs.writeFileSync(noCritPack, JSON.stringify({ packs: [{ moments: [{}, { criticality: 'NORMAL' }, {}] }] }));
check('UI preflight can detect legacy packs that need automatic criticality migration',
  serverApp.missingCriticalityCount(noCritPack) === 2);
const freshCrit = serverApp.criticalityStrategy('draft', false, 109, false);
const legacyReadyCrit = serverApp.criticalityStrategy('final', true, 109, true);
const legacyIncompleteCrit = serverApp.criticalityStrategy('final', true, 109, false);
check('criticality strategy migrates fresh drafts but preserves a completed legacy cache',
  freshCrit.migrate_now && !freshCrit.legacy_waiver
    && !legacyReadyCrit.migrate_now && legacyReadyCrit.legacy_waiver
    && !legacyIncompleteCrit.migrate_now && !legacyIncompleteCrit.legacy_waiver);

const runSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'run.js'), 'utf8');
check('legacy waiver is narrow: explicit flag plus HYBRID_READY are both required',
  /flag\(['"]legacy-human-complete['"]\)\s*&&\s*hybrid\.state\s*===\s*['"]HYBRID_READY['"]/.test(runSource));
check('presentation overlay policy invalidates only timeline/render, never acquisition cache',
  runSource.includes('delete cfgForHash.render.burnResearchOverlayText')
    && runSource.includes('delete cfgForHash.render._overlayNote')
    && runSource.includes('`research-overlay=${overlayPolicy}`')
    && renderSource.includes("manifest.some(m => m.asset === 'TEMPLATE_GRAPHIC_MEDIA')"));

const utilSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'util.js'), 'utf8');
check('all backend command runners hide child console windows on Windows',
  /windowsHide:\s*process\.platform\s*===\s*['"]win32['"]/.test(utilSource));

const launcher = require('../tools/launch-ui.js');
check('launcher and server share a stable instance identity', launcher.INSTANCE_ID === serverApp.INSTANCE_ID);
const rootBats = fs.readdirSync(path.join(__dirname, '..')).filter(n => /\.bat$/i.test(n));
check('fresh package exposes one launcher and no updater/old-folder workflow',
  rootBats.length === 1 && rootBats[0] === 'MOVIE_EDITOR.bat' && !fs.existsSync(path.join(__dirname, '..', 'UPDATE_TOOL.bat')),
  rootBats.join(','));

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
if (!process.exitCode) console.log(`M5B CONTRACT: ${pass} PASS / 0 FAIL`);
