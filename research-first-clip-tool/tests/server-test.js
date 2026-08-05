// ============================================================
//  M5.0-A SERVER + EDL TEST — asli http server ke against.
//  ffmpeg se ek chhoti jpg banate hain (media token resolve test ke liye),
//  ek synthetic job (timeline+manifest+gap-plan) aur ek DATA request rakhte
//  hain, phir server ke endpoints hit karke assert karte hain.
//  Isolated: RFC_INPUT_DIR / RFC_DATA_DIR / RFC_JOBS_DIR / RFC_PROJECT_DIR se
//  asli input/DATA/jobs ko kabhi haath nahi.
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tests', 'tmp', 'srv_' + process.pid);
const INPUT = path.join(TMP, 'input');
const DATA = path.join(TMP, 'DATA');
const JOBS = path.join(TMP, 'jobs');
const PROJ = path.join(TMP, 'proj');
for (const d of [INPUT, DATA, JOBS, PROJ]) fs.mkdirSync(d, { recursive: true });

// env pehle set karo — server module load par DATA capture karta hai
process.env.RFC_INPUT_DIR = INPUT;
process.env.RFC_DATA_DIR = DATA;
process.env.RFC_JOBS_DIR = JOBS;
process.env.RFC_PROJECT_DIR = PROJ;
process.env.RFC_UI_TOKEN = 'testtoken123';

