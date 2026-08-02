#!/usr/bin/env node
// ============================================================
//  CHECK-PACK — research pack ka "report card" (render se PEHLE).
//
//  Kyun: pack achha hai ya nahi ye jaanne ke liye 45-minute ka render karna
//  bewakoofi hai. Ye tool ~5 second mein batata hai:
//    - kitne SECONDS narration ke paas asli exact evidence hai (moment-count nahi)
//    - kaunse moments ke paas kuch bhi nahi (na locator, na frame_hints)
//    - render ke baad visual mix kya aayega (prediction)
//    - pack pass hai ya nahi, aur EXACTLY kya-kya add karwana hai
//
//  Ye asli pipeline ka hi alignment (src/align.js -> bestWindows) aur asli
//  scope-rules (src/locate.js jaisi) use karta hai — isliye iske seconds aur
//  render ke seconds ek hi jagah se aate hain, do alag guess nahi.
//
//  Do files likhta hai:
//    output/pack-report.json    -> machine-readable (UI/CI ke liye)
//    output/NEEDS_RESEARCH.txt  -> Genspark/Gemini ko copy-paste karne wala
//                                  ready-made work order (sirf missing cheezein)
//
//  Usage:
//    node tools/check-pack.js input/scene-research.json input/voiceover.srt
//    CHECKPACK.bat
//  Exit: 0 = pack achha, 2 = weak (upgrade chahiye), 1 = invalid/missing
// ============================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const U = require(path.join(ROOT, 'src', 'util.js'));
const validate = require(path.join(ROOT, 'src', 'validate.js'));
const SUB = require(path.join(ROOT, 'src', 'subtitles.js'));
const SRC = require(path.join(ROOT, 'src', 'sources.js'));
const align = require(path.join(ROOT, 'src', 'align.js'));

const flags = process.argv.slice(2).filter(a => a.startsWith('--'));
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const has = f => flags.some(x => x === '--' + f || x.startsWith('--' + f + '='));
const val = (f, d) => { const x = flags.find(y => y.startsWith('--' + f + '=')); return x ? x.slice(f.length + 3) : d; };

const packFile = args[0] || path.join(ROOT, 'input', 'scene-research.json');
const srtFile = args[1] || path.join(ROOT, 'input', 'voiceover.srt');
const outDir = val('out', path.join(ROOT, 'output'));
const quiet = has('quiet');

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch (e) { /* defaults */ }
const ACC = (cfg.align || {}).acceptSimilarity ?? 0.92;
const MARGIN = (cfg.align || {}).runnerUpMargin ?? 0.08;
const ABSORB = (cfg.shots || {}).gapAbsorbSeconds ?? 1.5;

// exact/hint-backed narration ka target (isse neeche pack "weak" hai)
const TARGET_EXACT_PCT = +val('target', '60');
// live verify: sources ke ASLI captions laakar har DIALOGUE locator ko sach
// mein match karke dekhna, aur EXACT_TIME ko episode ki duration se check karna.
// Yehi "best case" ko "asli result" mein badalta hai. --no-probe se band.
const PROBE = !has('no-probe');

const say = (...a) => { if (!quiet) console.log(...a); };
const line = (c = '=') => say(c.repeat(70));
const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : 0;
const fail = msg => { console.log('  [FAIL] ' + msg); process.exit(1); };

line(); say('  RESEARCH PACK REPORT CARD  (render se pehle 5-second check)'); line();

// ---------- 1. pack load + validate ----------
if (!fs.existsSync(packFile)) fail(`pack nahi mila: ${packFile}`);
const v = validate.validateFile(packFile);
(v.warnings || []).slice(0, 6).forEach(w => say('  [warn] ' + w));
if ((v.warnings || []).length > 6) say(`  [warn] ...aur ${v.warnings.length - 6} warnings`);
if (!v.ok) { (v.errors || []).forEach(e => console.log('  [FAIL] ' + e)); fail('pack invalid hai — pehle ye errors theek karao.'); }
const pack = v.pack;

// ---------- 2. sources + scope map (locate.js jaisa hi) ----------
const sourcesById = {};
for (const pk of pack.packs) for (const s of (pk.sources || [])) sourcesById[s.source_id] = { ...s, pack_id: pk.pack_id };
const isUsableSource = s => !!(s && (s.url || s.local_file));
// probe chala ho to "usable" ka matlab hai ASLI mein reachable (dead URL nahi).
// (probe neeche define hota hai; ye function uske baad hi call hota hai.)
const isLive = s => isUsableSource(s) && (!probe.ran || !!(probe.meta[s.source_id] && probe.meta[s.source_id].available));

const scopeKey = sc => sc ? `${sc.kind || ''}::${String(sc.title || '').trim().toLowerCase()}` : '';
const packsByScope = {};
for (const pk of pack.packs) {
  const k = scopeKey(pk.scope);
  if (!k || (pk.scope && pk.scope.kind === 'GRAPHIC')) continue;
  (packsByScope[k] = packsByScope[k] || []).push(pk.pack_id);
}
const showScopes = Object.keys(packsByScope);

