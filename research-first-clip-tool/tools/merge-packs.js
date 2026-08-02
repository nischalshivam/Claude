#!/usr/bin/env node
// ============================================================
//  MERGE-PACKS — kai research packs ko ek valid pack mein jodta hai.
//
//  Kyun: Genspark ek account par din mein ek hi message deta hai. Isliye lambi
//  script ko 2-3 accounts par PART 1 / PART 2 / PART 3 karke chalana padta hai
//  (prompts/SPLIT_MODE_ADDENDUM.txt dekho). Ye tool un parts ko ek
//  scene-research.json bana deta hai — ID collision, duplicate source, aur
//  scope-title mismatch sab handle karke.
//
//  Usage:
//    node tools/merge-packs.js part1.json part2.json [part3.json] -o input/scene-research.json
//    node tools/merge-packs.js part*.json -o out.json --unify-titles
//
//  --unify-titles : ek jaise dikhne wale show titles ko ek canonical string
//                   bana deta hai (sabse zyada moments wala title jeetta hai).
//                   Bina iske sirf WARNING milti hai — kyunki "Naruto" aur
//                   "Naruto Shippuden" sach mein alag show hain, aur unhe
//                   apne-aap jodna cross-show bleed banata hai. Isliye ye
//                   decision tumhara hai, tool ka nahi.
//  Exit: 0 = merged, 1 = koi part invalid / merge nahi ho paya
// ============================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const validate = require(path.join(ROOT, 'src', 'validate.js'));
const F = require(path.join(ROOT, 'lib', 'fuzzy.js'));

const argv = process.argv.slice(2);
const flags = argv.filter(a => a.startsWith('-'));
const files = argv.filter(a => !a.startsWith('-'));
const outIdx = argv.findIndex(a => a === '-o' || a === '--out');
let outFile = outIdx >= 0 ? argv[outIdx + 1] : path.join(ROOT, 'input', 'scene-research.json');
const inputs = files.filter(f => f !== outFile);
const unify = flags.includes('--unify-titles');

const line = (c = '=') => console.log(c.repeat(66));
const die = m => { console.log('  [FAIL] ' + m); process.exit(1); };

line(); console.log('  MERGE PACKS — kai parts ko ek research pack banao'); line();
if (inputs.length < 2) die('kam se kam 2 part files do.\n         node tools/merge-packs.js part1.json part2.json -o input/scene-research.json');

// ---------- 1. har part padho + validate ----------
const parts = [];
for (const f of inputs) {
  if (!fs.existsSync(f)) die(`file nahi mili: ${f}`);
  const v = validate.validateFile(f);
  if (!v.ok) {
    console.log(`  [FAIL] ${path.basename(f)} invalid hai:`);
    (v.errors || []).slice(0, 10).forEach(e => console.log('         ' + e));
    die('pehle is part ko theek karao (ya usse dobara generate karao).');
  }
  const nM = v.pack.packs.reduce((a, p) => a + (p.moments || []).length, 0);
  console.log(`  [ok] ${path.basename(f).padEnd(28)} ${v.pack.packs.length} packs · ${nM} moments`);
  parts.push({ file: f, pack: v.pack, tag: 'X' + (parts.length + 1) });
}

// ---------- 2. ID collision -> part-prefix ----------
// Alag accounts aksar wahi IDs (P01, P01_S01) generate karte hain. Collision par
// us part ke SAARE ids ko prefix karte hain, taaki har reference sahi rahe.
const seenPack = new Set(), seenSrc = new Set(), seenMom = new Set();
const collide = [];
for (const p of parts) {
  let hit = false;
  for (const pk of p.pack.packs) {
    if (seenPack.has(pk.pack_id)) hit = true;
    for (const s of (pk.sources || [])) if (seenSrc.has(s.source_id)) hit = true;
    for (const m of (pk.moments || [])) if (seenMom.has(m.moment_id)) hit = true;
  }
  for (const pk of p.pack.packs) {
    seenPack.add(pk.pack_id);
    for (const s of (pk.sources || [])) seenSrc.add(s.source_id);
    for (const m of (pk.moments || [])) seenMom.add(m.moment_id);
  }
  if (hit) collide.push(p);
}
for (const p of parts) {
  if (!collide.includes(p)) continue;
  const pre = p.tag + '_';
  const packMap = {}, srcMap = {};
  for (const pk of p.pack.packs) { packMap[pk.pack_id] = pre + pk.pack_id; for (const s of (pk.sources || [])) srcMap[s.source_id] = pre + s.source_id; }
  for (const pk of p.pack.packs) {
    pk.pack_id = packMap[pk.pack_id];
    for (const s of (pk.sources || [])) s.source_id = srcMap[s.source_id];
    for (const m of (pk.moments || [])) {
      m.moment_id = pre + m.moment_id;
      for (const L of (m.locators || [])) if (srcMap[L.source_id]) L.source_id = srcMap[L.source_id];
      const fp = m.fallback_plan;
      if (fp) {
        if (Array.isArray(fp.allowed_pack_ids)) fp.allowed_pack_ids = fp.allowed_pack_ids.map(x => packMap[x] || x);
        if (Array.isArray(fp.allowed_source_ids)) fp.allowed_source_ids = fp.allowed_source_ids.map(x => srcMap[x] || x);
        for (const h of (fp.frame_hints || [])) if (srcMap[h.source_id]) h.source_id = srcMap[h.source_id];
      }
      const fb = m.fallback;
      if (fb && Array.isArray(fb.reuse_pack_ids)) fb.reuse_pack_ids = fb.reuse_pack_ids.map(x => packMap[x] || x);
    }
  }
  console.log(`  [i]  ${path.basename(p.file)}: IDs clash kar rahe the -> "${pre}" prefix laga diya`);
}

