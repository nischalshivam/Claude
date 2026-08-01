// ============================================================
//  MINI TEST (offline, no YouTube).
//  Synthetic "episode" videos = time-region ke hisaab se alag COLOR + ek
//  subtitle track. local_file/local_subs sources se poori pipeline chalti
//  hai. Har moment ka cut sahi COLOR region par landa ya nahi — assert.
//
//  Coverage: >=2 EXACT_TIME, >=2 DIALOGUE, repeated source, dead source
//  (alternate recovery), unresolved -> NEEDS_SOURCE. Do independent packs
//  (Akatsuki single-topic + cross-show).
// ============================================================
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// ISOLATED jobs root — production ROOT/jobs ko kabhi haath nahi (M1.2-C).
const JOBS = process.env.RFC_JOBS_DIR && process.env.RFC_JOBS_DIR.trim() ? path.resolve(process.env.RFC_JOBS_DIR.trim()) : path.join(ROOT, 'tests', 'tmp', 'mini_' + process.pid);
process.env.RFC_JOBS_DIR = JOBS;   // spawned run.js isko inherit karega
const FX = path.join(ROOT, 'tests', 'fixtures');
const EP = path.join(FX, 'episodes');
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';

const PALETTE = [
  { name: 'red', hex: '0xC81E1E', rgb: [200, 30, 30] },
  { name: 'green', hex: '0x1EA03C', rgb: [30, 160, 60] },
  { name: 'blue', hex: '0x2850C8', rgb: [40, 80, 200] },
  { name: 'yellow', hex: '0xD2BE28', rgb: [210, 190, 40] },
  { name: 'magenta', hex: '0xB428A0', rgb: [180, 40, 160] },
  { name: 'cyan', hex: '0x28B4BE', rgb: [40, 180, 190] },
];
const SEG = 30; // seconds per segment

