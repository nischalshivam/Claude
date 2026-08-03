#!/usr/bin/env node
// ============================================================
//  APPLY-REPAIR — repair ke jawab (research-repair-v2) pack mein lagata hai.
//
//  Pehle kya galat tha (M3.6):
//  NEEDS_RESEARCH.txt jo cheezein maangta tha, apply tool unme se aadhi lagata
//  hi nahi tha — theek kiya hua `script_cue_exact`, `allowed_pack_ids`,
//  `overlay_text`, `criticality`, aur naya source add karna. Yaani Genspark ka
//  jawab aa bhi jata to 10 alignment problems waise ki waise reh jatin.
//
//  Ab ye poora contract lagata hai, aur SAHI TARTEEB mein:
//    1. sources (naye/replace/update)  — locators inhi ke duration par check honge
//    2. permissions (allowed packs/sources, borrow approval)  — hints inhi ke
//       hisaab se scope-check hote hain, isliye ye hints se PEHLE
//    3. moment ki baaki cheezein (cue, criticality, locators, hints, overlay)
//
//  Ek saath kitni bhi response files: default output/repair/responses/ ka
//  poora folder padh leta hai. Naam kuch bhi ho.
//
//    node tools/apply-repair.js
//    node tools/apply-repair.js input/scene-research.json                 (dry run)
//    node tools/apply-repair.js input/scene-research.json --apply
//    node tools/apply-repair.js input/scene-research.json a.json b.json --apply
//
//  Purana stage-2 format bhi chal jata hai (array / {entries:[...]}).
// ============================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const U = require(path.join(ROOT, 'src', 'util.js'));
const validate = require(path.join(ROOT, 'src', 'validate.js'));
const SCOPE = require(path.join(ROOT, 'src', 'scope.js'));
const ENUM = validate.ENUM;

const argv = process.argv.slice(2);
const flags = argv.filter(a => a.startsWith('--'));
const args = argv.filter(a => !a.startsWith('--'));
const has = f => flags.includes('--' + f);
const val = (f, d) => { const x = flags.find(y => y.startsWith('--' + f + '=')); return x ? x.slice(f.length + 3) : d; };

const packFile = args[0] || path.join(ROOT, 'input', 'scene-research.json');
const respDir = val('responses', path.join(ROOT, 'output', 'repair', 'responses'));
const explicit = args.slice(1);

const die = m => { console.log('  [FAIL] ' + m); process.exit(1); };
const line = (c = '=') => console.log(c.repeat(72));
const rel = p => { const r = path.relative(ROOT, p); return r.startsWith('..') ? p : r; };

line(); console.log('  APPLY REPAIR — research ke jawab pack mein lagao'); line();

if (!fs.existsSync(packFile)) die(`pack nahi mila: ${packFile}`);
const v0 = validate.validateFile(packFile);
if (!v0.ok) { (v0.errors || []).slice(0, 8).forEach(e => console.log('  [FAIL] ' + e)); die('pack invalid hai.'); }
const basePackSha = U.hashFile(packFile);
const raw = JSON.parse(fs.readFileSync(packFile, 'utf8'));

// ---------- kaunsi files padhni hain ----------
let inFiles = explicit.slice();
if (!inFiles.length) {
  if (!fs.existsSync(respDir)) die(`koi response file nahi di, aur folder bhi nahi hai:\n         ${rel(respDir)}\n         (REPAIR.bat -> prompts banao, phir jawab wahan daalo)`);
  inFiles = fs.readdirSync(respDir).filter(f => /\.(json|txt)$/i.test(f)).map(f => path.join(respDir, f));
  if (!inFiles.length) die(`${rel(respDir)} khaali hai — pehle repair prompts ke jawab wahan daalo.`);
}

