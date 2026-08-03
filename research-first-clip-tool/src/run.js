#!/usr/bin/env node
// ============================================================
//  run.js — ORCHESTRATOR (M2)
//   node src/run.js                    poori pipeline (input/ se)
//   node src/run.js --only=check       sirf setup check
//   node src/run.js --only=align,locate
//   node src/run.js --from=5           stage 5 se aage (resume)
//   node src/run.js --redo             sab dobara (sirf generated files clear)
//   node src/run.js --input=<dir> --job=<safe-id>
//
//  Resume: har stage state.json mein checkpoint; intermediate data disk par
//  (aligned/resolved/timeline json) taaki alag process mein bhi resume ho.
//  Inputs (pack/SRT/audio/config) change hon to fingerprint mismatch par
//  affected+downstream stages invalidate.
// ============================================================
const fs = require('fs');
const path = require('path');
const U = require('./util.js');
const ST = require('./state.js');

const check = require('./check.js');
const validate = require('./validate.js');
const align = require('./align.js');
const locate = require('./locate.js');
const download = require('./download.js');
const cut = require('./cut.js');
const localqa = require('./localqa.js');
const timeline = require('./timeline.js');
const render = require('./render.js');
const report = require('./report.js');
const shotReview = require('./shotreview.js');
const SUB = require('./subtitles.js');
const jobResult = require('./jobresult.js');

// ---------- console tee -> run.log ----------
const logLines = [];
const origLog = console.log.bind(console);
console.log = (...a) => { logLines.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); origLog(...a); };
function flushLog(id) { try { if (id) fs.writeFileSync(U.p(id, 'run.log'), logLines.join('\n')); } catch {} }

const arg = (name, def = null) => {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=').replace(/^["']|["']$/g, '') : def;
};
const flag = name => process.argv.includes(`--${name}`);

const STAGES = ['align', 'locate', 'download', 'cut', 'qa', 'timeline', 'render', 'report'];
const STAGE_N = { align: 2, locate: 3, download: 4, cut: 5, qa: 6, timeline: 7, render: 8, report: 9 };
const DOWNSTREAM = STAGES;   // order = downstream order

function loadSpec() {
  const inputDir = path.resolve(arg('input', path.join(U.ROOT, 'input')));
  const pick = names => { for (const nm of names) { const f = path.join(inputDir, nm); if (fs.existsSync(f)) return f; } return null; };
  const packFile = pick(['scene-research.json', 'research-pack.json', 'pack.json']);
  const srt = pick(['voiceover.srt', 'narration.srt']);
  const audio = pick(['voiceover.mp3', 'voiceover.m4a', 'voiceover.wav']);
  const script = pick(['script.txt']);
  if (!packFile) throw new Error(`scene-research.json nahi mila (${inputDir})`);
  if (!srt) throw new Error(`voiceover.srt nahi mila (${inputDir})`);

  const v = validate.validateFile(packFile);
  U.step('1. research pack validation');
  (v.warnings || []).forEach(w => U.warn(w));
  if (!v.ok) { (v.errors || []).forEach(e => U.bad(e)); throw new Error(`research pack invalid (${v.errors.length} errors)`); }
  U.ok(`pack valid — ${v.stats.packs} packs, ${v.stats.moments} moments, ${v.stats.exactOrDialoguePct}% EXACT/DIALOGUE`);

  // coverage readiness (configurable)
  const cfg = U.config();
  if (cfg.validation && cfg.validation.requireEntireScriptCoverage && v.pack.coverage_check && v.pack.coverage_check.entire_script_covered === false) {
    const uncov = (v.pack.coverage_check.uncovered_script_cues || []).length;
    U.warn(`coverage_check.entire_script_covered=false (${uncov} uncovered cues) — un beats par NEEDS_SOURCE aayega`);
  }

  // job id — sanitize (path traversal safe)
  let id = arg('job', U.slug(v.pack.project_title || path.basename(inputDir)));
  U.assertSafeId(id, 'job id');
  return { id, inputDir, packFile, srt, audio, script, pack: v.pack, validation: v };
}

function audioSig(f) { try { const s = fs.statSync(f); return `${s.size}:${Math.round(s.mtimeMs)}`; } catch { return 'na'; } }
function fingerprint(spec, cfg, chk) {
  const toolSig = (chk.results || []).map(r => `${r.bin}=${r.version || (r.ok ? 'ok' : 'no')}`).join(',');
  return {
    pack: U.hashFile(spec.packFile),
    srt: U.hashFile(spec.srt),
    audio: spec.audio ? audioSig(spec.audio) : 'none',
    config: U.hashStr(JSON.stringify(cfg)),
    tool: U.hashStr(toolSig + '|node=' + process.version),
  };
}

