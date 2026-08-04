#!/usr/bin/env node
// ============================================================
//  RECOVER ORPHANED MEDIA (M4.2.1)
//
//  Kyun ye bana:
//  M4.1 mein ek bug tha — jaise hi user kisi gap mein media daalta tha, wo
//  jagah agle plan mein "gap" hi nahi rehti thi, aur purana code use "ab
//  zaroorat nahi" samajh kar DATA\_ORPHANED mein daal deta tha. Uske saath
//  user ka dhoondha hua media bhi chala jata tha aur gap wapas khul jata tha.
//  Asli Candace project mein aise 16 folder orphan hue.
//
//  M4.2 ne aisa dobara hone se roka. Par jo pehle se _ORPHANED mein pada hai,
//  wo apne aap wapas nahi aata — aur user se ye kehna ki "16 folder haath se
//  wapas copy karo" ek production tool ka jawab nahi hai.
//
//  Ye tool wahi kaam karta hai, aur teen usoolon par:
//    1. Kabhi kisi maujooda file ko overwrite nahi karta.
//    2. Jo pakka match nahi hai use apne aap nahi lagata — suggestion deta hai.
//    3. _ORPHANED se kuch delete nahi karta (copy karta hai), taaki galti hui
//       to bhi asli files wahin surakshit rahein.
//
//  Milane ka tarika (isi tarteeb mein):
//    1. request_key hubahu same
//    2. wahi project + moment_ids milte hain + range overlap
//    3. range overlap + narration ki similarity
//    4. warna chhod do aur suggestion likh do
//
//  Chalao:
//    node tools/recover-orphaned-media.js --dry-run     (kuch nahi badlega)
//    node tools/recover-orphaned-media.js --apply
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const U = require(path.join(__dirname, '..', 'src', 'util.js'));
const manual = require(path.join(__dirname, '..', 'src', 'manual.js'));
const F = require(path.join(__dirname, '..', 'lib', 'fuzzy.js'));

const arg = (name, def = null) => {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : def;
};
const flag = n => process.argv.includes(`--${n}`);

const DATA = path.resolve(arg('data', U.dataRoot()));
const ORPH = path.join(DATA, '_ORPHANED');
const APPLY = flag('apply');
const MIN_NARRATION = Number(arg('min-similarity', '0.55'));

const isReqDir = n => /^MISSING_\d{3}__/.test(n);
const overlap = (a, b) => Math.max(0, Math.min(a.end_sec, b.end_sec) - Math.max(a.start_sec, b.start_sec));

/** _ORPHANED ke andar har request folder dhoondho (stamp folders ke ek level neeche). */
function findOrphans(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const walk = (dir, depth) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = path.join(dir, n);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (!st.isDirectory()) continue;
      if (isReqDir(n) && fs.existsSync(path.join(p, 'request.json'))) { out.push(p); continue; }
      if (depth < 3) walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

function mediaFiles(dir) {
  const m = path.join(dir, 'media');
  try {
    return fs.readdirSync(m).filter(n => !n.startsWith('.'))
      .map(n => path.join(m, n))
      .filter(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  } catch { return []; }
}

function readReq(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'request.json'), 'utf8')); } catch { return null; }
}

