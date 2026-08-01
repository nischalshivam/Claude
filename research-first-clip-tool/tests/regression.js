// ============================================================
//  M1.1 REGRESSION SUITE — audit ke mandated tests (offline, no YouTube).
//  Har test infra-correctness verify karta hai. run-mini-test.js = content
//  cases (13); ye = correctness/blocker cases (12).
// ============================================================
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// ISOLATED jobs root — production ROOT/jobs ko kabhi haath nahi (M1.2-C).
const JOBS = path.join(ROOT, 'tests', 'tmp', 'reg_' + process.pid);
process.env.RFC_JOBS_DIR = JOBS;   // spawned run.js isko inherit karega
const FX = path.join(ROOT, 'tests', 'fixtures', 'reg');
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const SEG = 20;
const PAL = { red: '0xC81E1E', green: '0x1EA03C', blue: '0x2850C8', yellow: '0xD2BE28', black: 'black' };
const PRGB = { red: [200, 30, 30], green: [30, 160, 60], blue: [40, 80, 200], yellow: [210, 190, 40], review: [58, 43, 8], needs: [74, 16, 16], text: [26, 26, 26], black: [0, 0, 0] };

function ff(args) { execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { timeout: 120000 }); }
function srtTime(s) { const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = Math.floor(s % 60), ms = Math.round((s % 1) * 1000); return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')},${String(ms).padStart(3,'0')}`; }

// segs: [{color, dialogue?}]  opts: {w,h}
function makeEp(dir, name, segs, { w = 1280, h = 720 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const video = path.join(dir, `${name}.mp4`), srt = path.join(dir, `${name}.srt`), tmp = path.join(dir, `_t_${name}`);
  fs.mkdirSync(tmp, { recursive: true });
  const parts = [], cues = [];
  segs.forEach((d, i) => {
    const seg = path.join(tmp, `s${i}.mp4`);
    ff(['-f', 'lavfi', '-i', `color=c=${PAL[d.color] || d.color}:s=${w}x${h}:r=30:d=${SEG}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-t', String(SEG), seg]);
    parts.push(`file '${seg.replace(/'/g, "'\\''")}'`);
    if (d.dialogue) cues.push({ t0: i * SEG + 2, t1: i * SEG + 7, text: d.dialogue });
    if (d.context) cues.push({ t0: i * SEG + 8, t1: i * SEG + 13, text: d.context });
  });
  const list = path.join(tmp, 'l.txt'); fs.writeFileSync(list, parts.join('\n'));
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', video]);
  fs.writeFileSync(srt, cues.map((c, k) => `${k + 1}\n${srtTime(c.t0)} --> ${srtTime(c.t1)}\n${c.text}\n`).join('\n'));
  fs.rmSync(tmp, { recursive: true, force: true });
  return { video: path.relative(ROOT, video), srt: path.relative(ROOT, srt), duration: segs.length * SEG };
}
function makeNarr(dir, cues) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'voiceover.srt'), cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n'));
  ff(['-f', 'lavfi', '-i', `sine=frequency=220:duration=${cues[cues.length - 1].end}`, '-c:a', 'aac', path.join(dir, 'voiceover.m4a')]);
}
function writePack(dir, pack) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'scene-research.json'), JSON.stringify(pack, null, 2)); }
function runRFC(args, env = {}) { return spawnSync('node', ['src/run.js', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 600000, env: { ...process.env, ...env } }); }
function dur(f) { try { execFileSync(FFMPEG, ['-hide_banner', '-i', f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { const m = String(e.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/); return m ? +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]) : 0; } return 0; }
function colorAt(f, t) { const tmp = f + `.${t}.rgb`; ff(['-ss', String(t), '-i', f, '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', tmp]); const b = fs.readFileSync(tmp); fs.rmSync(tmp, { force: true }); return [b[0], b[1], b[2]]; }
function nearest(rgb) { let best; for (const k in PRGB) { const d = Math.hypot(rgb[0] - PRGB[k][0], rgb[1] - PRGB[k][1], rgb[2] - PRGB[k][2]); if (!best || d < best.d) best = { k, d: Math.round(d) }; } return best; }
const jf = (job, f) => JSON.parse(fs.readFileSync(path.join(JOBS, job, f), 'utf8'));

const results = [];
function check(name, cond, detail = '') { results.push({ name, ok: !!cond, detail }); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`); }

console.log('== M1.1 REGRESSION SUITE ==');
fs.rmSync(FX, { recursive: true, force: true });
fs.rmSync(JOBS, { recursive: true, force: true }); fs.mkdirSync(JOBS, { recursive: true });

// shared good episode
const good = makeEp(path.join(FX, 'ep'), 'good', [
  { color: 'red', dialogue: 'The alarm rings across the base.' },
  { color: 'green', dialogue: 'She opens the sealed hatch slowly.' },
  { color: 'blue', dialogue: 'They meet on the rooftop at night.' },
  { color: 'yellow', dialogue: 'The final shot fades to black.' },
]);

// ---------- T1: path traversal & redo containment ----------
(() => {
  const d = path.join(FX, 'base'); makeNarr(d, [{ start: 0, end: 6, text: 'The alarm rings across the base.' }]);
  writePack(d, { schema_version: 'scene-research-pack-v1', project_title: 'Base', packs: [{ pack_id: 'P', scope: { kind: 'SERIES', title: 'X' }, sources: [{ source_id: 'S', local_file: good.video, local_subs: good.srt }], moments: [{ moment_id: 'M1', script_cue_exact: 'The alarm rings across the base.', locators: [{ source_id: 'S', locator_type: 'EXACT_TIME', start_sec: 2, end_sec: 7, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } }] }] });
  const r = runRFC([`--input=${d}`, '--job=../evil', '--redo']);
  const rejected = r.status !== 0 && /unsafe job id/i.test((r.stdout || '') + (r.stderr || ''));
  const noEvil = !fs.existsSync(path.join(ROOT, 'evil')) && !fs.existsSync(path.join(JOBS, '..', 'evil'));
  check('T1 path-traversal --job rejected & nothing created outside jobs/', rejected && noEvil, `exit=${r.status}`);
  // malicious moment_id in pack -> validation rejects
  writePack(d, { schema_version: 'scene-research-pack-v1', project_title: 'Base', packs: [{ pack_id: 'P', scope: { kind: 'SERIES', title: 'X' }, sources: [{ source_id: 'S', local_file: good.video, local_subs: good.srt }], moments: [{ moment_id: '../hack', script_cue_exact: 'x', locators: [{ source_id: 'S', locator_type: 'EXACT_TIME', start_sec: 2, end_sec: 7 }] }] }] });
  const r2 = runRFC([`--input=${d}`, '--job=reg_idcheck', '--redo']);
  check('T1b unsafe moment_id rejected by validator', r2.status !== 0 && /unsafe/i.test((r2.stdout || '')), `exit=${r2.status}`);
})();

// ---------- T2: fresh-process resume download -> cut ----------
(() => {
  const d = path.join(FX, 'resume'); makeNarr(d, [{ start: 0, end: 6, text: 'The alarm rings across the base.' }, { start: 6, end: 12, text: 'They meet on the rooftop at night.' }]);
  const pack = { schema_version: 'scene-research-pack-v1', project_title: 'Resume', packs: [{ pack_id: 'P', scope: { kind: 'SERIES', title: 'X' }, sources: [{ source_id: 'S', local_file: good.video, local_subs: good.srt }], moments: [
    { moment_id: 'R1', script_cue_exact: 'The alarm rings across the base.', locators: [{ source_id: 'S', locator_type: 'EXACT_TIME', start_sec: 2, end_sec: 7, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } },
    { moment_id: 'R2', script_cue_exact: 'They meet on the rooftop at night.', locators: [{ source_id: 'S', locator_type: 'DIALOGUE', dialogue_exact: 'they meet on the rooftop at night', confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } },
  ] }] };
  writePack(d, pack);
  // one-shot reference
  runRFC([`--input=${d}`, '--job=reg_oneshot', '--redo']);
  const oneClips = fs.readdirSync(path.join(JOBS, 'reg_oneshot', 'clips')).filter(f => f.endsWith('.mp4')).length;
  // resume: process A (through download), process B fresh (cut onward)
  const a = runRFC([`--input=${d}`, '--job=reg_resume', '--redo', '--only=align,locate,download']);
  const resolvedAfterDl = jf('reg_resume', 'resolved.json');
  const rawPersisted = resolvedAfterDl.filter(e => e.raw_file).length;
  const b = runRFC([`--input=${d}`, '--job=reg_resume', '--from=5']);   // fresh node process
  const resumeClips = fs.existsSync(path.join(JOBS, 'reg_resume', 'clips')) ? fs.readdirSync(path.join(JOBS, 'reg_resume', 'clips')).filter(f => f.endsWith('.mp4')).length : 0;
  const tl = jf('reg_resume', 'timeline.json');
  const vids = tl.slots.filter(s => s.kind === 'video').length;
  check('T2 raw_file persisted after download', rawPersisted === 2, `${rawPersisted}/2`);
  check('T2 fresh-process resume cut produces clips (not 0)', resumeClips === oneClips && resumeClips === 2, `resume=${resumeClips} oneshot=${oneClips}`);
  check('T2 resumed timeline has video slots', vids === 2, `video=${vids}`);
})();

// ---------- T3: red->blue timestamp change — resolved.json + CLIP + FINAL all change ----------
(() => {
  const d = path.join(FX, 'inv'); makeNarr(d, [{ start: 0, end: 6, text: 'The alarm rings across the base.' }]);
  const mk = (start, end) => ({ schema_version: 'scene-research-pack-v1', project_title: 'Inv', packs: [{ pack_id: 'P', scope: { kind: 'SERIES', title: 'X' }, sources: [{ source_id: 'S', local_file: good.video, local_subs: good.srt }], moments: [{ moment_id: 'IV', script_cue_exact: 'The alarm rings across the base.', locators: [{ source_id: 'S', locator_type: 'EXACT_TIME', start_sec: start, end_sec: end, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } }] }] });
  const clipCol = () => nearest(colorAt(path.join(JOBS, 'reg_inv', jf('reg_inv', 'resolved.json').find(e => e.moment_id === 'IV').clip), 1)).k;
  const finalCol = () => nearest(colorAt(path.join(JOBS, 'reg_inv', 'final.mp4'), 3)).k;
  writePack(d, mk(2, 7));                                       // seg0 red
  runRFC([`--input=${d}`, '--job=reg_inv', '--redo']);
  const cut1 = jf('reg_inv', 'resolved.json').find(e => e.moment_id === 'IV').cut.start, clip1 = clipCol(), final1 = finalCol();
  writePack(d, mk(42, 47));                                     // seg2 blue
  const r = runRFC([`--input=${d}`, '--job=reg_inv']);          // NO --redo
  const invalidated = /input change/i.test(r.stdout || '');
  const cut2 = jf('reg_inv', 'resolved.json').find(e => e.moment_id === 'IV').cut.start, clip2 = clipCol(), final2 = finalCol();
  check('T3 timestamp change red->blue reflects in resolved.json + CLIP + FINAL (no stale media)',
    invalidated && cut1 !== cut2 && clip1 === 'red' && clip2 === 'blue' && final1 === 'red' && final2 === 'blue',
    `resolved ${cut1}->${cut2} | clip ${clip1}->${clip2} | final ${final1}->${final2}`);
})();

// ---------- T3b: source (local_file) change, same source_id+range -> clip bytes/content change ----------
(() => {
  const redEp = makeEp(path.join(FX, 'ep'), 'redonly', [{ color: 'red', dialogue: 'the alarm rings across the base' }]);
  const blueEp = makeEp(path.join(FX, 'ep'), 'blueonly', [{ color: 'blue', dialogue: 'the alarm rings across the base' }]);
  const d = path.join(FX, 'srcchg'); makeNarr(d, [{ start: 0, end: 6, text: 'The alarm rings across the base.' }]);
  const mk = (ep) => ({ schema_version: 'scene-research-pack-v1', project_title: 'Src', packs: [{ pack_id: 'P', scope: { kind: 'SERIES', title: 'X' }, sources: [{ source_id: 'S', local_file: ep.video, local_subs: ep.srt }], moments: [{ moment_id: 'SC', script_cue_exact: 'The alarm rings across the base.', locators: [{ source_id: 'S', locator_type: 'EXACT_TIME', start_sec: 2, end_sec: 7, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } }] }] });
  const col = () => nearest(colorAt(path.join(JOBS, 'reg_src', jf('reg_src', 'resolved.json')[0].clip), 1)).k;
  writePack(d, mk(redEp)); runRFC([`--input=${d}`, '--job=reg_src', '--redo']); const c1 = col();
  writePack(d, mk(blueEp)); runRFC([`--input=${d}`, '--job=reg_src']); const c2 = col();  // same id/range, diff file
  check('T3b source local_file change (same id/range) -> clip content changes red->blue', c1 === 'red' && c2 === 'blue', `${c1}->${c2}`);
})();

// ---------- T4/T5: repeated dialogue margin + REVIEW excluded from final ----------
(() => {
  const rep = makeEp(path.join(FX, 'ep'), 'rep', [
    { color: 'red', dialogue: 'We strike at dawn.', context: 'at the old mill' },
    { color: 'green', dialogue: 'nothing here' },
    { color: 'blue', dialogue: 'We strike at dawn.', context: 'at the festival square' },
  ]);
  const d = path.join(FX, 'rep'); makeNarr(d, [{ start: 0, end: 7, text: 'He says we strike at dawn.' }, { start: 7, end: 14, text: 'Again the order we strike at dawn.' }]);
  writePack(d, { schema_version: 'scene-research-pack-v1', project_title: 'Rep', packs: [{ pack_id: 'P', scope: { kind: 'SERIES', title: 'X' }, sources: [{ source_id: 'S', local_file: rep.video, local_subs: rep.srt }], moments: [
    { moment_id: 'RA', script_cue_exact: 'He says we strike at dawn.', locators: [{ source_id: 'S', locator_type: 'DIALOGUE', dialogue_exact: 'we strike at dawn', nearby_context_terms: ['festival'], confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } },
    { moment_id: 'RB', script_cue_exact: 'Again the order we strike at dawn.', locators: [{ source_id: 'S', locator_type: 'DIALOGUE', dialogue_exact: 'we strike at dawn', confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } },
  ] }] });
  runRFC([`--input=${d}`, '--job=reg_rep', '--redo']);
  const res = jf('reg_rep', 'resolved.json');
  const RA = res.find(e => e.moment_id === 'RA'), RB = res.find(e => e.moment_id === 'RB');
  check('T5 repeated dialogue WITH anchor -> ACCEPT correct occurrence (blue)', RA.status === 'RESOLVED' && nearest(colorAt(path.join(JOBS, 'reg_rep', RA.clip), 1)).k === 'blue', `RA=${RA.status}`);
  check('T5 repeated dialogue WITHOUT context -> NEEDS_REVIEW (ambiguous)', RB.status === 'NEEDS_REVIEW', `RB=${RB.status}`);
  // T4: final at RB's beat must be a REVIEW card, not the clip
  const tl = jf('reg_rep', 'timeline.json'); const rbSlot = tl.slots.find(s => s.moment_id === 'RB');
  const finalCol = nearest(colorAt(path.join(JOBS, 'reg_rep', 'final.mp4'), (rbSlot.start + rbSlot.end) / 2));
  check('T4 NEEDS_REVIEW excluded from final (review card, not clip)', rbSlot.kind === 'needs_review' && finalCol.k === 'review', `slot=${rbSlot.kind} col=${finalCol.k}`);
})();

// ---------- T6: exact range-cache collision ----------
(() => {
  const DL = require(path.join(ROOT, 'src', 'download.js'));
  const k1 = DL.rangeKey('S', 10.1, 20.1, 480), k2 = DL.rangeKey('S', 10.9, 20.9, 480);
  check('T6 range-cache keys distinct for 10.1-20.1 vs 10.9-20.9', k1 !== k2, `${k1} vs ${k2}`);
  // reuse only on exact match: pre-populate cache for range A (url cand), then A reuses, B does not
  const U = require(path.join(ROOT, 'src', 'util.js')); const cfg = U.config();
  const id = 'reg_cache'; const rawDir = U.ensureDir(U.p(id, 'cache', '_raw'));
  const candA = { source_id: 'S', url: 'https://example.com/v', cut: { start: 13.1, end: 17.1 } };  // seg=guard: start-3..end+3 => 10.1..20.1
  const guard = cfg.clip.downloadGuardSeconds, segStart = candA.cut.start - guard, segEnd = candA.cut.end + guard;
  const rawFile = path.join(rawDir, DL.rangeKey('S', segStart, segEnd, cfg.qa.minHeight));
  // fabricate a real tiny mp4 as the "cached" raw + manifest
  ff(['-f', 'lavfi', '-i', 'color=c=green:s=320x240:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '2', rawFile]);
  fs.writeFileSync(rawFile + '.json', JSON.stringify({ segStart, segEnd, url: candA.url, minH: cfg.qa.minHeight }));
  const rA = DL.downloadCandidate(id, cfg, candA);
  const candB = { source_id: 'S', url: 'https://example.com/v', cut: { start: 13.9, end: 17.9 } };  // shifted -> diff key -> no reuse -> yt-dlp (blocked) fail
  const rB = DL.downloadCandidate(id, cfg, candB);
  check('T6 exact match reuses cache; shifted range does NOT reuse', rA.ok && rA.via === 'cache' && !rB.ok, `A=${rA.via} B=${rB.ok ? 'reused(wrong)' : 'no-reuse'}`);
})();

// ---------- T7 + T12: black/low-res QA + candidate fallback (download-time & QA-time) ----------
(() => {
  const black = makeEp(path.join(FX, 'ep'), 'black', [{ color: 'black', dialogue: 'darkness everywhere here now' }]);
  const low = makeEp(path.join(FX, 'ep'), 'low', [{ color: 'red', dialogue: 'tiny low resolution shot here' }], { w: 320, h: 240 });
  const d = path.join(FX, 'qa'); makeNarr(d, [
    { start: 0, end: 6, text: 'The alarm rings across the base.' },   // QA-time fallback (black->good)
    { start: 6, end: 12, text: 'She opens the sealed hatch slowly.' }, // download-time fallback (dead->good)
    { start: 12, end: 18, text: 'They meet on the rooftop at night.' },// low-res only -> NEEDS_SOURCE
  ]);
  writePack(d, { schema_version: 'scene-research-pack-v1', project_title: 'QA', packs: [{ pack_id: 'P', scope: { kind: 'SERIES', title: 'X' }, sources: [
    { source_id: 'BLACK', local_file: black.video, local_subs: black.srt }, { source_id: 'GOOD', local_file: good.video, local_subs: good.srt },
    { source_id: 'DEAD', local_file: 'tests/fixtures/reg/ep/MISSING.mp4' }, { source_id: 'LOW', local_file: low.video, local_subs: low.srt },
  ], moments: [
    { moment_id: 'QA1', script_cue_exact: 'The alarm rings across the base.', must_show: ['x'], locators: [
      { source_id: 'BLACK', locator_type: 'EXACT_TIME', start_sec: 2, end_sec: 7, confidence: 'HIGH' },
      { source_id: 'GOOD', locator_type: 'EXACT_TIME', start_sec: 22, end_sec: 27, confidence: 'HIGH' } ], fallback: { type: 'NEEDS_SOURCE' } },
    { moment_id: 'QA2', script_cue_exact: 'She opens the sealed hatch slowly.', locators: [
      { source_id: 'DEAD', locator_type: 'EXACT_TIME', start_sec: 2, end_sec: 7, confidence: 'MEDIUM' },
      { source_id: 'GOOD', locator_type: 'EXACT_TIME', start_sec: 22, end_sec: 27, confidence: 'HIGH' } ], fallback: { type: 'NEEDS_SOURCE' } },
    { moment_id: 'QA3', script_cue_exact: 'They meet on the rooftop at night.', locators: [
      { source_id: 'LOW', locator_type: 'EXACT_TIME', start_sec: 2, end_sec: 7, confidence: 'HIGH' } ], fallback: { type: 'NEEDS_SOURCE' } },
  ] }] });
  runRFC([`--input=${d}`, '--job=reg_qa', '--redo']);
  const res = jf('reg_qa', 'resolved.json');
  const q1 = res.find(e => e.moment_id === 'QA1'), q2 = res.find(e => e.moment_id === 'QA2'), q3 = res.find(e => e.moment_id === 'QA3');
  const q1col = q1.clip ? nearest(colorAt(path.join(JOBS, 'reg_qa', q1.clip), 1)).k : '-';
  check('T7/T12 QA rejects BLACK, recovers via alternate (green)', q1.status === 'RESOLVED' && q1.source_id === 'GOOD' && q1col === 'green', `${q1.status}/${q1.source_id}/${q1col}`);
  check('T12 download-time DEAD source -> alternate (RESOLVED via GOOD)', q2.status === 'RESOLVED' && q2.source_id === 'GOOD', `${q2.status}/${q2.source_id}`);
  check('T7 low-res source rejected -> NEEDS_SOURCE', q3.status === 'NEEDS_SOURCE', `${q3.status}`);
})();

// ---------- T8: segment failure -> fallback card, no drift (render ACTUALLY reruns) ----------
(() => {
  const job = 'reg_oneshot';
  const tl = jf(job, 'timeline.json');
  const vslot = tl.slots.find(s => s.kind === 'video');
  fs.writeFileSync(path.join(JOBS, job, vslot.video), 'CORRUPT');   // break one clip
  // render/report ko force rerun karao (warna checkpoint skip kar deta — GPT ne ye pakda tha)
  const stf = path.join(JOBS, job, 'state.json'); const st = JSON.parse(fs.readFileSync(stf, 'utf8'));
  delete st.done.render; delete st.done.report; fs.writeFileSync(stf, JSON.stringify(st));
  for (const f of ['final.mp4', 'video_master.mp4']) { const p = path.join(JOBS, job, f); if (fs.existsSync(p)) fs.rmSync(p); }
  fs.rmSync(path.join(JOBS, job, 'segments'), { recursive: true, force: true });
  const r = runRFC([`--input=${path.join(FX, 'resume')}`, `--job=${job}`, '--from=8']);
  const rendered = /render fail -> fallback card|render: final\.mp4/.test(r.stdout || '');
  const fdur = dur(path.join(JOBS, job, 'final.mp4'));
  check('T8 corrupt segment -> fallback card, render reruns, no drift (final dur == total)', rendered && Math.abs(fdur - tl.total) < 0.5, `final=${fdur.toFixed(2)} total=${tl.total}`);
})();

// ---------- T9 + T10: final duration equality + per-beat sampling ----------
(() => {
  const job = 'reg_qa';
  const tl = jf(job, 'timeline.json');
  const fdur = dur(path.join(JOBS, job, 'final.mp4'));
  check('T9 final.mp4 duration == timeline total (±0.4s)', Math.abs(fdur - tl.total) < 0.4, `final=${fdur.toFixed(2)} total=${tl.total}`);
  let allBeatsOk = true, detail = '';
  for (const s of tl.slots) {
    const col = nearest(colorAt(path.join(JOBS, job, 'final.mp4'), Math.min(tl.total - 0.2, (s.start + s.end) / 2)));
    const isCard = ['review', 'needs', 'text'].includes(col.k);
    const okSlot = s.kind === 'video' ? !isCard : true;   // video slot ka rang palette color hona chahiye
    if (!okSlot) { allBeatsOk = false; detail += `${s.kind}@${s.start}:${col.k} `; }
  }
  check('T10 final sampled at every beat matches slot kind', allBeatsOk, detail || 'all beats ok');
})();

// ---------- T11: preflight stop for URL project when yt-dlp missing ----------
(() => {
  const d = path.join(FX, 'url'); makeNarr(d, [{ start: 0, end: 6, text: 'The alarm rings across the base.' }]);
  writePack(d, { schema_version: 'scene-research-pack-v1', project_title: 'Url', packs: [{ pack_id: 'P', scope: { kind: 'SERIES', title: 'X' }, sources: [{ source_id: 'S', url: 'https://www.youtube.com/watch?v=TESTID12345', video_id: 'TESTID12345' }], moments: [{ moment_id: 'U1', script_cue_exact: 'The alarm rings across the base.', locators: [{ source_id: 'S', locator_type: 'EXACT_TIME', start_sec: 2, end_sec: 7, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } }] }] });
  const r = runRFC([`--input=${d}`, '--job=reg_url', '--redo'], { RFC_YTDLP: '/nonexistent/yt-dlp-xyz' });
  const stopped = r.status === 2 && /preflight STOP/i.test(r.stdout || '');
  const noFinal = !fs.existsSync(path.join(JOBS, 'reg_url', 'final.mp4'));
  check('T11 URL project + missing yt-dlp -> preflight STOP (exit 2, no misleading DONE)', stopped && noFinal, `exit=${r.status}`);
})();

// ---------- T-A / T-B: dense micro-cue SRT runner-up (align.js disjointness) ----------
// Real bug: 409-cue Whisper SRT mein ek phrase kai chhote cues par phaila hota hai.
// Sliding windows overlap karte hain -> purana code unhe "alag occurrence" samajh
// kar false AMBIGUOUS deta tha (production: 29 OK + 53 false AMBIGUOUS).
(() => {
  // dense micro-cues (har cue 2-4 shabd) — asli Whisper SRT jaisa
  const denseCues = (lines, t0 = 0) => lines.map((text, k) => ({ start: t0 + k * 1.5, end: t0 + k * 1.5 + 1.4, text }));
  const writeSrt = (file, cues) => fs.writeFileSync(file, cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n'));

  // Test A: phrase SIRF EK BAAR, par kai micro-cues par phaili -> OK rehna chahiye
  const aDir = path.join(FX, 'denseA'); fs.mkdirSync(aDir, { recursive: true });
  const aCues = denseCues([
    'Second place is', 'first place for', 'losers. Say that', 'to an adult,', 'and it is a',
    'motivational poster.', 'Say it to a', 'child, and it is', 'an operating system,', 'the parents go further.',
  ]);
  writeSrt(path.join(aDir, 'voiceover.srt'), aCues);
  ff(['-f', 'lavfi', '-i', `sine=frequency=220:duration=${aCues[aCues.length - 1].end}`, '-c:a', 'aac', path.join(aDir, 'voiceover.m4a')]);
  writePack(aDir, { schema_version: 'scene-research-pack-v1', project_title: 'DenseA', packs: [{ pack_id: 'P', scope: { kind: 'SERIES', title: 'X' }, sources: [{ source_id: 'S', local_file: good.video, local_subs: good.srt }], moments: [
    { moment_id: 'DA', script_cue_exact: 'Second place is first place for losers. Say that to an adult, and it is a motivational poster.',
      locators: [{ source_id: 'S', locator_type: 'EXACT_TIME', start_sec: 2, end_sec: 7, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } },
  ] }] });
  runRFC([`--input=${aDir}`, '--job=reg_denseA', '--redo', '--only=align,locate']);
  const A = jf('reg_denseA', 'aligned.json').moments[0];
  check('T-A dense SRT: overlapping sliding windows are NOT independent runner-ups (stays OK)',
    A.align_flag === 'OK', `flag=${A.align_flag} score=${A.align_score} runnerUp=${A.align_runnerup}`);

  // Test B: WAHI phrase do bilkul alag (disjoint) jagah -> AMBIGUOUS rehna chahiye
  const bDir = path.join(FX, 'denseB'); fs.mkdirSync(bDir, { recursive: true });
  const phrase = ['She has to be', 'the best, and', 'nothing was ever enough.'];
  const filler = ['Then the show', 'cuts to a', 'completely different', 'unrelated quiet', 'evening scene.'];
  const bCues = [...denseCues(phrase, 0), ...denseCues(filler, 10), ...denseCues(phrase, 25)];
  writeSrt(path.join(bDir, 'voiceover.srt'), bCues);
  ff(['-f', 'lavfi', '-i', `sine=frequency=220:duration=${bCues[bCues.length - 1].end}`, '-c:a', 'aac', path.join(bDir, 'voiceover.m4a')]);
  writePack(bDir, { schema_version: 'scene-research-pack-v1', project_title: 'DenseB', packs: [{ pack_id: 'P', scope: { kind: 'SERIES', title: 'X' }, sources: [{ source_id: 'S', local_file: good.video, local_subs: good.srt }], moments: [
    { moment_id: 'DB', script_cue_exact: 'She has to be the best, and nothing was ever enough.',
      locators: [{ source_id: 'S', locator_type: 'EXACT_TIME', start_sec: 2, end_sec: 7, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } },
  ] }] });
  runRFC([`--input=${bDir}`, '--job=reg_denseB', '--redo', '--only=align,locate']);
  const B = jf('reg_denseB', 'aligned.json').moments[0];
  const Bres = jf('reg_denseB', 'resolved.json')[0];
  check('T-B genuine disjoint repetition IS still caught (AMBIGUOUS, held out of final)',
    B.align_flag === 'AMBIGUOUS' && Bres.status === 'NEEDS_REVIEW', `flag=${B.align_flag} status=${Bres.status} best=${B.align_score} ru=${B.align_runnerup}`);
})();

// ---------- T-JS: yt-dlp --js-runtimes in ALL 3 calls (mocked yt-dlp) ----------
(() => {
  const mock = path.join(FX, 'mock-ytdlp.js');
  const mockSrc = [
    '#!/usr/bin/env node',
    'const fs=require("fs"),cp=require("child_process");const a=process.argv.slice(2);',
    'if(process.env.RFC_YTDLP_LOG)fs.appendFileSync(process.env.RFC_YTDLP_LOG,JSON.stringify(a)+"\\n");',
    'const has=x=>a.includes(x);',
    'if(has("--version")){process.stdout.write("9999.99.99\\n");process.exit(0);}',
    'if(has("--dump-single-json")){process.stdout.write(JSON.stringify({id:"TESTID12345",duration:600,title:"Mock",channel:"Mock",subtitles:{},automatic_captions:{}}));process.exit(0);}',
    'if(has("--write-subs")){const o=a[a.indexOf("-o")+1];const stem=o.replace(".%(ext)s","");fs.writeFileSync(stem+".en.srt","1\\n00:00:02,000 --> 00:00:07,000\\nthey meet on the rooftop at night\\n");process.exit(0);}',
    'if(has("--download-sections")){const o=a[a.indexOf("-o")+1];cp.execFileSync(process.env.FFMPEG_BIN||"ffmpeg",["-y","-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=red:s=1280x720:r=30:d=6","-c:v","libx264","-pix_fmt","yuv420p","-t","6",o]);process.exit(0);}',
    'process.exit(0);',
  ].join('\n');
  fs.writeFileSync(mock, mockSrc); fs.chmodSync(mock, 0o755);
  const log = path.join(FX, 'ytdlp-calls.log'); fs.writeFileSync(log, '');
  const d = path.join(FX, 'urljs'); makeNarr(d, [{ start: 0, end: 6, text: 'The alarm rings across the base.' }, { start: 6, end: 12, text: 'They meet on the rooftop at night.' }]);
  writePack(d, { schema_version: 'scene-research-pack-v1', project_title: 'UrlJs', packs: [{ pack_id: 'P', scope: { kind: 'SERIES', title: 'X' }, sources: [{ source_id: 'S', url: 'https://www.youtube.com/watch?v=TESTID12345', video_id: 'TESTID12345' }], moments: [
    { moment_id: 'J1', script_cue_exact: 'The alarm rings across the base.', locators: [{ source_id: 'S', locator_type: 'EXACT_TIME', start_sec: 5, end_sec: 10, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } },
    { moment_id: 'J2', script_cue_exact: 'They meet on the rooftop at night.', locators: [{ source_id: 'S', locator_type: 'DIALOGUE', dialogue_exact: 'they meet on the rooftop at night', confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } },
  ] }] });
  runRFC([`--input=${d}`, '--job=reg_js', '--redo'], { RFC_YTDLP: mock, RFC_YTDLP_LOG: log });
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const carries = kind => lines.some(a => a.includes(kind)) && lines.filter(a => a.includes(kind)).every(a => a.includes('--js-runtimes'));
  const meta = carries('--dump-single-json'), subs = carries('--write-subs'), dl = carries('--download-sections');
  check('T-JS meta+subs+download calls all carry official --js-runtimes', meta && subs && dl, `meta=${meta} subs=${subs} dl=${dl}`);
})();

// ---------- T-SENT: production jobs/ never touched by any test suite ----------
(() => {
  const prod = path.join(ROOT, 'jobs', 'prod_sentinel'); fs.mkdirSync(prod, { recursive: true });
  const keep = path.join(prod, 'keep.txt'); fs.writeFileSync(keep, 'DO NOT DELETE');
  const miniJobs = path.join(ROOT, 'tests', 'tmp', 'sentinel_mini_' + process.pid);
  const m = spawnSync('node', ['tests/run-mini-test.js'], { cwd: ROOT, encoding: 'utf8', timeout: 600000, env: { ...process.env, RFC_JOBS_DIR: miniJobs } });
  const survived = fs.existsSync(keep) && fs.readFileSync(keep, 'utf8') === 'DO NOT DELETE';
  check('T-SENT production ROOT/jobs untouched by both suites (isolated job root)', survived && m.status === 0, `mini exit=${m.status} sentinel survived=${survived}`);
  fs.rmSync(prod, { recursive: true, force: true }); fs.rmSync(miniJobs, { recursive: true, force: true });
})();

// ---------- summary ----------
const pass = results.filter(r => r.ok).length, fail = results.length - pass;
console.log('\n' + '='.repeat(70));
console.log(`  REGRESSION SUMMARY: ${pass} PASS, ${fail} FAIL`);
if (fail) { console.log('  FAILURES:'); results.filter(r => !r.ok).forEach(r => console.log('   - ' + r.name + ' :: ' + r.detail)); }
console.log('='.repeat(70));
process.exit(fail ? 1 : 0);