function allowedPacksOf(m, pk) {
  const fp = m.fallback_plan || {};
  if (fp.allowed_pack_ids && fp.allowed_pack_ids.length) return fp.allowed_pack_ids.slice();
  if (pk.scope && pk.scope.kind === 'GRAPHIC') return showScopes.length === 1 ? packsByScope[showScopes[0]].slice() : [pk.pack_id];
  return [...new Set([pk.pack_id, ...((packsByScope[scopeKey(pk.scope)]) || [])])];
}
function allowedSourcesOf(m, pk) {
  const fp = m.fallback_plan || {};
  if (fp.allowed_source_ids && fp.allowed_source_ids.length) return fp.allowed_source_ids.filter(sid => isLive(sourcesById[sid]));
  const packs = allowedPacksOf(m, pk);
  return Object.values(sourcesById).filter(s => packs.includes(s.pack_id) && isLive(s)).map(s => s.source_id);
}

// ---------- 3. narration windows (asli pipeline ka alignment) ----------
const cues = SUB.parseFile(srtFile);
const haveSrt = cues.length > 0;
if (!haveSrt) say(`  [warn] SRT nahi mila/parse nahi hua (${path.basename(srtFile)}) — seconds ESTIMATE honge.`);
const srtTotal = haveSrt ? cues[cues.length - 1].end : 0;

const moments = [];
for (const pk of pack.packs) for (const m of (pk.moments || [])) moments.push({ m, pk });

const rows = moments.map(({ m, pk }) => {
  let start = null, end = null, flag = 'NO_SRT', score = 0;
  if (haveSrt) {
    const { best, runnerUp } = align.bestWindows(cues, m.script_cue_exact);
    if (!best) flag = 'UNMATCHED';
    else {
      start = best.start; end = best.end; score = best.score;
      const ru = runnerUp ? runnerUp.score : 0;
      flag = best.score < ACC ? 'REVIEW' : ((best.score - ru) < MARGIN ? 'AMBIGUOUS' : 'OK');
    }
  }
  const words = String(m.script_cue_exact || '').split(/\s+/).filter(Boolean).length;
  return { m, pk, start, end, flag, score, estDur: Math.max(1, words / 2.6) };   // ~2.6 words/sec narration
});

// anchors: timeline.js jaisa hi — overlap trim + micro-gap absorb
const anchored = rows.filter(r => r.start != null).sort((a, b) => a.start - b.start);
for (let i = 0; i < anchored.length - 1; i++) if (anchored[i].end > anchored[i + 1].start) anchored[i].end = anchored[i + 1].start;
for (let i = 0; i < anchored.length - 1; i++) {
  const g = anchored[i + 1].start - anchored[i].end;
  if (g > 0 && g <= ABSORB) anchored[i].end = anchored[i + 1].start;
}
if (anchored.length) {
  if (anchored[0].start > 0 && anchored[0].start <= ABSORB) anchored[0].start = 0;
  const last = anchored[anchored.length - 1];
  if (srtTotal - last.end > 0 && srtTotal - last.end <= ABSORB) last.end = srtTotal;
}
for (const r of rows) r.dur = (r.start != null) ? Math.max(0.5, r.end - r.start) : r.estDur;

const narrTotal = haveSrt ? srtTotal : rows.reduce((a, r) => a + r.dur, 0);
const anchoredSec = rows.reduce((a, r) => a + (r.start != null ? r.dur : 0), 0);
const uncoveredSec = haveSrt ? Math.max(0, narrTotal - anchoredSec) : 0;

// ---------- 3b. LIVE VERIFY (yehi guess ko sach mein badalta hai) ----------
//  Bina iske hum sirf ye keh sakte hain "pack ne dialogue diya hai".
//  Iske saath hum keh sakte hain "ye dialogue source ke ASLI captions mein
//  mila / nahi mila", aur "ye EXACT_TIME episode ki length ke bahar hai".
const PROBE_JOB = 'packcheck';
const probe = { ran: false, meta: {}, subs: {}, checked: 0, dialogueOK: 0, dialogueBad: [], timeBad: [], deadSources: [] };
if (PROBE) {
  const referenced = new Set();
  for (const { m } of moments) for (const L of (m.locators || [])) if (sourcesById[L.source_id]) referenced.add(L.source_id);
  for (const s of Object.values(sourcesById)) if (isUsableSource(s)) referenced.add(s.source_id);
  const list = [...referenced];
  if (!list.length) { /* kuch probe karne ko nahi */ }
  else if (!U.tool('ytdlp') && Object.values(sourcesById).some(s => s.url)) {
    say('  [warn] yt-dlp nahi mila — live verify skip. (sirf pack ki likhi hui baat par bharosa)');
  } else {
    say(`\n  live verify: ${list.length} sources ke asli captions/duration check kar raha hoon...`);
    say('  (ek baar ka kaam — result cache ho jata hai; --no-probe se skip kar sakte ho)');
    let i = 0;
    for (const sid of list) {
      const s = sourcesById[sid]; i++;
      if (!isUsableSource(s)) continue;
      let meta = null, subs = null;
      try { meta = SRC.getMeta(PROBE_JOB, s, cfg); } catch (e) { meta = { available: false, error: e.message.slice(0, 80) }; }
      probe.meta[sid] = meta;
      if (!meta || !meta.available) { probe.deadSources.push({ source_id: sid, error: (meta && meta.error) || 'unavailable' }); }
      else { try { subs = SRC.getSubs(PROBE_JOB, s, cfg); } catch (e) { subs = { via: 'error', count: 0, cues: [] }; } probe.subs[sid] = subs; }
      say(`   [${String(i).padStart(2)}/${list.length}] ${sid.padEnd(14)} ${meta && meta.available ? `dur ${Math.round(meta.duration || 0)}s` : 'UNAVAILABLE'}  ${subs ? `captions: ${subs.count} cues (${subs.via})` : ''}`);
    }
    probe.ran = true;
  }
}
const dcfg = (cfg.dialogue || {});