function ff(args) { execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { timeout: 120000 }); }
function srtTime(s) { const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = Math.floor(s % 60), ms = Math.round((s % 1) * 1000); return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')},${String(ms).padStart(3,'0')}`; }

// segDefs: [{colorIndex, dialogue}]  -> mp4 (colored 30s each) + srt (dialogue cue per seg)
function makeEpisode(name, segDefs) { return makeEpisodeAt(EP, name, segDefs); }
function makeEpisodeAt(dir, name, segDefs) {
  fs.mkdirSync(dir, { recursive: true });
  const video = path.join(dir, `${name}.mp4`);
  const srt = path.join(dir, `${name}.srt`);
  const tmp = path.join(dir, `_tmp_${name}`);
  fs.mkdirSync(tmp, { recursive: true });
  const parts = [];
  const cueList = [];   // {t0,t1,text}
  segDefs.forEach((d, i) => {
    const seg = path.join(tmp, `s${i}.mp4`);
    const w = d.width || 1280, h = d.height || 720;
    ff(['-f', 'lavfi', '-i', `color=c=${PALETTE[d.colorIndex].hex}:s=${w}x${h}:r=30:d=${SEG}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-t', String(SEG), seg]);
    parts.push(`file '${seg.replace(/'/g, "'\\''")}'`);
    cueList.push({ t0: i * SEG + 2, t1: i * SEG + 8, text: d.dialogue });
    if (d.context) cueList.push({ t0: i * SEG + 9, t1: i * SEG + 14, text: d.context });  // nearby context line
  });
  const srtBlocks = cueList.map((c, k) => `${k + 1}\n${srtTime(c.t0)} --> ${srtTime(c.t1)}\n${c.text}\n`);
  const list = path.join(tmp, 'list.txt'); fs.writeFileSync(list, parts.join('\n'));
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', video]);
  fs.writeFileSync(srt, srtBlocks.join('\n'));
  fs.rmSync(tmp, { recursive: true, force: true });
  return { video: path.relative(ROOT, video), srt: path.relative(ROOT, srt), duration: segDefs.length * SEG };
}

// narration srt + silent-ish audio banana
function makeNarration(dir, cues) {
  fs.mkdirSync(dir, { recursive: true });
  const blocks = cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`);
  fs.writeFileSync(path.join(dir, 'voiceover.srt'), blocks.join('\n'));
  const total = cues[cues.length - 1].end;
  ff(['-f', 'lavfi', '-i', `sine=frequency=220:duration=${total}`, '-c:a', 'aac', path.join(dir, 'voiceover.m4a')]);
  return total;
}

function writePack(dir, pack) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'scene-research.json'), JSON.stringify(pack, null, 2));
}

// dominant color of clip mid-frame -> [r,g,b]
function domColor(clipAbs) {
  const tmp = clipAbs + '.rgb';
  ff(['-ss', '1.0', '-i', clipAbs, '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', tmp]);
  const b = fs.readFileSync(tmp); fs.rmSync(tmp, { force: true });
  return [b[0], b[1], b[2]];
}
function nearestColor(rgb) {
  let best = null;
  for (const p of PALETTE) {
    const d = Math.hypot(rgb[0] - p.rgb[0], rgb[1] - p.rgb[1], rgb[2] - p.rgb[2]);
    if (!best || d < best.d) best = { name: p.name, d: Math.round(d) };
  }
  return best;
}

// ---------------- BUILD FIXTURES ----------------
console.log('== building fixtures ==');
const naruto = makeEpisode('naruto_ep', [
  { colorIndex: 0, dialogue: 'Two red-cloud men walk through the village gates.' },        // 0-30 red
  { colorIndex: 1, dialogue: "I'll take the boy's legs off so he stops being difficult to carry." }, // 30-60 green
  { colorIndex: 2, dialogue: 'The Nine-Tails has to be sealed last or the statue breaks.' }, // 60-90 blue
  { colorIndex: 3, dialogue: 'Sealing a tailed beast takes three full days of standing still.' }, // 90-120 yellow
  { colorIndex: 4, dialogue: 'Almighty Push levels the entire hidden leaf village.' },       // 120-150 magenta
  { colorIndex: 5, dialogue: 'The safest possible moment to take the nine tails.' },         // 150-180 cyan
]);
const zim = makeEpisode('zim_ep', [
  { colorIndex: 0, dialogue: "That's an alien! He has no ears." },        // 0-30 red
  { colorIndex: 1, dialogue: 'The entire class laughs at Dib again.' },   // 30-60 green
  { colorIndex: 2, dialogue: 'I believe you, Dib. You are not crazy.' },  // 60-90 blue
  { colorIndex: 3, dialogue: 'Zim spins a sad little cover story.' },     // 90-120 yellow
]);
const fop = makeEpisode('fop_ep', [
  { colorIndex: 0, dialogue: 'Fairy godparents exist, written in his own handwriting.' }, // 0-30 red
  { colorIndex: 1, dialogue: 'Dimmsdale declares an official Denzel Crocker Day.' },      // 30-60 green
  { colorIndex: 2, dialogue: 'The room laughs him off the stage.' },                       // 60-90 blue
]);

// ---------------- AKATSUKI JOB ----------------
const akDir = path.join(FX, 'akatsuki');
makeNarration(akDir, [
  { start: 0, end: 6, text: 'Two men in red clouds walk into Konoha.' },
  { start: 6, end: 13, text: "Kisame pulls Samehada off his back and says he'll take the boy's legs off." },
  { start: 13, end: 21, text: "There is no need to rush, the Nine-Tails has to be sealed last." },
  { start: 21, end: 29, text: 'Sealing a tailed beast takes three days of standing still.' },
  { start: 29, end: 37, text: 'Then Pain personally invades Konoha and levels the village.' },
  { start: 37, end: 46, text: 'They waited for the safest possible moment to come for the Nine-Tails.' },
]);
writePack(akDir, {
  schema_version: 'scene-research-pack-v1',
  project_title: 'Akatsuki Mini Test',
  packs: [{
    pack_id: 'AK', scope: { kind: 'SERIES', title: 'Naruto' },
    sources: [
      { source_id: 'NARU', local_file: naruto.video, local_subs: naruto.srt, source_kind: 'OFFICIAL_EPISODE', inspection_status: 'VERIFIED_WATCHED', duration_sec: naruto.duration },
      { source_id: 'DEAD', local_file: 'tests/fixtures/episodes/MISSING.mp4', source_kind: 'OTHER', inspection_status: 'VERIFIED_WATCHED' },
    ],
    moments: [
      { moment_id: 'AK_M01', script_cue_exact: 'Two men in red clouds walk into Konoha.', must_show: ['two cloaked figures at village gate'],
        locators: [{ source_id: 'NARU', locator_type: 'EXACT_TIME', start_sec: 2, end_sec: 8, confidence: 'HIGH' }],
        fallback: { type: 'NEEDS_SOURCE' } },
      { moment_id: 'AK_M02', script_cue_exact: "Kisame pulls Samehada off his back and says he'll take the boy's legs off.", must_show: ['Kisame with sword'],
        locators: [{ source_id: 'NARU', locator_type: 'DIALOGUE', dialogue_exact: "take the boy's legs off", confidence: 'HIGH' }],
        fallback: { type: 'NEEDS_SOURCE' } },
      { moment_id: 'AK_M03', script_cue_exact: 'There is no need to rush, the Nine-Tails has to be sealed last.', must_show: ['sealing statue talk'],
        locators: [{ source_id: 'NARU', locator_type: 'DIALOGUE', dialogue_exact: 'the Nine-Tails has to be sealed last', confidence: 'HIGH' }],
        fallback: { type: 'NEEDS_SOURCE' } },
      { moment_id: 'AK_M04', script_cue_exact: 'Sealing a tailed beast takes three days of standing still.', must_show: ['demonic statue'],
        locators: [{ source_id: 'NARU', locator_type: 'EXACT_TIME', start_sec: 92, end_sec: 98, confidence: 'HIGH' }],
        fallback: { type: 'NEEDS_SOURCE' } },
      { moment_id: 'AK_M05', script_cue_exact: 'Then Pain personally invades Konoha and levels the village.', must_show: ['pain invasion'],
        locators: [
          { source_id: 'DEAD', locator_type: 'EXACT_TIME', start_sec: 10, end_sec: 16, confidence: 'MEDIUM' },
          { source_id: 'NARU', locator_type: 'EXACT_TIME', start_sec: 122, end_sec: 128, confidence: 'HIGH' },
        ], fallback: { type: 'NEEDS_SOURCE' } },
      { moment_id: 'AK_M06', script_cue_exact: 'They waited for the safest possible moment to come for the Nine-Tails.',
        locators: [{ source_id: 'NARU', locator_type: 'SEARCH_ONLY', confidence: 'LOW' }],
        fallback: { type: 'NEEDS_SOURCE' } },
    ],
  }],
});

// ---------------- CROSS-SHOW JOB ----------------
const csDir = path.join(FX, 'crossshow');
makeNarration(csDir, [
  { start: 0, end: 7, text: 'A boy looks at the green kid and says that is an alien.' },
  { start: 7, end: 15, text: 'Dib finally gets national television but everyone decides he is crazy.' },
  { start: 15, end: 24, text: 'The counselor Mister Dwicky says the sentence no adult ever said, I believe you.' },
  { start: 24, end: 32, text: 'A man opens a drawer and finds four words, fairy godparents exist.' },
  { start: 32, end: 41, text: 'The facts survived every time, but being believed is social.' },
]);
writePack(csDir, {
  schema_version: 'scene-research-pack-v1',
  project_title: 'Kids Nobody Believed Mini Test',
  packs: [
    {
      pack_id: 'ZIM', scope: { kind: 'SERIES', title: 'Invader Zim' },
      sources: [{ source_id: 'ZIM_EP', local_file: zim.video, local_subs: zim.srt, source_kind: 'OFFICIAL_EPISODE', inspection_status: 'VERIFIED_WATCHED', duration_sec: zim.duration }],
      moments: [
        { moment_id: 'CS_M01', script_cue_exact: 'A boy looks at the green kid and says that is an alien.', must_show: ['green alien kid'],
          locators: [{ source_id: 'ZIM_EP', locator_type: 'DIALOGUE', dialogue_exact: 'that is an alien', confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } },
        { moment_id: 'CS_M03', script_cue_exact: 'The counselor Mister Dwicky says the sentence no adult ever said, I believe you.', must_show: ['counselor scene'],
          locators: [{ source_id: 'ZIM_EP', locator_type: 'DIALOGUE', dialogue_exact: 'I believe you', confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } },
      ],
    },
    {
      pack_id: 'FOP', scope: { kind: 'SERIES', title: 'Fairly OddParents' },
      sources: [{ source_id: 'FOP_EP', local_file: fop.video, local_subs: fop.srt, source_kind: 'OFFICIAL_EPISODE', inspection_status: 'VERIFIED_WATCHED', duration_sec: fop.duration }],
      moments: [
        { moment_id: 'CS_M02', script_cue_exact: 'A man opens a drawer and finds four words, fairy godparents exist.', must_show: ['drawer note'],
          locators: [{ source_id: 'FOP_EP', locator_type: 'EXACT_TIME', start_sec: 2, end_sec: 8, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } },
        { moment_id: 'CS_M04', script_cue_exact: 'The facts survived every time, but being believed is social.',
          locators: [{ source_id: 'FOP_EP', locator_type: 'UNRESOLVED', confidence: 'NONE' }], fallback: { type: 'NEEDS_SOURCE' } },
      ],
    },
  ],
});

// ---------------- EDGE CASES JOB (space+Unicode path, repeated dialogue, missing caption) ----------------
// IDENTICAL dialogue seg0 & seg2; distinguishing CONTEXT line har jagah alag.
const repeat = makeEpisodeAt(path.join(EP, 'repeat épisode'), 'repeat_ep', [  // space+unicode in source path
  { colorIndex: 0, dialogue: 'We strike at dawn.', context: 'at the old mill by the river' },   // red  (repeat #1)
  { colorIndex: 1, dialogue: 'Nothing happens in this scene.' },                                 // green
  { colorIndex: 2, dialogue: 'We strike at dawn.', context: 'at the festival square downtown' }, // blue (repeat #2, anchor near)
  { colorIndex: 3, dialogue: 'The end credits roll.' },                                          // yellow
]);
const ecDir = path.join(FX, 'edgé cases');   // space+unicode in INPUT dir
makeNarration(ecDir, [
  { start: 0, end: 8, text: 'He whispers the plan, we strike at dawn.' },
  { start: 8, end: 16, text: 'Later a silent shot that has no caption at all.' },
  { start: 16, end: 24, text: 'The same order is given again, we strike at dawn.' },
]);
writePack(ecDir, {
  schema_version: 'scene-research-pack-v1',
  project_title: 'Edge Cases Mini Test',
  packs: [{
    pack_id: 'EC', scope: { kind: 'SERIES', title: 'Edge Show' },
    sources: [
      { source_id: 'REP', local_file: repeat.video, local_subs: repeat.srt, source_kind: 'OFFICIAL_EPISODE', inspection_status: 'VERIFIED_WATCHED', duration_sec: repeat.duration },
      { source_id: 'NOSUB', local_file: repeat.video, source_kind: 'OFFICIAL_EPISODE', inspection_status: 'VERIFIED_WATCHED', duration_sec: repeat.duration },
    ],
    moments: [
      // repeated dialogue WITH context: anchor 'festival' se seg2 (blue) chune
      { moment_id: 'EC_M01', script_cue_exact: 'He whispers the plan, we strike at dawn.', must_show: ['dawn raid plan'],
        locators: [{ source_id: 'REP', locator_type: 'DIALOGUE', dialogue_exact: 'we strike at dawn', nearby_context_terms: ['festival'], confidence: 'HIGH' }],
        fallback: { type: 'NEEDS_SOURCE' } },
      // missing caption: NOSUB source ke paas subs nahi -> controlled NEEDS_SOURCE (M2 ASR)
      { moment_id: 'EC_M02', script_cue_exact: 'Later a silent shot that has no caption at all.', must_show: ['silent b-roll'],
        locators: [{ source_id: 'NOSUB', locator_type: 'DIALOGUE', dialogue_exact: 'this line is not present in captions', confidence: 'MEDIUM' }],
        fallback: { type: 'NEEDS_SOURCE' } },
      // repeated dialogue WITHOUT context: ambiguous -> NEEDS_REVIEW (final se bahar)
      { moment_id: 'EC_M03', script_cue_exact: 'The same order is given again, we strike at dawn.', must_show: ['dawn raid'],
        locators: [{ source_id: 'REP', locator_type: 'DIALOGUE', dialogue_exact: 'we strike at dawn', confidence: 'HIGH' }],
        fallback: { type: 'NEEDS_SOURCE' } },
    ],
  }],
});

// ---------------- RUN PIPELINE ----------------
function runJob(inputDir, jobId) {
  console.log(`\n== run pipeline: ${jobId} ==`);
  try {
    const out = execFileSync('node', ['src/run.js', `--input=${inputDir}`, `--job=${jobId}`, '--redo'],
      { cwd: ROOT, encoding: 'utf8', timeout: 600000, stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(out.split('\n').filter(l => /\[OK\]|\[WARN\]|\[FAIL\]|DONE|located|timeline|render|report|QA/.test(l)).join('\n'));
  } catch (e) {
    console.log('PIPELINE ERROR:\n', (e.stdout || '') + (e.stderr || ''));
    throw e;
  }
}

runJob(akDir, 'akatsuki');
runJob(csDir, 'crossshow');
runJob(ecDir, 'edgecases');

// ---------------- ASSERTIONS ----------------
function loadResolved(jobId) { return JSON.parse(fs.readFileSync(path.join(JOBS, jobId, 'resolved.json'), 'utf8')); }
function findM(res, id) { return res.find(r => r.moment_id === id); }

const expectations = [
  // [job, moment, expectStatus, expectColor|null, expectLocator]
  ['akatsuki', 'AK_M01', 'RESOLVED', 'red', 'EXACT_TIME'],
  ['akatsuki', 'AK_M02', 'RESOLVED', 'green', 'DIALOGUE'],
  ['akatsuki', 'AK_M03', 'RESOLVED', 'blue', 'DIALOGUE'],
  ['akatsuki', 'AK_M04', 'RESOLVED', 'yellow', 'EXACT_TIME'],
  ['akatsuki', 'AK_M05', 'RESOLVED', 'magenta', 'EXACT_TIME'], // dead source -> alternate
  ['akatsuki', 'AK_M06', 'NEEDS_SOURCE', null, null],
  ['crossshow', 'CS_M01', 'RESOLVED', 'red', 'DIALOGUE'],
  ['crossshow', 'CS_M02', 'RESOLVED', 'red', 'EXACT_TIME'],
  ['crossshow', 'CS_M03', 'RESOLVED', 'blue', 'DIALOGUE'],
  ['crossshow', 'CS_M04', 'NEEDS_SOURCE', null, null],
  ['edgecases', 'EC_M01', 'RESOLVED', 'blue', 'DIALOGUE'],   // repeated dialogue, anchor 'festival' -> seg2 (blue)
  ['edgecases', 'EC_M02', 'NEEDS_SOURCE', null, null],       // missing caption -> NEEDS_SOURCE
  ['edgecases', 'EC_M03', 'NEEDS_REVIEW', null, 'DIALOGUE'], // repeated dialogue, no context -> held out of final
];

console.log('\n' + '='.repeat(78));
console.log('  PER-MOMENT TEST RESULTS');
console.log('='.repeat(78));
const cache = {};
let pass = 0, fail = 0; const failures = [];
for (const [job, mid, wantStatus, wantColor, wantLoc] of expectations) {
  cache[job] = cache[job] || loadResolved(job);
  const m = findM(cache[job], mid);
  let ok = true; const notes = [];
  if (!m) { ok = false; notes.push('moment missing'); }
  else {
    if (m.status !== wantStatus) { ok = false; notes.push(`status ${m.status}!=${wantStatus}`); }
    if (wantLoc && m.locator_type !== wantLoc) { ok = false; notes.push(`locator ${m.locator_type}!=${wantLoc}`); }
    if (wantColor && m.status === 'RESOLVED' && m.clip) {
      const clipAbs = path.join(JOBS, job, m.clip);
      if (!fs.existsSync(clipAbs)) { ok = false; notes.push('clip file missing'); }
      else { const got = nearestColor(domColor(clipAbs)); if (got.name !== wantColor || got.d > 60) { ok = false; notes.push(`color ${got.name}(d${got.d})!=${wantColor}`); } else notes.push(`color ${got.name} ok`); }
    }
    if (m.decision) notes.push(`dec=${m.decision}${m.score != null ? ' s=' + m.score : ''}`);
  }
  const tag = ok ? 'PASS' : 'FAIL';
  if (ok) pass++; else { fail++; failures.push(`${job}/${mid}: ${notes.join('; ')}`); }
  console.log(`  [${tag}] ${job.padEnd(9)} ${mid.padEnd(7)} ${String(wantStatus).padEnd(13)} ${(wantColor||'-').padEnd(8)} ${wantLoc||'-'}  |  ${notes.join('; ')}`);
}

// deliverables check
console.log('\n  -- deliverables --');
for (const job of ['akatsuki', 'crossshow', 'edgecases']) {
  for (const f of ['final.mp4', 'timeline.json', 'quality-report.html', 'NEEDS_SOURCE.csv']) {
    const p = path.join(JOBS, job, f);
    const exists = fs.existsSync(p);
    const sz = exists ? fs.statSync(p).size : 0;
    console.log(`  [${exists && sz > 0 ? 'OK' : 'MISS'}] ${job}/${f} ${exists ? '(' + sz + ' bytes)' : ''}`);
    if (!exists || !sz) { fail++; failures.push(`${job}/${f} missing/empty`); }
  }
  // final duration ~ narration
  const finalP = path.join(JOBS, job, 'final.mp4');
  if (fs.existsSync(finalP)) {
    try {
      const out = execFileSync(FFMPEG, ['-hide_banner', '-i', finalP], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const m = (e.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      if (m) console.log(`       ${job}/final.mp4 duration ${(+m[1]*3600+ +m[2]*60+ +parseFloat(m[3])).toFixed(1)}s`);
    }
  }
}

// NEEDS_SOURCE.csv content check
for (const [job, mid] of [['akatsuki', 'AK_M06'], ['crossshow', 'CS_M04'], ['edgecases', 'EC_M02']]) {
  const csv = fs.readFileSync(path.join(JOBS, job, 'NEEDS_SOURCE.csv'), 'utf8');
  const has = csv.includes(mid);
  console.log(`  [${has ? 'OK' : 'FAIL'}] ${job}/NEEDS_SOURCE.csv contains ${mid}`);
  if (!has) { fail++; failures.push(`${job} NEEDS_SOURCE.csv missing ${mid}`); }
}

console.log('\n' + '='.repeat(78));
console.log(`  SUMMARY: ${pass} PASS, ${fail} FAIL`);
if (failures.length) { console.log('  REMAINING FAILURES:'); failures.forEach(f => console.log('   - ' + f)); }
console.log('='.repeat(78));
process.exit(fail ? 1 : 0);
