#!/usr/bin/env node
// ============================================================
//  MERGE-PACK (M4.1) — do packs ka teen-tarfa merge, bina kuch khoye.
//
//  Ye kyun bana:
//  "Purana folder replace kar do" wali salaah ne asli nuksaan kiya. Naye ZIP ke
//  saath jo pack aaya, wo M3.6.1 wale REPAIRED pack se purana tha — 19 locators
//  aur 19 frame hints chup-chaap gayab ho gaye, aur coverage ~78.7% se wapas
//  ~66.8% par gir gayi. User ne kuch galat nahi kiya; workflow galat tha.
//
//  Ye tool dono ka behtareen hissa rakhta hai:
//    BASE  (abhi wala pack)  -> theek kiye hue cues + criticality + borrow approvals
//    DONOR (purana repaired) -> verified locators, frame hints, source health
//
//  Usool:
//   - Base ka text (script_cue_exact) aur criticality KABHI nahi badalta.
//   - Donor se sirf WO cheezein aati hain jo base mein hain hi nahi.
//   - Har aane wali cheez validate hoti hai (source maujood hai? timestamp
//     source ki length ke andar hai? dialogue itna lamba hai ki match ho sake?).
//   - Kuch bhi chup-chaap nahi: har accept/reject merge report mein likha jata hai.
//
//    node tools/merge-pack.js input/scene-research.json purana/scene-research.json
//    node tools/merge-pack.js input/scene-research.json purana/scene-research.json --apply
// ============================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const validate = require(path.join(ROOT, 'src', 'validate.js'));

const argv = process.argv.slice(2);
const flags = argv.filter(a => a.startsWith('--'));
const args = argv.filter(a => !a.startsWith('--'));
const has = f => flags.includes('--' + f);
const baseFile = args[0] || path.join(ROOT, 'input', 'scene-research.json');
const donorFile = args[1];

const line = (c = '=') => console.log(c.repeat(72));
const die = m => { console.log('  [FAIL] ' + m); process.exit(1); };
const rel = p => { const r = path.relative(ROOT, p); return r.startsWith('..') ? p : r; };

line(); console.log('  PACK MERGE — purane repaired pack ka evidence naye pack mein laao'); line();
if (!donorFile) die('usage: node tools/merge-pack.js <abhi-wala-pack> <purana-repaired-pack> [--apply]');
for (const f of [baseFile, donorFile]) if (!fs.existsSync(f)) die(`nahi mila: ${f}`);

const vb = validate.validateFile(baseFile);
if (!vb.ok) { (vb.errors || []).slice(0, 6).forEach(e => console.log('  ' + e)); die('abhi wala pack invalid hai.'); }
const vd = validate.validateFile(donorFile);
if (!vd.ok) { (vd.errors || []).slice(0, 6).forEach(e => console.log('  ' + e)); die('purana pack invalid hai.'); }

const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
const donor = JSON.parse(fs.readFileSync(donorFile, 'utf8'));

// ---------- index ----------
const idx = (pack) => {
  const moments = {}, sources = {}, packOf = {};
  for (const pk of (pack.packs || [])) {
    for (const m of (pk.moments || [])) { moments[m.moment_id] = m; packOf[m.moment_id] = pk.pack_id; }
    for (const s of (pk.sources || [])) sources[s.source_id] = s;
  }
  return { moments, sources, packOf };
};
const B = idx(base), D = idx(donor);

const count = (pack) => {
  let loc = 0, hints = 0, withLoc = 0, withHints = 0;
  for (const pk of (pack.packs || [])) for (const m of (pk.moments || [])) {
    const L = (m.locators || []).filter(x => x.locator_type === 'EXACT_TIME' || x.locator_type === 'DIALOGUE');
    const h = ((m.fallback_plan || {}).frame_hints || []);
    loc += L.length; hints += h.length;
    if (L.length) withLoc++; if (h.length) withHints++;
  }
  return { loc, hints, withLoc, withHints };
};
const before = count(base), donorC = count(donor);
console.log(`  abhi wala : ${Object.keys(B.moments).length} moments · ${before.loc} locators · ${before.hints} hints · ${before.withLoc} moments par locator`);
console.log(`  purana    : ${Object.keys(D.moments).length} moments · ${donorC.loc} locators · ${donorC.hints} hints · ${donorC.withLoc} moments par locator`);
console.log('');