// ek locator sach mein chalega ya nahi — probe hua ho to asli jawab, warna "shayad"
function verifyLocator(L) {
  const s = sourcesById[L.source_id];
  if (!isUsableSource(s)) return { ok: false, code: 'DEAD', why: 'source missing' };
  if (!probe.ran) return { ok: true, code: 'OK', why: 'unverified' };
  const meta = probe.meta[L.source_id];
  if (!meta || !meta.available) return { ok: false, code: 'DEAD', why: 'source available nahi (dead/private URL ya missing file)' };
  if (L.locator_type === 'EXACT_TIME') {
    if (meta.duration && L.start_sec >= meta.duration) return { ok: false, code: 'BOUNDS', why: `start ${Math.round(L.start_sec)}s > episode length ${Math.round(meta.duration)}s` };
    return { ok: true, code: 'OK', why: 'bounds ok' };
  }
  const subs = probe.subs[L.source_id];
  if (!subs || !subs.count) return { ok: false, code: 'NOSUBS', why: `source ke captions nahi mile (${(subs && subs.via) || 'na'})` };
  const match = SUB.locateDialogue(subs.cues, L.dialogue_exact, { variants: L.dialogue_variants_verified || [], anchors: L.nearby_context_terms || [] });
  const dec = SUB.decide(match, dcfg);
  if (dec.decision === 'ACCEPT' || dec.decision === 'REVIEW') return { ok: true, code: 'OK', why: `${dec.decision} @ ${Math.round(match.start_sec)}s`, at: match.start_sec };
  return { ok: false, code: 'NOMATCH', why: `dialogue captions mein nahi mila (${dec.reason})` };
}

// ---------- 4. classify ----------
//  Ye wahi ladder hai jo timeline.js chalata hai, isliye ye prediction hai —
//  wish-list nahi:
//   EXACT_T   -> EXACT_TIME locator: clip pakki (captions ki zaroorat nahi)
//   EXACT_D   -> sirf DIALOGUE locator: clip tabhi jab source ke captions milein
//   HINT      -> frame_hints: us source ka SAHI frame (still/graphic)
//   CONTEXT   -> apne scope ka koi source: sahi show, exact scene nahi
//   NEIGHBOUR -> apna scope khaali; timeline padosi beat ka show udhaar lega
//   NONE      -> poore project mein koi usable source nahi -> generic text
const LABEL = {
  EXACT_T: 'EXACT CLIP     (asli scene — pakki)',
  EXACT_D: 'EXACT CLIP*    (asli scene — source ke captions mile to)',
  HINT: 'FRAME HINT     (asli scene ka frame — still/graphic)',
  CONTEXT: 'CONTEXT ONLY   (sahi show, exact scene nahi)',
  NEIGHBOUR: 'UDHAAR CONTEXT (apna scope khaali — padosi beat ka show)',
  NONE: 'KUCH NAHI      (generic text)',
};
const KEYS = ['EXACT_T', 'EXACT_D', 'HINT', 'CONTEXT', 'NEIGHBOUR', 'NONE'];
const byClass = {}; const secBy = {};
for (const k of KEYS) { byClass[k] = 0; secBy[k] = 0; }
const gaps = [], needExact = [], alignBad = [], borrowed = [];
const anyUsableSource = Object.values(sourcesById).some(isLive);