/** Ek orphan ke liye sabse achha maujooda target dhoondho. */
function matchTarget(orphan, targets) {
  const oKey = manual.requestKey(orphan.req);
  // 1. hubahu key
  for (const t of targets) if (oKey && manual.requestKey(t.req) === oKey) {
    return { target: t, confidence: 'EXACT', how: 'request_key hubahu same hai' };
  }
  const oRange = orphan.req.range || {};
  const oMoments = new Set(orphan.req.moment_ids || []);
  const oProj = orphan.req.project_id || null;

  // 2. wahi project + moments + range overlap
  let best = null;
  for (const t of targets) {
    if (oProj && t.req.project_id && oProj !== t.req.project_id) continue;
    const tMoments = (t.req.moment_ids || []).filter(m => oMoments.has(m));
    if (!tMoments.length) continue;
    const ov = overlap(oRange, t.req.range || {});
    if (ov <= 0) continue;
    const score = tMoments.length * 100 + ov;
    if (!best || score > best.score) best = { target: t, score, shared: tMoments.length, ov };
  }
  if (best) {
    return { target: best.target, confidence: 'STRONG',
      how: `${best.shared} moment same hain aur ${best.ov.toFixed(1)}s range overlap karti hai` };
  }

  // 3. range overlap + narration similarity
  let sim = null;
  for (const t of targets) {
    if (oProj && t.req.project_id && oProj !== t.req.project_id) continue;
    const ov = overlap(oRange, t.req.range || {});
    if (ov <= 0) continue;
    const s = F.score(String(t.req.narration_exact || ''), String(orphan.req.narration_exact || '')).score;
    if (s < MIN_NARRATION) continue;
    if (!sim || s > sim.s) sim = { target: t, s, ov };
  }
  if (sim) {
    return { target: sim.target, confidence: 'PROBABLE',
      how: `narration ${(sim.s * 100).toFixed(0)}% milti hai aur ${sim.ov.toFixed(1)}s range overlap karti hai` };
  }
  return null;
}

/** Kabhi overwrite nahi. Same file (same hash) hai to dobara copy bhi nahi. */
function copyInto(srcFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const base = path.basename(srcFile);
  const srcHash = U.hashFile(srcFile);
  const direct = path.join(destDir, base);
  if (fs.existsSync(direct)) {
    if (U.hashFile(direct) === srcHash) return { action: 'ALREADY_THERE', dest: direct };
  } else {
    if (APPLY) fs.copyFileSync(srcFile, direct);
    return { action: 'COPIED', dest: direct };
  }
  // naam bhara hua hai par file alag hai — deterministic naya naam
  const ext = path.extname(base), stem = base.slice(0, base.length - ext.length);
  for (let i = 2; i < 100; i++) {
    const alt = path.join(destDir, `${stem}__recovered${i}${ext}`);
    if (fs.existsSync(alt)) { if (U.hashFile(alt) === srcHash) return { action: 'ALREADY_THERE', dest: alt }; continue; }
    if (APPLY) fs.copyFileSync(srcFile, alt);
    return { action: 'COPIED_RENAMED', dest: alt };
  }
  return { action: 'SKIPPED_TOO_MANY', dest: null };
}