// ---------- 3. saare packs jodo ----------
const merged = {
  schema_version: 'scene-research-pack-v1',
  project_title: parts[0].pack.project_title || 'Merged project',
  packs: [],
  coverage_check: { entire_script_covered: false, uncovered_script_cues: [], packs_needing_more_research: [] },
};
for (const p of parts) merged.packs.push(...p.pack.packs);

// ---------- 4. duplicate sources (same video, alag id) ----------
// Do parts aksar ek hi episode ka URL alag source_id se dete hain. Download
// bank URL se chalta hai, isliye ye galat nahi — par report saaf rakhne ke liye
// bata dete hain.
const byVideo = {};
for (const pk of merged.packs) for (const s of (pk.sources || [])) {
  const key = s.video_id || s.url || s.local_file;
  if (!key) continue;
  (byVideo[key] = byVideo[key] || []).push(`${pk.pack_id}/${s.source_id}`);
}
const dupes = Object.entries(byVideo).filter(([, v]) => v.length > 1);
if (dupes.length) {
  console.log(`\n  [i]  ${dupes.length} video do jagah use ho rahi hai (theek hai — download ek hi baar hoga):`);
  dupes.slice(0, 5).forEach(([k, v]) => console.log(`         ${String(k).slice(0, 30)} -> ${v.join(', ')}`));
}

// ---------- 5. scope title mismatch ----------
const titles = {};
for (const pk of merged.packs) {
  if (!pk.scope || pk.scope.kind === 'GRAPHIC') continue;
  const t = String(pk.scope.title || '').trim();
  if (!t) continue;
  titles[t] = titles[t] || { packs: [], moments: 0 };
  titles[t].packs.push(pk.pack_id);
  titles[t].moments += (pk.moments || []).length;
}
const keys = Object.keys(titles);
const near = [];
for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
  const sim = F.score(keys[i].toLowerCase(), keys[j].toLowerCase()).score;
  if (sim >= 0.45) near.push([keys[i], keys[j], +sim.toFixed(2)]);
}
if (near.length) {
  console.log('\n  [!]  SCOPE TITLE MISMATCH — ek hi show alag-alag likha gaya hai:');
  for (const [a, b, s] of near) {
    console.log(`         "${a}"  (${titles[a].packs.join(',')}, ${titles[a].moments} moments)`);
    console.log(`         "${b}"  (${titles[b].packs.join(',')}, ${titles[b].moments} moments)   similarity ${s}`);
  }
  if (unify) {
    // sabse zyada moments wala title canonical
    for (const [a, b] of near) {
      const win = titles[a].moments >= titles[b].moments ? a : b;
      const lose = win === a ? b : a;
      for (const pk of merged.packs) if (pk.scope && String(pk.scope.title || '').trim() === lose) pk.scope.title = win;
      console.log(`         -> unified: "${lose}" ab "${win}"`);
    }
  } else {
    console.log('         Ye do alag show maane jayenge (ek ke sources doosre par nahi lagenge).');
    console.log('         Agar ye SACH MEIN ek hi show hai to --unify-titles ke saath dobara chalao,');
    console.log('         ya JSON mein title khud ek jaisa kar do.');
  }
}

// ---------- 6. coverage_check jodo ----------
const cc = merged.coverage_check;
for (const p of parts) {
  const c = p.pack.coverage_check || {};
  cc.uncovered_script_cues.push(...(c.uncovered_script_cues || []));
  cc.packs_needing_more_research.push(...(c.packs_needing_more_research || []));
}
cc.entire_script_covered = parts.every(p => (p.pack.coverage_check || {}).entire_script_covered === true)
  && !cc.uncovered_script_cues.length && !cc.packs_needing_more_research.length;
cc.merged_from = parts.map(p => path.basename(p.file));

// ---------- 7. likho + dobara validate ----------
fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(merged, null, 2));
const v2 = validate.validateFile(outFile);
const nM = merged.packs.reduce((a, p) => a + (p.moments || []).length, 0);
const nS = merged.packs.reduce((a, p) => a + (p.sources || []).length, 0);

line();
if (!v2.ok) {
  console.log('  [FAIL] merged pack validate nahi hua:');
  (v2.errors || []).slice(0, 10).forEach(e => console.log('         ' + e));
  line();
  process.exit(1);
}
console.log(`  MERGED: ${merged.packs.length} packs · ${nM} moments · ${nS} sources`);
console.log(`  likha : ${outFile}`);
console.log('  ab CHECKPACK.bat chalao — merged pack ka report card mil jayega.');
line();
process.exit(0);