for (const r of rows) {
  const { m, pk } = r;
  const fp = m.fallback_plan || {};
  const locs = (m.locators || []).filter(L => isUsableSource(sourcesById[L.source_id]));   // dead check verifyLocator karega
  const shapedT = locs.filter(L => L.locator_type === 'EXACT_TIME' && typeof L.start_sec === 'number' && typeof L.end_sec === 'number' && L.end_sec > L.start_sec);
  const shapedD = locs.filter(L => L.locator_type === 'DIALOGUE' && String(L.dialogue_exact || '').trim().length >= 8);
  const hints = (fp.frame_hints || []).filter(h => isLive(sourcesById[h.source_id]) && typeof h.time_sec === 'number');
  const scopeN = allowedSourcesOf(m, pk).length;

  // live verify: jo locator sach mein nahi chalega use yahin chhaant do
  const exactT = [], dialT = [];
  const at = { moment_id: m.moment_id, pack_id: pk.pack_id };
  for (const L of shapedT) {
    const vr = verifyLocator(L); probe.checked++;
    if (vr.ok) { exactT.push(L); continue; }
    // dead source ko "galat timestamp" mat batao — wo alag problem hai
    if (vr.code !== 'DEAD') probe.timeBad.push({ ...at, source_id: L.source_id, why: vr.why });
  }
  for (const L of shapedD) {
    const vr = verifyLocator(L); probe.checked++;
    if (vr.ok) { dialT.push(L); if (probe.ran) probe.dialogueOK++; continue; }
    if (vr.code !== 'DEAD') probe.dialogueBad.push({ ...at, source_id: L.source_id, why: vr.why, dialogue: String(L.dialogue_exact || '').slice(0, 70) });
  }

  const alignOK = r.flag === 'OK' || r.flag === 'NO_SRT';
  if (!alignOK && (exactT.length || dialT.length)) alignBad.push(r);

  let cls;
  if (exactT.length && alignOK) cls = 'EXACT_T';
  else if (dialT.length && alignOK) cls = 'EXACT_D';
  else if (hints.length) cls = 'HINT';
  else if (scopeN > 0) cls = 'CONTEXT';
  else cls = anyUsableSource ? 'NEIGHBOUR' : 'NONE';

  if (cls === 'CONTEXT' || cls === 'NEIGHBOUR' || cls === 'NONE') needExact.push({ r, scopeN });
  if (cls === 'NEIGHBOUR') borrowed.push(r);
  if (cls === 'NONE') gaps.push(r);
  r._class = cls; r._scopeN = scopeN;
  byClass[cls]++; secBy[cls] += r.dur;
}
// jo narration kisi bhi moment se anchor nahi hui — usme bhi context hi lagega
secBy.CONTEXT += uncoveredSec;

const bestSec = secBy.EXACT_T + secBy.EXACT_D + secBy.HINT;   // captions mil gaye
const sureSec = secBy.EXACT_T + secBy.HINT;                   // captions bina bhi
const exactPct = pct(bestSec, narrTotal);
const surePct = pct(sureSec, narrTotal);
const contextPct = pct(secBy.CONTEXT, narrTotal);
const borrowPct = pct(secBy.NEIGHBOUR, narrTotal);
const nonePct = pct(secBy.NONE, narrTotal);

// ---------- 4b. scope-title mismatch (P06 wala bug: same show, alag likha title) ----------
const F = require(path.join(ROOT, 'lib', 'fuzzy.js'));
const scopeMismatch = [];
for (let i = 0; i < showScopes.length; i++) {
  for (let j = i + 1; j < showScopes.length; j++) {
    const [ka, kb] = [showScopes[i], showScopes[j]];
    const [ta, tb] = [ka.split('::')[1] || '', kb.split('::')[1] || ''];
    const sim = F.score(ta, tb).score;
    if (sim >= 0.45) scopeMismatch.push({ a: ta, b: tb, sim: +sim.toFixed(2), packsA: packsByScope[ka], packsB: packsByScope[kb] });
  }
}

// ---------- 5. report ----------
say(`\n  pack   : ${path.basename(packFile)}`);
say(`  size   : ${pack.packs.length} packs · ${moments.length} moments · ${Object.keys(sourcesById).length} sources`);
say(`  script : ${narrTotal.toFixed(0)}s narration ${haveSrt ? '(voiceover.srt se — exact)' : '(ESTIMATE — SRT do to exact milega)'}`);

line('-');
say('  RENDER KE BAAD KYA MILEGA — SECONDS ke hisaab se (moment-count nahi):\n');
const bar = p => '#'.repeat(Math.round(p / 2.5)).padEnd(40, '.');
for (const k of KEYS) {
  if (!byClass[k] && !secBy[k]) continue;
  const p = pct(secBy[k], narrTotal);
  say(`   ${String(p + '%').padStart(6)}  ${bar(p)}  ${LABEL[k]}  [${byClass[k]} moments]`);
}
if (uncoveredSec > 1) say(`\n   (${uncoveredSec.toFixed(0)}s narration par koi moment hi nahi — CONTEXT mein gina)`);
if (secBy.EXACT_D > 0 && !probe.ran) {
  say(`\n   * DIALOGUE-only ${byClass.EXACT_D} moments (${pct(secBy.EXACT_D, narrTotal)}%): engine inhe source ke ASLI`);
  say(`     captions se match karta hai. Caption na mile to ye CONTEXT ban jate hain.`);
  say(`     Ye number BEST-CASE hai (${exactPct}%); captions-ke-bina pakka sirf ${surePct}%.`);
  say(`     Sach jaanne ke liye --no-probe hataakar chalao (asli captions check honge).`);
}
if (probe.ran) {
  line('-');
  say('  LIVE VERIFY — ye guess nahi, asli check hai:');
  say(`   ${probe.checked} locators check kiye | ${probe.dialogueOK} dialogue asli captions mein MILE`);
  if (probe.deadSources.length) {
    say(`   ${probe.deadSources.length} source ab reachable NAHI hai (video hata/private ho gaya):`);
    probe.deadSources.slice(0, 8).forEach(d => say(`     ${d.source_id.padEnd(14)} ${String(d.error).slice(0, 46)}`));
  }
  if (probe.timeBad.length) {
    say(`   ${probe.timeBad.length} EXACT_TIME locator galat hai (episode ki length se bahar):`);
    probe.timeBad.slice(0, 8).forEach(d => say(`     ${d.moment_id.padEnd(10)} ${d.source_id.padEnd(14)} ${d.why}`));
  }
  if (probe.dialogueBad.length) {
    say(`   ${probe.dialogueBad.length} dialogue captions mein NAHI mile (in par clip nahi lagegi):`);
    probe.dialogueBad.slice(0, 10).forEach(d => say(`     ${d.moment_id.padEnd(10)} ${d.source_id.padEnd(14)} ${String(d.why).slice(0, 40)}`));
    if (probe.dialogueBad.length > 10) say(`     ...aur ${probe.dialogueBad.length - 10}`);
  }
  if (!probe.deadSources.length && !probe.timeBad.length && !probe.dialogueBad.length) say('   sab locators verified — koi dead source/galat timestamp nahi.');
}