async function main() {
  U.log('='.repeat(60)); U.log('  RESEARCH-FIRST CLIP TOOL — M3.6.1'); U.log('='.repeat(60));

  const cfg = U.config();
  // --review: diagnostic mode. Production gates (criticality, render-failure
  // abort) yahan warning ban jaate hain, taaki toota hua pack bhi INSPECT kiya
  // ja sake. Final export ke liye ye kabhi use mat karo.
  if (flag('review')) { cfg.output = { ...(cfg.output || {}), mode: 'review' }; U.warn('--review: production gates OFF (sirf inspection ke liye)'); }
  const only = arg('only');

  if (only === 'check') { const r = check(); process.exit(r.ok ? 0 : 1); }

  const chk = check();

  const spec = loadSpec();

  // --- preflight: URL project ke liye yt-dlp/runtime zaroori (misleading DONE se bachne ko) ---
  const hasUrlSource = spec.pack.packs.some(pk => (pk.sources || []).some(s => s.url && !s.local_file));
  if (hasUrlSource) {
    const ytOk = chk.results.find(r => r.key === 'ytdlp' && r.ok);
    const jsOk = chk.results.find(r => r.key === 'jsruntime' && r.ok);
    if (!ytOk) { U.bad('URL sources hain par yt-dlp nahi mila — preflight STOP (misleading DONE se bachne ko).'); flushLog(spec.id); process.exit(2); }
    if (!jsOk) { U.bad('URL sources hain par koi usable JS runtime nahi (Deno 2.3+ ya Node 22+) — preflight STOP (yt-dlp YouTube EJS chahiye).'); flushLog(spec.id); process.exit(2); }
  }

  // --- redo: containment-safe cleanup ---
  if (flag('redo')) cleanJob(spec.id, spec.inputDir);
  // Job dir GATE SE PEHLE banti hai. M3.6 mein gate job dir banne se pehle exit
  // kar jata tha, isliye "har fail par repair package milega" ka wada gate wale
  // fail par toot jata tha — user ke paas na video thi, na koi file bata rahi
  // thi ki kya karna hai.
  U.ensureDir(U.jobDir(spec.id));
  U.assertInside(U.jobsRoot(), U.jobDir(spec.id), 'job dir');

  // --- PRODUCTION GATE ---
  //  Do alag darwaze, kyunki do alag cheezein hain:
  //   PREVIEW (5/6/7): sirf TAAZA check chahiye. Pack weak ho to bhi preview
  //     chalega — usi ko dekh kar to pata chalega ki engine kya kar raha hai.
  //     Aisa preview saaf-saaf DIAGNOSTIC likha jata hai.
  //   POORA EXPORT (8): taaza check + pack sach mein PASS + har moment par
  //     criticality + koi critical beat khaali nahi. Weak evidence par 45 minute
  //     ka final render banana bekaar hai.
  const isPreviewRun = arg('preview-start') != null || arg('preview-duration') != null || arg('preview-moments');
  const wantsRender = !only || /render|report/.test(only) || arg('from') != null || isPreviewRun;
  const isFullExport = wantsRender && !isPreviewRun;
  const blockAndExit = (reason, message, steps) => {
    U.bad(`PRODUCTION GATE: ${message}`);
    U.log('');
    steps.forEach(s => U.log('   ' + s));
    U.log('');
    try {
      const r = jobResult(spec, { meta: {} }, { status: 'BLOCKED', stage: 'gate', message, nextSteps: steps, blockedReason: reason });
      U.log(`   Poori detail: jobs/${spec.id}/blocked-report.html  (aur job-result.json)`);
      if (r && r.repair && r.repair.length) U.log(`   ${r.repair.length} moments ki list: jobs/${spec.id}/NEEDS_SOURCE.csv`);
    } catch (e) { U.warn('blocked-report nahi ban paya: ' + e.message.slice(0, 70)); }
    flushLog(spec.id);
    process.exit(3);
  };
  if (wantsRender && !flag('diagnostic-override') && (cfg.output && cfg.output.mode) !== 'review') {
    const repFile = path.join(U.ROOT, 'output', 'pack-report.json');
    let rep = null; try { rep = JSON.parse(fs.readFileSync(repFile, 'utf8')); } catch {}
    const packHash = U.hashFile(spec.packFile), srtHash = U.hashFile(spec.srt);
    const stale = !rep || rep.pack_sha256 !== packHash || rep.srt_sha256 !== srtHash;
    if (stale) {
      blockAndExit('STALE_PACK_REPORT', 'is pack/SRT ka taaza check nahi hai.', [
        'Kyun: pack ya voiceover badla hai (ya check chalaya hi nahi gaya). Bina check ke',
        'render chalane ka matlab hai 45 minute baad pata chalna ki kaunse moments toote the.',
        '',
        'Chalao:  START_HERE.bat -> option 2   (ya)',
        '         node tools/check-pack.js input/scene-research.json input/voiceover.srt --apply-probe',
        '',
        'Sirf dekhne ke liye (export nahi): isi command ke aage --diagnostic-override lagao.',
      ]);
    }
    if (rep.pass === false) {
      if (isFullExport) {
        blockAndExit('PACK_NOT_PRODUCTION_READY', `pack check mein ${(rep.failed_checks || []).length} cheezein fail hain — poora export nahi hoga.`, [
          ...(rep.failed_checks || []).slice(0, 8).map(f => `- ${f.check} (${f.detail})`),
          '',
          'Preview (option 5/6/7) ab bhi chal sakte hain — wo DIAGNOSTIC hain, final nahi.',
          'Theek karne ke liye: REPAIR.bat chalao (standalone prompts + local cue fix).',
        ]);
      }
      U.warn(`DIAGNOSTIC PREVIEW — pack check fail hai (${(rep.failed_checks || []).length} checks). Ye engine dekhne ke liye hai, final output nahi:`);
      (rep.failed_checks || []).slice(0, 6).forEach(f => U.log(`     - ${f.check} (${f.detail})`));
      spec.isDiagnostic = true;
    }
    if (isFullExport && rep.missing_criticality) {
      blockAndExit('CRITICALITY_MISSING', `${rep.missing_criticality} moments par criticality nahi hai — HOOK/HARD_EVIDENCE ka koi bachav nahi lagega.`, [
        'Criticality bataati hai ki kaunsa beat bina asli footage ke chhap hi nahi sakta.',
        'Ye na ho to engine sab kuch NORMAL maan leta hai aur udhaar footage chup-chaap chalta hai.',
        '',
        'Chalao:  REPAIR.bat -> "criticality migrate karo"  (ya)',
        '         node tools/migrate-pack.js input/scene-research.json --apply',
      ]);
    }
  }

  let st = flag('redo') ? { done: {}, meta: {} } : ST.load(spec.id);

  // --- fingerprint: input/config/tool change -> generated ARTIFACTS + state dono
  //     invalidate (sirf state.done nahi — warna stale clip/final reuse ho jata tha)
  //     aur full rerun force (invalidated prerequisite ke upar --from/--only na chale)
  const fp = fingerprint(spec, cfg, chk);
  let invalidated = false;
  if (!flag('redo') && st.fingerprint) {
    const changed = Object.keys(fp).filter(k => st.fingerprint[k] !== fp[k]);
    if (changed.length) {
      U.warn(`input change detected (${changed.join(', ')}) — generated artifacts wipe + full rerun (stale media reuse nahi)`);
      cleanJob(spec.id, spec.inputDir);   // clips/segments/cache/final/json sab wipe (inputs safe)
      U.ensureDir(U.jobDir(spec.id));
      st = { done: {}, meta: {} };
      invalidated = true;
    }
  }
  st.fingerprint = fp;
  ST.save(spec.id, st);

  U.log(`\n  job: ${spec.id}  ->  ${path.relative(U.ROOT, U.jobDir(spec.id))}/`);

  const from = Number(arg('from', 0));
  let toRun = STAGES.slice();
  if (invalidated) {
    if (only || from) U.warn('input change ke baad --from/--only override — full rerun (stale prerequisite se bachne ko)');
  } else if (only) toRun = only.split(',').map(s => s.trim()).filter(k => STAGES.includes(k));
  else if (from) toRun = STAGES.filter(k => STAGE_N[k] >= from);

  const pending = k => flag('redo') || !ST.isDone(st, k);
  const jf = f => { const pp = U.p(spec.id, f); return fs.existsSync(pp) ? JSON.parse(fs.readFileSync(pp, 'utf8')) : null; };
  let aligned = null, resolved = null, tl = null;

  const runStage = async (key, fn) => {
    U.step(`${STAGE_N[key]}. ${key}`);
    const t0 = Date.now();
    await fn();
    ST.markDone(st, key, { seconds: Math.round((Date.now() - t0) / 1000) });
    ST.save(spec.id, st);
    flushLog(spec.id);
  };

  for (const key of toRun) {
    if (!pending(key)) { U.log(`\n  -- ${STAGE_N[key]}. ${key} (pehle ho chuka, skip)`); continue; }
    try {
      if (key === 'align') await runStage(key, () => {
        aligned = align(spec, cfg, st);
        // ---- PREVIEW FILTER: acquisition/download/keyframes/render SE PEHLE ----
        // (poora 14-min job process karke baad mein trim NAHI karte)
        const pStart = arg('preview-start'), pDur = arg('preview-duration'), pMoments = arg('preview-moments');
        if (pStart != null || pDur != null || pMoments) {
          const before = aligned.moments.length;
          if (pMoments) {
            const want = new Set(pMoments.split(',').map(x => x.trim()).filter(Boolean));
            aligned.moments = aligned.moments.filter(m => want.has(m.moment_id));
          } else {
            const a = Number(pStart || 0), b = a + Number(pDur || 120);
            aligned.moments = aligned.moments.filter(m => m.beat_end > a && m.beat_start < b);
          }
          // preview timeline ko 0 se shuru karo (audio bhi wahin se cut hoga)
          const t0 = aligned.moments.length ? Math.min(...aligned.moments.map(m => m.beat_start)) : 0;
          const t1 = aligned.moments.length ? Math.max(...aligned.moments.map(m => m.beat_end)) : 0;
          for (const m of aligned.moments) { m.beat_start = +(m.beat_start - t0).toFixed(3); m.beat_end = +(m.beat_end - t0).toFixed(3); }
          aligned.total = +(t1 - t0).toFixed(3);
          spec.previewOffset = t0;
          spec.isPreview = true;
          // ---- SRT bhi USI offset se rebase ----
          // Moments to 0 se shuru ho gaye, par timeline.js shot boundaries ke
          // liye ASLI SRT padhta raha — yaani 300s se shuru hone wala preview
          // apne cuts SRT ki shuruat ke hisaab se lagata tha. Ab preview ke liye
          // ek rebased SRT likhte hain aur wahi aage jata hai.
          try {
            const cues = SUB.parseFile(spec.srt)
              .map(c => ({ start: +(c.start - t0).toFixed(3), end: +(c.end - t0).toFixed(3), text: c.text }))
              .filter(c => c.end > 0 && c.start < aligned.total)
              .map(c => ({ start: Math.max(0, c.start), end: Math.min(aligned.total, c.end), text: c.text }));
            const ts = s => { const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = Math.floor(s % 60), ms = Math.round((s % 1) * 1000);
              return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')},${String(ms).padStart(3, '0')}`; };
            const pf = U.p(spec.id, 'preview.srt');
            fs.writeFileSync(pf, cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join('\n'));
            spec.srt = pf;
            U.log(`   preview SRT rebased: ${cues.length} cues, offset -${t0.toFixed(1)}s`);
          } catch (e) { U.warn('preview SRT rebase fail: ' + e.message.slice(0, 80)); }
          U.warn(`PREVIEW MODE: ${aligned.moments.length}/${before} moments (${aligned.total.toFixed(1)}s). Sirf inke sources download honge.`);
          fs.writeFileSync(U.p(spec.id, 'aligned.json'), JSON.stringify(aligned, null, 2));
        }
      });
      else if (key === 'locate') await runStage(key, () => { aligned = aligned || jf('aligned.json'); resolved = locate(spec, cfg, st, aligned); });
      else if (key === 'download') await runStage(key, () => { resolved = resolved || jf('resolved.json'); resolved = download(spec, cfg, st, resolved); saveResolved(spec.id, resolved); });
      else if (key === 'cut') await runStage(key, () => { resolved = resolved || jf('resolved.json'); resolved = cut(spec, cfg, st, resolved); saveResolved(spec.id, resolved); });
      else if (key === 'qa') await runStage(key, () => { resolved = resolved || jf('resolved.json'); resolved = localqa(spec, cfg, st, resolved); saveResolved(spec.id, resolved); });
      else if (key === 'timeline') await runStage(key, () => { resolved = resolved || jf('resolved.json'); aligned = aligned || jf('aligned.json'); tl = timeline(spec, cfg, st, resolved, aligned && aligned.total); });
      else if (key === 'render') await runStage(key, () => { tl = tl || jf('timeline.json'); render(spec, cfg, st, tl); });
      else if (key === 'report') await runStage(key, () => {
        resolved = resolved || jf('resolved.json'); tl = tl || jf('timeline.json');
        report(spec, cfg, st, resolved, tl);
        // shot-level contact sheet: percentages ke bharose mat raho, har shot dekho
        try { shotReview(spec, cfg, st); } catch (e) { U.warn('shot-review fail: ' + e.message.slice(0, 90)); }
      });
    } catch (e) {
      U.bad(`stage ${key} fail: ${e.message}`);
      // FAIL PAR BHI REPAIR FILES: pehle render fail hone par NEEDS_SOURCE.csv
      // banti hi nahi thi (report stage render ke baad hai), aur error usi file
      // ko dekhne bolta tha. Ab har fail ke saath repair package banta hai.
      try {
        resolved = resolved || jf('resolved.json');
        tl = tl || jf('timeline.json');
        const r = jobResult(spec, st, { status: 'FAILED', stage: key, message: e.message, resolved, tl });
        U.log('');
        U.log(`  ${r.repair.length} moments ko kaam chahiye — poori list yahan hai:`);
        U.log(`     jobs/${spec.id}/NEEDS_SOURCE.csv        (spreadsheet mein khol lo)`);
        U.log(`     jobs/${spec.id}/blocked-report.html     (padhne layak, repair list ke saath)`);
        U.log(`     jobs/${spec.id}/job-result.json         (machine-readable)`);
        if (r.critical_unresolved.length) U.bad(`   inme ${r.critical_unresolved.length} CRITICAL beats hain: ${r.critical_unresolved.slice(0, 6).join(', ')}`);
      } catch (e2) { U.warn('repair package bhi nahi ban paya: ' + e2.message.slice(0, 80)); }
      ST.save(spec.id, st); flushLog(spec.id);
      U.log(`\n  jab moments theek ho jayein: node src/run.js --from=${STAGE_N[key]} --job=${spec.id}`);
      flushLog(spec.id);
      process.exit(1);
    }
  }

  // SUCCESS bhi tabhi jab final.mp4 SACH mein bani ho
  try {
    resolved = resolved || jf('resolved.json'); tl = tl || jf('timeline.json');
    const okFinal = fs.existsSync(U.p(spec.id, 'final.mp4')) && U.probe(U.p(spec.id, 'final.mp4')).ok;
    jobResult(spec, st, { status: okFinal ? 'SUCCESS' : 'FAILED', stage: okFinal ? null : 'render',
      message: okFinal ? 'final.mp4 ban gayi aur probe pass hui.' : 'saare stages chal gaye par final.mp4 valid nahi hai.',
      resolved, tl });
    if (!okFinal) { U.bad('final.mp4 valid nahi hai — job FAILED mana ja raha hai.'); flushLog(spec.id); process.exit(1); }
  } catch (e) { U.warn('job-result likhne mein dikkat: ' + e.message.slice(0, 80)); }

  U.log('\n' + '='.repeat(60));
  U.log(`  DONE — ${path.relative(U.ROOT, U.jobDir(spec.id))}/`);
  U.log('   final.mp4, shot-review.html (har shot ka frame), quality-report.html, NEEDS_SOURCE.csv, timeline.json, run.log, clips/');
  U.log('='.repeat(60));
  flushLog(spec.id);
}

function saveResolved(id, resolved) {
  // internal (underscore) fields hata kar likho. raw_file/raw_offset NON-underscore
  // hain -> persist honge (resume ke liye zaroori).
  const clean = resolved.map(e => { const o = {}; for (const k in e) if (!k.startsWith('_')) o[k] = e[k]; return o; });
  fs.writeFileSync(U.p(id, 'resolved.json'), JSON.stringify(clean, null, 2));
}

// --redo: sirf GENERATED artifacts delete. Containment-safe: ROOT/jobs/<safe-id>
// ke bahar kuch nahi. Inputs (input/ dir) ko kabhi haath nahi.
function cleanJob(id, inputDir) {
  U.assertSafeId(id, 'job id');
  const dir = U.jobDir(id);
  U.assertInside(U.jobsRoot(), dir, 'job dir');
  if (path.resolve(dir) === path.resolve(inputDir || '')) { U.warn('--redo skip: job dir == input dir (inputs safe)'); return; }
  // render-manifest.json bhi hatana ZAROORI hai: report isi se banti hai, aur
  // purana manifest reh gaya to naye render ke baad bhi PURANE percentages
  // dikhte rehte hain.
  const items = ['clips', 'segments', 'cache', 'thumbs', 'resolved.json', 'aligned.json', 'timeline.json',
    'render-manifest.json', 'shot-review.html', 'state.json', 'final.mp4', 'video_master.mp4',
    'quality-report.html', 'NEEDS_SOURCE.csv', 'run.log'];
  for (const it of items) { const pp = path.join(dir, it); if (fs.existsSync(pp) && U.isInside(dir, pp)) fs.rmSync(pp, { recursive: true, force: true }); }
}

main().catch(e => { U.bad('fatal: ' + e.message); try { flushLog(U.slug(arg('job') || '')); } catch {} process.exit(1); });
