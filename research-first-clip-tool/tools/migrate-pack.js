#!/usr/bin/env node
// ============================================================
//  MIGRATE-PACK — purane pack ko naye rules ke laayak banata hai.
//
//  Do cheezein jo purane packs mein hoti hi nahi thi, aur dono chup-chaap
//  nuksaan karti hain:
//
//  1) criticality
//     Ye batati hai ki kaunsa beat bina ASLI footage ke chhap hi nahi sakta.
//     Candace pack ke 109/109 moments par ye field thi hi nahi, isliye engine ne
//     sabko NORMAL maan liya — yaani "critical beat par udhaar footage nahi" wala
//     poora bachav kisi bhi beat par laga hi nahi.
//
//  2) borrow approval
//     Purane packs mein `allowed_pack_ids` mein doosre EPISODE ka pack likha hota
//     hai (jaise P06 -> [P06, P01]). M3.6 ne default to episode-tight kar diya,
//     par ye purani likhi hui permission uska darwaza khula chhod deti thi.
//     Ab wo tabhi chalega jab yahan se saaf-saaf approve kiya jaye.
//
//  Ye tool KUCH GUESS NAHI karta jo dikhaye bina lag jaye — pehle poori list
//  dikhata hai (aur CSV likhta hai), --apply par hi pack chhuta hai.
//
//    node tools/migrate-pack.js input/scene-research.json
//    node tools/migrate-pack.js input/scene-research.json --apply
//    node tools/migrate-pack.js input/scene-research.json --apply --approve-borrow
// ============================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const validate = require(path.join(ROOT, 'src', 'validate.js'));
const SUB = require(path.join(ROOT, 'src', 'subtitles.js'));
const align = require(path.join(ROOT, 'src', 'align.js'));
const SCOPE = require(path.join(ROOT, 'src', 'scope.js'));

const argv = process.argv.slice(2);
const flags = argv.filter(a => a.startsWith('--'));
const args = argv.filter(a => !a.startsWith('--'));
const has = f => flags.includes('--' + f);
const packFile = args[0] || path.join(ROOT, 'input', 'scene-research.json');
const srtFile = args[1] || path.join(ROOT, 'input', 'voiceover.srt');
const outDir = path.join(ROOT, 'output');

const line = (c = '=') => console.log(c.repeat(72));
const die = m => { console.log('  [FAIL] ' + m); process.exit(1); };
const csvCell = s => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;

line(); console.log('  PACK MIGRATION — criticality + purani borrow permission'); line();
if (!fs.existsSync(packFile)) die(`pack nahi mila: ${packFile}`);
const v = validate.validateFile(packFile);
if (!v.ok) { (v.errors || []).slice(0, 6).forEach(e => console.log('  [FAIL] ' + e)); die('pack invalid hai.'); }

const raw = JSON.parse(fs.readFileSync(packFile, 'utf8'));
const idx = SCOPE.indexPack(v.pack);
const cues = fs.existsSync(srtFile) ? SUB.parseFile(srtFile) : [];
const HOOK_SECONDS = 45;      // video ka pehla ~45s — yahan galat visual sabse mehnga hai

// beat narration mein kahan aata hai (SRT ho to asli, warna pata nahi)
const startOf = m => {
  if (!cues.length) return null;
  const { best } = align.bestWindows(cues, m.script_cue_exact);
  return best ? best.start : null;
};

// EVIDENCE ke structural ishaare — pack ke apne fields se, narration ke matlab se nahi.
// (Ye tool editor nahi hai; wo faisla insaan ka hai. Isliye ye sirf wahan
//  HARD_EVIDENCE lagata hai jahan pack khud keh raha hai ki kuch DIKHNA chahiye.)
const EVIDENCE_PURPOSE = /(PROOF|EVIDENCE|REVEAL|SHOW|CLAIM|QUOTE|CITE)/i;

const changes = [], borrowRows = [];
for (const pk of (raw.packs || [])) {
  const graphic = SCOPE.isGraphic(pk.scope);
  const myEp = SCOPE.episodeKey(pk.scope), myWork = SCOPE.workKey(pk.scope);
  for (const m of (pk.moments || [])) {
    // ---- 1. criticality ----
    if (!m.criticality) {
      const at = startOf(m);
      const fp = m.fallback_plan || {};
      const mustShow = (fp.must_show || m.must_show || []).length > 0;
      const hasLocator = (m.locators || []).some(L => L.locator_type === 'EXACT_TIME' || L.locator_type === 'DIALOGUE');
      let crit = 'NORMAL', why = 'koi khaas ishaara nahi';
      if (!graphic && at != null && at <= HOOK_SECONDS) { crit = 'HOOK'; why = `video ke pehle ${HOOK_SECONDS}s mein hai`; }
      else if (!graphic && mustShow && hasLocator) { crit = 'HARD_EVIDENCE'; why = 'pack khud kehta hai ki kuch DIKHNA chahiye (must_show + locator)'; }
      else if (!graphic && EVIDENCE_PURPOSE.test(String(m.purpose || ''))) { crit = 'HARD_EVIDENCE'; why = `purpose "${String(m.purpose).slice(0, 24)}"`; }
      changes.push({ moment_id: m.moment_id, pack_id: pk.pack_id, field: 'criticality', value: crit, why,
        cue: String(m.script_cue_exact || '').slice(0, 90) });
    }
    // ---- 2. purani borrow permission ----
    const fp = m.fallback_plan || {};
    if (!graphic && (fp.allowed_pack_ids || []).length) {
      const foreign = fp.allowed_pack_ids.filter(pid => {
        const info = idx.byPack[pid];
        return info && !info.graphic && pid !== pk.pack_id && info.episode_key !== myEp;
      });
      if (foreign.length && !fp.borrow_approved && !fp.allow_context_borrow) {
        borrowRows.push({ moment_id: m.moment_id, pack_id: pk.pack_id, foreign,
          same_show: foreign.every(pid => (idx.byPack[pid] || {}).work_key === myWork),
          cue: String(m.script_cue_exact || '').slice(0, 90) });
      }
    }
  }
}