const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const ff = a => execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...a], { timeout: 60000 });
const crypto = require('crypto');
const sha1 = s => crypto.createHash('sha1').update(String(s)).digest('hex');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`); };

// ---- fixture: input pack (jobId ke liye) ----
fs.writeFileSync(path.join(INPUT, 'scene-research.json'), JSON.stringify({
  schema_version: 'scene-research-pack-v1', project_title: 'SrvTest', packs: [] }, null, 2));
fs.writeFileSync(path.join(INPUT, 'voiceover.srt'), `1\n00:00:00,000 --> 00:00:05,000\nline one\n`);

// ---- fixture: a real image (auto shot ka media, token resolve test) ----
const jobDir = path.join(JOBS, 'srvtest');
fs.mkdirSync(path.join(jobDir, 'segments'), { recursive: true });
const imgPath = path.join(jobDir, 'segments', 'shot0.jpg');
ff(['-f', 'lavfi', '-i', 'color=c=0x2f9e44:s=320x180:d=1', '-frames:v', '1', imgPath]);

// ---- fixture: synthetic timeline + manifest + gap-plan ----
const total = 20;
fs.writeFileSync(path.join(jobDir, 'timeline.json'), JSON.stringify({ total, preview_offset: 0, slots: [] }));
fs.writeFileSync(path.join(jobDir, 'render-manifest.json'), JSON.stringify({
  total, mode: 'draft', is_draft: true,
  duration: { audio: total, srt_end_before_clamp: total, timeline: total, rendered: total, correction: 'NONE', difference_sec: 0 },
  preview_offset: 0, missing_placeholders: [{ tag: 'MISSING 001', i: 1 }],
  shots: [
    { i: 0, start: 0, end: 10, dur: 10, kind: 'still', asset: 'VERIFIED_SOURCE_STILL', moment_id: 'M0', criticality: 'NORMAL', image: imgPath, scope_relation: 'SAME_EPISODE', source_id: 'S1' },
    { i: 1, start: 10, end: 20, dur: 10, kind: 'graphic', asset: 'MISSING_PLACEHOLDER', moment_id: 'M1', criticality: 'HARD_EVIDENCE', missing_label: 'MISSING 001', cue: 'the missing beat' },
  ],
}, null, 2));

// ---- fixture: DATA request for the gap (so /missing shows it) ----
const reqKey = 'REQ_' + sha1('abc').slice(0, 8);
const reqDir = path.join(DATA, 'MISSING_001__00m10s-00m20s__M1');
fs.mkdirSync(path.join(reqDir, 'media'), { recursive: true });
fs.writeFileSync(path.join(reqDir, 'request.json'), JSON.stringify({
  schema: 'manual-gap-request-v2', request_key: reqKey, request_id: 'MISSING_001__' + reqKey.slice(4),
  label: 'MISSING 001', range: { start_sec: 10, end_sec: 20, duration_sec: 10 },
  moment_ids: ['M1'], criticality: 'HARD_EVIDENCE', narration_exact: 'the missing beat',
  must_show: ['the artifact'], search_queries: ['test scene'],
  input_fingerprint: { pack_sha256: 'x', srt_sha256: 'y', audio_signature: 'z' },
}, null, 2));

const app = require(path.join(ROOT, 'server', 'app.js'));
const TOKEN = app.TOKEN;

function req(method, p, { body, token = TOKEN, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const h = { ...headers };
    if (token) h['x-rfc-token'] = token;
    if (data) { h['content-type'] = 'application/json'; h['content-length'] = data.length; }
    const r = http.request({ host: '127.0.0.1', port: PORTX, path: p, method, headers: h }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); let j = null; try { j = JSON.parse(buf.toString()); } catch {}
        resolve({ status: res.statusCode, json: j, buf, ct: res.headers['content-type'] }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

function rawPost(p, buf) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORTX, path: p, method: 'POST',
      headers: { 'x-rfc-token': TOKEN, 'content-length': buf.length } }, res => {
      const c = []; res.on('data', d => c.push(d)); res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString()); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject); r.write(buf); r.end();
  });
}
const PORTX = 7911;
app.server.listen(PORTX, '127.0.0.1', async () => {
  try {
    // 1. health (no token)
    let r = await req('GET', '/api/v1/health', { token: null });
    check('T-SRV1 health responds without a token', r.status === 200 && r.json && r.json.ok, `status=${r.status}`);

    // 2. token gate
    r = await req('GET', '/api/v1/state', { token: null });
    const unauth = r.status === 401;
    r = await req('GET', '/api/v1/state', { token: 'wrong' });
    check('T-SRV2 protected routes reject a missing or wrong token (401)', unauth && r.status === 401, `no=${unauth} wrong=${r.status}`);

    // 3. state — canonical PROJECT_STATE
    r = await req('GET', '/api/v1/state');
    const st = r.json;
    check('T-SRV3 /state returns a canonical PROJECT_STATE and honest inputs',
      r.status === 200 && st.state && st.project_states && Object.keys(st.project_states).length >= 15
        && st.inputs && st.inputs.pack === true && st.job_id === 'srvtest',
      `state=${st && st.state} jobId=${st && st.job_id}`);

    // 4. missing — the gap request shows with stable key + critical
    r = await req('GET', '/api/v1/missing');
    const mr = (r.json.requests || [])[0];
    check('T-SRV4 /missing lists the gap by stable request_key, marked critical',
      r.status === 200 && mr && mr.request_key === reqKey && mr.approval_required === true && mr.media_status === 'EMPTY',
      `key=${mr && mr.request_key} crit=${mr && mr.approval_required}`);

    // 5. EDL built from the draft job, stable keys + missing marked
    r = await req('GET', '/api/v1/edl');
    const edl = r.json.edl;
    const shots = edl && edl.tracks.video_main;
    const autoShot = shots && shots[0];
    const missShot = shots && shots.find(s => s.missing);
    const noRawPath = shots && shots.every(s => !s.asset || s.asset.path === undefined);
    check('T-SRV5 /edl builds project-edl-v1 from the draft, tokens only (no raw paths)',
      r.status === 200 && edl.schema === 'project-edl-v1' && shots.length === 2
        && autoShot.asset.path_token && noRawPath && missShot && missShot.provenance.origin === 'MISSING',
      `shots=${shots && shots.length} token=${!!(autoShot && autoShot.asset.path_token)} noRaw=${noRawPath}`);

    // 6. media token resolves to the real image; a bogus token 404s
    const tok = autoShot.asset.path_token;
    r = await req('GET', `/api/v1/media/${tok}`);
    const okMedia = r.status === 200 && (r.ct || '').includes('image');
    r = await req('GET', '/api/v1/media/deadbeefdeadbeef');
    check('T-SRV6 a valid media token streams the file; an unknown token is refused',
      okMedia && r.status === 404, `ok=${okMedia} bogus=${r.status}`);

    // 7. EDL patch: transform saved, revision bumps; stale revision -> 409
    const sid = autoShot.shot_id;
    r = await req('PATCH', '/api/v1/edl', { body: { expected_revision: edl.revision, ops: [{ shot_id: sid, transform: { fit: 'blur', scale: 1.5 } }] } });
    const bumped = r.status === 200 && r.json.revision === edl.revision + 1;
    const savedFit = r.json.edl.tracks.video_main.find(s => s.shot_id === sid).transform.fit === 'blur';
    const r2 = await req('PATCH', '/api/v1/edl', { body: { expected_revision: edl.revision, ops: [{ shot_id: sid, transform: { scale: 2 } }] } });
    check('T-SRV7 EDL patch saves transform + bumps revision; a stale revision 409s',
      bumped && savedFit && r2.status === 409, `bumped=${bumped} savedFit=${savedFit} stale=${r2.status}`);

    // 8. patch survives reload (persisted to disk)
    const disk = JSON.parse(fs.readFileSync(path.join(PROJ, 'project', 'project.edl.json'), 'utf8'));
    const persisted = disk.tracks.video_main.find(s => s.shot_id === sid).transform.fit === 'blur';
    check('T-SRV8 the EDL edit is persisted to disk (survives reload)', persisted, `persisted=${persisted}`);

    // 9. upload media into the gap, then approve -> readiness flips, then bytes change -> approval expires
    const upload = (name, colour) => {
      const f = path.join(TMP, name); ff(['-f', 'lavfi', '-i', `color=c=${colour}:s=320x180:d=1`, '-frames:v', '1', f]);
      const b = fs.readFileSync(f);
      return new Promise((resolve, reject) => {
        const rq = http.request({ host: '127.0.0.1', port: PORTX, method: 'POST',
          path: `/api/v1/requests/${encodeURIComponent(reqKey)}/media?name=${encodeURIComponent(name)}`,
          headers: { 'x-rfc-token': TOKEN, 'content-length': b.length } }, res => { res.on('data', () => {}); res.on('end', resolve); });
        rq.on('error', reject); rq.write(b); rq.end();
      });
    };
    // 10s range -> do file chahiye taaki poori bhar jaye (VALID)
    await upload('01_a.jpg', '0x1E90FF');
    await upload('02_b.jpg', '0x228B22');
    await req('POST', `/api/v1/requests/${encodeURIComponent(reqKey)}/approve`);
    r = await req('GET', '/api/v1/missing');
    const afterApprove = (r.json.requests || [])[0];
    // ab 01_a.jpg ke bytes badlo (usi naam se) -> approval EXPIRE
    await upload('01_a.jpg', '0xC81E1E');
    r = await req('GET', '/api/v1/missing');
    const afterChange = (r.json.requests || [])[0];
    check('T-SRV9 upload+approve makes it APPROVED; changing the bytes expires the approval',
      afterApprove && afterApprove.approval_status === 'APPROVED'
        && afterChange && afterChange.approval_status === 'EXPIRED',
      `approved=${afterApprove && afterApprove.approval_status} afterChange=${afterChange && afterChange.approval_status}`);

    // 10. UI shell + app.js served, token injected
    r = await req('GET', '/', { token: null });
    const htmlOk = r.status === 200 && r.buf.toString().includes(TOKEN) && !r.buf.toString().includes('%%SESSION_TOKEN%%');
    const rjs = await req('GET', '/app.js', { token: null });
    check('T-SRV10 the UI shell is served with the token injected and app.js loads',
      htmlOk && rjs.status === 200, `html=${htmlOk} appjs=${rjs.status}`);

    // ---- M5.0-A.2: in-UI inputs ----
    // 11. import audio (mp3/m4a/wav auto-detect) + inputs summary shows duration
    const aud = path.join(TMP, 'vo.m4a'); ff(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=12', '-c:a', 'aac', aud]);
    const audBuf = fs.readFileSync(aud);
    let rr = await rawPost(`/api/v1/import?kind=audio&name=vo.m4a`, audBuf);
    const impOk = rr.status === 200 && rr.json.ok && rr.json.duration > 11;
    rr = await rawPost(`/api/v1/import?kind=audio&name=bad.txt`, Buffer.from('x'));
    check('T-SRV11 audio import accepts m4a and reports duration; a non-audio ext is refused',
      impOk && rr.status === 400, `audio=${impOk} badExt=${rr.status}`);

    // 12. import pack (valid) + reject invalid json
    const pack = { schema_version: 'scene-research-pack-v1', project_title: 'ImpTest', packs: [] };
    rr = await rawPost('/api/v1/import?kind=pack&name=p.json', Buffer.from(JSON.stringify(pack)));
    const packOk = rr.status === 200 && rr.json.ok;
    rr = await rawPost('/api/v1/import?kind=pack&name=p.json', Buffer.from('{not json'));
    check('T-SRV12 pack import saves valid JSON and refuses broken JSON',
      packOk && rr.status === 400 && rr.json.code === 'BAD_JSON', `pack=${packOk} broken=${rr.json && rr.json.code}`);

    // 13. script import + make-srt (script + audio -> estimated srt) + inputs summary
    await rawPost('/api/v1/import?kind=script&name=script.txt',
      Buffer.from('The hero enters the arena. Then the lost city appears. Everyone gasps in wonder.'));
    rr = await req('POST', '/api/v1/make-srt', { body: {} });
    const srtOk = rr.status === 200 && rr.json.ok && rr.json.cues === 3 && Math.abs(rr.json.total - 12) < 0.5;
    r = await req('GET', '/api/v1/inputs');
    const sum = r.json.inputs;
    check('T-SRV13 make-srt builds an estimated SRT from script+audio; inputs summary reflects it',
      srtOk && sum.srt && sum.srt.cues === 3 && sum.script === true && sum.audio.duration > 11,
      `srt=${JSON.stringify(rr.json)} summaryCues=${sum.srt && sum.srt.cues}`);

    // 14. fresh start archives everything (no delete), inputs cleared
    r = await req('POST', '/api/v1/new-project', { body: {} });
    const archived = r.status === 200 && r.json.ok && r.json.moved > 0;
    r = await req('GET', '/api/v1/inputs');
    const cleared = !r.json.inputs.audio && !r.json.inputs.srt;
    const archiveExists = fs.existsSync(path.join(PROJ, 'archive'));
    check('T-SRV14 fresh start archives inputs (moves, never deletes) and clears the project',
      archived && cleared && archiveExists, `archived=${archived} clearedAudio=${cleared} archiveDir=${archiveExists}`);

    // 15. genspark prompt is served
    r = await req('GET', '/api/v1/genspark-prompt');
    check('T-SRV15 the Genspark research-pack prompt is served to the UI',
      r.status === 200 && r.json.ok && typeof r.json.text === 'string' && r.json.text.length > 200,
      `len=${r.json && r.json.text && r.json.text.length}`);

  } catch (e) {
    check('server-test crashed', false, String(e && e.stack || e).slice(0, 300));
  } finally {
    app.server.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    const pass = results.filter(r => r.ok).length, fail = results.length - pass;
    console.log('\n' + '='.repeat(64));
    console.log(`  SERVER TEST SUMMARY: ${pass} PASS, ${fail} FAIL`);
    if (fail) results.filter(r => !r.ok).forEach(r => console.log('   - ' + r.name + ' :: ' + r.detail));
    console.log('='.repeat(64));
    process.exit(fail ? 1 : 0);
  }
});