// ---------- validation helpers ----------
const accepted = [], rejected = [];
const acc = (what, id, detail) => accepted.push({ what, id, detail });
const rej = (what, id, why) => rejected.push({ what, id, why });

// source jispar ye evidence hai — base mein hona chahiye, aur uski length ke andar
function sourceOk(sid) { return !!B.sources[sid]; }
function withinDuration(sid, t) {
  const s = B.sources[sid];
  if (!s || !s.duration_sec) return true;      // duration pata nahi to bounds check skip
  return t < s.duration_sec;
}
// wahi locator dobara na aaye
const locKey = L => L.locator_type === 'EXACT_TIME'
  ? `T|${L.source_id}|${Math.round(L.start_sec)}`
  : `D|${L.source_id}|${String(L.dialogue_exact || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60)}`;
const hintKey = h => `${h.source_id}@${Math.round(h.time_sec)}`;

let addedLoc = 0, addedHints = 0, addedHealth = 0, touched = 0;

for (const mid of Object.keys(D.moments)) {
  const dm = D.moments[mid], bm = B.moments[mid];
  if (!bm) { rej('moment', mid, 'ye moment ab pack mein hai hi nahi'); continue; }
  let changed = false;

  // ---- locators (union) ----
  const have = new Set((bm.locators || []).map(locKey));
  for (const L of (dm.locators || [])) {
    if (L.locator_type !== 'EXACT_TIME' && L.locator_type !== 'DIALOGUE') continue;
    if (have.has(locKey(L))) continue;                        // pehle se hai
    if (!sourceOk(L.source_id)) { rej('locator', mid, `source ${L.source_id} ab pack mein nahi`); continue; }
    if (L.locator_type === 'EXACT_TIME') {
      if (typeof L.start_sec !== 'number' || typeof L.end_sec !== 'number' || L.end_sec <= L.start_sec) { rej('locator', mid, 'EXACT_TIME ka start/end galat'); continue; }
      if (!withinDuration(L.source_id, L.start_sec)) { rej('locator', mid, `${Math.round(L.start_sec)}s source ki length se bahar`); continue; }
    } else {
      const words = String(L.dialogue_exact || '').trim().split(/\s+/).filter(Boolean).length;
      if (words < 3) { rej('locator', mid, 'DIALOGUE bahut chhota'); continue; }
    }
    bm.locators = bm.locators || [];
    bm.locators.push(L);
    have.add(locKey(L));
    addedLoc++; changed = true;
    acc('locator', mid, `${L.locator_type} ${L.source_id}`);
  }

  // ---- frame hints (union) ----
  const dh = ((dm.fallback_plan || {}).frame_hints || []);
  if (dh.length) {
    bm.fallback_plan = bm.fallback_plan || {};
    const cur = bm.fallback_plan.frame_hints || [];
    const seen = new Set(cur.map(hintKey));
    for (const h of dh) {
      if (!h || typeof h.time_sec !== 'number' || h.time_sec < 0) { rej('hint', mid, 'time_sec galat'); continue; }
      if (seen.has(hintKey(h))) continue;
      if (!sourceOk(h.source_id)) { rej('hint', mid, `source ${h.source_id} ab pack mein nahi`); continue; }
      if (!withinDuration(h.source_id, h.time_sec)) { rej('hint', mid, `${Math.round(h.time_sec)}s source ki length se bahar`); continue; }
      cur.push(h); seen.add(hintKey(h));
      addedHints++; changed = true;
      acc('hint', mid, `${h.source_id}@${Math.round(h.time_sec)}s`);
    }
    bm.fallback_plan.frame_hints = cur;
  }

  // NOTE: script_cue_exact aur criticality JAAN-BOOJH kar nahi chhuye.
  // Base ke cues abhi voiceover se hubahu milaye gaye hain, aur criticality
  // migrate ho chuki hai — donor ke purane values inhe kharab kar denge.
  if (changed) touched++;
}

