#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

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

const renderSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'render.js'), 'utf8');
check('short manual video render is loop-safe', renderSource.includes("'-stream_loop', '-1', '-ss', String(s.media_start || 0)"));
for (const f of ['CHATGPT_STAGE1_TOPIC_AND_SOURCE_MAP_PROMPT.txt', 'CHATGPT_STAGE2_MISSING_SCENE_RESEARCH_PROMPT.txt']) {
  const text = fs.readFileSync(path.join(__dirname, '..', 'prompts', f), 'utf8');
  check(`${f} forbids invented sources`, /never invent|never fabricate/i.test(text));
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
if (!process.exitCode) console.log(`M5B CONTRACT: ${pass} PASS / 0 FAIL`);