line('-');
say('  VERDICT:');
const ownScopeBad = pct(secBy.NEIGHBOUR + secBy.NONE, narrTotal);
const checks = [
  [`Exact/frame-hint backed narration >= ${TARGET_EXACT_PCT}%`, exactPct >= TARGET_EXACT_PCT, `abhi ${exactPct}%`],
  ['Har moment ke apne scope mein source hai (udhaar <= 15%)', ownScopeBad <= 15, `abhi ${ownScopeBad}% udhaar/khaali`],
  ['Generic text (koi visual evidence nahi) = 0%', nonePct === 0, `abhi ${nonePct}% (${gaps.length} moments)`],
  ['Alignment saaf (script_cue_exact SRT se milta hai)', alignBad.length === 0, `${alignBad.length} moments ka cue match nahi/ambiguous`],
  ['Scope titles consistent (ek show = ek hi title)', scopeMismatch.length === 0, `${scopeMismatch.length} title mismatch`],
];
if (probe.ran) {
  checks.push(['Saare sources abhi live hain (video hata nahi)', probe.deadSources.length === 0, `${probe.deadSources.length} dead`]);
  checks.push(['EXACT_TIME timestamps episode ke andar hain', probe.timeBad.length === 0, `${probe.timeBad.length} bahar`]);
  const dTot = probe.dialogueOK + probe.dialogueBad.length;
  checks.push(['Dialogue lines asli captions mein milte hain (>=80%)', dTot === 0 || probe.dialogueOK / dTot >= 0.8, `${probe.dialogueOK}/${dTot} mile`]);
}
let pass = true;
for (const [name, ok, detail] of checks) { say(`   [${ok ? 'OK ' : 'NO '}] ${name} — ${detail}`); if (!ok) pass = false; }

if (scopeMismatch.length) {
  line('-');
  say('  SCOPE TITLE MISMATCH — ye do titles ek hi show lagte hain par alag likhe hain.');
  say('  Isse engine inhe DO alag show samajhta hai aur ek pack ke sources doosre par');
  say('  nahi lagte (yahi wo bug tha jisse generic text badh jata hai). Title EK jaisa karao:');
  for (const s of scopeMismatch.slice(0, 5)) {
    say(`   "${s.a}"  (${s.packsA.join(',')})`);
    say(`   "${s.b}"  (${s.packsB.join(',')})     similarity ${s.sim}`);
  }
}

// weakest packs
const packSec = {};
for (const r of rows) {
  const id = r.pk.pack_id;
  packSec[id] = packSec[id] || { total: 0, weak: 0, sources: (r.pk.sources || []).length, moments: 0, scope: (r.pk.scope || {}).title || '' };
  packSec[id].total += r.dur; packSec[id].moments++;
  if (r._class === 'CONTEXT' || r._class === 'NEIGHBOUR' || r._class === 'NONE') packSec[id].weak += r.dur;
}
const weak = Object.entries(packSec).filter(([, s]) => s.weak > 5).sort((a, b) => b[1].weak - a[1].weak);
if (weak.length) {
  line('-');
  say('  SABSE PEHLE INHE THEEK KARWAO (sabse zyada waqt bina exact evidence ke):');
  for (const [id, s] of weak.slice(0, 8)) {
    say(`   ${id.padEnd(14)} ${s.weak.toFixed(0).padStart(4)}s / ${s.total.toFixed(0)}s bina evidence   (${s.sources} source, ${s.moments} moments)  ${s.scope.slice(0, 28)}`);
  }
}
if (alignBad.length) {
  line('-');
  say(`  IN MOMENTS KA script_cue_exact VOICEOVER SE MATCH NAHI HUA (${alignBad.length}) —`);
  say('  locator sahi hone par bhi clip nahi lagegi. Cue ko voiceover se HUBAHU copy karao:');
  alignBad.slice(0, 10).forEach(r => say(`   ${r.m.moment_id.padEnd(10)} ${r.flag.padEnd(10)} score ${r.score.toFixed(2)}  "${String(r.m.script_cue_exact).slice(0, 46)}..."`));
  if (alignBad.length > 10) say(`   ...aur ${alignBad.length - 10}`);
}
const showList = (title, list) => {
  if (!list.length) return;
  line('-');
  say(`  ${title} (${list.reduce((a, g) => a + g.dur, 0).toFixed(0)}s, ${list.length} moments):`);
  list.slice(0, 20).forEach(r => say(`   ${r.pk.pack_id.padEnd(14)} ${r.m.moment_id.padEnd(10)} ${r.dur.toFixed(0).padStart(3)}s  "${String(r.m.script_cue_exact).slice(0, 44)}..."`));
  if (list.length > 20) say(`   ...aur ${list.length - 20}`);
};
showList('IN MOMENTS KE PAAS KUCH BHI NAHI — GENERIC TEXT AAYEGA', gaps);
showList('IN MOMENTS KE APNE PACK MEIN KOI SOURCE NAHI — PADOSI BEAT KA SHOW UDHAAR LEGA', borrowed);

