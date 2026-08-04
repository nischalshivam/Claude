// ============================================================
//  M1.1 REGRESSION SUITE — audit ke mandated tests (offline, no YouTube).
//  Har test infra-correctness verify karta hai. run-mini-test.js = content
//  cases (13); ye = correctness/blocker cases (12).
// ============================================================
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const U = require(path.join(ROOT, 'src', 'util.js'));
// ISOLATED jobs root — production ROOT/jobs ko kabhi haath nahi (M1.2-C).
const JOBS = path.join(ROOT, 'tests', 'tmp', 'reg_' + process.pid);
const DATA = path.join(ROOT, 'tests', 'tmp', 'data_' + process.pid);
process.env.RFC_DATA_DIR = DATA;
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
// Tests apne khud ke packs banate hain, unka koi output/pack-report.json nahi
// hota. Production gate asli hai — isliye tests use documented escape hatch se
// bypass karte hain, gate ko kamzor nahi karte. (T-GATE isse alag se test karta
// hai ki bina override ke gate SACH mein rokta hai.)
function runRFC(args, env = {}) {
  const a = args.includes('--diagnostic-override') ? args : [...args, '--diagnostic-override'];
  return spawnSync('node', ['src/run.js', ...a], { cwd: ROOT, encoding: 'utf8', timeout: 600000, env: { ...process.env, ...env } });
}
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
  // T4 (M2): NEEDS_REVIEW ki clip production final mein NAHI jaati — aur uski jagah
  // diagnostic card bhi nahi aata. Us beat par scope-correct still/graphic hona chahiye.
  const tl = jf('reg_rep', 'timeline.json');
  const rbSlots = tl.slots.filter(s => s.moment_id === 'RB');
  const noClip = rbSlots.every(s => s.kind !== 'video');
  const noCard = rbSlots.every(s => !['needs_review', 'needs_source', 'text'].includes(s.kind));
  const kinds = [...new Set(rbSlots.map(s => s.kind))].join(',');
  check('T4 NEEDS_REVIEW clip not used in production final, and no diagnostic card either',
    rbSlots.length > 0 && noClip && noCard, `slot kinds=${kinds}`);
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
  const fdur = dur(path.join(JOBS, job, 'final.mp4'));
  // M2.1: corrupt clip ab chupchap solid card NAHI banta. Ya to scope-correct
  // still se recover hota hai (manifest mein VERIFIED_SOURCE_STILL), ya production
  // saaf-saaf FAIL karta hai. Dono acceptable — silent card kabhi nahi.
  let recovered = false, failedLoud = false;
  const mfp = path.join(JOBS, job, 'render-manifest.json');
  if (r.status === 0 && fs.existsSync(mfp)) {
    const mf = JSON.parse(fs.readFileSync(mfp, 'utf8'));
    const bad = mf.shots.filter(s => s.asset === 'RENDER_FAILURE_FALLBACK');
    recovered = bad.length === 0 && Math.abs(fdur - tl.total) < 0.5;
  } else if (r.status !== 0 && /render nahi ho paya|Production export rok/.test((r.stdout || '') + (r.stderr || ''))) {
    failedLoud = true;
  }
  check('T8 corrupt clip -> scope-correct still recovery OR loud production failure (never a silent card)',
    recovered || failedLoud, recovered ? `recovered, final=${fdur.toFixed(2)}s total=${tl.total}s` : `loud fail exit=${r.status}`);
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
  // Windows-safe: .js file ko direct executable ki tarah spawn nahi kar sakte.
  // Isliye platform-ke-hisaab se wrapper banate hain jo `node mock.js` chalata hai.
  let wrapper;
  if (process.platform === 'win32') {
    wrapper = path.join(FX, 'mock-ytdlp.cmd');
    fs.writeFileSync(wrapper, '@echo off\r\nnode "' + mock + '" %*\r\n');
  } else {
    wrapper = path.join(FX, 'mock-ytdlp.sh');
    fs.writeFileSync(wrapper, '#!/bin/sh\nexec node "' + mock + '" "$@"\n');
    fs.chmodSync(wrapper, 0o755);
  }
  runRFC([`--input=${d}`, '--job=reg_js', '--redo'], { RFC_YTDLP: wrapper, RFC_YTDLP_LOG: log });
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const carries = kind => lines.some(a => a.includes(kind)) && lines.filter(a => a.includes(kind)).every(a => a.includes('--js-runtimes'));
  const meta = carries('--dump-single-json'), subs = carries('--write-subs'), dl = carries('--download-sections');
  check('T-JS meta+subs+download calls all carry official --js-runtimes', meta && subs && dl, `meta=${meta} subs=${subs} dl=${dl}`);
})();

