#!/usr/bin/env node
// ============================================================
//  APPLY-STAGE2 — stage-2 ka JSON array pack mein merge karta hai.
//
//  83 moments ko haath se merge karna galti ka nyota hai. Ye tool har entry ko
//  check karke lagata hai, aur jo galat hai use LAGATA NAHI — batata hai.
//  Stage 2 sources bhi theek karta hai (dead URL ki jagah naya), wo bhi yahin
//  lagta hai — par sirf tab jab naya URL dhang ka ho.
//
//    node tools/apply-stage2.js input/scene-research.json stage2.json
//    node tools/apply-stage2.js input/scene-research.json s1.json s2.json -o merged.json
//
//  Default: pack ko usi jagah update karta hai (backup .bak ke saath).
//  Reject hone ki wajahein (chup-chaap kabhi nahi):
//    - moment_id pack mein hai hi nahi
//    - source_id kisi pack mein nahi / us moment ke allowed scope se bahar
//    - EXACT_TIME ka start/end galat ya source ki duration se bahar
//    - DIALOGUE bahut chhota (2 shabd wali line captions mein kahin bhi mil jayegi)
// ============================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const validate = require(path.join(ROOT, 'src', 'validate.js'));

const argv = process.argv.slice(2);
const oIdx = argv.findIndex(a => a === '-o' || a === '--out');
const outFile = oIdx >= 0 ? argv[oIdx + 1] : null;
// -o ke baad wali value output path hai, input nahi. (oIdx -1 ho to kuch skip mat karo.)
const files = argv.filter((a, i) => !a.startsWith('-') && !(oIdx >= 0 && i === oIdx + 1));
const packFile = files[0];
const stageFiles = files.slice(1);

const die = m => { console.log('  [FAIL] ' + m); process.exit(1); };
const line = (c = '=') => console.log(c.repeat(66));

line(); console.log('  APPLY STAGE-2 — verified sources + locators pack mein lagao'); line();
if (!packFile || !stageFiles.length) die('usage: node tools/apply-stage2.js input/scene-research.json stage2.json');
if (!fs.existsSync(packFile)) die(`pack nahi mila: ${packFile}`);

const v = validate.validateFile(packFile);
if (!v.ok) { (v.errors || []).slice(0, 8).forEach(e => console.log('  [FAIL] ' + e)); die('pack invalid hai.'); }
const pack = v.pack;

// index
const momentById = {}, packOfMoment = {};
for (const pk of pack.packs) for (const m of (pk.moments || [])) { momentById[m.moment_id] = m; packOfMoment[m.moment_id] = pk; }
const sourcesById = {};
for (const pk of pack.packs) for (const s of (pk.sources || [])) sourcesById[s.source_id] = { ...s, pack_id: pk.pack_id };
const showPacks = pack.packs.filter(pk => pk.scope && pk.scope.kind !== 'GRAPHIC').map(pk => pk.pack_id);

// stage-2 entries padho (array, ya {entries:[...]}, ya ek hi object)
const entries = [], broken = [], replaceSrc = [], srcUpdates = [];
for (const f of stageFiles) {
  if (!fs.existsSync(f)) die(`stage-2 file nahi mili: ${f}`);
  let raw = fs.readFileSync(f, 'utf8').trim();
  // AI kabhi-kabhi ```json fence laga deta hai — hata do
  raw = raw.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  let j;
  try { j = JSON.parse(raw); }
  catch (e) { die(`${path.basename(f)} valid JSON nahi hai: ${e.message.slice(0, 90)}`); }
  const arr = Array.isArray(j) ? j : (Array.isArray(j.entries) ? j.entries : [j]);
  for (const e of arr) {
    if (!e) continue;
    if (Array.isArray(e.broken_sources)) { broken.push(...e.broken_sources); continue; }
    if (Array.isArray(e.replace_sources)) { replaceSrc.push(...e.replace_sources); continue; }
    if (Array.isArray(e.source_updates)) { srcUpdates.push(...e.source_updates); continue; }
    if (e.moment_id) entries.push(e);
  }
  console.log(`  [ok] ${path.basename(f).padEnd(24)} ${arr.length} entries`);
}
if (!entries.length && !broken.length && !replaceSrc.length && !srcUpdates.length) die('koi usable entry nahi mili.');