// ---------- 6. files ----------
fs.mkdirSync(outDir, { recursive: true });
const reportJson = {
  schema: 'pack-report-v1',
  pack_file: path.basename(packFile), generated_at: new Date().toISOString(),
  narration_seconds: +narrTotal.toFixed(1), have_srt: haveSrt,
  packs: pack.packs.length, moments: moments.length, sources: Object.keys(sourcesById).length,
  seconds_by_class: Object.fromEntries(Object.entries(secBy).map(([k, x]) => [k, +x.toFixed(1)])),
  percent_by_class: Object.fromEntries(Object.entries(secBy).map(([k, x]) => [k, pct(x, narrTotal)])),
  moments_by_class: byClass,
  exact_or_hint_percent: exactPct, exact_without_captions_percent: surePct,
  context_percent: contextPct, borrowed_percent: borrowPct, generic_percent: nonePct,
  unanchored_seconds: +uncoveredSec.toFixed(1),
  align_problem_moments: alignBad.map(r => ({ moment_id: r.m.moment_id, pack_id: r.pk.pack_id, flag: r.flag, score: +r.score.toFixed(3), cue: r.m.script_cue_exact })),
  empty_moments: gaps.map(r => ({ moment_id: r.m.moment_id, pack_id: r.pk.pack_id, seconds: +r.dur.toFixed(1) })),
  borrowed_moments: borrowed.map(r => ({ moment_id: r.m.moment_id, pack_id: r.pk.pack_id, seconds: +r.dur.toFixed(1) })),
  scope_title_mismatch: scopeMismatch,
  live_verify: probe.ran ? {
    locators_checked: probe.checked, dialogue_found: probe.dialogueOK,
    dead_sources: probe.deadSources, bad_exact_time: probe.timeBad, dialogue_not_found: probe.dialogueBad,
  } : { ran: false },
  weak_packs: weak.map(([id, s]) => ({ pack_id: id, weak_seconds: +s.weak.toFixed(1), total_seconds: +s.total.toFixed(1), sources: s.sources, moments: s.moments })),
  failed_checks: checks.filter(c => !c[1]).map(c => ({ check: c[0], detail: c[2] })),
  pass,
};
const jsonOut = path.join(outDir, 'pack-report.json');
fs.writeFileSync(jsonOut, JSON.stringify(reportJson, null, 2));

// ---------- 7. Genspark work order ----------
const needFile = path.join(outDir, 'NEEDS_RESEARCH.txt');
fs.writeFileSync(needFile, buildWorkOrder());

// paths: ROOT ke andar ho to short, bahar ho to poora (relative ../../.. bekar lagta hai)
const shortPath = p => { const r = path.relative(ROOT, p); return r.startsWith('..') ? p : r; };

line();
if (pass) {
  say(`  RESULT: pack RENDER KE LIYE ACHHA hai (exact/hint ${exactPct}%).`);
} else {
  const bad = checks.filter(c => !c[1]);
  say(`  RESULT: pack WEAK hai — ${bad.length} check fail:`);
  bad.forEach(c => say(`          - ${c[0]}  (${c[2]})`));
}
say(`  report : ${shortPath(jsonOut)}`);
if (!pass || needExact.length) {
  say(`\n  AAGE KYA KARNA HAI:`);
  say(`   1. ${shortPath(needFile)} kholo (ye tumhare liye ready hai)`);
  say(`   2. poora text Genspark/Gemini ke USI chat mein paste karo jisme pack bana tha`);
  say(`   3. jo JSON aaye usse scene-research.json mein merge karo`);
  say(`   4. ye tool dobara chalao — verdict turant mil jayega (render ki zaroorat nahi)`);
}
line();
process.exit(pass ? 0 : 2);