// ---------- padho ----------
const momentUpdates = [], srcAdds = [], srcReplaces = [], srcUpdates = [], unresolved = [];
const seenBatches = [], fileNotes = [];
for (const f of inFiles) {
  if (!fs.existsSync(f)) { fileNotes.push(`${path.basename(f)}: file nahi mili — chhoda`); continue; }
  let txt = fs.readFileSync(f, 'utf8').trim();
  txt = txt.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  // kabhi-kabhi AI JSON ke aage-peeche ek line likh deta hai — pehla { ya [ se aakhri } ya ] tak lo
  if (!/^[[{]/.test(txt)) {
    const a = txt.search(/[[{]/), b = Math.max(txt.lastIndexOf('}'), txt.lastIndexOf(']'));
    if (a >= 0 && b > a) txt = txt.slice(a, b + 1);
  }
  let j;
  try { j = JSON.parse(txt); }
  catch (e) { fileNotes.push(`${path.basename(f)}: valid JSON nahi (${e.message.slice(0, 60)}) — chhoda`); continue; }

  const take = (o) => {
    if (!o || typeof o !== 'object') return;
    if (o.batch_id) seenBatches.push({ file: path.basename(f), batch_id: o.batch_id, base: o.base_pack_sha256 || null });
    for (const k of ['moment_updates', 'entries']) if (Array.isArray(o[k])) momentUpdates.push(...o[k]);
    if (Array.isArray(o.source_additions)) srcAdds.push(...o.source_additions);
    if (Array.isArray(o.source_replacements)) srcReplaces.push(...o.source_replacements);
    if (Array.isArray(o.replace_sources)) srcReplaces.push(...o.replace_sources);       // purana naam
    if (Array.isArray(o.source_updates)) srcUpdates.push(...o.source_updates);
    if (Array.isArray(o.unresolved)) unresolved.push(...o.unresolved);
    if (Array.isArray(o.broken_sources)) unresolved.push(...o.broken_sources);           // purana naam
    if (o.moment_id) momentUpdates.push(o);                                              // seedha ek moment
  };
  if (Array.isArray(j)) j.forEach(take); else take(j);
  fileNotes.push(`${path.basename(f)}: padh li`);
}
fileNotes.forEach(n => console.log('  [file] ' + n));
if (!momentUpdates.length && !srcAdds.length && !srcReplaces.length && !srcUpdates.length) die('koi lagane layak entry nahi mili.');

// base hash: sirf batana hai, rokna nahi — pack pehle hi thoda aage badh chuka ho sakta hai
const wrongBase = seenBatches.filter(b => b.base && b.base !== basePackSha);
if (wrongBase.length) {
  console.log('');
  console.log(`  [!] ${wrongBase.length} jawab kisi PURANE pack version par bane the (base hash alag hai).`);
  console.log('      Ye lag to jayenge, par jo moment beech mein badla hai uspar dhyan dena.');
  wrongBase.slice(0, 5).forEach(b => console.log(`        ${b.file} (batch ${b.batch_id})`));
}

// ---------- index ----------
const momentById = {}, packOfMoment = {};
for (const pk of (raw.packs || [])) for (const m of (pk.moments || [])) { momentById[m.moment_id] = m; packOfMoment[m.moment_id] = pk; }
const findSource = sid => { for (const pk of (raw.packs || [])) for (const s of (pk.sources || [])) if (s.source_id === sid) return s; return null; };
const packOfSource = sid => { for (const pk of (raw.packs || [])) for (const s of (pk.sources || [])) if (s.source_id === sid) return pk; return null; };
const looksLikeUrl = u => /^https?:\/\/[^\s"']+$/i.test(String(u || ''));

const ALIAS = {
  inspection: { WATCHED: 'VERIFIED_WATCHED', VIEWED: 'VERIFIED_WATCHED', VERIFIED: 'VERIFIED_WATCHED',
    TRANSCRIPT: 'TRANSCRIPT_CHECKED', CAPTIONS_CHECKED: 'TRANSCRIPT_CHECKED', METADATA: 'METADATA_ONLY' },
  sourceKind: { LICENSED_CLIP: 'LICENSED_UPLOAD', OFFICIAL_FULL_EPISODE: 'OFFICIAL_EPISODE',
    FULL_EPISODE: 'OFFICIAL_EPISODE', CLIP: 'OFFICIAL_CLIP', SCENE: 'CLEAN_SCENE', FAN_UPLOAD: 'OTHER' },
  criticality: { CRITICAL: 'HARD_EVIDENCE', EVIDENCE: 'HARD_EVIDENCE', PROOF: 'HARD_EVIDENCE',
    OPENING: 'HOOK', INTRO: 'HOOK', NORMAL: 'NORMAL', STANDARD: 'NORMAL' },
};
const CRITICALITY = ENUM.criticality || ['HOOK', 'HARD_EVIDENCE', 'NORMAL'];
const notes = [], rejects = [];
const rej = (mid, why) => rejects.push({ mid, why });
function normEnum(kind, value, who, allowedList) {
  if (value == null) return null;
  const s = String(value).trim().toUpperCase();
  const allowed = allowedList || ENUM[kind] || [];
  if (allowed.includes(s)) return s;
  const mapped = (ALIAS[kind] || {})[s];
  if (mapped && allowed.includes(mapped)) { notes.push(`${who}: ${kind} "${value}" -> "${mapped}"`); return mapped; }
  notes.push(`${who}: ${kind} "${value}" pehchana nahi — purani value rehne di`);
  return null;
}

// ============================================================
//  1. SOURCES pehle — locators/hints inhi ke duration par check honge
// ============================================================
let nSrcAdd = 0, nSrcRep = 0, nSrcUpd = 0;
for (const a of srcAdds) {
  const sid = String(a.source_id || '').trim();
  if (!sid) { notes.push('source_additions: source_id nahi — chhoda'); continue; }
  if (findSource(sid)) { notes.push(`source_additions: "${sid}" pehle se maujood hai — update ki tarah laga do`); srcUpdates.push(a); continue; }
  if (!looksLikeUrl(a.url) && !a.local_file) { notes.push(`source_additions: "${sid}" ka URL theek nahi lagta — chhoda`); continue; }
  const pid = a.pack_id;
  const pk = (raw.packs || []).find(p => p.pack_id === pid);
  if (!pk) { notes.push(`source_additions: "${sid}" ka pack_id "${pid}" pack mein nahi — chhoda`); continue; }
  const s = { source_id: sid, url: a.url || undefined, local_file: a.local_file || undefined,
    video_id: a.video_id || undefined, title: a.title || undefined, channel: a.channel || undefined,
    duration_sec: typeof a.duration_sec === 'number' ? a.duration_sec : undefined,
    has_captions: typeof a.has_captions === 'boolean' ? a.has_captions : undefined,
    source_kind: normEnum('sourceKind', a.source_kind, sid) || 'OTHER',
    inspection_status: normEnum('inspection', a.inspection_status, sid) || 'VERIFIED_WATCHED',
    availability_status: 'UNKNOWN',
    source_notes: `repair: added (${String(a.reason || 'new source').slice(0, 60)})`,
  };
  for (const k of Object.keys(s)) if (s[k] === undefined) delete s[k];
  pk.sources = pk.sources || [];
  pk.sources.push(s);
  nSrcAdd++; notes.push(`ADDED source ${sid} -> ${pid}`);
}
for (const r of srcReplaces) {
  const s = findSource(r.source_id);
  if (!s) { notes.push(`source_replacements: "${r.source_id}" pack mein nahi — chhoda`); continue; }
  if (!looksLikeUrl(r.url)) { notes.push(`source_replacements: "${r.source_id}" ka naya URL theek nahi lagta — chhoda`); continue; }
  const old = s.url || s.local_file || '(none)';
  s.url = r.url;
  if (r.video_id) s.video_id = r.video_id;
  if (r.title) s.title = r.title;
  if (r.channel) s.channel = r.channel;
  if (typeof r.duration_sec === 'number' && r.duration_sec > 0) s.duration_sec = r.duration_sec;
  const sk = normEnum('sourceKind', r.source_kind, r.source_id); if (sk) s.source_kind = sk;
  if (typeof r.has_captions === 'boolean') s.has_captions = r.has_captions;
  s.inspection_status = normEnum('inspection', r.inspection_status, r.source_id) || 'VERIFIED_WATCHED';
  // naya URL = purani health ab bekaar hai. Isse CHECKPACK dobara khol kar dekhega.
  s.availability_status = 'UNKNOWN';
  delete s.last_checked_at;
  s.source_notes = `repair: replaced (${String(r.reason || 'original unusable').slice(0, 60)})`;
  nSrcRep++; notes.push(`REPLACED ${r.source_id}: ${String(old).slice(0, 30)} -> ${String(r.url).slice(0, 30)}`);
}
for (const u of srcUpdates) {
  const s = findSource(u.source_id);
  if (!s) { notes.push(`source_updates: "${u.source_id}" pack mein nahi — chhoda`); continue; }
  const bits = [];
  if (typeof u.duration_sec === 'number' && u.duration_sec > 0 && u.duration_sec !== s.duration_sec) { bits.push(`duration ${s.duration_sec || '?'}s -> ${u.duration_sec}s`); s.duration_sec = u.duration_sec; }
  if (typeof u.has_captions === 'boolean' && u.has_captions !== s.has_captions) { bits.push(`captions ${u.has_captions}`); s.has_captions = u.has_captions; }
  const ins = normEnum('inspection', u.inspection_status, u.source_id);
  if (ins && ins !== s.inspection_status) { bits.push(`${s.inspection_status || '?'} -> ${ins}`); s.inspection_status = ins; }
  if (bits.length) { nSrcUpd++; notes.push(`updated ${u.source_id}: ${bits.join(', ')}`); }
}

// ============================================================
//  2. PERMISSIONS — hints/locators ke scope-check SE PEHLE
// ============================================================
//  Ye tarteeb zaroori hai. Pehle ulta tha: naya frame_hint PURANE allowed scope
//  par check hota tha aur reject ho jata tha, jabki usi jawab mein naya
//  allowed_pack_ids bhi aaya tha. Yaani sahi jawab bhi lagta nahi tha.
let nPerm = 0;
const scopeIdx = SCOPE.indexPack(v0.pack);
for (const e of momentUpdates) {
  const m = momentById[e.moment_id]; if (!m) continue;
  const pk = packOfMoment[e.moment_id];
  const fpIn = e.fallback_plan || e;
  const packs = fpIn.allowed_pack_ids, srcs = fpIn.allowed_source_ids;
  const borrow = fpIn.borrow_approved;
  if (!Array.isArray(packs) && !Array.isArray(srcs) && borrow == null) continue;
  m.fallback_plan = m.fallback_plan || {};
  if (Array.isArray(packs)) {
    const good = packs.filter(pid => scopeIdx.byPack[pid] || (raw.packs || []).some(p => p.pack_id === pid));
    const bad = packs.filter(pid => !good.includes(pid));
    if (bad.length) rej(e.moment_id, `allowed_pack_ids mein "${bad.join(',')}" koi pack hi nahi`);
    if (good.length) { m.fallback_plan.allowed_pack_ids = good; nPerm++; }
  }
  if (Array.isArray(srcs)) {
    const good = srcs.filter(sid => findSource(sid));
    const bad = srcs.filter(sid => !good.includes(sid));
    if (bad.length) rej(e.moment_id, `allowed_source_ids mein "${bad.join(',')}" koi source hi nahi`);
    if (good.length) { m.fallback_plan.allowed_source_ids = good; nPerm++; }
  }
  if (borrow != null) {
    // udhaar ki manzoori CRITICAL beat par kabhi nahi — wahan galat episode ka
    // footage sabse mehnga hai, aur yehi wo bug tha jo P06 par mila.
    const crit = String(e.criticality || m.criticality || 'NORMAL').toUpperCase();
    if (borrow === true && (crit === 'HOOK' || crit === 'HARD_EVIDENCE')) {
      rej(e.moment_id, `borrow_approved critical beat (${crit}) par nahi lag sakta`);
    } else { m.fallback_plan.borrow_approved = !!borrow; nPerm++; }
  }
}

// moment ke liye ab kaunse sources jaayaz hain (permissions LAGNE KE BAAD)
function allowedSourcesFor(mid) {
  const m = momentById[mid], pk = packOfMoment[mid];
  const fp = m.fallback_plan || {};
  if ((fp.allowed_source_ids || []).length) return new Set(fp.allowed_source_ids);
  const graphic = SCOPE.isGraphic(pk.scope);
  const showPacks = (raw.packs || []).filter(p => !SCOPE.isGraphic(p.scope)).map(p => p.pack_id);
  const packs = (fp.allowed_pack_ids || []).length ? fp.allowed_pack_ids : (graphic ? showPacks : [pk.pack_id]);
  const out = new Set();
  for (const p of (raw.packs || [])) if (packs.includes(p.pack_id)) for (const s of (p.sources || [])) out.add(s.source_id);
  return out;
}

// ============================================================
//  3. MOMENT ki baaki cheezein
// ============================================================
let nCue = 0, nCrit = 0, nLoc = 0, nHint = 0, nOverlay = 0, nMom = 0;
for (const e of momentUpdates) {
  const mid = e.moment_id;
  const m = momentById[mid];
  if (!m) { rej(mid, 'ye moment_id pack mein hai hi nahi'); continue; }
  const allow = allowedSourcesFor(mid);
  let touched = false;

  // ---- script_cue_exact ----
  //  M3.6 mein ye lagta hi nahi tha — isliye 10 alignment problems ka koi
  //  raasta hi nahi bacha tha. (Behtar ab bhi yahi hai ki inhe tools/fix-cues.js
  //  se LOCAL theek karo; ye raasta tab ke liye hai jab research ne bheja ho.)
  if (typeof e.script_cue_exact === 'string') {
    const nw = e.script_cue_exact.trim();
    if (nw.split(/\s+/).filter(Boolean).length < 4) rej(mid, `script_cue_exact bahut chhota: ${JSON.stringify(nw.slice(0, 40))}`);
    else if (nw !== m.script_cue_exact) { m.script_cue_exact = nw; nCue++; touched = true; }
  }

  // ---- criticality ----
  if (e.criticality != null) {
    const c = normEnum('criticality', e.criticality, mid, CRITICALITY);
    if (c && c !== m.criticality) { m.criticality = c; nCrit++; touched = true; }
  }

  // ---- overlay_text ----
  if (typeof e.overlay_text === 'string' || typeof (e.fallback_plan || {}).overlay_text === 'string') {
    const t = String(e.overlay_text ?? e.fallback_plan.overlay_text).trim();
    if (t) { m.fallback_plan = m.fallback_plan || {}; m.fallback_plan.overlay_text = t.slice(0, 120); nOverlay++; touched = true; }
  }

  // ---- locators ----
  const good = [];
  for (const Lc of (e.locators || [])) {
    const sid = Lc.source_id, src = findSource(sid);
    if (!src) { rej(mid, `source "${sid}" kisi pack mein nahi`); continue; }
    if (!allow.has(sid)) { rej(mid, `source "${sid}" is moment ke scope se bahar (allowed_pack_ids bhejo ya galat source hai)`); continue; }
    if (Lc.locator_type === 'EXACT_TIME') {
      const s = Lc.start_sec, en = Lc.end_sec;
      if (typeof s !== 'number' || typeof en !== 'number' || en <= s || s < 0) { rej(mid, `EXACT_TIME ka start/end galat (${s} -> ${en})`); continue; }
      if (src.duration_sec && s >= src.duration_sec) { rej(mid, `EXACT_TIME ${Math.round(s)}s source ki length ${src.duration_sec}s se bahar`); continue; }
      good.push({ source_id: sid, locator_type: 'EXACT_TIME', start_sec: +s, end_sec: +en,
        verification_method: Lc.verification_method || 'WATCHED', confidence: Lc.confidence || 'MEDIUM' });
    } else if (Lc.locator_type === 'DIALOGUE') {
      const d = String(Lc.dialogue_exact || '').trim();
      if (d.split(/\s+/).filter(Boolean).length < 3) { rej(mid, `DIALOGUE bahut chhota: ${JSON.stringify(d)}`); continue; }
      good.push({ source_id: sid, locator_type: 'DIALOGUE', dialogue_exact: d,
        dialogue_variants_verified: Lc.dialogue_variants_verified || [],
        nearby_context_terms: Lc.nearby_context_terms || [],
        verification_method: Lc.verification_method || 'TRANSCRIPT', confidence: Lc.confidence || 'MEDIUM' });
    } else rej(mid, `locator_type "${Lc.locator_type}" se footage nahi banti (sirf EXACT_TIME/DIALOGUE)`);
  }
  if (good.length) {
    good.sort((a, b) => (a.locator_type === 'DIALOGUE' ? 0 : 1) - (b.locator_type === 'DIALOGUE' ? 0 : 1));
    // jo locator hum TOOTA hua sabit kar chuke hain use rakhna bekaar hai —
    // par baaki purana usable evidence peeche rehne do.
    const keepSrc = new Set(good.map(g => g.source_id + '|' + g.locator_type));
    const keep = (m.locators || []).filter(x => (x.locator_type === 'EXACT_TIME' || x.locator_type === 'DIALOGUE')
      && !keepSrc.has(x.source_id + '|' + x.locator_type));
    m.locators = good.concat(keep);
    nLoc += good.length; touched = true;
  }

  // ---- frame_hints ----
  const rawHints = (e.frame_hints || (e.fallback_plan || {}).frame_hints || []);
  const hints = [];
  for (const h of rawHints) {
    const src = h && findSource(h.source_id);
    if (!src) { rej(mid, `frame_hint ka source "${h && h.source_id}" nahi mila`); continue; }
    if (!allow.has(h.source_id)) { rej(mid, `frame_hint source "${h.source_id}" scope se bahar`); continue; }
    const t = h.time_sec;
    if (typeof t !== 'number' || t < 0) { rej(mid, `frame_hint ka time_sec number nahi (${JSON.stringify(t)})`); continue; }
    if (src.duration_sec && t >= src.duration_sec) { rej(mid, `frame_hint ${Math.round(t)}s source ki length ${src.duration_sec}s se bahar`); continue; }
    hints.push({ source_id: h.source_id, time_sec: +t, reason: h.reason || h.what || '' });
  }
  if (hints.length) {
    m.fallback_plan = m.fallback_plan || {};
    const old = m.fallback_plan.frame_hints || [];
    const seen = new Set(old.map(h => h.source_id + '@' + Math.round(h.time_sec)));
    m.fallback_plan.frame_hints = old.concat(hints.filter(h => !seen.has(h.source_id + '@' + Math.round(h.time_sec))));
    nHint += hints.length; touched = true;
  }
  if (touched) nMom++;
}

// ---------- report ----------
line('-');
console.log(`  moments  : ${nMom} badle`);
console.log(`  evidence : ${nLoc} locators, ${nHint} frame_hints`);
console.log(`  text     : ${nCue} cue theek, ${nCrit} criticality, ${nOverlay} overlay`);
console.log(`  scope    : ${nPerm} permission updates`);
console.log(`  sources  : ${nSrcAdd} naye, ${nSrcRep} replace, ${nSrcUpd} update`);
if (notes.length) { console.log(''); notes.slice(0, 20).forEach(n => console.log('  [src] ' + n)); if (notes.length > 20) console.log(`  ...aur ${notes.length - 20}`); }
if (unresolved.length) {
  console.log(`\n  [!] ${unresolved.length} cheez research se bhi theek nahi hui — ye ab bhi khaali hain:`);
  unresolved.slice(0, 10).forEach(b => console.log(`        ${String(b.moment_id || b.source_id || '?').padEnd(12)} ${String(b.problem || '').slice(0, 60)}`));
}
if (rejects.length) {
  console.log(`\n  [!] ${rejects.length} entry REJECT hui (ye pack mein NAHI gayi):`);
  const byWhy = {};
  for (const r of rejects) (byWhy[r.why] = byWhy[r.why] || []).push(r.mid);
  Object.entries(byWhy).slice(0, 12).forEach(([why, ids]) =>
    console.log(`        ${ids.length}x  ${why}\n              ${ids.slice(0, 6).join(', ')}${ids.length > 6 ? ' ...' : ''}`));
}

if (!has('apply')) {
  line('-');
  console.log('  Ye DRY RUN tha — pack ko haath nahi lagaya.');
  console.log(`  Lagane ke liye:  node tools/apply-repair.js ${rel(packFile)} --apply`);
  line();
  process.exit(nMom || nSrcRep || nSrcAdd ? 2 : 0);
}

// ---------- atomically likho ----------
const tmp = packFile + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
fs.copyFileSync(packFile, packFile + '.bak');
fs.renameSync(tmp, packFile);
const v2 = validate.validateFile(packFile);
if (!v2.ok) {
  console.log('  [FAIL] badla hua pack validate nahi hua:');
  (v2.errors || []).slice(0, 8).forEach(e => console.log('         ' + e));
  fs.copyFileSync(packFile + '.bak', packFile);
  console.log('  purana pack wapas laga diya (.bak se) — kuch nahi bigda.');
  line(); process.exit(1);
}
line();
console.log(`  likha: ${rel(packFile)}   (backup: ${path.basename(packFile)}.bak)`);
// jo response files laga di, unhe hata do taaki agli baar dobara na lag jayein
if (!explicit.length && has('archive')) {
  const done = path.join(respDir, 'applied');
  fs.mkdirSync(done, { recursive: true });
  for (const f of inFiles) { try { fs.renameSync(f, path.join(done, path.basename(f))); } catch {} }
  console.log(`  response files ${rel(done)}\\ mein move kar di.`);
}
console.log('');
console.log('  Ab CHECKPACK dobara chalao — naya verdict turant mil jayega:');
console.log('     CHECKPACK.bat   (ya START_HERE.bat -> option 2)');
line();
process.exit(0);
