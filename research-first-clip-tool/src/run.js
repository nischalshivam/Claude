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
const gapplan = require('./gapplan.js');
const manual = require('./manual.js');
const effectivegate = require('./effectivegate.js');

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
  // M4.1: `output.mode` (draft/production/review) config hash se BAHAR hai.
  // Warna draft chalane par mode badal jata tha, fingerprint badal jata tha,
  // aur poora job wipe hokar saare downloads dobara hote the. Draft se final
  // jaana ek switch hai, naya project nahi.
  const cfgForHash = { ...cfg, output: { ...(cfg.output || {}) } };
  delete cfgForHash.output.mode;
  return {
    pack: U.hashFile(spec.packFile),
    srt: U.hashFile(spec.srt),
    audio: spec.audio ? audioSig(spec.audio) : 'none',
    config: U.hashStr(JSON.stringify(cfgForHash)),
    tool: U.hashStr(toolSig + '|node=' + process.version),
  };
}

async function main() {
  U.log('='.repeat(60)); U.log('  RESEARCH-FIRST CLIP TOOL — M4.1'); U.log('='.repeat(60));

  const cfg = U.config();
  // --review: diagnostic mode. Production gates (criticality, render-failure
  // abort) yahan warning ban jaate hain, taaki toota hua pack bhi INSPECT kiya
  // ja sake. Final export ke liye ye kabhi use mat karo.
  if (flag('review')) { cfg.output = { ...(cfg.output || {}), mode: 'review' }; U.warn('--review: production gates OFF (sirf inspection ke liye)'); }
  const only = arg('only');
  // DRAFT mode (M4): poori timeline banti hai, jahan media nahi wahan numbered
  // "MISSING NNN" placeholder. Output ka naam draft.mp4 — final.mp4 kabhi nahi.
  const isDraft = flag('draft');
  if (isDraft && !flag('review')) { cfg.output = { ...(cfg.output || {}), mode: 'draft' }; }

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
  const isFullExport = wantsRender && !isPreviewRun && !isDraft;
  // PREVIEW = DIAGNOSTIC = DRAFT. Asli run mein mid/weak preview download, cut
  // aur QA sab paar kar gaye aur phir ek missing graphic par ruk gaye — yaani
  // jise dekhne ke liye preview chalaya tha wahi kabhi bani hi nahi. Preview ka
  // kaam kami DIKHANA hai; ab wo placeholder lagakar aage badhta hai.
  if (isPreviewRun && (cfg.output && cfg.output.mode) !== 'review') {
    cfg.output = { ...(cfg.output || {}), mode: 'draft' };
  }
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
  // ---- EFFECTIVE GATE, part 1 (M4): media hai ya nahi ----
  //  Ye pack ki QUALITY ka sawaal nahi hai, isliye ye --diagnostic-override se
  //  bhi nahi hatta. Baat sirf itni hai: final video ke har slot par sach mein
  //  koi media file honi chahiye. Agar user ne khaali jagahon ke liye media
  //  daalne ka kaam shuru kiya hai par poora nahi kiya, to final ab render ke
  //  beech mein crash hone ke bajaye YAHIN saaf-saaf rukta hai.
  const hybridPre = hybridState(spec, cfg);
  if (isFullExport && hybridPre.total && hybridPre.state === 'NEEDS_HUMAN_MEDIA') {
    blockAndExit('NEEDS_HUMAN_MEDIA', `${hybridPre.total - hybridPre.ready} jagah abhi aapke media ka intezaar hai.`, [
      ...hybridPre.pending.slice(0, 8).map(p => `- DATA\\${p.folder}  (${p.status === 'WAITING_FOR_MEDIA' ? 'abhi koi file nahi' : 'aur media chahiye'})`),
      '',
      'Har folder mein WHAT_IS_MISSING.txt hai — usme narration aur search words likhe hain.',
      'Media daal kar yahi option dobara chalao. Purane downloads dobara nahi honge.',
      '',
      'Dashboard se karna ho to: START_UI.bat  (ya START_HERE.bat -> M)',
    ]);
  }

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
    // ---- EFFECTIVE GATE (M4): HYBRID_READY ----
    //  Raw research pack ka fail hona aur FINAL VIDEO ka adhoora hona do alag
    //  baatein hain. Agar user ne har khaali jagah ke liye apna media de diya
    //  hai, to "P03 ka source mar chuka hai" ab final video ko rokne ki wajah
    //  nahi rahi — wo jagah bhar chuki hai.
    //  Sharat: gap plan INHI inputs ka ho, aur har blocking request READY ho.
    const hybrid = hybridPre;
    if (isFullExport && hybrid.state === 'HYBRID_READY') {
      U.ok(`HYBRID READY — ${hybrid.ready}/${hybrid.total} khaali jagah aapke apne media se bhari hui hain.`);
      U.log('   (Raw research pack ke fail checks waise ke waise hain — wo alag se report hote hain.');
      U.log('    Ye video is liye ban rahi hai ki har slot par sach mein media maujood hai.)');
      spec.isHybrid = true;
    } else if (rep.pass === false) {
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

  // ---- MANUAL / MODE INVALIDATION (M4.1) ----
  //  Downloads aur cuts ghanton ka kaam hain — unhe chhedna nahi. Par jab
  //  aapka apna media badalta hai (nayi file, order, trim, approval), ya draft
  //  se final par jaate ho, to timeline/render/report DOBARA banne chahiye.
  //  Warna wahi purani timeline reuse ho jati hai aur aapka daala hua media
  //  kabhi lagta hi nahi — asli test mein yahi hua tha.
  const renderSig = U.hashStr([manual.fingerprint(DATA_ROOT), (cfg.output && cfg.output.mode) || 'production'].join('|'));
  if (!flag('redo') && st.render_sig && st.render_sig !== renderSig) {
    U.log('   aapka media ya mode badla hai — timeline/render dobara banega (downloads waise ke waise rahenge)');
    for (const k of ['timeline', 'render', 'report']) delete (st.done || {})[k];
    for (const f of ['timeline.json', 'render-manifest.json', 'gap-plan.json', 'final.mp4', 'draft.mp4', 'video_master.mp4', 'shot-review.html']) {
      const pp = U.p(spec.id, f); try { if (fs.existsSync(pp)) fs.rmSync(pp, { force: true }); } catch {}
    }
    const segs = U.p(spec.id, 'segments'); try { if (fs.existsSync(segs)) fs.rmSync(segs, { recursive: true, force: true }); } catch {}
  }
  st.render_sig = renderSig;
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
            spec.origSrt = spec.origSrt || spec.srt;   // gap plan ko POORE audio ka waqt chahiye
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
      else if (key === 'timeline') await runStage(key, () => {
        resolved = resolved || jf('resolved.json'); aligned = aligned || jf('aligned.json');
        // 1. CANDIDATE timeline — ab ye critical beats par throw nahi karti
        tl = timeline(spec, cfg, st, resolved, aligned && aligned.total);
        tl.preview_offset = spec.previewOffset || 0;

        // 2. USER KA APNA MEDIA — gate se PEHLE.
        //    M4 mein ye gate ke BAAD lagta tha, isliye critical beat ke liye user
        //    file de bhi de to wo kabhi lagti hi nahi thi. Asli run yahin mara.
        const applied = manual.applyToTimeline(tl, DATA_ROOT, cfg);
        if (applied.applied) {
          tl = applied.tl;
          U.ok(`aapka apna media ${applied.applied} jagah laga diya (${applied.requests.join(', ')})`);
        }

        // 3. EK EFFECTIVE GATE — final slots par ek hi faisla
        const mode = (cfg.output && cfg.output.mode) || 'production';
        const approvedRequests = manual.approvedRequestIds(DATA_ROOT, cfg);
        const gate = effectivegate.evaluate(tl, resolved, { mode, approvedRequests });
        tl.gate = { mode, ok: gate.ok, blockers: gate.blockers.length, critical: gate.critical, counts: gate.counts };

        // 4. DRAFT: har blocker ko ek NUMBERED request ka naam do — wahi naam
        //    video ke placeholder par bhi likha jayega aur DATA folder par bhi.
        //    (M4 mein renderer apna alag numbering karta tha, isliye "MISSING 002"
        //     dikh jata tha jiska koi folder hota hi nahi.)
        if (!gate.ok) {
          const gp = buildGapPlan(spec, cfg, resolved, tl, gate);
          const labelBySlot = {};
          for (const r of gp.requests) for (const sub of (r.sub_slots || [])) labelBySlot[sub.i] = r.label;
          for (const sl of tl.slots) if (labelBySlot[sl.i]) sl.missing_label = labelBySlot[sl.i];
          fs.writeFileSync(U.p(spec.id, 'gap-plan.json'), JSON.stringify(gp, null, 2));
          spec.gapPlan = gp;
        }
        fs.writeFileSync(U.p(spec.id, 'timeline.json'), JSON.stringify(tl, null, 2));

        // 5. PRODUCTION mein ek bhi khaali slot = export nahi. Draft mein aage badho.
        if (gate.blocks_render) {
          const crit = gate.critical.length ? ` (${gate.critical.length} CRITICAL: ${gate.critical.slice(0, 5).join(', ')})` : '';
          throw new Error(`${gate.blockers.length} slots par koi asli media nahi hai${crit} — final export rok raha hoon.\n` +
            `   Draft banao (START_HERE -> D). Wo poori video bana dega aur har khaali jagah ke liye\n` +
            `   DATA folder mein saaf-saaf likh dega ki kya chahiye. Wahan apni image/video daal kar\n` +
            `   dobara final chalana.`);
        }
      });
      else if (key === 'render') await runStage(key, () => { tl = tl || jf('timeline.json'); render(spec, cfg, st, tl); });
      else if (key === 'report') await runStage(key, () => {
        resolved = resolved || jf('resolved.json'); tl = tl || jf('timeline.json');
        report(spec, cfg, st, resolved, tl);
        // shot-level contact sheet: percentages ke bharose mat raho, har shot dekho
        try { shotReview(spec, cfg, st); } catch (e) { U.warn('shot-review fail: ' + e.message.slice(0, 90)); }
        // ---- DATA FOLDERS (M4.1) ----
        // Gap plan timeline stage mein hi ban chuka hai (taaki placeholder ke
        // number aur folder ke number ek jaise hon). Yahan sirf folders likhte hain.
        try { writeDataFolders(spec); } catch (e) { U.warn('DATA folder fail: ' + e.message.slice(0, 90)); }
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
    const draftMode = (cfg.output && cfg.output.mode) === 'draft';
    const outName = draftMode ? 'draft.mp4' : 'final.mp4';
    const okFinal = fs.existsSync(U.p(spec.id, outName)) && U.probe(U.p(spec.id, outName)).ok;
    // DRAFT ka status kabhi plain SUCCESS nahi hota jab usme khaali jagah bachi ho —
    // wahi jhooth tha jisse 45-minute ka render bekaar jata tha.
    let gp = null; try { gp = JSON.parse(fs.readFileSync(U.p(spec.id, 'gap-plan.json'), 'utf8')); } catch {}
    const gaps = gp ? gp.requests.length : 0;
    const status = !okFinal ? 'FAILED' : (draftMode && gaps ? 'DRAFT_NEEDS_HUMAN' : 'SUCCESS');
    jobResult(spec, st, { status, stage: okFinal ? null : 'render',
      message: !okFinal ? `saare stages chal gaye par ${outName} valid nahi hai.`
        : (status === 'DRAFT_NEEDS_HUMAN'
          ? `${outName} poori ban gayi, par ${gaps} jagah aapka media chahiye (${gp.missing_seconds}s). DATA folder dekho.`
          : `${outName} ban gayi aur probe pass hui.`),
      resolved, tl });
    if (!okFinal) { U.bad(`${outName} valid nahi hai — job FAILED mana ja raha hai.`); flushLog(spec.id); process.exit(1); }
  } catch (e) { U.warn('job-result likhne mein dikkat: ' + e.message.slice(0, 80)); }

  U.log('\n' + '='.repeat(60));
  U.log(`  DONE — ${path.relative(U.ROOT, U.jobDir(spec.id))}/`);
  U.log('   final.mp4, shot-review.html (har shot ka frame), quality-report.html, NEEDS_SOURCE.csv, timeline.json, run.log, clips/');
  U.log('='.repeat(60));
  flushLog(spec.id);
}

// DATA/ project ke andar rehta hai — job ke andar nahi. Job dobara banti hai,
// user ki dhoondhi hui files kabhi nahi khoni chahiye.
const DATA_ROOT = U.dataRoot();

/**
 * Video ab ban sakti hai ya nahi — teen saaf haalat:
 *   AUTO_READY        automatic research hi kaafi hai, koi gap nahi
 *   NEEDS_HUMAN_MEDIA draft ban sakta hai, par kuch jagah abhi khaali hain
 *   HYBRID_READY      gaps the, par user ne har jagah apna media de diya
 *
 * Ye pack ke report se ALAG cheez hai. Pack ka score kabhi nahi badalta chahe
 * user kitni bhi files de — wo automation ki imaandar naap hai. Ye batata hai
 * ki FINAL TIMELINE ke har slot par sach mein kuch hai ya nahi.
 */
function hybridState(spec, cfg) {
  const out = { state: 'AUTO_READY', total: 0, ready: 0, pending: [], stale: false };
  let scan;
  try { scan = manual.scan(DATA_ROOT, { cfg }); } catch { return out; }
  const reqs = scan.requests || [];
  if (!reqs.length) return out;

  // gap plan usi pack/SRT ka hona chahiye jispar ab render ho raha hai
  const want = { pack: U.hashFile(spec.packFile), srt: U.hashFile(spec.srt) };
  let anyStale = false;
  for (const r of reqs) {
    let req = null;
    try { req = JSON.parse(fs.readFileSync(path.join(r.dir, 'request.json'), 'utf8')); } catch { continue; }
    const fp = req.input_fingerprint || {};
    if (fp.pack_sha256 && fp.pack_sha256 !== want.pack) anyStale = true;
    if (fp.srt_sha256 && fp.srt_sha256 !== want.srt) anyStale = true;
  }
  out.total = reqs.length;
  out.ready = reqs.filter(r => r.status === 'READY').length;
  out.pending = reqs.filter(r => r.status !== 'READY').map(r => ({ folder: r.folder, status: r.status }));
  out.stale = anyStale;
  // Purana/doosre project ka gap plan mila to us par bharosa nahi karte —
  // aur na hi uske naam par render rokte hain. Aisa plan hai hi nahi maano.
  if (anyStale) {
    U.warn('DATA folder ka gap plan in inputs ka nahi hai — ise nazarandaz kar raha hoon. Naya draft banao.');
    return { state: 'AUTO_READY', total: 0, ready: 0, pending: [], stale: true };
  }
  out.state = out.ready === out.total ? 'HYBRID_READY' : 'NEEDS_HUMAN_MEDIA';
  return out;
}

// Gap plan RENDER SE PEHLE banta hai — timeline aur manual media ke baad.
// Isse do faayde: (1) video ke placeholder par wahi number aata hai jo DATA
// folder par hai, (2) draft ke fail hone par bhi requests bani rehti hain.
function buildGapPlan(spec, cfg, resolved, tl, gate) {
  const cues = SUB.parseFile(spec.origSrt || spec.srt);
  const packIndex = {};
  for (const pk of spec.pack.packs) packIndex[pk.pack_id] = pk;
  const gp = gapplan.plan({
    manifest: { preview_offset: tl.preview_offset || 0, shots: tl.slots },
    resolved, cues, packIndex,
    fingerprint: {
      pack_sha256: U.hashFile(spec.packFile),
      srt_sha256: U.hashFile(spec.origSrt || spec.srt),
      // audio bhi fingerprint mein: wahi SRT par naya voiceover = purani manzoori
      // ab valid nahi (timing badal chuki hai).
      audio_signature: spec.audio ? audioSig(spec.audio) : 'none',
    },
    projectId: spec.id, cfg, gate,
  });
  return gp;
}

function writeDataFolders(spec) {
  const gp = spec.gapPlan;
  if (!gp || !gp.requests.length) {
    U.ok('har shot ke paas asli media hai — DATA folder ki zaroorat nahi');
    return null;
  }
  const w = gapplan.writeDataFolders(DATA_ROOT, gp);
  U.log('');
  U.log(`  ${gp.requests.length} jagah aapka media chahiye (${gp.missing_seconds}s). Folders bana diye:`);
  w.made.slice(0, 8).forEach(n => U.log(`     DATA\\${n}\\media\\`));
  if (w.made.length > 8) U.log(`     ...aur ${w.made.length - 8}`);
  if (w.orphaned.length) U.log(`     (${w.orphaned.length} purane folder DATA\\_ORPHANED mein chale gaye — files surakshit hain)`);
  U.log('  Har folder mein WHAT_IS_MISSING.txt padho — usme narration aur search words likhe hain.');
  U.log('  Ya dashboard se: START_UI.bat');
  return gp;
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
    'render-manifest.json', 'shot-review.html', 'state.json', 'final.mp4', 'draft.mp4', 'video_master.mp4', 'gap-plan.json',
    'quality-report.html', 'NEEDS_SOURCE.csv', 'run.log'];
  for (const it of items) { const pp = path.join(dir, it); if (fs.existsSync(pp) && U.isInside(dir, pp)) fs.rmSync(pp, { recursive: true, force: true }); }
}

main().catch(e => { U.bad('fatal: ' + e.message); try { flushLog(U.slug(arg('job') || '')); } catch {} process.exit(1); });