// ============================================================
function buildWorkOrder() {
  const L = [];
  const P = s => L.push(s);
  P('================================================================');
  P('  FOLLOW-UP RESEARCH REQUEST  (research pack upgrade)');
  P('  Ise Genspark / Gemini Pro ke usi chat mein paste karo jisme');
  P('  ye scene-research.json bana tha (taaki context available rahe).');
  P('================================================================');
  P('');
  P('CONTEXT: pichhla pack ban chuka hai. Video engine ne use check kiya.');
  P(`Result: narration ke sirf ${exactPct}% seconds ke paas asli scene ka evidence hai.`);
  P(`${contextPct}% par sirf "sahi show" chalega (exact scene nahi), ${borrowPct}% par kisi`);
  P(`doosre section ka show udhaar lena padega, aur ${nonePct}% par kuch bhi nahi hai.`);
  P('Mujhe PURA pack dobara nahi chahiye. Sirf neeche listed moments ke liye');
  P('MISSING evidence chahiye — baaki sab jaisa hai waisa hi rehne do.');
  P('');
  P('----------------------------------------------------------------');
  P('KYA CHAHIYE (priority order — jitna mile utna do, jhooth mat likhna):');
  P('----------------------------------------------------------------');
  P('1) BEST: `locators` — us exact scene ka real timestamp ya dialogue:');
  P('     {"locator_type":"EXACT_TIME","source_id":"<usi pack ka source>",');
  P('      "start_sec":123.0,"end_sec":129.0,"confidence":"HIGH"}');
  P('   ya (agar timestamp pakka nahi, par dialogue yaad hai — ye ZYADA SAFE hai):');
  P('     {"locator_type":"DIALOGUE","source_id":"<source>",');
  P('      "dialogue_exact":"episode mein bola gaya HUBAHU line",');
  P('      "nearby_context_terms":["character","jagah"],"confidence":"MEDIUM"}');
  P('   NOTE: engine dialogue ko source ke asli captions se khud match karta hai,');
  P('         isliye galat timestamp se dialogue kaafi behtar hai.');
  P('');
  P('2) AGAR exact scene ka locator nahi de sakte, to `fallback_plan.frame_hints`');
  P('   do — yaani "us source mein ye cheez in seconds par dikhti hai":');
  P('     "fallback_plan": {');
  P('       "allowed_pack_ids": ["P01"],');
  P('       "allowed_source_ids": ["S01_EP12"],');
  P('       "frame_hints": [');
  P('         {"source_id":"S01_EP12","time_sec":412,"reason":"Nicole gusse mein, close-up"},');
  P('         {"source_id":"S01_EP12","time_sec":455,"reason":"Nicole aur Richard saath"}');
  P('       ]');
  P('     }');
  P('   frame_hints se engine wahi frame nikaal kar still/graphic banata hai —');
  P('   yaani "sahi character/sahi scene" screen par aata hai, random frame nahi.');
  P('   Har weak moment ke liye 2-3 hints do.');
  P('');
  P('3) SABSE ZAROORI (agar pack ke paas source hi nahi hai): us pack mein');
  P('   `sources` add karo — YouTube URLs jo abhi live hain, poora episode/clip,');
  P('   sahi show ka, sahi language/version. Har source:');
  P('     {"source_id":"S09_A","kind":"YOUTUBE","url":"https://www.youtube.com/watch?v=...",');
  P('      "title":"...","priority":1}');
  P('');
  P('RULES (inhe todoge to engine reject kar dega):');
  P('  - source_id wahi ho jo us pack ke `sources` mein maujood ho (ya naya add karo).');
  P('  - kisi doosre show ka source mat mixing karo — scope lock hai.');
  P('  - time_sec / start_sec seconds mein (number), "12:34" string mein nahi.');
  P('  - jo pakka nahi hai wo mat likho — galat timestamp se khali chhodna behtar hai,');
  P('    kyunki engine tab bhi sahi show ka context laga dega.');
  P('  - OUTPUT: sirf VALID JSON — ek array, har element:');
  P('      {"moment_id":"...","pack_id":"...","locators":[...],"fallback_plan":{...}}');
  P('    (jo field nahi de rahe use chhod do). Koi explanation text nahi.');
  P('');

  // sources ki kami wale packs
  const emptyPacks = pack.packs.filter(pk => !(pk.sources || []).some(isLive));
  if (emptyPacks.length) {
    P('================================================================');
    P('A) IN PACKS KE PAAS EK BHI SOURCE NAHI HAI — pehle sources do:');
    P('================================================================');
    for (const pk of emptyPacks) {
      const sec = rows.filter(r => r.pk.pack_id === pk.pack_id).reduce((a, r) => a + r.dur, 0);
      P(`  ${pk.pack_id}  [${(pk.scope || {}).kind || '?'}] ${(pk.scope || {}).title || ''}`);
      P(`     ${(pk.moments || []).length} moments · ~${sec.toFixed(0)}s narration · abhi 0 usable sources`);
    }
    P('');
  }

  if (scopeMismatch.length) {
    P('================================================================');
    P('A2) SCOPE TITLE MISMATCH — ek hi show ke do alag titles likhe hain.');
    P('    Engine inhe ALAG-ALAG show maan leta hai, isliye ek pack ke sources');
    P('    doosre pack ke moments par nahi lagte. Dono jagah BILKUL EK jaisa');
    P('    title likho (canonical official name):');
    P('================================================================');
    for (const s of scopeMismatch) {
      P(`  "${s.a}"   -> packs ${s.packsA.join(', ')}`);
      P(`  "${s.b}"   -> packs ${s.packsB.join(', ')}`);
      P('');
    }
  }

  if (probe.ran && (probe.deadSources.length || probe.timeBad.length || probe.dialogueBad.length)) {
    P('================================================================');
    P('A3) YE LOCATORS SACH MEIN TOOTE HUE HAIN — maine inhe asli video/captions');
    P('    se check kiya hai. Inhe theek karo ya hata do:');
    P('================================================================');
    for (const d of probe.deadSources) P(`  [DEAD SOURCE] ${d.source_id} — ab available nahi (${d.error}). Naya URL do.`);
    for (const d of probe.timeBad) P(`  [GALAT TIME]  ${d.pack_id}/${d.moment_id} (${d.source_id}) — ${d.why}`);
    for (const d of probe.dialogueBad) {
      P(`  [DIALOGUE NAHI MILA] ${d.pack_id}/${d.moment_id} (${d.source_id})`);
      P(`        tumne likha : "${d.dialogue}"`);
      P(`        problem     : ${d.why}`);
    }
    P('');
    P('  NOTE: dialogue HUBAHU wahi hona chahiye jo episode ke captions mein hai');
    P('  (paraphrase nahi). Agar line yaad nahi to dialogue mat likho — us moment');
    P('  ke liye frame_hints de do.');
    P('');
  }

  if (alignBad.length) {
    P('================================================================');
    P('B) IN MOMENTS KA script_cue_exact VOICEOVER SE MATCH NAHI HO RAHA:');
    P('   (cue ko voiceover ki transcript se HUBAHU copy karo — 8-20 words,');
    P('    beech se, aur aisa hissa jo script mein sirf EK BAAR aata ho)');
    P('================================================================');
    for (const r of alignBad) P(`  ${r.pk.pack_id} / ${r.m.moment_id}  (${r.flag}) : "${r.m.script_cue_exact}"`);
    P('');
  }

  const grouped = {};
  for (const { r, scopeN } of needExact) (grouped[r.pk.pack_id] = grouped[r.pk.pack_id] || []).push({ r, scopeN });
  const order = Object.keys(grouped).sort((a, b) =>
    grouped[b].reduce((x, y) => x + y.r.dur, 0) - grouped[a].reduce((x, y) => x + y.r.dur, 0));
  if (order.length) {
    P('================================================================');
    P(`C) IN ${needExact.length} MOMENTS KO EVIDENCE CHAHIYE (sabse zyada waqt wale pehle):`);
    P('================================================================');
    for (const pid of order) {
      const pk = grouped[pid][0].r.pk;
      const sec = grouped[pid].reduce((a, x) => a + x.r.dur, 0);
      const srcs = (pk.sources || []).filter(isLive).map(s => s.source_id);
      const isGraphic = (pk.scope || {}).kind === 'GRAPHIC';
      P('');
      P(`--- ${pid}  [${(pk.scope || {}).kind || '?'}] ${(pk.scope || {}).title || ''}  (~${sec.toFixed(0)}s) ---`);
      P(`    is pack ke available source_id: ${srcs.length ? srcs.join(', ') : '(KOI NAHI)'}`);
      if (isGraphic) {
        // GRAPHIC/analysis beats ko apne sources nahi chahiye — unhe show ke
        // frames par baithna hota hai. Ye sabse aam aur sabse bada gap hai.
        P('    NOTE: ye ANALYSIS/GRAPHIC pack hai — ise apne video sources NAHI chahiye.');
        P('    Har moment ke liye sirf ye do (text screen par engine khud daalta hai):');
        P('      "fallback_plan": {');
        P(`        "allowed_pack_ids": [${(showScopes.length ? (packsByScope[showScopes[0]] || []) : []).slice(0, 4).map(x => `"${x}"`).join(', ')}],`);
        P('        "frame_hints": [ {"source_id":"<us show ka source>","time_sec":123,"reason":"kya dikh raha hai"} ],');
        P('        "overlay_text": "screen par jo 3-6 word likhna hai"');
        P('      }');
        P('    Yaani: analysis line ke peeche us show ka SAHI frame chalega, khali gradient nahi.');
      }
      for (const { r, scopeN } of grouped[pid]) {
        const need = isGraphic ? 'allowed_pack_ids + frame_hints' : (scopeN > 0 ? 'locator ya frame_hints' : 'SOURCE + locator');
        P(`  * ${r.m.moment_id}  (~${r.dur.toFixed(0)}s, chahiye: ${need})`);
        P(`      narration : "${r.m.script_cue_exact}"`);
        if (r.m.visual_intent) P(`      dikhana hai: ${r.m.visual_intent}`);
        const must = (r.m.must_show || (r.m.fallback_plan || {}).must_show || []);
        if (must.length) P(`      must_show : ${must.join(', ')}`);
      }
    }
    P('');
  }
  P('================================================================');
  P('END — output sirf JSON array do, upar wale shape mein.');
  P('================================================================');
  return L.join('\n') + '\n';
}
