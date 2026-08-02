#!/usr/bin/env node
// ============================================================
//  APPLY-ROUND2 — round-2 ka JSON array pack mein merge karta hai.
//
//  83 moments ko haath se merge karna galti ka nyota hai. Ye tool har entry ko
//  check karke lagata hai, aur jo galat hai use LAGATA NAHI — batata hai.
//
//    node tools/apply-round2.js input/scene-research.json round2.json
//    node tools/apply-round2.js input/scene-research.json r1.json r2.json -o merged.json
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
const roundFiles = files.slice(1);

const die = m => { console.log('  [FAIL] ' + m); process.exit(1); };
const line = (c = '=') => console.log(c.repeat(66));

line(); console.log('  APPLY ROUND-2 — locators ko pack mein lagao'); line();
if (!packFile || !roundFiles.length) die('usage: node tools/apply-round2.js input/scene-research.json round2.json');
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

// round-2 entries padho (array, ya {entries:[...]}, ya JSON lines)
const entries = [], broken = [];
for (const f of roundFiles) {
  if (!fs.existsSync(f)) die(`round-2 file nahi mili: ${f}`);
  let raw = fs.readFileSync(f, 'utf8').trim();
  // AI kabhi-kabhi ```json fence laga deta hai — hata do
  raw = raw.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  let j;
  try { j = JSON.parse(raw); }
  catch (e) { die(`${path.basename(f)} valid JSON nahi hai: ${e.message.slice(0, 90)}`); }
  const arr = Array.isArray(j) ? j : (Array.isArray(j.entries) ? j.entries : [j]);
  for (const e of arr) {
    if (e && Array.isArray(e.broken_sources)) { broken.push(...e.broken_sources); continue; }
    if (e && e.moment_id) entries.push(e);
  }
  console.log(`  [ok] ${path.basename(f).padEnd(24)} ${arr.length} entries`);
}
if (!entries.length && !broken.length) die('koi usable entry nahi mili.');

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
if (broken.length) {
  console.log(`\n  [!] AI ne ${broken.length} source ko toota bataya — inhe khud badalna padega:`);
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