// ---- source health (naapi hui baat) ----
for (const sid of Object.keys(D.sources)) {
  const ds = D.sources[sid], bs = B.sources[sid];
  if (!bs) { rej('source', sid, 'ye source ab pack mein nahi'); continue; }
  const bits = [];
  if (ds.duration_sec && !bs.duration_sec) { bs.duration_sec = ds.duration_sec; bits.push(`duration ${ds.duration_sec}s`); }
  if (typeof ds.has_captions === 'boolean' && typeof bs.has_captions !== 'boolean') { bs.has_captions = ds.has_captions; bits.push(`captions ${ds.has_captions}`); }
  if (ds.availability_status && !bs.availability_status) { bs.availability_status = ds.availability_status; bits.push(`availability ${ds.availability_status}`); }
  if (ds.last_checked_at && !bs.last_checked_at) { bs.last_checked_at = ds.last_checked_at; bits.push('last_checked_at'); }
  // inspection sirf UPAR ki taraf badhta hai — DEAD_VERIFIED/TRANSCRIPT_CHECKED
  // ko METADATA_ONLY se badalna galat hoga.
  const RANK = { METADATA_ONLY: 0, TRANSCRIPT_CHECKED: 1, VERIFIED_WATCHED: 2, DEAD_VERIFIED: 3 };
  if (ds.inspection_status && (RANK[ds.inspection_status] || 0) > (RANK[bs.inspection_status] || 0)) {
    bs.inspection_status = ds.inspection_status; bits.push(`status ${ds.inspection_status}`);
  }
  if (bits.length) { addedHealth++; acc('source', sid, bits.join(', ')); }
}

// ---------- report ----------
const after = count(base);
line('-');
console.log(`  locators : ${before.loc} -> ${after.loc}   (+${addedLoc})`);
console.log(`  hints    : ${before.hints} -> ${after.hints}   (+${addedHints})`);
console.log(`  moments  : ${before.withLoc} -> ${after.withLoc} par locator   (${touched} moments badle)`);
console.log(`  sources  : ${addedHealth} par health info aayi`);
if (rejected.length) {
  console.log('');
  console.log(`  ${rejected.length} cheezein NAHI li gayi (ye jaan-boojh kar chhodi hain):`);
  const byWhy = {};
  for (const r of rejected) (byWhy[r.why] = byWhy[r.why] || []).push(r.id);
  Object.entries(byWhy).slice(0, 10).forEach(([why, ids]) =>
    console.log(`     ${String(ids.length).padStart(3)}x  ${why}   (${[...new Set(ids)].slice(0, 4).join(', ')}${ids.length > 4 ? ' ...' : ''})`));
}

// merge report — machine readable, taaki baad mein sawal na ho ki kya aaya
const outDir = path.join(ROOT, 'output');
fs.mkdirSync(outDir, { recursive: true });
const reportFile = path.join(outDir, 'pack-merge-report.json');
fs.writeFileSync(reportFile, JSON.stringify({
  schema: 'pack-merge-report-v1', generated_at: new Date().toISOString(),
  base_file: path.basename(baseFile), donor_file: path.basename(donorFile),
  before, after, donor: donorC,
  added: { locators: addedLoc, frame_hints: addedHints, source_health: addedHealth, moments_touched: touched },
  accepted, rejected,
  preserved: 'script_cue_exact aur criticality base se jaise the waise hi hain',
}, null, 2));
console.log('');
console.log(`  poori list: ${rel(reportFile)}`);

if (!has('apply')) {
  line('-');
  console.log('  Ye DRY RUN tha — pack ko haath nahi lagaya.');
  console.log(`  Lagane ke liye:  node tools/merge-pack.js ${rel(baseFile)} ${rel(donorFile)} --apply`);
  line();
  process.exit(addedLoc || addedHints || addedHealth ? 2 : 0);
}

if (!addedLoc && !addedHints && !addedHealth) { console.log('  Lagane ko kuch naya nahi tha.'); line(); process.exit(0); }
const tmp = baseFile + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(base, null, 2));
fs.copyFileSync(baseFile, baseFile + '.bak');
fs.renameSync(tmp, baseFile);
const v2 = validate.validateFile(baseFile);
if (!v2.ok) {
  fs.copyFileSync(baseFile + '.bak', baseFile);
  (v2.errors || []).slice(0, 8).forEach(e => console.log('  ' + e));
  die('merge ke baad pack validate nahi hua — purana wapas laga diya, kuch nahi bigda.');
}
line();
console.log(`  Ho gaya. ${addedLoc} locators + ${addedHints} hints wapas aa gaye.`);
console.log(`  backup: ${path.basename(baseFile)}.bak`);
console.log('  Ab CHECKPACK.bat chalao — coverage badhi hui dikhni chahiye.');
line();
process.exit(0);