// ---------- T-PACK: check-pack report card (render se pehle ka verdict) ----------
// Ye tool render se pehle bata deta hai ki pack kaisa hai. Agar iska verdict
// jhootha ho to poora point khatm — isliye teen cheezein prove karte hain:
//  (a) toota pack pakadta hai aur EXACT reason batata hai (dead source, galat
//      timestamp, dialogue jo captions mein hai hi nahi, scope-title mismatch)
//  (b) accha pack ko accha kehta hai (exit 0) — jhoothi alarm nahi
//  (c) NEEDS_RESEARCH.txt mein wahi moments hain jinhe kaam chahiye
(() => {
  const d = path.join(FX, 'packchk');
  makeNarr(d, [
    { start: 0, end: 6, text: 'The alarm rings across the base.' },
    { start: 6, end: 12, text: 'She opens the sealed hatch slowly.' },
    { start: 12, end: 18, text: 'They meet on the rooftop at night.' },
    { start: 18, end: 24, text: 'The final shot fades to black.' },
    { start: 24, end: 30, text: 'Nobody expected the quiet ending afterwards.' },
  ]);
  const srt = path.join(d, 'voiceover.srt');
  const run = (pf, out, extra = []) => {
    const r = spawnSync('node', ['tools/check-pack.js', pf, srt, `--out=${out}`, ...extra], { cwd: ROOT, encoding: 'utf8', timeout: 300000, env: process.env });
    let rep = null; try { rep = JSON.parse(fs.readFileSync(path.join(out, 'pack-report.json'), 'utf8')); } catch {}
    let need = ''; try { need = fs.readFileSync(path.join(out, 'NEEDS_RESEARCH.txt'), 'utf8'); } catch {}
    return { status: r.status, stdout: r.stdout || '', rep, need };
  };

  // --- (a) jaan-boojh kar toota hua pack ---
  const badPack = {
    schema_version: 'scene-research-pack-v1', project_title: 'PackCheck',
    packs: [
      { pack_id: 'P1', scope: { kind: 'SERIES', title: 'The Amazing World of X' },
        sources: [
          { source_id: 'S_OK', local_file: good.video, local_subs: good.srt },
          { source_id: 'S_DEAD', local_file: 'tests/fixtures/reg/ep/NOPE_missing.mp4' },
        ],
        moments: [
          // sahi dialogue — asli episode captions mein maujood hai
          { moment_id: 'M_GOOD', script_cue_exact: 'The alarm rings across the base.',
            locators: [{ source_id: 'S_OK', locator_type: 'DIALOGUE', dialogue_exact: 'The alarm rings across the base.', confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } },
          // dialogue jo episode mein hai hi nahi -> tool ko pakadna chahiye
          { moment_id: 'M_FAKEDLG', script_cue_exact: 'She opens the sealed hatch slowly.',
            locators: [{ source_id: 'S_OK', locator_type: 'DIALOGUE', dialogue_exact: 'zzz nobody ever said this sentence in the episode zzz', confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } },
          // timestamp episode ki length se bahar (episode 80s ka hai)
          { moment_id: 'M_OOB', script_cue_exact: 'They meet on the rooftop at night.',
            locators: [{ source_id: 'S_OK', locator_type: 'EXACT_TIME', start_sec: 9000, end_sec: 9006, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } },
          // dead source
          { moment_id: 'M_DEAD', script_cue_exact: 'The final shot fades to black.',
            locators: [{ source_id: 'S_DEAD', locator_type: 'EXACT_TIME', start_sec: 2, end_sec: 8, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } },
        ] },
      // wahi show, alag likha title -> scope split (yehi asli bug tha)
      { pack_id: 'P2', scope: { kind: 'SERIES', title: 'The Wonderfully Amazing World of X' }, sources: [],
        moments: [{ moment_id: 'M_ORPHAN', script_cue_exact: 'Nobody expected the quiet ending afterwards.', locators: [], fallback: { type: 'NEEDS_SOURCE' } }] },
    ],
  };
  const bf = path.join(d, 'bad.json'); fs.writeFileSync(bf, JSON.stringify(badPack, null, 2));
  const A = run(bf, path.join(d, 'out_bad'));
  const lv = (A.rep && A.rep.live_verify) || {};
  const hit = (arr, id) => Array.isArray(arr) && arr.some(x => x.moment_id === id || x.source_id === id);
  check('T-PACK1 check-pack catches dialogue that is not in the real captions',
    hit(lv.dialogue_not_found, 'M_FAKEDLG') && !hit(lv.dialogue_not_found, 'M_GOOD'),
    `not_found=${JSON.stringify((lv.dialogue_not_found || []).map(x => x.moment_id))}`);
  check('T-PACK2 check-pack catches EXACT_TIME beyond episode duration',
    hit(lv.bad_exact_time, 'M_OOB'), `bad_time=${JSON.stringify((lv.bad_exact_time || []).map(x => x.moment_id))}`);
  check('T-PACK3 check-pack catches dead source (and does not blame its timestamp)',
    hit(lv.dead_sources, 'S_DEAD') && !hit(lv.bad_exact_time, 'M_DEAD'),
    `dead=${JSON.stringify((lv.dead_sources || []).map(x => x.source_id))}`);
  check('T-PACK4 check-pack catches near-duplicate scope titles (same show, 2 spellings)',
    A.rep && Array.isArray(A.rep.scope_title_mismatch) && A.rep.scope_title_mismatch.length === 1,
    `mismatch=${A.rep ? A.rep.scope_title_mismatch.length : 'n/a'}`);
  check('T-PACK5 weak pack -> exit 2 + work order names the weak moments',
    A.status === 2 && /M_FAKEDLG/.test(A.need) && /M_OOB/.test(A.need),
    `exit=${A.status} workOrderBytes=${A.need.length}`);

  // --- (a2) research AI ki do aam chaalbaaziyan: "verify kiya" bolkar sources
  //          METADATA_ONLY chhodna, aur bina research wale beats ko "analysis"
  //          bolkar GRAPHIC pack mein daal dena. Dono pack ke apne fields se
  //          pakde jate hain, AI ki self-report se nahi.
  const sloppy = {
    schema_version: 'scene-research-pack-v1', project_title: 'Sloppy',
    packs: [
      { pack_id: 'P1', scope: { kind: 'SERIES', title: 'Show S' },
        sources: [{ source_id: 'S_OPEN', local_file: good.video, local_subs: good.srt, inspection_status: 'TRANSCRIPT_CHECKED' },
                  { source_id: 'S_GUESS', url: 'https://www.youtube.com/watch?v=NEVEROPEN1', inspection_status: 'METADATA_ONLY' }],
        moments: [{ moment_id: 'S_M1', script_cue_exact: 'The alarm rings across the base.',
          locators: [{ source_id: 'S_OPEN', locator_type: 'EXACT_TIME', start_sec: 2, end_sec: 8, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } }] },
      { pack_id: 'P9_G', scope: { kind: 'GRAPHIC', title: 'Analysis cards' }, sources: [],
        moments: [
          { moment_id: 'G_M1', script_cue_exact: 'She opens the sealed hatch slowly.', locators: [], fallback_plan: { allowed_pack_ids: ['P1'] }, fallback: { type: 'LOCAL_GRAPHIC', text: 'a' } },
          { moment_id: 'G_M2', script_cue_exact: 'They meet on the rooftop at night.', locators: [], fallback_plan: { allowed_pack_ids: ['P1'] }, fallback: { type: 'LOCAL_GRAPHIC', text: 'b' } },
          { moment_id: 'G_M3', script_cue_exact: 'The final shot fades to black.', locators: [], fallback_plan: { allowed_pack_ids: ['P1'] }, fallback: { type: 'LOCAL_GRAPHIC', text: 'c' } },
        ] },
    ],
  };
  const sf = path.join(d, 'sloppy.json'); fs.writeFileSync(sf, JSON.stringify(sloppy, null, 2));
  const S = run(sf, path.join(d, 'out_sloppy'), ['--no-probe']);
  const sFailed = (S.rep && S.rep.failed_checks || []).map(f => f.check).join(' | ');
  check('T-PACK8 unopened (METADATA_ONLY) sources are named, not taken on trust',
    S.rep && (S.rep.unopened_sources || []).length === 1 && S.rep.unopened_sources[0].source_id === 'S_GUESS'
      && /METADATA_ONLY/.test(sFailed) && /NEVEROPEN1/.test(S.stdout),
    `unopened=${S.rep ? JSON.stringify((S.rep.unopened_sources || []).map(x => x.source_id)) : 'n/a'}`);
  check('T-PACK9 oversized GRAPHIC pack is flagged (beats parked as "analysis")',
    S.rep && S.rep.graphic_moment_percent === 75 && /GRAPHIC moments <= 25%/.test(sFailed),
    `graphic=${S.rep ? S.rep.graphic_moment_percent : '?'}%`);

  // --- (b) saaf pack: koi jhoothi alarm nahi ---
  const goodPack = {
    schema_version: 'scene-research-pack-v1', project_title: 'PackCheckOK',
    packs: [{ pack_id: 'P1', scope: { kind: 'SERIES', title: 'The Amazing World of X' },
      sources: [{ source_id: 'S_OK', local_file: good.video, local_subs: good.srt, inspection_status: 'VERIFIED_WATCHED' }],
      moments: [
        { moment_id: 'G1', script_cue_exact: 'The alarm rings across the base.', locators: [{ source_id: 'S_OK', locator_type: 'EXACT_TIME', start_sec: 2, end_sec: 8, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } },
        { moment_id: 'G2', script_cue_exact: 'She opens the sealed hatch slowly.', locators: [{ source_id: 'S_OK', locator_type: 'EXACT_TIME', start_sec: 22, end_sec: 28, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } },
        { moment_id: 'G3', script_cue_exact: 'They meet on the rooftop at night.', locators: [{ source_id: 'S_OK', locator_type: 'DIALOGUE', dialogue_exact: 'They meet on the rooftop at night.', confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } },
        { moment_id: 'G4', script_cue_exact: 'The final shot fades to black.', locators: [{ source_id: 'S_OK', locator_type: 'EXACT_TIME', start_sec: 62, end_sec: 68, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } },
        { moment_id: 'G5', script_cue_exact: 'Nobody expected the quiet ending afterwards.', locators: [{ source_id: 'S_OK', locator_type: 'EXACT_TIME', start_sec: 42, end_sec: 48, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } },
      ] }],
  };
  const gf = path.join(d, 'good.json'); fs.writeFileSync(gf, JSON.stringify(goodPack, null, 2));
  const B = run(gf, path.join(d, 'out_good'));
  check('T-PACK6 healthy pack -> exit 0, no false alarms',
    B.status === 0 && B.rep && B.rep.pass === true && (B.rep.failed_checks || []).length === 0,
    `exit=${B.status} exact=${B.rep ? B.rep.exact_or_hint_percent : '?'}% failed=${JSON.stringify(B.rep ? B.rep.failed_checks.map(f => f.check) : [])}`);

  // --- (c) offline mode (--no-probe) bhi chale, aur seconds-weighting sahi ho ---
  const C = run(gf, path.join(d, 'out_np'), ['--no-probe']);
  check('T-PACK7 --no-probe offline mode works and weights by narration seconds',
    C.status === 0 && C.rep && Math.abs(C.rep.narration_seconds - 30) < 1.5 && C.rep.live_verify.ran === false,
    `exit=${C.status} narr=${C.rep ? C.rep.narration_seconds : '?'}s`);
})();

// ---------- T-MERGE: split-mode pack merging (Genspark 1-message-per-day) ----------
// Alag accounts wahi IDs (P01, P01_S01) generate karte hain aur show ka naam
// alag likh dete hain. Merge tool ko dono sambhalne chahiye, warna merged pack
// ya to invalid hoga ya chupke se galat scope bana dega.
(() => {
  const d = path.join(FX, 'merge');
  fs.mkdirSync(d, { recursive: true });
  const mkPart = (title, cue, mid) => ({
    schema_version: 'scene-research-pack-v1', project_title: 'Split Test',
    packs: [{ pack_id: 'P01', scope: { kind: 'SERIES', title }, // dono parts mein WAHI ids -> collision
      sources: [{ source_id: 'P01_S01', local_file: good.video, local_subs: good.srt, video_id: 'SAMEVID' }],
      moments: [{ moment_id: mid, script_cue_exact: cue,
        locators: [{ source_id: 'P01_S01', locator_type: 'EXACT_TIME', start_sec: 2, end_sec: 8, confidence: 'HIGH' }],
        fallback_plan: { allowed_pack_ids: ['P01'], allowed_source_ids: ['P01_S01'], frame_hints: [{ source_id: 'P01_S01', time_sec: 5 }] },
        fallback: { type: 'NEEDS_SOURCE' } }] }],
    coverage_check: { entire_script_covered: true, uncovered_script_cues: [], packs_needing_more_research: [] },
  });
  const p1 = path.join(d, 'part1.json'), p2 = path.join(d, 'part2.json'), out = path.join(d, 'merged.json');
  fs.writeFileSync(p1, JSON.stringify(mkPart('The Amazing World of X', 'The alarm rings across the base.', 'P01_M01')));
  fs.writeFileSync(p2, JSON.stringify(mkPart('The Wonderfully Amazing World of X', 'They meet on the rooftop at night.', 'P01_M01')));

  const run = (extra = []) => spawnSync('node', ['tools/merge-packs.js', p1, p2, '-o', out, ...extra], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: process.env });
  const A = run();
  let M = null; try { M = JSON.parse(fs.readFileSync(out, 'utf8')); } catch {}
  const ids = M ? M.packs.map(p => p.pack_id) : [];
  const mids = M ? M.packs.flatMap(p => p.moments.map(x => x.moment_id)) : [];
  const val = M ? require(path.join(ROOT, 'src', 'validate.js')).validateFile(out) : { ok: false, errors: ['no file'] };
  check('T-MERGE1 colliding IDs from two accounts are prefixed, merged pack stays valid',
    A.status === 0 && val.ok && new Set(ids).size === 2 && new Set(mids).size === 2,
    `exit=${A.status} valid=${val.ok} packs=${JSON.stringify(ids)}`);
  // prefix lagne ke baad har reference bhi update hona chahiye, warna scope tootega
  const refsOk = M && M.packs.every(p => p.moments.every(m =>
    m.locators.every(L => p.sources.some(s => s.source_id === L.source_id)) &&
    m.fallback_plan.allowed_pack_ids.every(x => ids.includes(x)) &&
    m.fallback_plan.allowed_source_ids.every(x => p.sources.some(s => s.source_id === x)) &&
    m.fallback_plan.frame_hints.every(h => p.sources.some(s => s.source_id === h.source_id))));
  check('T-MERGE2 renaming rewrites every reference (locators, allowed_*, frame_hints)',
    !!refsOk, `refsOk=${refsOk}`);
  check('T-MERGE3 near-duplicate show titles are reported, not silently merged',
    /SCOPE TITLE MISMATCH/.test(A.stdout) && M && new Set(M.packs.map(p => p.scope.title)).size === 2,
    `titles=${M ? JSON.stringify([...new Set(M.packs.map(p => p.scope.title))]) : 'n/a'}`);
  const B = run(['--unify-titles']);
  let M2 = null; try { M2 = JSON.parse(fs.readFileSync(out, 'utf8')); } catch {}
  check('T-MERGE4 --unify-titles collapses them only when explicitly asked',
    B.status === 0 && M2 && new Set(M2.packs.map(p => p.scope.title)).size === 1,
    `titles=${M2 ? JSON.stringify([...new Set(M2.packs.map(p => p.scope.title))]) : 'n/a'}`);
  // invalid part chupke se merge nahi hona chahiye
  const bad = path.join(d, 'bad.json'); fs.writeFileSync(bad, '{"schema_version":"scene-research-pack-v1","packs":[]}');
  const C = spawnSync('node', ['tools/merge-packs.js', p1, bad, '-o', path.join(d, 'x.json')], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: process.env });
  check('T-MERGE5 invalid part stops the merge loudly (no half-broken pack)',
    C.status === 1 && /FAIL/.test(C.stdout), `exit=${C.status}`);
})();

// ---------- T-S2: two-stage research (stage-2 prompt + validating apply) ----------
// Research AI aksar script to sahi baant deta hai par asli research nahi karta.
// Aisa pack render nahi ho sakta, par uska segmentation sahi hota hai. Round-2
// wahi segmentation reuse karke sirf locators maangta hai. Apply karte waqt
// koi bhi galat locator chupke se andar nahi jana chahiye — warna hum wahi
// jhoothi evidence wapas le aayenge jisse bachna tha.
(() => {
  const d = path.join(FX, 'stage2');
  fs.mkdirSync(d, { recursive: true });
  const pk = {
    schema_version: 'scene-research-pack-v1', project_title: 'R2',
    packs: [
      { pack_id: 'P01', scope: { kind: 'SERIES', title: 'Show A' },
        sources: [{ source_id: 'P01_S01', local_file: good.video, local_subs: good.srt, duration_sec: 80 }],
        moments: [
          { moment_id: 'P01_M01', script_cue_exact: 'The alarm rings across the base.', locators: [], fallback: { type: 'NEEDS_SOURCE' } },
          { moment_id: 'P01_M02', script_cue_exact: 'She opens the sealed hatch slowly.',
            locators: [{ source_id: 'P01_S01', locator_type: 'EXACT_TIME', start_sec: 22, end_sec: 28, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } },
        ] },
      { pack_id: 'P02', scope: { kind: 'SERIES', title: 'Show B' },
        sources: [{ source_id: 'P02_S01', local_file: good.video, local_subs: good.srt, duration_sec: 80 }],
        moments: [{ moment_id: 'P02_M01', script_cue_exact: 'They meet on the rooftop at night.', locators: [], fallback: { type: 'NEEDS_SOURCE' } }] },
      { pack_id: 'P09_G', scope: { kind: 'GRAPHIC', title: 'Analysis cards' }, sources: [],
        moments: [{ moment_id: 'P09_M01', script_cue_exact: 'The final shot fades to black.', locators: [],
          fallback_plan: { allowed_pack_ids: ['P01'] }, fallback: { type: 'LOCAL_GRAPHIC', text: 'x' } }] },
    ],
  };
  const pf = path.join(d, 'pack.json'); fs.writeFileSync(pf, JSON.stringify(pk, null, 2));
  const A = spawnSync('node', ['tools/make-stage2.js', pf, `--out=${d}`], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: process.env });
  const prompt = fs.existsSync(path.join(d, 'STAGE2_PROMPT.txt')) ? fs.readFileSync(path.join(d, 'STAGE2_PROMPT.txt'), 'utf8') : '';
  check('T-S21 stage-2 prompt lists only the moments still missing evidence',
    A.status === 0 && /P01_M01/.test(prompt) && /P02_M01/.test(prompt) && /P09_M01/.test(prompt) && !/P01_M02/.test(prompt),
    `exit=${A.status} bytes=${prompt.length} hasSolved=${/P01_M02/.test(prompt)}`);
  check('T-S22 analysis moments are asked for frame_hints, not invented scenes',
    /P09_M01\s+\[ANALYSIS/.test(prompt) && /frame_hints only/.test(prompt), 'ANALYSIS marker present');

  // round-2 response: 2 valid + 4 that MUST be rejected
  const resp = [
    { moment_id: 'P01_M01', locators: [
      { source_id: 'P01_S01', locator_type: 'DIALOGUE', dialogue_exact: 'The alarm rings across the base.', confidence: 'HIGH' },
      { source_id: 'P01_S01', locator_type: 'EXACT_TIME', start_sec: 2, end_sec: 8, confidence: 'HIGH' }],
      frame_hints: [{ source_id: 'P01_S01', time_sec: 5, reason: 'wide shot' }] },
    { moment_id: 'P09_M01', frame_hints: [{ source_id: 'P01_S01', time_sec: 40, reason: 'clear frame' }] },
    { moment_id: 'P02_M01', locators: [{ source_id: 'P01_S01', locator_type: 'EXACT_TIME', start_sec: 5, end_sec: 9 }] },  // cross-show
    { moment_id: 'P01_M01', locators: [{ source_id: 'P01_S01', locator_type: 'EXACT_TIME', start_sec: 9000, end_sec: 9006 }] }, // past duration
    { moment_id: 'GHOST_M99', locators: [{ source_id: 'P01_S01', locator_type: 'EXACT_TIME', start_sec: 1, end_sec: 5 }] },  // unknown
    { moment_id: 'P01_M02', locators: [{ source_id: 'P01_S01', locator_type: 'DIALOGUE', dialogue_exact: 'ok sure' }] },     // too short
    { broken_sources: [{ source_id: 'P02_S01', problem: 'video unavailable' }] },
  ];
  const rf = path.join(d, 'r2.json'); fs.writeFileSync(rf, '```json\n' + JSON.stringify(resp) + '\n```');   // fence bhi test karo
  const outPack = path.join(d, 'applied.json');
  const B = spawnSync('node', ['tools/apply-stage2.js', pf, rf, '-o', outPack], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: process.env });
  let AP = null; try { AP = JSON.parse(fs.readFileSync(outPack, 'utf8')); } catch {}
  const find = id => { for (const p of (AP ? AP.packs : [])) for (const m of p.moments) if (m.moment_id === id) return m; return null; };
  const m1 = find('P01_M01'), g1 = find('P09_M01'), x1 = find('P02_M01'), m2 = find('P01_M02');
  check('T-S23 valid locators applied, DIALOGUE ordered first (survives upload offset)',
    B.status === 0 && m1 && m1.locators.length === 2 && m1.locators[0].locator_type === 'DIALOGUE'
      && (m1.fallback_plan.frame_hints || []).length === 1 && g1 && g1.fallback_plan.frame_hints.length === 1,
    `exit=${B.status} m1locs=${m1 ? m1.locators.length : 'n/a'}`);
  check('T-S24 cross-scope source, past-duration time, unknown moment and 2-word dialogue all rejected',
    x1 && x1.locators.length === 0
      && m1 && !m1.locators.some(l => l.start_sec === 9000)
      && m2 && !m2.locators.some(l => l.locator_type === 'DIALOGUE')
      && /REJECT/.test(B.stdout) && /GHOST_M99/.test(B.stdout),
    `crossShow=${x1 ? x1.locators.length : '?'} rejectsShown=${/REJECT/.test(B.stdout)}`);
  check('T-S25 broken sources surfaced, applied pack still validates',
    /video unavailable/.test(B.stdout) && AP && require(path.join(ROOT, 'src', 'validate.js')).validateFile(outPack).ok,
    `brokenShown=${/video unavailable/.test(B.stdout)}`);

  // in-place mode must leave a backup (galti se pack kho na jaye)
  const C = spawnSync('node', ['tools/apply-stage2.js', pf, rf], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: process.env });
  check('T-S26 in-place apply writes a .bak before touching the pack',
    C.status === 0 && fs.existsSync(pf + '.bak') && JSON.parse(fs.readFileSync(pf + '.bak', 'utf8')).packs.length === 3,
    `exit=${C.status} bak=${fs.existsSync(pf + '.bak')}`);

  // ---- CHECKPACK ka naapa hua sach stage-2 prompt tak pahunchna chahiye ----
  // Hum khud sources khol kar dekh chuke hote hain. Wo sach stage 2 ko na dena
  // matlab usse wahi kaam dobara karwana — aur dead source par timestamp
  // banwana, jo poora bekaar jata hai.
  (() => {
    const dd = path.join(d, 'verified');
    fs.mkdirSync(dd, { recursive: true });
    const vp = {
      schema_version: 'scene-research-pack-v1', project_title: 'V',
      packs: [{ pack_id: 'VP', scope: { kind: 'SERIES', title: 'Show V' },
        sources: [
          { source_id: 'V_LIVE', local_file: good.video, local_subs: good.srt, inspection_status: 'METADATA_ONLY', duration_sec: 999 },
          { source_id: 'V_DEAD', local_file: 'tests/fixtures/reg/ep/GONE_missing.mp4', inspection_status: 'METADATA_ONLY', duration_sec: 500 },
        ],
        moments: [
          { moment_id: 'V_M1', script_cue_exact: 'The alarm rings across the base.', locators: [], fallback: { type: 'NEEDS_SOURCE' } },
          { moment_id: 'V_M2', script_cue_exact: 'She opens the sealed hatch slowly.',
            locators: [{ source_id: 'V_LIVE', locator_type: 'DIALOGUE', dialogue_exact: 'this line was never spoken in the episode at all', confidence: 'MEDIUM' }], fallback: { type: 'NEEDS_SOURCE' } },
        ] }],
    };
    const vf = path.join(dd, 'pack.json'); fs.writeFileSync(vf, JSON.stringify(vp, null, 2));
    // probe chalao (local files -> network ki zaroorat nahi) + naapi hui value likh do
    const CP = spawnSync('node', ['tools/check-pack.js', vf, path.join(dd, 'none.srt'), `--out=${dd}`, '--apply-probe'],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000, env: process.env });
    let rep = null; try { rep = JSON.parse(fs.readFileSync(path.join(dd, 'pack-report.json'), 'utf8')); } catch {}
    const after = JSON.parse(fs.readFileSync(vf, 'utf8'));
    const liveSrc = after.packs[0].sources.find(s => s.source_id === 'V_LIVE');
    check('T-S210 --apply-probe writes MEASURED duration/captions into the pack',
      liveSrc && liveSrc.duration_sec === 80 && liveSrc.has_captions === true && liveSrc.inspection_status === 'TRANSCRIPT_CHECKED'
        && fs.existsSync(vf + '.bak'),
      `dur=${liveSrc ? liveSrc.duration_sec : '?'} caps=${liveSrc ? liveSrc.has_captions : '?'} status=${liveSrc ? liveSrc.inspection_status : '?'}`);

    const MK = spawnSync('node', ['tools/make-stage2.js', vf, `--out=${dd}`, `--report=${path.join(dd, 'pack-report.json')}`],
      { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: process.env });
    const pr = fs.existsSync(path.join(dd, 'STAGE2_PROMPT.txt')) ? fs.readFileSync(path.join(dd, 'STAGE2_PROMPT.txt'), 'utf8') : '';
    check('T-S211 stage-2 prompt marks the confirmed-dead source and the confirmed-working one',
      MK.status === 0 && /V_DEAD[\s\S]{0,80}CONFIRMED DEAD/.test(pr) && /V_LIVE\s+\[CONFIRMED WORKING\]/.test(pr)
        && /we opened this ourselves/.test(pr),
      `dead=${/CONFIRMED DEAD/.test(pr)} live=${/CONFIRMED WORKING/.test(pr)}`);
    check('T-S212 dialogue proven absent from real captions is named for replacement',
      /NOT found/.test(pr) && /V_M2/.test(pr) && /never spoken in the episode/.test(pr),
      `listed=${/V_M2/.test(pr)} reportBad=${rep ? (rep.live_verify.dialogue_not_found || []).length : '?'}`);
  })();

  // ---- stage 2 ko stage 1 ke TOOTE sources theek karne dena ----
  // Yahi do-stage ka asli faayda hai: stage 1 ne jo jhootha/dead URL diya, wo
  // yahan pakda aur badla jata hai. Par naya URL bhi bina check ke andar na jaye.
  const pf2 = path.join(d, 'pack2.json'); fs.writeFileSync(pf2, JSON.stringify(pk, null, 2));
  const fix = [
    { source_updates: [{ source_id: 'P01_S01', duration_sec: 1300, has_captions: true, inspection_status: 'TRANSCRIPT_CHECKED' }] },
    { replace_sources: [{ source_id: 'P02_S01', url: 'https://www.youtube.com/watch?v=REALFIXED01', video_id: 'REALFIXED01', title: 'Real ep', channel: 'Official', duration_sec: 1250, has_captions: true, reason: 'original was unavailable' }] },
    { replace_sources: [{ source_id: 'P01_S01', url: 'not a url at all', reason: 'junk' }] },              // reject hona chahiye
    { replace_sources: [{ source_id: 'NOPE_S99', url: 'https://www.youtube.com/watch?v=zzzzzzzzzzz' }] },  // reject hona chahiye
    // naye duration (1300s) ke andar ka timestamp ab valid hai — pehle 80s tha
    { moment_id: 'P01_M01', locators: [{ source_id: 'P01_S01', locator_type: 'EXACT_TIME', start_sec: 900, end_sec: 906 }] },
  ];
  const ff2 = path.join(d, 'fix.json'); fs.writeFileSync(ff2, JSON.stringify(fix));
  const outPack2 = path.join(d, 'fixed.json');
  const D = spawnSync('node', ['tools/apply-stage2.js', pf2, ff2, '-o', outPack2], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: process.env });
  let FP = null; try { FP = JSON.parse(fs.readFileSync(outPack2, 'utf8')); } catch {}
  const src = sid => { for (const p of (FP ? FP.packs : [])) for (const s of (p.sources || [])) if (s.source_id === sid) return s; return null; };
  const s1 = src('P01_S01'), s2 = src('P02_S01');
  const fm1 = (() => { for (const p of (FP ? FP.packs : [])) for (const m of p.moments) if (m.moment_id === 'P01_M01') return m; return null; })();
  check('T-S27 stage 2 can replace a dead stage-1 source and correct its duration',
    D.status === 0 && s2 && /REALFIXED01/.test(s2.url || '') && s1 && s1.duration_sec === 1300 && s1.has_captions === true,
    `exit=${D.status} p2url=${s2 ? String(s2.url).slice(-12) : 'n/a'} p1dur=${s1 ? s1.duration_sec : '?'}`);
  check('T-S28 junk replacement URL and unknown source_id are refused',
    s1 && /youtube|\.mp4$/i.test(String(s1.url || s1.local_file || '')) && !/not a url/.test(String(s1.url || '')) && !src('NOPE_S99'),
    `p1src=${s1 ? String(s1.url || s1.local_file).slice(0, 26) : 'n/a'}`);
  // AI enum ke aas-paas ki value likh deta hai ("WATCHED", "LICENSED_CLIP").
  // Wo jaisi ki waisi pack mein chali gayi to schema toot jata hai.
  const enumFix = [{ replace_sources: [{ source_id: 'P02_S01', url: 'https://www.youtube.com/watch?v=ENUMFIX001', duration_sec: 900, source_kind: 'LICENSED_CLIP', inspection_status: 'WATCHED' }] },
                   { source_updates: [{ source_id: 'P01_S01', inspection_status: 'nonsense_status' }] }];
  const ef = path.join(d, 'enum.json'); fs.writeFileSync(ef, JSON.stringify(enumFix));
  const outPack3 = path.join(d, 'enum-out.json');
  const E = spawnSync('node', ['tools/apply-stage2.js', pf2, ef, '-o', outPack3], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: process.env });
  let EP = null; try { EP = JSON.parse(fs.readFileSync(outPack3, 'utf8')); } catch {}
  const esrc = sid => { for (const p of (EP ? EP.packs : [])) for (const s of (p.sources || [])) if (s.source_id === sid) return s; return null; };
  const e2 = esrc('P02_S01'), e1 = esrc('P01_S01');
  check('T-S213 near-miss enum values are mapped, unknown ones left alone (schema stays valid)',
    E.status === 0 && e2 && e2.source_kind === 'LICENSED_UPLOAD' && e2.inspection_status === 'VERIFIED_WATCHED'
      && e1 && e1.inspection_status !== 'nonsense_status' && /pehchana nahi/.test(E.stdout),
    `kind=${e2 ? e2.source_kind : '?'} status=${e2 ? e2.inspection_status : '?'} untouched=${e1 ? e1.inspection_status : '?'}`);

  check('T-S29 timestamps are validated against the CORRECTED duration, not the stale one',
    fm1 && fm1.locators.some(l => l.start_sec === 900),
    `applied900=${fm1 ? fm1.locators.some(l => l.start_sec === 900) : 'n/a'}`);
})();

// ---------- T-M33: M3.3 reliability contract (decoded pixels, not labels) ----------
// Ye group sabse zaroori hai. Pehle manifest ka label PLAN se aata tha, isliye
// missing media chupchap text card ban jata tha aur report "CONTEXT_VIDEO"
// bolti thi. Isliye har check yahan DECODE karke dekhta hai ki screen par kya
// hai — label par bharosa nahi.
(() => {
  const d = path.join(FX, 'm33');
  makeNarr(d, [
    { start: 0, end: 6, text: 'The alarm rings across the base.' },
    { start: 6, end: 12, text: 'She opens the sealed hatch slowly.' },
    { start: 12, end: 18, text: 'They meet on the rooftop at night.' },
  ]);
  const CARD = [26, 32, 46];   // generic gradient card ka rang (0x141a2e..0x0a0d18)
  const isCard = rgb => Math.hypot(rgb[0] - 12, rgb[1] - 15, rgb[2] - 28) < 26 || Math.hypot(rgb[0] - CARD[0], rgb[1] - CARD[1], rgb[2] - CARD[2]) < 26;

  // --- (1) local_file context video: pixels asli video ke hone chahiye ---
  // Ye wahi bug tha: sourceMediaPath ROOT-relative path deta tha, render use
  // job-relative maanta tha, file "missing" lagti thi -> card, label CONTEXT_VIDEO.
  const ctxPack = { schema_version: 'scene-research-pack-v1', project_title: 'Ctx', packs: [{
    pack_id: 'P', scope: { kind: 'SERIES', title: 'Show C' },
    sources: [{ source_id: 'S', local_file: good.video, local_subs: good.srt, inspection_status: 'VERIFIED_WATCHED' }],
    moments: [
      { moment_id: 'C1', script_cue_exact: 'The alarm rings across the base.',
        locators: [{ source_id: 'S', locator_type: 'EXACT_TIME', start_sec: 2, end_sec: 7, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } },
      { moment_id: 'C2', script_cue_exact: 'She opens the sealed hatch slowly.', locators: [], fallback: { type: 'NEEDS_SOURCE' } },
      { moment_id: 'C3', script_cue_exact: 'They meet on the rooftop at night.', locators: [], fallback: { type: 'NEEDS_SOURCE' } },
    ] }] };
  writePack(d, ctxPack);
  runRFC([`--input=${d}`, '--job=reg_m33ctx', '--redo']);
  const man = () => { try { return JSON.parse(fs.readFileSync(path.join(JOBS, 'reg_m33ctx', 'render-manifest.json'), 'utf8')); } catch { return null; } };
  const M = man();
  const fin = path.join(JOBS, 'reg_m33ctx', 'final.mp4');
  let ctxOk = false, ctxDetail = 'no manifest';
  if (M && fs.existsSync(fin)) {
    const media = M.shots.filter(s => ['CONTEXT_VIDEO', 'EXACT_VIDEO', 'VERIFIED_SOURCE_STILL', 'MONTAGE'].includes(s.asset));
    const bad = media.filter(s => isCard(colorAt(fin, s.start + Math.min(1, s.dur / 2))));
    ctxOk = media.length > 0 && bad.length === 0;
    ctxDetail = `${media.length} media shots, ${bad.length} actually a card`;
  }
  check('T-M331 every shot labelled media really decodes to media (no card wearing a media label)', ctxOk, ctxDetail);

  // --- (2) missing planned asset kabhi media-backed report nahi hota ---
  // Clip ko jaan-boojh kar uda dete hain, phir sirf render dobara chalate hain.
  (() => {
    const job = path.join(JOBS, 'reg_m33ctx');
    const clip = path.join(job, 'clips');
    if (fs.existsSync(clip)) for (const f of fs.readdirSync(clip)) if (f.endsWith('.mp4')) fs.writeFileSync(path.join(clip, f), 'x');
    fs.rmSync(path.join(job, 'render-manifest.json'), { force: true });
    fs.rmSync(path.join(job, 'segments'), { recursive: true, force: true });
    try { const stj = JSON.parse(fs.readFileSync(path.join(job, 'state.json'), 'utf8'));
      delete stj.done.render; delete stj.done.report; fs.writeFileSync(path.join(job, 'state.json'), JSON.stringify(stj)); } catch {}
    const r = runRFC([`--input=${d}`, '--job=reg_m33ctx', '--from=render']);
    const M2 = man();
    const fin2 = path.join(job, 'final.mp4');
    let ok = false, detail = `exit=${r.status}`;
    if (M2 && fs.existsSync(fin2)) {
      const claimedVideo = M2.shots.filter(s => s.asset === 'EXACT_VIDEO');
      const lying = claimedVideo.filter(s => isCard(colorAt(fin2, s.start + Math.min(1, s.dur / 2))));
      ok = lying.length === 0;
      detail = `${claimedVideo.length} EXACT_VIDEO claims, ${lying.length} were cards`;
    } else if (r.status !== 0) { ok = true; detail = 'production aborted instead of shipping a mislabelled card'; }
    check('T-M332 corrupt clip: either recovers with real media or aborts — never a card labelled EXACT_VIDEO', ok, detail);
  })();

  // --- (3) frame hint EXACT second par materialize ho ---
  (() => {
    const long = makeEp(path.join(FX, 'ep'), 'longsrc', [
      { color: 'red' }, { color: 'green' }, { color: 'blue' }, { color: 'yellow' },
      { color: 'red' }, { color: 'green' }, { color: 'blue' }, { color: 'yellow' },
    ]);   // 160s — uniform sampling se hint 1-2s tak off ho sakta hai
    const hd = path.join(FX, 'm33hint');
    makeNarr(hd, [{ start: 0, end: 8, text: 'The alarm rings across the base.' }]);
    // 130s = 7th segment (blue). Uniform bank kabhi-kabhi green/yellow de deta.
    writePack(hd, { schema_version: 'scene-research-pack-v1', project_title: 'Hint', packs: [{
      pack_id: 'H', scope: { kind: 'SERIES', title: 'Show H' },
      sources: [{ source_id: 'HS', local_file: long.video, inspection_status: 'VERIFIED_WATCHED' }],
      moments: [{ moment_id: 'H1', script_cue_exact: 'The alarm rings across the base.', locators: [],
        fallback_plan: { allowed_pack_ids: ['H'], allowed_source_ids: ['HS'], frame_hints: [{ source_id: 'HS', time_sec: 130, reason: 'blue segment' }] },
        fallback: { type: 'NEEDS_SOURCE' } }] }] });
    runRFC([`--input=${hd}`, '--job=reg_m33hint', '--redo']);
    let HM = null; try { HM = JSON.parse(fs.readFileSync(path.join(JOBS, 'reg_m33hint', 'render-manifest.json'), 'utf8')); } catch {}
    const hinted = HM ? HM.shots.filter(s => s.hint_time != null) : [];
    const delta = hinted.length ? Math.max(...hinted.map(s => Math.abs(s.hint_delta || 0))) : null;
    const hfin = path.join(JOBS, 'reg_m33hint', 'final.mp4');
    const col = hinted.length && fs.existsSync(hfin) ? nearest(colorAt(hfin, hinted[0].start + Math.min(1, hinted[0].dur / 2))) : null;
    check('T-M333 frame hint materializes at the exact second (<=0.5s) and shows that frame',
      hinted.length > 0 && delta <= 0.5 && col && col.k === 'blue',
      `hinted=${hinted.length} maxDelta=${delta}s colour=${col ? col.k : 'n/a'}`);
    check('T-M334 hint-only source gets indexed even though no clip was ever cut from it',
      hinted.length > 0, `shots with hint_time=${hinted.length}`);
  })();

  // --- (4) cross-show neighbour borrow band ---
  (() => {
    const other = makeEp(path.join(FX, 'ep'), 'showb', [{ color: 'yellow', dialogue: 'a completely different series entirely' }]);
    const xd = path.join(FX, 'm33scope');
    makeNarr(xd, [
      { start: 0, end: 6, text: 'The alarm rings across the base.' },
      { start: 6, end: 12, text: 'She opens the sealed hatch slowly.' },
    ]);
    writePack(xd, { schema_version: 'scene-research-pack-v1', project_title: 'Scope', packs: [
      { pack_id: 'PA', scope: { kind: 'SERIES', title: 'Show A' }, sources: [],
        moments: [{ moment_id: 'A1', script_cue_exact: 'The alarm rings across the base.', locators: [], fallback: { type: 'TEXT_CARD', text: 'no show A media' } }] },
      { pack_id: 'PB', scope: { kind: 'SERIES', title: 'Show B' },
        sources: [{ source_id: 'BS', local_file: other.video, local_subs: other.srt, inspection_status: 'VERIFIED_WATCHED' }],
        moments: [{ moment_id: 'B1', script_cue_exact: 'She opens the sealed hatch slowly.',
          locators: [{ source_id: 'BS', locator_type: 'EXACT_TIME', start_sec: 2, end_sec: 7, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } }] },
    ] }, );
    runRFC([`--input=${xd}`, '--job=reg_m33scope', '--redo', '--review']);
    let SM = null; try { SM = JSON.parse(fs.readFileSync(path.join(JOBS, 'reg_m33scope', 'render-manifest.json'), 'utf8')); } catch {}
    const aShots = SM ? SM.shots.filter(s => s.moment_id === 'A1') : [];
    const borrowed = aShots.filter(s => s.source_id === 'BS' || s.image_source === 'BS');
    check('T-M335 a Show-A beat with no media never borrows Show-B footage',
      aShots.length > 0 && borrowed.length === 0,
      `A1 shots=${aShots.length} borrowedFromB=${borrowed.length} assets=${[...new Set(aShots.map(s => s.asset))].join('/')}`);
  })();

  // --- (5) HARD_EVIDENCE bina exact clip ke production block kare ---
  (() => {
    const cd = path.join(FX, 'm33crit');
    makeNarr(cd, [{ start: 0, end: 6, text: 'The alarm rings across the base.' }]);
    writePack(cd, { schema_version: 'scene-research-pack-v1', project_title: 'Crit', packs: [{
      pack_id: 'K', scope: { kind: 'SERIES', title: 'Show K' },
      sources: [{ source_id: 'KS', local_file: good.video, local_subs: good.srt, inspection_status: 'VERIFIED_WATCHED' }],
      moments: [{ moment_id: 'K1', script_cue_exact: 'The alarm rings across the base.', criticality: 'HARD_EVIDENCE',
        locators: [], fallback_plan: { allowed_pack_ids: ['K'], allowed_source_ids: ['KS'] }, fallback: { type: 'NEEDS_SOURCE' } }] }] });
    const r = runRFC([`--input=${cd}`, '--job=reg_m33crit', '--redo']);
    const out = (r.stdout || '') + (r.stderr || '');
    check('T-M336 HARD_EVIDENCE without an exact clip blocks production export',
      r.status !== 0 && /HARD_EVIDENCE|critical moments/i.test(out) && !fs.existsSync(path.join(JOBS, 'reg_m33crit', 'final.mp4')),
      `exit=${r.status} blocked=${/critical moments/i.test(out)}`);
  })();

  // --- (5b) asli preview se mile do quality bugs ---
  // (a) ek hi hint moment ke DO shots par lag jata tha -> 8-11s ka freeze jaisa
  // (b) analysis beat ka overlay_text gayab ho gaya tha (plain still ban gaya)
  (() => {
    const qd = path.join(FX, 'm33quality');
    // 14-second beat -> shot planner ise 2-3 shots mein todega
    makeNarr(qd, [{ start: 0, end: 14, text: 'The alarm rings across the base and she opens the sealed hatch slowly tonight.' },
                  { start: 14, end: 20, text: 'The final shot fades to black.' }]);
    writePack(qd, { schema_version: 'scene-research-pack-v1', project_title: 'Q', packs: [
      { pack_id: 'QS', scope: { kind: 'SERIES', title: 'Show Q' },
        sources: [{ source_id: 'QSS', local_file: good.video, local_subs: good.srt, inspection_status: 'VERIFIED_WATCHED' }],
        moments: [{ moment_id: 'QS1', script_cue_exact: 'The final shot fades to black.',
          locators: [{ source_id: 'QSS', locator_type: 'EXACT_TIME', start_sec: 62, end_sec: 68, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } }] },
      { pack_id: 'QG', scope: { kind: 'GRAPHIC', title: 'Analysis cards' }, sources: [],
        moments: [{ moment_id: 'QG1', script_cue_exact: 'The alarm rings across the base and she opens the sealed hatch slowly tonight.',
          locators: [],
          fallback_plan: { allowed_pack_ids: ['QS'], allowed_source_ids: ['QSS'],
            frame_hints: [{ source_id: 'QSS', time_sec: 25, reason: 'green' }, { source_id: 'QSS', time_sec: 45, reason: 'blue' }],
            overlay_text: 'Nothing was ever enough' },
          fallback: { type: 'LOCAL_GRAPHIC', text: 'Nothing was ever enough' } }] },
    ] });
    runRFC([`--input=${qd}`, '--job=reg_m33q', '--redo']);
    let QM = null; try { QM = JSON.parse(fs.readFileSync(path.join(JOBS, 'reg_m33q', 'render-manifest.json'), 'utf8')); } catch {}
    const qs = QM ? QM.shots.filter(s => s.moment_id === 'QG1') : [];
    const imgs = qs.map(s => s.image).filter(Boolean);
    // Asli defect ADJACENT repeat tha (do lagatar shots par wahi frame = freeze
    // jaisa). Hints khatam hon to rotation se dobara aana theek hai — bas
    // lagatar nahi.
    const adjRepeat = qs.filter((s2, i2) => i2 > 0 && s2.image && s2.image === qs[i2 - 1].image).length;
    check('T-M338 two consecutive shots of one moment never show the same frame',
      qs.length >= 2 && adjRepeat === 0,
      `${qs.length} shots, ${new Set(imgs).size} distinct frames, ${adjRepeat} adjacent repeats`);
    check('T-M339 analysis beat keeps its overlay text (media-backed graphic, not a silent still)',
      qs.length > 0 && qs.every(s => s.asset === 'TEMPLATE_GRAPHIC_MEDIA'),
      `assets=${[...new Set(qs.map(s => s.asset))].join('/')}`);
  })();

  // --- (5c) range download re-encode flag hata diya gaya hai ---
  // `--force-keyframes-at-cuts` yt-dlp se poori stream re-encode karwata tha —
  // asli preview mein har range download 300s par ETIMEDOUT ho raha tha.
  check('T-M340 range download does not ask yt-dlp to re-encode at cut points',
    !/'--force-keyframes-at-cuts'/.test(fs.readFileSync(path.join(ROOT, 'src', 'download.js'), 'utf8')),
    'force-keyframes flag absent');

  // --- (6) --redo purana render-manifest.json chhode nahi ---
  (() => {
    const stale = path.join(JOBS, 'reg_m33ctx', 'render-manifest.json');
    fs.writeFileSync(stale, JSON.stringify({ total: 999, shots: [{ i: 0, asset: 'STALE_MARKER', dur: 999 }] }));
    runRFC([`--input=${d}`, '--job=reg_m33ctx', '--redo']);
    let after = null; try { after = JSON.parse(fs.readFileSync(stale, 'utf8')); } catch {}
    check('T-M337 --redo removes the stale render manifest (report cannot show old numbers)',
      after && !JSON.stringify(after).includes('STALE_MARKER'),
      `stalePresent=${after ? JSON.stringify(after).includes('STALE_MARKER') : 'no file'}`);
  })();
})();

// ---------- T-M36: audit ke P0 items (asli run se aaye) ----------
(() => {
  const d = path.join(FX, 'm36');
  makeNarr(d, [
    { start: 0, end: 6, text: 'The alarm rings across the base.' },
    { start: 6, end: 12, text: 'She opens the sealed hatch slowly.' },
  ]);

  // --- (1) PRODUCTION GATE: bina taaza pack-report ke render nahi ---
  (() => {
    writePack(d, { schema_version: 'scene-research-pack-v1', project_title: 'G', packs: [{
      pack_id: 'G1', scope: { kind: 'SERIES', title: 'Show G' },
      sources: [{ source_id: 'GS', local_file: good.video, local_subs: good.srt, inspection_status: 'VERIFIED_WATCHED' }],
      moments: [
        { moment_id: 'G_M1', script_cue_exact: 'The alarm rings across the base.', criticality: 'NORMAL',
          locators: [{ source_id: 'GS', locator_type: 'EXACT_TIME', start_sec: 2, end_sec: 8, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } },
        { moment_id: 'G_M2', script_cue_exact: 'She opens the sealed hatch slowly.', criticality: 'NORMAL',
          locators: [{ source_id: 'GS', locator_type: 'EXACT_TIME', start_sec: 22, end_sec: 28, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } },
      ] }] });
    // override ke BINA — gate ko rokna chahiye
    const blocked = spawnSync('node', ['src/run.js', `--input=${d}`, '--job=reg_gate', '--redo'],
      { cwd: ROOT, encoding: 'utf8', timeout: 600000, env: process.env });
    const out = (blocked.stdout || '') + (blocked.stderr || '');
    check('T-M361 stale/missing pack check blocks a production render (exit 3)',
      blocked.status === 3 && /PRODUCTION GATE/.test(out) && !fs.existsSync(path.join(JOBS, 'reg_gate', 'final.mp4')),
      `exit=${blocked.status} gateMsg=${/PRODUCTION GATE/.test(out)}`);

    // ab TAAZA report banao -> wahi run chal jana chahiye
    const outDir = path.join(d, 'out');
    spawnSync('node', ['tools/check-pack.js', path.join(d, 'scene-research.json'), path.join(d, 'voiceover.srt'), `--out=${outDir}`, '--no-probe'],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000, env: process.env });
    const rep = JSON.parse(fs.readFileSync(path.join(outDir, 'pack-report.json'), 'utf8'));
    fs.mkdirSync(path.join(ROOT, 'output'), { recursive: true });
    const prodRep = path.join(ROOT, 'output', 'pack-report.json');
    const hadRep = fs.existsSync(prodRep) ? fs.readFileSync(prodRep) : null;
    fs.writeFileSync(prodRep, JSON.stringify(rep));
    const passed = spawnSync('node', ['src/run.js', `--input=${d}`, '--job=reg_gate', '--redo'],
      { cwd: ROOT, encoding: 'utf8', timeout: 600000, env: process.env });
    check('T-M362 a fresh pack check for these exact inputs unblocks the render',
      passed.status === 0 && fs.existsSync(path.join(JOBS, 'reg_gate', 'final.mp4'))
        && rep.pack_sha256 && rep.srt_sha256,
      `exit=${passed.status} hashes=${!!rep.pack_sha256}`);
    if (hadRep) fs.writeFileSync(prodRep, hadRep); else fs.rmSync(prodRep, { force: true });
  })();

  // --- (2) FAIL PAR BHI REPAIR PACKAGE ---
  (() => {
    const fd = path.join(FX, 'm36fail');
    makeNarr(fd, [{ start: 0, end: 8, text: 'The alarm rings across the base.' }]);
    // koi source nahi -> timeline generic text -> render production mein rukega
    writePack(fd, { schema_version: 'scene-research-pack-v1', project_title: 'F', packs: [{
      pack_id: 'F1', scope: { kind: 'SERIES', title: 'Show F' }, sources: [],
      moments: [{ moment_id: 'F_M1', script_cue_exact: 'The alarm rings across the base.', criticality: 'HARD_EVIDENCE',
        locators: [], fallback: { type: 'NEEDS_SOURCE' } }] }] });
    const r = runRFC([`--input=${fd}`, '--job=reg_m36fail', '--redo']);
    const j = path.join(JOBS, 'reg_m36fail');
    let jr = null; try { jr = JSON.parse(fs.readFileSync(path.join(j, 'job-result.json'), 'utf8')); } catch {}
    const csv = fs.existsSync(path.join(j, 'NEEDS_SOURCE.csv')) ? fs.readFileSync(path.join(j, 'NEEDS_SOURCE.csv'), 'utf8') : '';
    check('T-M363 a failed render still leaves job-result.json, NEEDS_SOURCE.csv and a readable report',
      r.status !== 0 && jr && jr.status === 'FAILED' && csv.includes('F_M1')
        && fs.existsSync(path.join(j, 'blocked-report.html')),
      `exit=${r.status} status=${jr ? jr.status : 'none'} csvHasMoment=${csv.includes('F_M1')}`);
    check('T-M364 the failure report names the critical beat that blocked it',
      jr && jr.critical_unresolved.includes('F_M1') && jr.next_steps.length > 0,
      `critical=${jr ? JSON.stringify(jr.critical_unresolved) : 'n/a'}`);
    check('T-M365 the failure report never points at a file that does not exist',
      jr && jr.artifacts.every(a => fs.existsSync(path.join(j, a))),
      `artifacts=${jr ? jr.artifacts.join(',') : 'n/a'}`);
  })();

  // --- (3) SAME SHOW, ALAG EPISODE bina permission ke leak na ho ---
  (() => {
    const ep2 = makeEp(path.join(FX, 'ep'), 'ep2', [{ color: 'yellow', dialogue: 'second episode entirely different scene' }]);
    const sd = path.join(FX, 'm36ep');
    makeNarr(sd, [
      { start: 0, end: 6, text: 'The alarm rings across the base.' },
      { start: 6, end: 12, text: 'She opens the sealed hatch slowly.' },
    ]);
    const mk = (borrow) => ({ schema_version: 'scene-research-pack-v1', project_title: 'EP', packs: [
      { pack_id: 'E1', scope: { kind: 'SERIES', title: 'Show E', season: 1, episode_number: 1, episode_title: 'One' },
        sources: [{ source_id: 'E1S', local_file: good.video, local_subs: good.srt, inspection_status: 'VERIFIED_WATCHED' }],
        moments: [{ moment_id: 'E1_M1', script_cue_exact: 'The alarm rings across the base.', criticality: 'NORMAL',
          locators: [{ source_id: 'E1S', locator_type: 'EXACT_TIME', start_sec: 2, end_sec: 8, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } }] },
      { pack_id: 'E2', scope: { kind: 'SERIES', title: 'Show E', season: 1, episode_number: 2, episode_title: 'Two' },
        sources: [],   // is episode ki koi media nahi
        moments: [{ moment_id: 'E2_M1', script_cue_exact: 'She opens the sealed hatch slowly.', criticality: 'NORMAL',
          locators: [], fallback_plan: borrow ? { allow_context_borrow: true } : {}, fallback: { type: 'TEXT_CARD', text: 'ep2 media nahi' } }] },
    ] });
    writePack(sd, mk(false));
    runRFC([`--input=${sd}`, '--job=reg_m36ep', '--redo', '--review']);
    let TM = null; try { TM = JSON.parse(fs.readFileSync(path.join(JOBS, 'reg_m36ep', 'render-manifest.json'), 'utf8')); } catch {}
    const e2 = TM ? TM.shots.filter(s => s.moment_id === 'E2_M1') : [];
    const leaked = e2.filter(s => s.actual_source_id === 'E1S');
    check('T-M366 same show, different episode does not leak footage without permission',
      e2.length > 0 && leaked.length === 0,
      `E2 shots=${e2.length} usedEp1=${leaked.length} assets=${[...new Set(e2.map(s => s.asset))].join('/')}`);

    writePack(sd, mk(true));
    runRFC([`--input=${sd}`, '--job=reg_m36ep2', '--redo', '--review']);
    let TM2 = null; try { TM2 = JSON.parse(fs.readFileSync(path.join(JOBS, 'reg_m36ep2', 'render-manifest.json'), 'utf8')); } catch {}
    const e2b = TM2 ? TM2.shots.filter(s => s.moment_id === 'E2_M1') : [];
    const borrowed = e2b.filter(s => s.actual_source_id === 'E1S');
    check('T-M367 with allow_context_borrow it is used, and labelled SAME_SHOW_OTHER_EPISODE',
      borrowed.length > 0 && borrowed.every(s => s.scope_relation === 'SAME_SHOW_OTHER_EPISODE'),
      `borrowed=${borrowed.length} rel=${[...new Set(e2b.map(s => s.scope_relation))].join('/')}`);
  })();

  // --- (4) unknown-duration / over-cap source poori download na ho ---
  (() => {
    const DL = require(path.join(ROOT, 'src', 'download.js'));
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const unknown = DL.acquireFullSource('reg_capcheck', cfg, { source_id: 'UNK', url: 'https://www.youtube.com/watch?v=UNKNOWNDUR1' }, null);
    const tooLong = DL.acquireFullSource('reg_capcheck', cfg, { source_id: 'LONG', url: 'https://www.youtube.com/watch?v=LONGSOURCE1' }, { duration: 5000 });
    check('T-M368 unknown-duration and over-cap sources are refused before any download',
      !unknown.ok && /duration pata nahi/i.test(unknown.error) && !tooLong.ok && tooLong.tooLong === true,
      `unknown="${String(unknown.error).slice(0, 40)}" long=${tooLong.tooLong}`);
  })();
})();

// ---------- T-M361x: M3.6.1 — asli Windows run se aaye workflow bugs ----------
//  M3.6 ka engine is run mein fail nahi hua — wo CHALA HI NAHI. Option 2 ne pack
//  ko badal kar apni hi report ko stale kar diya, aur 5/6/7 teeno gate par ruk
//  gaye. Ye tests wahi cheezein pin karte hain.
(() => {
  const d = path.join(FX, 'm361');
  makeNarr(d, [
    { start: 0, end: 6, text: 'The alarm rings across the base.' },
    { start: 6, end: 12, text: 'She opens the sealed hatch slowly.' },
  ]);
  const mkPack = (extra = {}) => ({
    schema_version: 'scene-research-pack-v1', project_title: 'A61', packs: [{
      pack_id: 'A1', scope: { kind: 'SERIES', title: 'Show A', year: 2011, season: 1, episode_number: 1 },
      // duration jaan-boojh kar GALAT — probe ise theek karega, yaani pack badlega
      sources: [{ source_id: 'AS', local_file: good.video, local_subs: good.srt, duration_sec: 9999, inspection_status: 'METADATA_ONLY' }],
      moments: [
        { moment_id: 'A_M1', script_cue_exact: 'The alarm rings across the base.', criticality: 'NORMAL',
          locators: [{ source_id: 'AS', locator_type: 'DIALOGUE', dialogue_exact: 'The alarm rings across the base.', confidence: 'MEDIUM' }],
          fallback: { type: 'NEEDS_SOURCE' }, ...extra },
        { moment_id: 'A_M2', script_cue_exact: 'She opens the sealed hatch slowly.', criticality: 'NORMAL',
          locators: [{ source_id: 'AS', locator_type: 'DIALOGUE', dialogue_exact: 'She opens the sealed hatch slowly.', confidence: 'MEDIUM' }],
          fallback: { type: 'NEEDS_SOURCE' } },
      ] }] });

  // --- (1) CHECKPACK khud ko stale na kare: ek run, hash sach mein match kare ---
  (() => {
    const pf = path.join(d, 'scene-research.json'), srt = path.join(d, 'voiceover.srt');
    writePack(d, mkPack());
    const outDir = path.join(d, 'out1');
    const before = U.hashFile(pf);
    spawnSync('node', ['tools/check-pack.js', pf, srt, `--out=${outDir}`, '--apply-probe'],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000, env: process.env });
    let rep = null; try { rep = JSON.parse(fs.readFileSync(path.join(outDir, 'pack-report.json'), 'utf8')); } catch {}
    const after = U.hashFile(pf);
    const mutated = before !== after;            // probe ne sach mein pack badla
    const matches = rep && String(rep.pack_sha256).toUpperCase() === String(after).toUpperCase();
    check('T-M3611 check-pack --apply-probe mutates the pack AND its report still matches it',
      mutated && matches && rep.probe_applied > 0,
      `mutated=${mutated} reportMatchesDisk=${matches} applied=${rep ? rep.probe_applied : 'n/a'}`);

    // --- (2) ek option-2 ke baad preview stale na bole ---
    fs.mkdirSync(path.join(ROOT, 'output'), { recursive: true });
    const prodRep = path.join(ROOT, 'output', 'pack-report.json');
    const hadRep = fs.existsSync(prodRep) ? fs.readFileSync(prodRep) : null;
    fs.writeFileSync(prodRep, JSON.stringify(rep));
    const prev = spawnSync('node', ['src/run.js', `--input=${d}`, '--job=reg_m361prev', '--redo',
      '--preview-start=0', '--preview-duration=120'], { cwd: ROOT, encoding: 'utf8', timeout: 600000, env: process.env });
    const pout = (prev.stdout || '') + (prev.stderr || '');
    check('T-M3612 one check run is enough — the very next preview is not called stale',
      prev.status !== 3 && !/taaza check nahi hai/.test(pout),
      `exit=${prev.status} stale=${/taaza check nahi hai/.test(pout)}`);

    // --- (3) weak pack: preview DIAGNOSTIC chale, poora export ruke ---
    const weakRep = { ...rep, pass: false, failed_checks: [{ check: 'test', detail: 'forced weak' }] };
    fs.writeFileSync(prodRep, JSON.stringify(weakRep));
    const dPrev = spawnSync('node', ['src/run.js', `--input=${d}`, '--job=reg_m361diag', '--redo',
      '--preview-start=0', '--preview-duration=120'], { cwd: ROOT, encoding: 'utf8', timeout: 600000, env: process.env });
    const dOut = (dPrev.stdout || '') + (dPrev.stderr || '');
    const full = spawnSync('node', ['src/run.js', `--input=${d}`, '--job=reg_m361full', '--redo'],
      { cwd: ROOT, encoding: 'utf8', timeout: 600000, env: process.env });
    const fOut = (full.stdout || '') + (full.stderr || '');
    check('T-M3613 a weak pack still allows a DIAGNOSTIC preview but blocks the full export',
      dPrev.status !== 3 && /DIAGNOSTIC PREVIEW/.test(dOut) && full.status === 3 && /poora export nahi hoga/.test(fOut),
      `preview=${dPrev.status} diagLabel=${/DIAGNOSTIC PREVIEW/.test(dOut)} full=${full.status}`);

    // --- (4) gate par ruke to bhi repair package bane ---
    let jr = null; const jdir = path.join(JOBS, 'reg_m361full');
    try { jr = JSON.parse(fs.readFileSync(path.join(jdir, 'job-result.json'), 'utf8')); } catch {}
    check('T-M3614 a gate block still writes job-result.json and a readable blocked report',
      jr && jr.status === 'BLOCKED' && jr.blocked_reason === 'PACK_NOT_PRODUCTION_READY'
        && fs.existsSync(path.join(jdir, 'blocked-report.html'))
        && jr.artifacts.every(a => fs.existsSync(path.join(jdir, a))),
      `status=${jr ? jr.status : 'none'} reason=${jr ? jr.blocked_reason : 'n/a'}`);

    // --- (5) criticality ke bina poora export na ho ---
    const noCrit = mkPack();
    for (const m of noCrit.packs[0].moments) delete m.criticality;
    const cd = path.join(FX, 'm361crit');
    makeNarr(cd, [{ start: 0, end: 6, text: 'The alarm rings across the base.' },
      { start: 6, end: 12, text: 'She opens the sealed hatch slowly.' }]);
    writePack(cd, noCrit);
    const cOut2 = path.join(cd, 'out');
    spawnSync('node', ['tools/check-pack.js', path.join(cd, 'scene-research.json'), path.join(cd, 'voiceover.srt'),
      `--out=${cOut2}`, '--no-probe'], { cwd: ROOT, encoding: 'utf8', timeout: 300000, env: process.env });
    let cRep = null; try { cRep = JSON.parse(fs.readFileSync(path.join(cOut2, 'pack-report.json'), 'utf8')); } catch {}
    fs.writeFileSync(prodRep, JSON.stringify({ ...cRep, pass: true }));
    const cFull = spawnSync('node', ['src/run.js', `--input=${cd}`, '--job=reg_m361nc', '--redo'],
      { cwd: ROOT, encoding: 'utf8', timeout: 600000, env: process.env });
    check('T-M3615 missing criticality blocks the full export and is counted in the report',
      cRep && cRep.missing_criticality === 2 && cFull.status === 3,
      `missing=${cRep ? cRep.missing_criticality : 'n/a'} exit=${cFull.status}`);

    if (hadRep) fs.writeFileSync(prodRep, hadRep); else fs.rmSync(prodRep, { force: true });
  })();

  // --- (6) SERIES ka air year show ki pehchaan na bane ---
  (() => {
    const SCOPE = require(path.join(ROOT, 'src', 'scope.js'));
    const e1 = { kind: 'SERIES', title: 'Phineas and Ferb', year: 2011, season: 3, episode_number: 21 };
    const e2 = { kind: 'SERIES', title: 'Phineas and Ferb', year: 2008, season: 1, episode_number: 24 };
    const f1 = { kind: 'FILM', title: 'Same Name', year: 1998 };
    const f2 = { kind: 'FILM', title: 'Same Name', year: 2015 };
    check('T-M3616 same series with different episode air years is one show, two episodes',
      SCOPE.workKey(e1) === SCOPE.workKey(e2) && SCOPE.relation(e1, e2) === 'SAME_SHOW_OTHER_EPISODE'
        && SCOPE.workKey(f1) !== SCOPE.workKey(f2) && SCOPE.relation(f1, f2) === 'CROSS_SHOW',
      `series=${SCOPE.relation(e1, e2)} film=${SCOPE.relation(f1, f2)}`);
  })();

  // --- (7) purani allowed_pack_ids chupke se doosra episode na khol de ---
  (() => {
    const ep2 = makeEp(path.join(FX, 'ep'), 'ep2', [{ color: 'yellow', dialogue: 'second episode entirely different scene' }]);
    const bd = path.join(FX, 'm361borrow');
    makeNarr(bd, [
      { start: 0, end: 6, text: 'The alarm rings across the base.' },
      { start: 6, end: 12, text: 'A beat with no source of its own at all.' },
    ]);
    const pack = { schema_version: 'scene-research-pack-v1', project_title: 'B61', packs: [
      { pack_id: 'B1', scope: { kind: 'SERIES', title: 'Show B', year: 2011, season: 1, episode_number: 1 },
        sources: [{ source_id: 'BS1', local_file: good.video, local_subs: good.srt, inspection_status: 'VERIFIED_WATCHED' }],
        moments: [{ moment_id: 'B_M1', script_cue_exact: 'The alarm rings across the base.', criticality: 'NORMAL',
          locators: [{ source_id: 'BS1', locator_type: 'EXACT_TIME', start_sec: 2, end_sec: 8, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } }] },
      // alag EPISODE (year bhi alag — asli Candace pack jaisa), koi apna source nahi,
      // aur purane style ki `allowed_pack_ids` jo B1 ko allow karti hai
      { pack_id: 'B2', scope: { kind: 'SERIES', title: 'Show B', year: 2012, season: 3, episode_number: 42 },
        sources: [{ source_id: 'BS2', local_file: ep2.video, local_subs: ep2.srt, inspection_status: 'VERIFIED_WATCHED' }],
        moments: [{ moment_id: 'B_M2', script_cue_exact: 'A beat with no source of its own at all.', criticality: 'HARD_EVIDENCE',
          locators: [], fallback: { type: 'NEEDS_SOURCE' },
          fallback_plan: { allowed_pack_ids: ['B2', 'B1'], frame_hints: [] } }] },
    ] };
    writePack(bd, pack);
    const r = runRFC([`--input=${bd}`, '--job=reg_m361borrow', '--redo', '--diagnostic-override', '--review']);
    const rOut = (r.stdout || '') + (r.stderr || '');
    let man = null; try { man = JSON.parse(fs.readFileSync(path.join(JOBS, 'reg_m361borrow', 'render-manifest.json'), 'utf8')); } catch {}
    const m2shots = ((man && man.shots) || []).filter(s => s.moment_id === 'B_M2');
    const leaked = m2shots.some(s => s.actual_source_id === 'BS1');
    const warned = /borrow_approved nahi|critical beat udhaar/.test(rOut);
    check('T-M3617 a legacy allowed_pack_ids cannot silently authorise wrong-episode footage on a critical beat',
      man && !leaked && warned,
      `leaked=${leaked} shots=${m2shots.length} warned=${warned}`);
  })();

  // --- (8) repair prompts standalone hon, batch mein hon, aur toote locator bhi lein ---
  (() => {
    const rd = path.join(FX, 'm361rep');
    makeNarr(rd, [{ start: 0, end: 6, text: 'The alarm rings across the base.' }]);
    const moments = [];
    for (let i = 1; i <= 20; i++) moments.push({ moment_id: `R_M${String(i).padStart(2, '0')}`,
      script_cue_exact: 'The alarm rings across the base.', criticality: 'NORMAL', locators: [], fallback: { type: 'NEEDS_SOURCE' } });
    writePack(rd, { schema_version: 'scene-research-pack-v1', project_title: 'R61', packs: [{
      pack_id: 'R1', scope: { kind: 'SERIES', title: 'Show R', year: 2011, season: 1, episode_number: 1 },
      sources: [{ source_id: 'RS', local_file: good.video, local_subs: good.srt, inspection_status: 'VERIFIED_WATCHED' }],
      moments }] });
    const rout = path.join(rd, 'out');
    const rr = spawnSync('node', ['tools/repair.js', path.join(rd, 'scene-research.json'), `--out=${rout}`, '--batch=15'],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000, env: process.env });
    const dir = path.join(rout, 'repair');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.txt')) : [];
    const texts = files.map(f => fs.readFileSync(path.join(dir, f), 'utf8'));
    let man = null; try { man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch {}
    const sizes = (man && man.batches.map(b => b.moments.length)) || [];
    check('T-M3618 repair prompts are self-contained, batched 12-18, and never demand the original chat',
      files.length >= 2 && sizes.every(n => n <= 15) && sizes.reduce((a, b) => a + b, 0) === 20
        && texts.every(t => /SELF-CONTAINED/.test(t) && /research-repair-v2/.test(t))
        && !texts.some(t => /usi chat|same chat/i.test(t)),
      `files=${files.length} sizes=${JSON.stringify(sizes)} exit=${rr.status}`);

    // --- (9) apply-repair poora contract lagaye, sahi tarteeb mein ---
    const respDir = path.join(dir, 'responses');
    fs.writeFileSync(path.join(respDir, 'batch1.json'), JSON.stringify({
      schema_version: 'research-repair-v2', batch_id: 'test-01',
      source_additions: [{ source_id: 'RS2', pack_id: 'R1', url: 'https://example.com/watch?v=NEWSRC', duration_sec: 300, has_captions: true }],
      moment_updates: [{
        moment_id: 'R_M01',
        script_cue_exact: 'She opens the sealed hatch slowly.',
        criticality: 'HARD_EVIDENCE',
        overlay_text: 'the receipts',
        allowed_source_ids: ['RS', 'RS2'],
        locators: [{ source_id: 'RS2', locator_type: 'EXACT_TIME', start_sec: 10, end_sec: 16, confidence: 'HIGH' }],
        frame_hints: [{ source_id: 'RS2', time_sec: 12, reason: 'test hint' }],
      }],
    }, null, 2));
    const ar = spawnSync('node', ['tools/apply-repair.js', path.join(rd, 'scene-research.json'), '--apply', `--responses=${respDir}`],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000, env: process.env });
    let after = null; try { after = JSON.parse(fs.readFileSync(path.join(rd, 'scene-research.json'), 'utf8')); } catch {}
    const m1 = after && after.packs[0].moments.find(m => m.moment_id === 'R_M01');
    const newSrc = after && after.packs[0].sources.find(s => s.source_id === 'RS2');
    check('T-M3619 apply-repair updates cue, criticality, overlay, allowed sources AND adds a new source',
      ar.status === 0 && newSrc && m1 && m1.script_cue_exact === 'She opens the sealed hatch slowly.'
        && m1.criticality === 'HARD_EVIDENCE' && m1.fallback_plan.overlay_text === 'the receipts'
        && (m1.locators || []).some(L => L.source_id === 'RS2')
        && (m1.fallback_plan.frame_hints || []).some(h => h.source_id === 'RS2'),
      `exit=${ar.status} newSrc=${!!newSrc} crit=${m1 ? m1.criticality : 'n/a'} loc=${m1 ? (m1.locators || []).length : 0}`);
  })();

  // --- (10) cue LOCAL theek ho — koi AI nahi ---
  (() => {
    const cd = path.join(FX, 'm361cue');
    makeNarr(cd, [
      { start: 0, end: 6, text: 'The alarm rings across the base.' },
      { start: 6, end: 12, text: 'She opens the sealed hatch slowly.' },
    ]);
    writePack(cd, { schema_version: 'scene-research-pack-v1', project_title: 'C61', packs: [{
      pack_id: 'C1', scope: { kind: 'SERIES', title: 'Show C', year: 2011, season: 1, episode_number: 1 },
      sources: [{ source_id: 'CS', local_file: good.video, local_subs: good.srt, inspection_status: 'VERIFIED_WATCHED' }],
      moments: [{ moment_id: 'C_M1',
        // narration mein hai "She opens the sealed hatch slowly." — research ne apne shabd likh diye
        script_cue_exact: 'Then she opens up that sealed hatch very slowly indeed',
        criticality: 'NORMAL',
        locators: [{ source_id: 'CS', locator_type: 'EXACT_TIME', start_sec: 22, end_sec: 28, confidence: 'HIGH' }],
        fallback: { type: 'NEEDS_SOURCE' } }] }] });
    const pf = path.join(cd, 'scene-research.json');
    const fc = spawnSync('node', ['tools/fix-cues.js', pf, path.join(cd, 'voiceover.srt'), '--apply'],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000, env: process.env });
    let after = null; try { after = JSON.parse(fs.readFileSync(pf, 'utf8')); } catch {}
    const cue = after && after.packs[0].moments[0].script_cue_exact;
    check('T-M36110 a mismatched narration cue is repaired locally from the SRT, with no AI call',
      fc.status === 0 && cue === 'She opens the sealed hatch slowly.',
      `exit=${fc.status} cue=${JSON.stringify(String(cue).slice(0, 50))}`);
  })();

  // --- (11) migrate-pack criticality bhare aur purana udhaar surface kare ---
  (() => {
    const md = path.join(FX, 'm361mig');
    makeNarr(md, [{ start: 0, end: 6, text: 'The alarm rings across the base.' },
      { start: 300, end: 306, text: 'She opens the sealed hatch slowly.' }]);
    writePack(md, { schema_version: 'scene-research-pack-v1', project_title: 'M61', packs: [
      { pack_id: 'M1', scope: { kind: 'SERIES', title: 'Show M', year: 2011, season: 1, episode_number: 1 },
        sources: [{ source_id: 'MS', local_file: good.video, local_subs: good.srt, inspection_status: 'VERIFIED_WATCHED' }],
        moments: [{ moment_id: 'M_M1', script_cue_exact: 'The alarm rings across the base.', locators: [], fallback: { type: 'NEEDS_SOURCE' } }] },
      { pack_id: 'M2', scope: { kind: 'SERIES', title: 'Show M', year: 2012, season: 3, episode_number: 42 },
        sources: [], moments: [{ moment_id: 'M_M2', script_cue_exact: 'She opens the sealed hatch slowly.',
          locators: [], fallback: { type: 'NEEDS_SOURCE' }, fallback_plan: { allowed_pack_ids: ['M2', 'M1'] } }] },
    ] });
    const pf = path.join(md, 'scene-research.json');
    const mg = spawnSync('node', ['tools/migrate-pack.js', pf, path.join(md, 'voiceover.srt'), '--apply'],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000, env: process.env });
    let after = null; try { after = JSON.parse(fs.readFileSync(pf, 'utf8')); } catch {}
    const m1 = after && after.packs[0].moments[0], m2 = after && after.packs[1].moments[0];
    check('T-M36111 migration fills criticality everywhere and flags legacy cross-episode borrow',
      mg.status === 0 && m1 && m1.criticality === 'HOOK' && m2 && m2.criticality
        && !(m2.fallback_plan || {}).borrow_approved && /M_M2/.test(mg.stdout || ''),
      `m1=${m1 ? m1.criticality : 'n/a'} m2=${m2 ? m2.criticality : 'n/a'} flagged=${/M_M2/.test(mg.stdout || '')}`);
  })();

  // --- (12) menu ka status jhooth na bole ---
  (() => {
    const sd = path.join(FX, 'm361stat');
    makeNarr(sd, [{ start: 0, end: 6, text: 'The alarm rings across the base.' }]);
    writePack(sd, { schema_version: 'scene-research-pack-v1', project_title: 'S61', packs: [{
      pack_id: 'S1', scope: { kind: 'SERIES', title: 'Show S', year: 2011, season: 1, episode_number: 1 },
      sources: [{ source_id: 'SS', local_file: good.video, local_subs: good.srt, inspection_status: 'VERIFIED_WATCHED' }],
      moments: [{ moment_id: 'S_M1', script_cue_exact: 'The alarm rings across the base.', criticality: 'NORMAL',
        locators: [{ source_id: 'SS', locator_type: 'EXACT_TIME', start_sec: 2, end_sec: 8, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } }] }] });
    const pf = path.join(sd, 'scene-research.json'), srt = path.join(sd, 'voiceover.srt');
    const so = path.join(sd, 'out');
    const stat = (extra = []) => {
      const r = spawnSync('node', ['tools/pack-status.js', pf, srt, path.join(so, 'pack-report.json'), ...extra],
        { cwd: ROOT, encoding: 'utf8', timeout: 60000, env: process.env });
      return (r.stdout || '').trim();
    };
    const s0 = stat();                                   // report hai hi nahi
    spawnSync('node', ['tools/check-pack.js', pf, srt, `--out=${so}`, '--no-probe'],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000, env: process.env });
    const s1 = stat();                                   // taaza
    // ab pack badal do — report wahi purani reh gayi
    const raw = JSON.parse(fs.readFileSync(pf, 'utf8'));
    raw.packs[0].moments[0].purpose = 'changed after the check';
    fs.writeFileSync(pf, JSON.stringify(raw, null, 2));
    const s2 = stat();
    check('T-M36112 the menu status tells the truth: not checked / fresh / stale',
      /^NOT_CHECKED/.test(s0) && /^(PRODUCTION_READY|NEEDS_RESEARCH|DIAGNOSTIC_READY)/.test(s1) && /^STALE/.test(s2),
      `s0=${s0.split(' ')[0]} s1=${s1.split(' ')[0]} s2=${s2.split(' ')[0]}`);
  })();
})();

// ---------- T-M4: hybrid completion — jab footage internet par hai hi nahi ----------
//  Asli project mein movie (P03) ke dono uploads mar chuke hain: 21 moments,
//  ~162 second. Koi AI wo clip nahi bana sakta. Ye tests wo raasta pin karte
//  hain jisse video phir bhi poori banti hai — user apna media deta hai.
(() => {
  const gapplan = require(path.join(ROOT, 'src', 'gapplan.js'));
  const manual = require(path.join(ROOT, 'src', 'manual.js'));

  // --- (1) gap ID sthir rahe, aur paas-paas ke gaps jud jayein ---
  (() => {
    const cues = [];
    for (let i = 0; i < 12; i++) cues.push({ start: i * 5, end: i * 5 + 5, text: `line number ${i} of the narration here` });
    const mkMan = () => ({ preview_offset: 0, shots: [
      { i: 0, start: 0, end: 5, asset: 'EXACT_VIDEO', moment_id: 'A', pack_id: 'P1', cue: cues[0].text },
      // do khaali slot bilkul saath-saath -> ek hi request banni chahiye
      { i: 1, start: 5, end: 10, asset: 'GENERIC_TEXT_GRAPHIC', moment_id: 'B', pack_id: 'P1', cue: cues[1].text },
      { i: 2, start: 10, end: 15, asset: 'GENERIC_TEXT_GRAPHIC', moment_id: 'C', pack_id: 'P1', cue: cues[2].text },
      { i: 3, start: 15, end: 20, asset: 'VERIFIED_SOURCE_STILL', moment_id: 'D', pack_id: 'P1', cue: cues[3].text },
      // door wala khaali slot -> alag request
      { i: 4, start: 40, end: 45, asset: 'GENERIC_TEXT_GRAPHIC', moment_id: 'E', pack_id: 'P1', cue: cues[8].text },
    ] });
    const args = { manifest: mkMan(), resolved: [], cues, packIndex: { P1: { scope: { kind: 'SERIES', title: 'Show G' } } },
      fingerprint: { pack_sha256: 'x', srt_sha256: 'y' }, projectId: 'proj', cfg: {} };
    const a = gapplan.plan(args), b = gapplan.plan(args);
    const ids = a.requests.map(r => r.request_id);
    check('T-M41 gap requests merge adjacent misses and keep the same id across runs',
      a.requests.length === 2 && ids.join() === b.requests.map(r => r.request_id).join()
        && a.requests[0].range.start_sec === 5 && a.requests[0].range.end_sec === 15
        && a.requests[0].moment_ids.join() === 'B,C',
      `n=${a.requests.length} first=${JSON.stringify(a.requests[0] && a.requests[0].range)} stable=${ids.join() === b.requests.map(r => r.request_id).join()}`);

    // --- (2) preview ka rebased waqt POORE audio ke waqt par wapas aaye ---
    const off = gapplan.plan({ ...args, manifest: { ...mkMan(), preview_offset: 300 } });
    check('T-M42 a preview-rebased gap is reported in absolute full-audio time',
      off.requests[0].range.start_sec === 305 && off.requests[0].range.end_sec === 315,
      `range=${JSON.stringify(off.requests[0].range)}`);

    // --- (3) narration aur search words request mein hon ---
    const r0 = a.requests[0];
    check('T-M43 the request carries the exact narration and usable search words',
      /line number 1/.test(r0.narration_exact) && /line number 2/.test(r0.narration_exact)
        && r0.search_queries.length >= 1 && r0.search_queries.every(q => q.length > 3)
        && r0.suggested_media.minimum_unique_assets >= 1,
      `cue="${r0.narration_exact.slice(0, 40)}" q=${JSON.stringify(r0.search_queries)}`);

    // --- (4) media-backed graphic blocking NAHI hai, generic card hai ---
    const cls1 = gapplan.classifyShot({ asset: 'TEMPLATE_GRAPHIC_MEDIA', criticality: 'NORMAL' }, {});
    const cls2 = gapplan.classifyShot({ asset: 'GENERIC_TEXT_GRAPHIC', criticality: 'NORMAL' }, {});
    const cls3 = gapplan.classifyShot({ asset: 'USER_IMAGE', scope_relation: 'USER_APPROVED', criticality: 'HOOK' }, {});
    check('T-M44 a media-backed graphic is fine, a generic text card is not, user media satisfies a critical beat',
      cls1.level === 'OK' && cls2.level === 'BLOCKING' && cls3.level === 'OK',
      `graphic=${cls1.level} generic=${cls2.level} user=${cls3.level}`);
  })();

  // --- (5) POORA HYBRID CYCLE — bina internet ke ---
  (() => {
    const d = path.join(FX, 'm4hybrid');
    makeNarr(d, [
      { start: 0, end: 6, text: 'The alarm rings across the base.' },
      { start: 6, end: 12, text: 'She opens the sealed hatch slowly.' },
      { start: 12, end: 18, text: 'They meet on the rooftop at night.' },
    ]);
    // beat 2 aur 3 ke paas kuch bhi nahi — yahi wo "footage exist hi nahi karta" wali haalat hai
    writePack(d, { schema_version: 'scene-research-pack-v1', project_title: 'H4', packs: [
      { pack_id: 'H1', scope: { kind: 'SERIES', title: 'Show H', year: 2011, season: 1, episode_number: 1 },
        sources: [{ source_id: 'HS', local_file: good.video, local_subs: good.srt, inspection_status: 'VERIFIED_WATCHED' }],
        moments: [
          { moment_id: 'H_M1', script_cue_exact: 'The alarm rings across the base.', criticality: 'NORMAL',
            locators: [{ source_id: 'HS', locator_type: 'EXACT_TIME', start_sec: 2, end_sec: 8, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } }] },
      { pack_id: 'H2', scope: { kind: 'FILM', title: 'A Film With No Upload', year: 2020 }, sources: [],
        moments: [
          { moment_id: 'H_M2', script_cue_exact: 'She opens the sealed hatch slowly.', criticality: 'NORMAL',
            locators: [], fallback: { type: 'NEEDS_SOURCE' } },
          { moment_id: 'H_M3', script_cue_exact: 'They meet on the rooftop at night.', criticality: 'NORMAL',
            locators: [], fallback: { type: 'NEEDS_SOURCE' } }] },
    ] });
    const dataDir = path.join(ROOT, 'tests', 'tmp', 'data_hy_' + process.pid);
    fs.rmSync(dataDir, { recursive: true, force: true });
    const env = { ...process.env, RFC_DATA_DIR: dataDir, RFC_JOBS_DIR: JOBS };
    const runJob = (extra) => spawnSync('node', ['src/run.js', `--input=${d}`, '--job=reg_m4hy', '--redo',
      '--diagnostic-override', ...extra], { cwd: ROOT, encoding: 'utf8', timeout: 900000, env });

    // ---- DRAFT: rukta nahi, poori timeline banti hai ----
    const draft = runJob(['--draft']);
    const jdir = path.join(JOBS, 'reg_m4hy');
    const draftFile = path.join(jdir, 'draft.mp4');
    let man = null, gp = null, jr = null;
    try { man = JSON.parse(fs.readFileSync(path.join(jdir, 'render-manifest.json'), 'utf8')); } catch {}
    try { gp = JSON.parse(fs.readFileSync(path.join(jdir, 'gap-plan.json'), 'utf8')); } catch {}
    try { jr = JSON.parse(fs.readFileSync(path.join(jdir, 'job-result.json'), 'utf8')); } catch {}
    const placeholders = ((man && man.shots) || []).filter(s => s.asset === 'MISSING_PLACEHOLDER');
    check('T-M45 draft renders to the very end and marks every gap with a numbered placeholder',
      draft.status === 0 && fs.existsSync(draftFile) && !fs.existsSync(path.join(jdir, 'final.mp4'))
        && placeholders.length > 0 && Math.abs((man.total || 0) - 18) < 1.5,
      `exit=${draft.status} draft=${fs.existsSync(draftFile)} placeholders=${placeholders.length} total=${man && man.total}`);
    check('T-M46 a draft with gaps never reports plain SUCCESS',
      jr && jr.status === 'DRAFT_NEEDS_HUMAN' && /DATA/.test(jr.message || ''),
      `status=${jr && jr.status}`);

    // ---- DATA folders ----
    const reqDirs = fs.existsSync(dataDir) ? fs.readdirSync(dataDir).filter(n => /^MISSING_/.test(n)) : [];
    const first = reqDirs.length ? path.join(dataDir, reqDirs[0]) : null;
    const readme = first ? fs.readFileSync(path.join(first, 'WHAT_IS_MISSING.txt'), 'utf8') : '';
    check('T-M47 every gap gets a folder with plain-language instructions and the exact narration',
      reqDirs.length > 0 && gp && gp.requests.length === reqDirs.length
        && /Video time:/.test(readme) && /sealed hatch|rooftop/.test(readme)
        && fs.existsSync(path.join(first, 'media')) && fs.existsSync(path.join(dataDir, 'READ_ME_FIRST.txt')),
      `folders=${reqDirs.length} readmeBytes=${readme.length}`);

    // ---- FINAL abhi block hona chahiye ----
    const early = runJob([]);
    let ejr = null; try { ejr = JSON.parse(fs.readFileSync(path.join(jdir, 'job-result.json'), 'utf8')); } catch {}
    check('T-M48 the final export is blocked while any gap is still waiting for media',
      early.status === 3 && ejr && ejr.status === 'BLOCKED' && ejr.blocked_reason === 'NEEDS_HUMAN_MEDIA',
      `exit=${early.status} reason=${ejr && ejr.blocked_reason}`);

    // ---- user media daalo (image + video), order 01_/02_/10_ ----
    for (const rd of reqDirs) {
      const m = path.join(dataDir, rd, 'media');
      ff(['-f', 'lavfi', '-i', 'color=c=0x1E90FF:s=640x360:d=1', '-frames:v', '1', path.join(m, '02_second.jpg')]);
      ff(['-f', 'lavfi', '-i', 'color=c=0xFF8C00:s=640x360:d=1', '-frames:v', '1', path.join(m, '10_last.jpg')]);
      ff(['-f', 'lavfi', '-i', 'color=c=0x228B22:s=640x360:r=25:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(m, '01_first.mp4')]);
      fs.writeFileSync(path.join(m, 'broken.mp4'), 'not a video at all');
    }
    const scan = manual.scan(dataDir, { cfg: JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')) });
    const r0 = scan.requests[0];
    check('T-M49 user media is validated, ordered naturally (01,02,10) and the corrupt file is refused with a reason',
      r0 && r0.files.length === 3 && r0.files.map(f => f.file).join() === '01_first.mp4,02_second.jpg,10_last.jpg'
        && r0.invalid.length === 1 && /kharab|khaali|support/.test(r0.invalid[0].problem),
      `files=${r0 ? r0.files.map(f => f.file).join() : 'n/a'} invalid=${r0 ? JSON.stringify(r0.invalid) : ''}`);
    check('T-M410 with valid media in every gap the project reaches HYBRID_READY',
      scan.ready === true && scan.requests.every(r => r.status === 'READY'),
      `ready=${scan.ready} states=${scan.requests.map(r => r.status).join()}`);

    // ---- ab FINAL banni chahiye ----
    const fin = runJob([]);
    let fman = null, fjr = null;
    try { fman = JSON.parse(fs.readFileSync(path.join(jdir, 'render-manifest.json'), 'utf8')); } catch {}
    try { fjr = JSON.parse(fs.readFileSync(path.join(jdir, 'job-result.json'), 'utf8')); } catch {}
    const userShots = ((fman && fman.shots) || []).filter(s => ['USER_VIDEO', 'USER_IMAGE', 'USER_MONTAGE'].includes(s.asset));
    const badShots = ((fman && fman.shots) || []).filter(s =>
      ['GENERIC_TEXT_GRAPHIC', 'DIAGNOSTIC_CARD', 'RENDER_FAILURE_FALLBACK', 'MISSING_PLACEHOLDER'].includes(s.asset));
    check('T-M411 user media unblocks the final render and fills exactly the missing ranges',
      fin.status === 0 && fs.existsSync(path.join(jdir, 'final.mp4'))
        && userShots.length > 0 && badShots.length === 0,
      `exit=${fin.status} userShots=${userShots.length} leftoverCards=${badShots.length}`);
    check('T-M412 user media is labelled USER_APPROVED and never as researched exact footage',
      userShots.every(s => s.scope_relation === 'USER_APPROVED')
        && userShots.every(s => s.asset !== 'EXACT_VIDEO')
        && fjr && fjr.status === 'SUCCESS',
      `rel=${[...new Set(userShots.map(s => s.scope_relation))].join()} status=${fjr && fjr.status}`);

    // ---- final ki lambai voiceover se milni chahiye ----
    const fdur = dur(path.join(jdir, 'final.mp4'));
    check('T-M413 the final video length still matches the narration (manual media never shifts audio)',
      Math.abs(fdur - 18) <= 0.5, `final=${fdur.toFixed(2)}s expected~18s`);

    // ---- lagatar do shots par ek hi file nahi ----
    const seq = userShots.map(s => s.source_id || s.image || s.media_file || '');
    let adjacentDup = false;
    for (let i = 1; i < userShots.length; i++) {
      if (userShots[i].moment_id === userShots[i - 1].moment_id
        && (userShots[i].image || userShots[i].media_file) === (userShots[i - 1].image || userShots[i - 1].media_file)) adjacentDup = true;
    }
    check('T-M414 no user asset repeats on two adjacent shots while another asset is available',
      !adjacentDup, `shots=${userShots.length} dup=${adjacentDup} seq=${seq.length}`);

    // ---- upload path traversal band ----
    const inside = U.isInside(path.join(dataDir, 'x', 'media'), path.join(dataDir, 'x', 'media', 'ok.jpg'));
    const outside = U.isInside(path.join(dataDir, 'x', 'media'), path.join(dataDir, 'x', 'media', '..', '..', 'evil.jpg'));
    check('T-M415 a media path outside its own request folder is refused',
      inside === true && outside === false, `inside=${inside} outside=${outside}`);

    fs.rmSync(dataDir, { recursive: true, force: true });
  })();
})();

// ---------- T-M41: the real 897s run's failures ----------
//  M4 ke 95/0 tests ke bawajood asli project timeline par mara — kyunki har
//  hybrid fixture mein missing beats NORMAL the. Ye fixture jaan-boojh kar
//  HOOK + HARD_EVIDENCE + NORMAL, teeno rakhta hai.
(() => {
  const manual = require(path.join(ROOT, 'src', 'manual.js'));
  const gapplan = require(path.join(ROOT, 'src', 'gapplan.js'));
  const DL = require(path.join(ROOT, 'src', 'download.js'));

  const d = path.join(FX, 'm41crit');
  makeNarr(d, [
    { start: 0, end: 6, text: 'The alarm rings across the base.' },
    { start: 6, end: 12, text: 'She opens the sealed hatch slowly.' },
    { start: 12, end: 18, text: 'They meet on the rooftop at night.' },
    { start: 18, end: 24, text: 'The final shot fades to black.' },
  ]);
  writePack(d, { schema_version: 'scene-research-pack-v1', project_title: 'C41', packs: [
    { pack_id: 'C1', scope: { kind: 'SERIES', title: 'Show C', year: 2011, season: 1, episode_number: 1 },
      sources: [{ source_id: 'CS', local_file: good.video, local_subs: good.srt, inspection_status: 'VERIFIED_WATCHED' }],
      moments: [{ moment_id: 'C_M1', script_cue_exact: 'The alarm rings across the base.', criticality: 'NORMAL',
        locators: [{ source_id: 'CS', locator_type: 'EXACT_TIME', start_sec: 2, end_sec: 8, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } }] },
    // koi source nahi — aur beats CRITICAL hain. M4 yahin marta tha.
    { pack_id: 'C2', scope: { kind: 'FILM', title: 'Film With No Upload', year: 2020 }, sources: [],
      moments: [
        { moment_id: 'C_M2', script_cue_exact: 'She opens the sealed hatch slowly.', criticality: 'HARD_EVIDENCE',
          locators: [], fallback: { type: 'NEEDS_SOURCE' } },
        { moment_id: 'C_M3', script_cue_exact: 'They meet on the rooftop at night.', criticality: 'HOOK',
          locators: [], fallback: { type: 'NEEDS_SOURCE' } },
        { moment_id: 'C_M4', script_cue_exact: 'The final shot fades to black.', criticality: 'NORMAL',
          locators: [], fallback: { type: 'NEEDS_SOURCE' } }] },
  ] });
  const dataDir = path.join(ROOT, 'tests', 'tmp', 'data_c41_' + process.pid);
  fs.rmSync(dataDir, { recursive: true, force: true });
  const env = { ...process.env, RFC_DATA_DIR: dataDir, RFC_JOBS_DIR: JOBS };
  const runJob = (extra) => spawnSync('node', ['src/run.js', `--input=${d}`, '--job=reg_m41c', '--diagnostic-override', ...extra],
    { cwd: ROOT, encoding: 'utf8', timeout: 900000, env });
  const jdir = path.join(JOBS, 'reg_m41c');

  // --- (1) draft CRITICAL beats par bhi poora chalta hai ---
  const draft = runJob(['--draft', '--redo']);
  let man = null, gp = null;
  try { man = JSON.parse(fs.readFileSync(path.join(jdir, 'render-manifest.json'), 'utf8')); } catch {}
  try { gp = JSON.parse(fs.readFileSync(path.join(jdir, 'gap-plan.json'), 'utf8')); } catch {}
  const ph = ((man && man.shots) || []).filter(s => s.asset === 'MISSING_PLACEHOLDER');
  check('T-M411A draft finishes even when HOOK/HARD_EVIDENCE beats have no evidence (the real 897s bug)',
    draft.status === 0 && fs.existsSync(path.join(jdir, 'draft.mp4'))
      && ph.length > 0 && gp && gp.requests.length > 0 && Math.abs((man.total || 0) - 24) < 1.5,
    `exit=${draft.status} placeholders=${ph.length} requests=${gp ? gp.requests.length : 0} total=${man && man.total}`);

  // --- (2) har placeholder ka theek ek DATA request, aur ulta bhi ---
  const labels = new Set(ph.map(s => s.missing_label).filter(Boolean));
  const reqLabels = new Set((gp ? gp.requests : []).map(r => r.label));
  const folders = fs.existsSync(dataDir) ? fs.readdirSync(dataDir).filter(n => /^MISSING_/.test(n)) : [];
  check('T-M411B every placeholder label has exactly one DATA request and vice versa',
    labels.size > 0 && labels.size === reqLabels.size
      && [...labels].every(l => reqLabels.has(l)) && folders.length === reqLabels.size,
    `placeholderLabels=${[...labels].join()} requests=${[...reqLabels].join()} folders=${folders.length}`);

  // --- (3) critical gap: sirf file daal dene se READY nahi ---
  for (const f of folders) {
    const m = path.join(dataDir, f, 'media');
    ff(['-f', 'lavfi', '-i', 'color=c=0x1E90FF:s=640x360:d=1', '-frames:v', '1', path.join(m, '01_a.jpg')]);
    ff(['-f', 'lavfi', '-i', 'color=c=0xFF8C00:s=640x360:d=1', '-frames:v', '1', path.join(m, '02_b.jpg')]);
    ff(['-f', 'lavfi', '-i', 'color=c=0x228B22:s=640x360:r=25:d=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(m, '03_c.mp4')]);
  }
  const cfgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const approvedBefore = manual.approvedRequestIds(dataDir, cfgJson);
  const finalNoApprove = runJob([]);
  check('T-M411C copying files is not enough for a critical beat — explicit approval is required',
    approvedBefore.size === 0 && finalNoApprove.status !== 0,
    `approved=${approvedBefore.size} finalExit=${finalNoApprove.status}`);

  // --- (4) approve karne par critical gap bhar jata hai aur final ban jati hai ---
  for (const f of folders) fs.writeFileSync(path.join(dataDir, f, 'APPROVE_MEDIA.txt'), 'haan, ye media is jagah ke liye theek hai\n');
  const approvedAfter = manual.approvedRequestIds(dataDir, cfgJson);
  const fin = runJob([]);
  let fman = null; try { fman = JSON.parse(fs.readFileSync(path.join(jdir, 'render-manifest.json'), 'utf8')); } catch {}
  const shots = (fman && fman.shots) || [];
  const userShots = shots.filter(s => ['USER_VIDEO', 'USER_IMAGE', 'USER_MONTAGE'].includes(s.asset));
  const leftover = shots.filter(s => ['GENERIC_TEXT_GRAPHIC', 'DIAGNOSTIC_CARD', 'RENDER_FAILURE_FALLBACK', 'MISSING_PLACEHOLDER'].includes(s.asset));
  check('T-M411D approved user media resolves a HARD_EVIDENCE gap and the final render succeeds',
    approvedAfter.size === folders.length && fin.status === 0
      && fs.existsSync(path.join(jdir, 'final.mp4')) && userShots.length > 0 && leftover.length === 0,
    `approved=${approvedAfter.size} exit=${fin.status} userShots=${userShots.length} leftover=${leftover.length}`);

  // --- (5) manual provenance manifest mein bacha rehna chahiye ---
  check('T-M411E the manifest keeps which file, from which request, with which hash',
    userShots.every(s => s.manual === true && s.manual_request_id && s.manual_sha256 && s.manual_file)
      && userShots.every(s => s.scope_relation === 'USER_APPROVED'),
    `sample=${JSON.stringify(userShots[0] ? { r: userShots[0].manual_request_id, f: userShots[0].manual_file, h: !!userShots[0].manual_sha256 } : {})}`);

  // --- (6) draft -> final ne dobara download nahi kiya ---
  const fullLog = (fin.stdout || '') + (fin.stderr || '');
  check('T-M411F going from draft to final does not wipe the job or re-download anything',
    !/input change detected/.test(fullLog) && !/downloading\.\.\./.test(fullLog),
    `wipe=${/input change detected/.test(fullLog)} downloaded=${/downloading\.\.\./.test(fullLog)}`);

  fs.rmSync(dataDir, { recursive: true, force: true });

  // --- (7) 30s se lamba gap hamesha tut'ta hai ---
  (() => {
    const cues = [];
    for (let i = 0; i < 20; i++) cues.push({ start: i * 5, end: i * 5 + 5, text: `narration line number ${i} goes here` });
    const shots = [];
    for (let i = 0; i < 8; i++) shots.push({ i, start: i * 5, end: i * 5 + 5, asset: 'GENERIC_TEXT_GRAPHIC',
      moment_id: `G${i}`, pack_id: 'P1', cue: cues[i].text });   // 40s lagataar
    const p = gapplan.plan({ manifest: { preview_offset: 0, shots }, resolved: [], cues,
      packIndex: { P1: { scope: { kind: 'SERIES', title: 'Show S' } } },
      fingerprint: {}, projectId: 'p', cfg: {} });
    const longest = Math.max(...p.requests.map(r => r.range.duration_sec));
    const covered = p.requests.reduce((a, r) => a + r.range.duration_sec, 0);
    check('T-M411G a 40-second run of missing shots is split into requests of at most 30 seconds',
      p.requests.length >= 2 && longest <= 30.5 && Math.abs(covered - 40) < 0.5,
      `requests=${p.requests.length} longest=${longest} covered=${covered}`);
  })();

  // --- (8) fatal source pehchana jaye (do baar 165s barbaad na ho) ---
  check('T-M411H a zero-video-stream failure is recognised as fatal to the source, not a bad timestamp',
    DL.isFatalSourceError('invalid media: ffprobe: zero video streams (quarantined, retry/alternate)') === true
      && DL.isFatalSourceError('Video unavailable') === true
      && DL.isFatalSourceError('range short: got 1.20s, need 6.00s') === false,
    'fatal-classifier');
})();

// ---------- T-M42: stability — the bugs the 897s run exposed ----------
//  Real run: filling some gaps renumbered the rest, so 16 folders with the
//  user's own media were moved to _ORPHANED. And the dashboard said
//  "HYBRID READY 23/23" moments before the engine refused 16 CRITICAL slots.
(() => {
  const gapplan = require(path.join(ROOT, 'src', 'gapplan.js'));
  const manual = require(path.join(ROOT, 'src', 'manual.js'));
  const readiness = require(path.join(ROOT, 'src', 'readiness.js'));
  const cfgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

  const cues = [];
  for (let i = 0; i < 20; i++) cues.push({ start: i * 5, end: i * 5 + 5, text: `narration line number ${i} here` });
  const packIndex = { P1: { scope: { kind: 'SERIES', title: 'Show X' } } };
  const mkPlan = (badIdx, crit = {}) => {
    const shots = [];
    for (let i = 0; i < 12; i++) {
      shots.push({ i, start: i * 5, end: i * 5 + 5, moment_id: `M${i}`, pack_id: 'P1', cue: cues[i].text,
        criticality: crit[i] || 'NORMAL',
        asset: badIdx.includes(i) ? 'GENERIC_TEXT_GRAPHIC' : 'EXACT_VIDEO' });
    }
    return gapplan.plan({ manifest: { preview_offset: 0, shots }, resolved: [], cues, packIndex,
      fingerprint: { pack_sha256: 'p', srt_sha256: 's' }, projectId: 'stab', cfg: {} });
  };

  // --- (1) ek gap bharne par baaki gaps ki PEHCHAAN na badle ---
  const before = mkPlan([1, 5, 9]);
  const after = mkPlan([5, 9]);                       // pehla gap bhar gaya
  const keyOf = (p, t) => (p.requests.find(r => r.range.start_sec === t) || {}).request_key;
  check('T-M421 filling one gap does not change the identity of the others',
    before.requests.length === 3 && after.requests.length === 2
      && keyOf(before, 25) === keyOf(after, 25) && keyOf(before, 45) === keyOf(after, 45)
      && before.requests.every(r => r.request_key && /^REQ_/.test(r.request_key)),
    `before=${before.requests.map(r => r.label + ':' + r.request_key).join()} after=${after.requests.map(r => r.label + ':' + r.request_key).join()}`);

  // --- (2) renumber hone par folder RENAME ho, _ORPHANED nahi ---
  const dd = path.join(ROOT, 'tests', 'tmp', 'data_stab_' + process.pid);
  fs.rmSync(dd, { recursive: true, force: true });
  gapplan.writeDataFolders(dd, before);
  const dirBefore = fs.readdirSync(dd).filter(n => /^MISSING_/.test(n)).sort();
  // user ne teesre gap (45s) mein apni file daali
  const third = dirBefore.find(n => /__00m45s/.test(n));
  ff(['-f', 'lavfi', '-i', 'color=c=0x1E90FF:s=640x360:d=1', '-frames:v', '1', path.join(dd, third, 'media', '01_a.jpg')]);
  const w = gapplan.writeDataFolders(dd, after);     // ab pehla gap bhar gaya -> renumber
  const dirAfter = fs.readdirSync(dd).filter(n => /^MISSING_/.test(n));
  const orphanRoot = path.join(dd, '_ORPHANED');
  const stillHasMedia = dirAfter.some(n => {
    try { return fs.readdirSync(path.join(dd, n, 'media')).includes('01_a.jpg'); } catch { return false; }
  });
  // jo folder khaali tha wo ja sakta hai; jisme media tha wo KABHI nahi.
  let orphanWithMedia = 0;
  if (fs.existsSync(orphanRoot)) {
    for (const stamp of fs.readdirSync(orphanRoot)) {
      for (const n of fs.readdirSync(path.join(orphanRoot, stamp))) {
        try { if (fs.readdirSync(path.join(orphanRoot, stamp, n, 'media')).some(f => !f.startsWith('.'))) orphanWithMedia++; } catch {}
      }
    }
  }
  check('T-M422 renumbering renames the folder in place and never orphans a folder holding media',
    dirAfter.length === 2 && orphanWithMedia === 0 && stillHasMedia && w.renamed.length >= 1,
    `after=${dirAfter.join()} orphansWithMedia=${orphanWithMedia} keptMedia=${stillHasMedia} renamed=${JSON.stringify(w.renamed)}`);

  // --- (2b) jis request ko user ne bhar diya, uska folder KABHI na jaye ---
  //  Asli run ka sabse mehnga bug: media daalne se wo jagah gap nahi rehti,
  //  agla plan usse hata deta tha, folder _ORPHANED chala jata tha aur media
  //  ke saath gap wapas khul jata tha — user wahi kaam dobara karta tha.
  (() => {
    const dd2 = path.join(ROOT, 'tests', 'tmp', 'data_sat_' + process.pid);
    fs.rmSync(dd2, { recursive: true, force: true });
    const p1 = mkPlan([2, 6]);
    gapplan.writeDataFolders(dd2, p1);
    const filled = fs.readdirSync(dd2).find(n => /__00m10s/.test(n));
    ff(['-f', 'lavfi', '-i', 'color=c=0x228B22:s=640x360:d=1', '-frames:v', '1', path.join(dd2, filled, 'media', '01_x.jpg')]);
    const p2 = mkPlan([6]);                       // wo jagah ab bhar chuki hai
    const w3 = gapplan.writeDataFolders(dd2, p2);
    const stillThere = fs.existsSync(path.join(dd2, filled, 'media', '01_x.jpg'));
    const orph = fs.existsSync(path.join(dd2, '_ORPHANED')) ? fs.readdirSync(path.join(dd2, '_ORPHANED')).length : 0;
    check('T-M422b a request the user already filled keeps its folder and media forever',
      stillThere && orph === 0 && (w3.satisfied || []).length === 1,
      `mediaKept=${stillThere} orphans=${orph} satisfied=${JSON.stringify(w3.satisfied)}`);
    fs.rmSync(dd2, { recursive: true, force: true });
  })();

  // --- (3) dobara wahi plan likhne par kuch na badle (idempotent) ---
  const w2 = gapplan.writeDataFolders(dd, after);
  const orphan2 = w2.orphaned.length;
  check('T-M423 re-running the same plan creates no new folders and no new orphans',
    orphan2 === 0 && w2.renamed.length === 0
      && fs.readdirSync(dd).filter(n => /^MISSING_/.test(n)).length === 2,
    `orphans=${orphan2} renamed=${JSON.stringify(w2.renamed)}`);

  // --- (4) CRITICAL par media hone se hi READY na bane ---
  fs.rmSync(dd, { recursive: true, force: true });
  const critPlan = mkPlan([3, 7], { 3: 'HARD_EVIDENCE' });
  gapplan.writeDataFolders(dd, critPlan);
  for (const n of fs.readdirSync(dd).filter(x => /^MISSING_/.test(x))) {
    const m = path.join(dd, n, 'media');
    ff(['-f', 'lavfi', '-i', 'color=c=0x228B22:s=640x360:d=1', '-frames:v', '1', path.join(m, '01_a.jpg')]);
    ff(['-f', 'lavfi', '-i', 'color=c=0xFF8C00:s=640x360:d=1', '-frames:v', '1', path.join(m, '02_b.jpg')]);
  }
  const ev1 = readiness.evaluate(dd, manual, cfgJson);
  check('T-M424 a critical gap with media still says NEEDS_CRITICAL_APPROVAL, never ready',
    ev1.state === 'NEEDS_CRITICAL_APPROVAL' && ev1.can_export === false
      && ev1.requests.some(r => r.approval_required && r.approval_status === 'PENDING'),
    `state=${ev1.state} canExport=${ev1.can_export}`);

  // --- (5) approve karne par hi ready ---
  for (const n of fs.readdirSync(dd).filter(x => /^MISSING_/.test(x))) {
    let req = null; try { req = JSON.parse(fs.readFileSync(path.join(dd, n, 'request.json'), 'utf8')); } catch {}
    if (req && req.criticality !== 'NORMAL') fs.writeFileSync(path.join(dd, n, 'APPROVE_MEDIA.txt'), 'haan\n');
  }
  const ev2 = readiness.evaluate(dd, manual, cfgJson);
  check('T-M425 explicit approval flips the same evaluator to ready — UI and gate agree',
    ev2.state === 'READY_FOR_CONTENT_REVIEW' && ev2.can_export === true
      && readiness.approvedKeys(dd, manual, cfgJson).size >= 1,
    `state=${ev2.state} canExport=${ev2.can_export}`);

  // --- (6) NORMAL gap ko bewajah approval na maange ---
  const normalOnly = ev2.requests.filter(r => r.criticality === 'NORMAL');
  check('T-M426 a normal gap never demands critical approval',
    normalOnly.length > 0 && normalOnly.every(r => r.approval_required === false && r.approval_status === 'NOT_REQUIRED'),
    `normal=${normalOnly.length}`);
  fs.rmSync(dd, { recursive: true, force: true });

  // --- (7) draft ke baad message sirf wahi file bole jo bani hai ---
  (() => {
    const d = path.join(FX, 'm42msg');
    makeNarr(d, [{ start: 0, end: 6, text: 'The alarm rings across the base.' },
      { start: 6, end: 12, text: 'She opens the sealed hatch slowly.' }]);
    writePack(d, { schema_version: 'scene-research-pack-v1', project_title: 'G42', packs: [
      { pack_id: 'G1', scope: { kind: 'SERIES', title: 'Show G', year: 2011, season: 1, episode_number: 1 },
        sources: [{ source_id: 'GS', local_file: good.video, local_subs: good.srt, inspection_status: 'VERIFIED_WATCHED' }],
        moments: [{ moment_id: 'G_M1', script_cue_exact: 'The alarm rings across the base.', criticality: 'NORMAL',
          locators: [{ source_id: 'GS', locator_type: 'EXACT_TIME', start_sec: 2, end_sec: 8, confidence: 'HIGH' }], fallback: { type: 'NEEDS_SOURCE' } }] },
      { pack_id: 'G2', scope: { kind: 'FILM', title: 'Nothing Online', year: 2020 }, sources: [],
        moments: [{ moment_id: 'G_M2', script_cue_exact: 'She opens the sealed hatch slowly.', criticality: 'NORMAL',
          locators: [], fallback: { type: 'NEEDS_SOURCE' } }] },
    ] });
    const dataDir = path.join(ROOT, 'tests', 'tmp', 'data_msg_' + process.pid);
    fs.rmSync(dataDir, { recursive: true, force: true });
    const env = { ...process.env, RFC_DATA_DIR: dataDir, RFC_JOBS_DIR: JOBS };
    spawnSync('node', ['src/run.js', `--input=${d}`, '--job=reg_m42msg', '--redo', '--diagnostic-override', '--draft'],
      { cwd: ROOT, encoding: 'utf8', timeout: 900000, env });
    const pr = spawnSync('node', ['tools/print-job-result.js', '--expect=draft', '--job=reg_m42msg'],
      { cwd: ROOT, encoding: 'utf8', timeout: 60000, env });
    const out = (pr.stdout || '') + (pr.stderr || '');
    const jdir = path.join(JOBS, 'reg_m42msg');
    check('T-M427 after a draft the tool never points at final.mp4 or shot-review.html',
      /draft\.mp4/.test(out) && !/final\.mp4/.test(out) && !/shot-review\.html/.test(out)
        && !fs.existsSync(path.join(jdir, 'final.mp4')) && pr.status === 2,
      `exit=${pr.status} mentionsFinal=${/final\.mp4/.test(out)}`);
    fs.rmSync(dataDir, { recursive: true, force: true });
  })();
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