function main() {
  console.log('='.repeat(66));
  console.log(`  KHOYA HUA MEDIA WAPAS LAO  ${APPLY ? '(APPLY — files copy hongi)' : '(DRY RUN — kuch nahi badlega)'}`);
  console.log('='.repeat(66));
  console.log(`  DATA folder: ${DATA}`);

  if (!fs.existsSync(ORPH)) {
    console.log('\n  _ORPHANED folder hai hi nahi — kuch khoya hi nahi. Sab theek hai.');
    return 0;
  }

  const orphanDirs = findOrphans(ORPH);
  const targets = [];
  try {
    for (const n of fs.readdirSync(DATA)) {
      if (!isReqDir(n)) continue;
      const dir = path.join(DATA, n);
      const req = readReq(dir);
      if (req) targets.push({ dir, folder: n, req });
    }
  } catch {}

  console.log(`  _ORPHANED mein ${orphanDirs.length} folder | abhi ${targets.length} maujooda request`);
  console.log('');

  const report = {
    schema: 'orphan-recovery-report-v1',
    generated_at: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'dry-run',
    data_root: DATA,
    orphan_folders: orphanDirs.length,
    active_requests: targets.length,
    recovered: [], probable: [], untouched: [], files: [],
  };

  let filesCopied = 0, filesAlready = 0;

  for (const dir of orphanDirs) {
    const req = readReq(dir);
    const files = mediaFiles(dir);
    const rel = path.relative(DATA, dir);
    if (!req) { report.untouched.push({ from: rel, why: 'request.json padhi nahi ja saki' }); continue; }
    if (!files.length) { report.untouched.push({ from: rel, why: 'isme koi media file thi hi nahi' }); continue; }

    const m = matchTarget({ dir, req }, targets);
    if (!m) {
      report.untouched.push({ from: rel, files: files.length,
        why: 'koi milta-julta request nahi mila (range/moments/narration kuch match nahi hua)',
        narration: String(req.narration_exact || '').slice(0, 120),
        range: req.range || null });
      console.log(`  [CHHODA]  ${rel}  (${files.length} file) — koi match nahi mila`);
      continue;
    }

    const destMedia = path.join(m.target.dir, 'media');
    const entry = {
      from: rel, to: path.relative(DATA, m.target.dir),
      confidence: m.confidence, how: m.how, files: [],
      request_key_from: manual.requestKey(req), request_key_to: manual.requestKey(m.target.req),
    };

    // PROBABLE ko apne aap nahi lagate — user ki manzoori chahiye
    if (m.confidence === 'PROBABLE') {
      entry.files = files.map(f => path.basename(f));
      entry.suggestion = `manually copy karo: ${rel}\\media\\*  ->  ${entry.to}\\media\\`;
      report.probable.push(entry);
      console.log(`  [SHAYAD]  ${rel}`);
      console.log(`             -> ${entry.to}   (${m.how})`);
      console.log('             ye pakka nahi hai — apne aap nahi lagaya. Report dekh kar khud copy karo.');
      continue;
    }

    for (const f of files) {
      const r = copyInto(f, destMedia);
      entry.files.push({ file: path.basename(f), action: r.action, dest: r.dest ? path.relative(DATA, r.dest) : null });
      report.files.push({ src: path.relative(DATA, f), dest: r.dest ? path.relative(DATA, r.dest) : null, action: r.action });
      if (r.action === 'COPIED' || r.action === 'COPIED_RENAMED') filesCopied++;
      else if (r.action === 'ALREADY_THERE') filesAlready++;
    }
    report.recovered.push(entry);
    console.log(`  [WAPAS]   ${rel}`);
    console.log(`             -> ${entry.to}   (${m.confidence}: ${m.how})`);
    console.log(`             ${entry.files.length} file`);

    if (APPLY) {
      try {
        fs.writeFileSync(path.join(dir, 'RECOVERED.txt'),
          'Is folder ka media wapas laga diya gaya hai:\n' +
          `  -> DATA\\${entry.to}\\media\\\n\n` +
          `Kab: ${new Date().toISOString()}\n` +
          `Kaise mila: ${m.how}\n\n` +
          'Ye folder yahin chhoda gaya hai (delete nahi kiya) taaki asli files\n' +
          'kisi bhi haalat mein surakshit rahein.\n');
      } catch {}
    }
  }

  report.summary = {
    recovered_folders: report.recovered.length,
    probable_folders: report.probable.length,
    untouched_folders: report.untouched.length,
    files_copied: filesCopied,
    files_already_present: filesAlready,
  };

  const outDir = path.join(U.ROOT, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'orphan-recovery-report.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  console.log('');
  console.log('-'.repeat(66));
  console.log(`  wapas laye     : ${report.recovered.length} folder, ${filesCopied} file` +
    (filesAlready ? ` (${filesAlready} pehle se wahan thi)` : ''));
  console.log(`  shayad match   : ${report.probable.length} folder  (report dekh kar khud copy karo)`);
  console.log(`  chhode gaye    : ${report.untouched.length} folder`);
  console.log(`  poori report   : ${path.relative(U.ROOT, outFile)}`);
  if (!APPLY && (report.recovered.length || filesCopied)) {
    console.log('');
    console.log('  Ye sirf DRY RUN tha — abhi kuch copy nahi hua.');
    console.log('  Sach mein karna hai to:  node tools/recover-orphaned-media.js --apply');
  }
  if (APPLY && filesCopied) {
    console.log('');
    console.log('  Ab dashboard kholo (START_UI.bat) aur dekho ki kaunse card bhar gaye.');
    console.log('  ZAROORI: HOOK/HARD_EVIDENCE beats par manzoori dobara deni hogi —');
    console.log('  purana media naye fingerprint se bandha jayega (ye jaan-boojh kar hai).');
  }
  console.log('-'.repeat(66));
  return report.probable.length ? 2 : 0;
}

try { process.exit(main()); }
catch (e) { console.error('fatal: ' + (e && e.message)); process.exit(1); }