// ---------- dikhao ----------
const byCrit = {};
for (const c of changes) byCrit[c.value] = (byCrit[c.value] || 0) + 1;
if (changes.length) {
  console.log(`  ${changes.length} moments par criticality nahi hai. Tajweez:`);
  Object.entries(byCrit).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`     ${String(n).padStart(4)}  ${k}`));
  console.log('');
  const sample = changes.filter(c => c.value !== 'NORMAL').slice(0, 8);
  if (sample.length) {
    console.log('  (namune — NORMAL ke alawa)');
    sample.forEach(c => console.log(`     ${c.moment_id.padEnd(12)} ${c.value.padEnd(14)} ${c.why}`));
    console.log('');
  }
} else console.log('  criticality: har moment par pehle se likhi hai.');

if (borrowRows.length) {
  console.log(`  ${borrowRows.length} moments ki PURANI allowed_pack_ids doosre episode/show ka pack maang rahi hai:`);
  borrowRows.slice(0, 10).forEach(b => console.log(`     ${b.moment_id.padEnd(12)} ${b.pack_id} -> ${b.foreign.join(',')}   ${b.same_show ? '(wahi show, alag episode)' : '(DOOSRA SHOW)'}`));
  if (borrowRows.length > 10) console.log(`     ...aur ${borrowRows.length - 10}`);
  console.log('');
  console.log('  Jab tak approve na ho, engine ye packs ISTEMAAL NAHI karega (exact scene');
  console.log('  ki jagah kisi aur episode ka footage lag jana sabse chupa hua bug hai).');
  console.log('  Manzoor ho to: --apply --approve-borrow');
  console.log('');
}

// review ke liye CSV — yahi record hai ki migration ne kya-kya badla
fs.mkdirSync(outDir, { recursive: true });
const csv = ['moment_id,pack_id,field,value,wajah,narration'];
for (const c of changes) csv.push([c.moment_id, c.pack_id, c.field, c.value, c.why, c.cue].map(csvCell).join(','));
for (const b of borrowRows) csv.push([b.moment_id, b.pack_id, 'borrow_approved', has('approve-borrow') ? 'true' : '(pending)',
  `purana allowed_pack_ids: ${b.foreign.join(' ')}`, b.cue].map(csvCell).join(','));
const csvOut = path.join(outDir, 'migration-review.csv');
fs.writeFileSync(csvOut, csv.join('\n'));
console.log(`  poori list: ${path.relative(ROOT, csvOut)}  (spreadsheet mein khol lo)`);

if (!has('apply')) {
  line('-');
  console.log('  Ye sirf TAJWEEZ hai — pack ko haath nahi lagaya.');
  console.log(`    node tools/migrate-pack.js ${path.relative(ROOT, packFile)} --apply`);
  if (borrowRows.length) console.log('    (udhaar bhi manzoor karna ho to aage --approve-borrow lagao)');
  line();
  process.exit(changes.length || borrowRows.length ? 2 : 0);
}

// ---------- lagao ----------
const byId = {};
for (const pk of (raw.packs || [])) for (const m of (pk.moments || [])) byId[m.moment_id] = m;
for (const c of changes) { const m = byId[c.moment_id]; if (m && !m.criticality) m.criticality = c.value; }
let approved = 0;
if (has('approve-borrow')) {
  for (const b of borrowRows) {
    const m = byId[b.moment_id]; if (!m) continue;
    m.fallback_plan = m.fallback_plan || {};
    m.fallback_plan.borrow_approved = true;
    approved++;
  }
}
const tmp = packFile + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
fs.copyFileSync(packFile, packFile + '.bak');
fs.renameSync(tmp, packFile);
const v2 = validate.validateFile(packFile);
if (!v2.ok) {
  fs.copyFileSync(packFile + '.bak', packFile);
  (v2.errors || []).slice(0, 6).forEach(e => console.log('  ' + e));
  die('migrate hua pack validate nahi hua — purana wapas laga diya.');
}
line();
console.log(`  ${changes.length} moments par criticality likh di${approved ? `, ${approved} par udhaar manzoor kiya` : ''}.`);
console.log(`  backup: ${path.basename(packFile)}.bak`);
console.log('  Ab CHECKPACK.bat chalao — report card naya banega.');
line();
process.exit(0);