// ---------- sources pehle theek karo (locators inhi par check honge) ----------
// Ye pehle isliye hota hai kyunki naye duration ke hisaab se hi timestamps
// validate honge. Purana galat duration rakhein to sahi timestamp bhi reject ho.
const srcNotes = [];
const findSourceObj = sid => { for (const pk of pack.packs) for (const s of (pk.sources || [])) if (s.source_id === sid) return s; return null; };
const looksLikeUrl = u => /^https?:\/\/[^\s"']+$/i.test(String(u || ''));

// AI aksar enum ke aas-paas ki value likh deta hai ("WATCHED", "LICENSED_CLIP").
// Unhe jaisa ka waisa pack mein likhna matlab schema todna. Jo saaf-saaf samajh
// aata hai use map karo, baaki chhod do (purani value rehne do) — kabhi guess nahi.
const ENUM = require(path.join(ROOT, 'src', 'validate.js')).ENUM;
const ALIAS = {
  inspection: { WATCHED: 'VERIFIED_WATCHED', VIEWED: 'VERIFIED_WATCHED', VERIFIED: 'VERIFIED_WATCHED',
    TRANSCRIPT: 'TRANSCRIPT_CHECKED', CAPTIONS_CHECKED: 'TRANSCRIPT_CHECKED', METADATA: 'METADATA_ONLY' },
  sourceKind: { LICENSED_CLIP: 'LICENSED_UPLOAD', OFFICIAL_FULL_EPISODE: 'OFFICIAL_EPISODE',
    FULL_EPISODE: 'OFFICIAL_EPISODE', CLIP: 'OFFICIAL_CLIP', SCENE: 'CLEAN_SCENE', FAN_UPLOAD: 'OTHER' },
};
function normEnum(kind, value, sid) {
  if (value == null) return null;
  const v = String(value).trim().toUpperCase();
  const allowed = ENUM[kind] || [];
  if (allowed.includes(v)) return v;
  const mapped = (ALIAS[kind] || {})[v];
  if (mapped) { srcNotes.push(`${sid}: ${kind} "${value}" -> "${mapped}"`); return mapped; }
  srcNotes.push(`${sid}: ${kind} "${value}" pehchana nahi — purani value rehne di`);
  return null;
}

for (const r of replaceSrc) {
  const s = findSourceObj(r.source_id);
  if (!s) { srcNotes.push(`replace_sources: "${r.source_id}" pack mein nahi — chhoda`); continue; }
  if (!looksLikeUrl(r.url)) { srcNotes.push(`replace_sources: "${r.source_id}" ka naya URL theek nahi lagta — chhoda`); continue; }
  const old = s.url || s.local_file || '(none)';
  s.url = r.url;
  if (r.video_id) s.video_id = r.video_id;
  if (r.title) s.title = r.title;
  if (r.channel) s.channel = r.channel;
  if (typeof r.duration_sec === 'number' && r.duration_sec > 0) s.duration_sec = r.duration_sec;
  const sk = normEnum('sourceKind', r.source_kind, r.source_id); if (sk) s.source_kind = sk;
  if (typeof r.has_captions === 'boolean') s.has_captions = r.has_captions;
  s.inspection_status = normEnum('inspection', r.inspection_status, r.source_id) || 'VERIFIED_WATCHED';
  s.source_notes = `stage2 replaced (${r.reason || 'original unusable'})`;
  sourcesById[r.source_id] = { ...s, pack_id: (sourcesById[r.source_id] || {}).pack_id };
  srcNotes.push(`REPLACED ${r.source_id}: ${String(old).slice(0, 34)} -> ${String(r.url).slice(0, 34)}`);
}
for (const u of srcUpdates) {
  const s = findSourceObj(u.source_id);
  if (!s) { srcNotes.push(`source_updates: "${u.source_id}" pack mein nahi — chhoda`); continue; }
  const bits = [];
  if (typeof u.duration_sec === 'number' && u.duration_sec > 0 && u.duration_sec !== s.duration_sec) { bits.push(`duration ${s.duration_sec || '?'}s -> ${u.duration_sec}s`); s.duration_sec = u.duration_sec; }
  if (typeof u.has_captions === 'boolean' && u.has_captions !== s.has_captions) { bits.push(`captions ${u.has_captions}`); s.has_captions = u.has_captions; }
  const ins = normEnum('inspection', u.inspection_status, u.source_id);
  if (ins && ins !== s.inspection_status) { bits.push(`${s.inspection_status || '?'} -> ${ins}`); s.inspection_status = ins; }
  if (bits.length) { sourcesById[u.source_id] = { ...s, pack_id: (sourcesById[u.source_id] || {}).pack_id }; srcNotes.push(`updated ${u.source_id}: ${bits.join(', ')}`); }
}
if (srcNotes.length) { console.log(''); srcNotes.forEach(n => console.log('  [src] ' + n)); }

// allowed scope for a moment
function allowedSourcesFor(mid) {
  const m = momentById[mid], pk = packOfMoment[mid];
  const fp = m.fallback_plan || {};
  if ((fp.allowed_source_ids || []).length) return new Set(fp.allowed_source_ids);
  const packs = (fp.allowed_pack_ids || []).length ? fp.allowed_pack_ids
    : (pk.scope && pk.scope.kind === 'GRAPHIC' ? showPacks : [pk.pack_id]);
  return new Set(Object.values(sourcesById).filter(s => packs.includes(s.pack_id)).map(s => s.source_id));
}

const rejects = [];
let nLoc = 0, nHint = 0, nMom = 0;
const rej = (mid, why) => rejects.push({ mid, why });

for (const e of entries) {
  const mid = e.moment_id;
  const m = momentById[mid];
  if (!m) { rej(mid, 'ye moment_id pack mein hai hi nahi'); continue; }
  const allow = allowedSourcesFor(mid);
  let touched = false;

  // ---- locators ----
  const good = [];
  for (const Lc of (e.locators || [])) {
    const sid = Lc.source_id, src = sourcesById[sid];
    if (!src) { rej(mid, `source "${sid}" kisi pack mein nahi`); continue; }
    if (!allow.has(sid)) { rej(mid, `source "${sid}" is moment ke scope se bahar (cross-show block)`); continue; }
    if (Lc.locator_type === 'EXACT_TIME') {
      const s = Lc.start_sec, en = Lc.end_sec;
      if (typeof s !== 'number' || typeof en !== 'number' || en <= s || s < 0) { rej(mid, `EXACT_TIME ka start/end galat (${s} -> ${en})`); continue; }
      if (src.duration_sec && s >= src.duration_sec) { rej(mid, `EXACT_TIME ${Math.round(s)}s source ki length ${src.duration_sec}s se bahar`); continue; }
      good.push({ source_id: sid, locator_type: 'EXACT_TIME', start_sec: +s, end_sec: +en, verification_method: Lc.verification_method || 'WATCHED', confidence: Lc.confidence || 'MEDIUM' });
    } else if (Lc.locator_type === 'DIALOGUE') {
      const d = String(Lc.dialogue_exact || '').trim();
      if (d.split(/\s+/).filter(Boolean).length < 3) { rej(mid, `DIALOGUE bahut chhota: ${JSON.stringify(d)}`); continue; }
      good.push({ source_id: sid, locator_type: 'DIALOGUE', dialogue_exact: d,
        dialogue_variants_verified: Lc.dialogue_variants_verified || [],
        nearby_context_terms: Lc.nearby_context_terms || [],
        verification_method: Lc.verification_method || 'TRANSCRIPT', confidence: Lc.confidence || 'MEDIUM' });
    } else { rej(mid, `locator_type "${Lc.locator_type}" se footage nahi banti (sirf EXACT_TIME/DIALOGUE)`); }
  }
  if (good.length) {
    // DIALOGUE pehle — wo upload ke offset ko khud theek kar leta hai
    good.sort((a, b) => (a.locator_type === 'DIALOGUE' ? 0 : 1) - (b.locator_type === 'DIALOGUE' ? 0 : 1));
    const keep = (m.locators || []).filter(x => x.locator_type === 'EXACT_TIME' || x.locator_type === 'DIALOGUE');
    m.locators = good.concat(keep);   // naya evidence pehle, purana usable evidence peeche
    nLoc += good.length; touched = true;
  }

  // ---- frame_hints (entry par ya fallback_plan ke andar, dono accept) ----
  const rawHints = (e.frame_hints || (e.fallback_plan || {}).frame_hints || []);
  const hints = [];
  for (const h of rawHints) {
    if (!h || !sourcesById[h.source_id]) { rej(mid, `frame_hint ka source "${h && h.source_id}" nahi mila`); continue; }
    if (!allow.has(h.source_id)) { rej(mid, `frame_hint source "${h.source_id}" scope se bahar`); continue; }
    const t = h.time_sec;
    if (typeof t !== 'number' || t < 0) { rej(mid, `frame_hint ka time_sec number nahi (${JSON.stringify(t)})`); continue; }
    const src = sourcesById[h.source_id];
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
console.log(`  laga diya : ${nLoc} locators + ${nHint} frame_hints  ->  ${nMom} moments`);
if (replaceSrc.length) console.log(`  sources   : ${replaceSrc.length} replace kiye, ${srcUpdates.length} update`);
if (broken.length) {
  console.log(`\n  [!] ${broken.length} source aisa hai jiska replacement bhi nahi mila — ye khud dhoondhna padega:`);
  broken.forEach(b => console.log(`        ${String(b.source_id).padEnd(12)} ${String(b.problem || '').slice(0, 60)}`));
}
if (rejects.length) {
  console.log(`\n  [!] ${rejects.length} entry REJECT hui (ye pack mein NAHI gayi):`);
  const byWhy = {};
  for (const r of rejects) (byWhy[r.why] = byWhy[r.why] || []).push(r.mid);
  Object.entries(byWhy).slice(0, 12).forEach(([why, ids]) =>
    console.log(`        ${ids.length}x  ${why}\n              ${ids.slice(0, 6).join(', ')}${ids.length > 6 ? ' ...' : ''}`));
}

// ---------- likho ----------
const target = outFile || packFile;
if (!outFile && fs.existsSync(packFile)) fs.copyFileSync(packFile, packFile + '.bak');
fs.writeFileSync(target, JSON.stringify(pack, null, 2));
const v2 = validate.validateFile(target);
line();
if (!v2.ok) {
  console.log('  [FAIL] updated pack validate nahi hua:');
  (v2.errors || []).slice(0, 8).forEach(e => console.log('         ' + e));
  if (!outFile) { fs.copyFileSync(packFile + '.bak', packFile); console.log('  purana pack wapas restore kar diya (.bak se).'); }
  line(); process.exit(1);
}
const rel = p => { const r = path.relative(ROOT, p); return r.startsWith('..') ? p : r; };
console.log(`  likha: ${rel(target)}${outFile ? '' : `   (backup: ${rel(packFile + '.bak')})`}`);
console.log('  ab CHECKPACK.bat chalao — naya verdict mil jayega.');
line();
process.exit(0);
