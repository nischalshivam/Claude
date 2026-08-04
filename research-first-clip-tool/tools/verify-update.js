#!/usr/bin/env node
// ============================================================
//  VERIFY UPDATE (M4.2.1) — update ke baad SACH check karo.
//
//  Kyun ye bana: UPDATE_TOOL.bat pehle "HO GAYA" likh deta tha aur bas.
//  Agar koi folder copy hone se reh jata (jaise docs\ reh gaya tha), ya
//  purana code kahin aadha reh jata, to pata hi nahi chalta — pata tab
//  chalta jab kuch cheez chalti hi nahi.
//
//  Ab update ke turant baad ye chalta hai aur do sawal ka jawab deta hai:
//    1. naya code sach mein aa gaya? (version + critical files ka hash)
//    2. mera kaam bacha hua hai? (input / DATA / jobs / config)
//
//  Chalao:  node tools/verify-update.js [--src=<naye code ka folder>]
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const arg = n => { const a = process.argv.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=').replace(/^["']|["']$/g, '') : null; };
// --root se kisi bhi folder ko check kar sakte ho (test + future UI updater).
// Default: is script ke parent (yaani jahan tool laga hua hai).
const ROOT = path.resolve(arg('root') || path.resolve(__dirname, '..'));
const SRC = arg('src');

const sha = f => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 12); } catch { return null; } };
const exists = p => { try { return fs.existsSync(p); } catch { return false; } };

// jo files na aayein to tool chalega hi nahi
const CRITICAL = [
  'src/run.js', 'src/manual.js', 'src/approval.js', 'src/readiness.js',
  'src/timebase.js', 'src/effectivegate.js', 'src/gapplan.js', 'src/render.js', 'src/edl.js',
  'tools/check-pack.js', 'tools/recover-orphaned-media.js',
  'server/app.js', 'server/ui/index.html', 'server/ui/app.js',
];
const DIRS = ['src', 'server', 'tools', 'lib', 'prompts', 'schemas', 'tests', 'docs'];
const YOURS = ['input', 'DATA', 'jobs', 'output', 'config.json'];

function buildInfo(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'BUILD_INFO.json'), 'utf8')); } catch { return null; }
}

let bad = 0;
console.log('='.repeat(62));
console.log('  UPDATE CHECK — sach mein kya laga aur kya bacha');
console.log('='.repeat(62));

const bi = buildInfo(ROOT);
console.log(`  version   : ${bi ? (bi.version || '?') + '  (' + (bi.milestone || '') + ')' : 'BUILD_INFO.json nahi mila'}`);
if (!bi) bad++;

console.log('');
console.log('  NAYA CODE:');
for (const d of DIRS) {
  const here = exists(path.join(ROOT, d));
  if (!here) { console.log(`    [NAHI AAYA] ${d}\\`); bad++; }
  else console.log(`    [ok] ${d}\\`);
}

let mismatch = 0, missing = 0;
for (const f of CRITICAL) {
  const mine = sha(path.join(ROOT, f));
  if (!mine) { console.log(`    [FILE NAHI MILI] ${f}`); missing++; bad++; continue; }
  if (SRC) {
    const theirs = sha(path.join(SRC, f));
    if (theirs && theirs !== mine) { console.log(`    [PURANI REH GAYI] ${f}  (${mine} != ${theirs})`); mismatch++; bad++; }
  }
}
if (!missing && !mismatch) {
  console.log(`    [ok] ${CRITICAL.length} zaroori file maujood${SRC ? ' aur naye code se match kar rahi hain' : ''}`);
}

console.log('');
console.log('  AAPKA KAAM:');
for (const y of YOURS) {
  const p = path.join(ROOT, y);
  console.log(exists(p) ? `    [surakshit] ${y}` : `    [hai hi nahi] ${y}   (abhi bana nahi — normal hai)`);
}

// backup mila? (UPDATE_TOOL.bat _backup_code_* banata hai)
let backups = [];
try { backups = fs.readdirSync(ROOT).filter(n => n.startsWith('_backup_code_')); } catch {}
console.log('');
console.log(backups.length
  ? `  purane code ka backup: ${backups[backups.length - 1]}  (rollback yahan se)`
  : '  purane code ka backup nahi mila — agar update abhi chala hai to ye dekhna chahiye.');

console.log('='.repeat(62));
if (bad) {
  console.log('  [DHYAN DO] Upar jo [NAHI AAYA] / [PURANI REH GAYI] likha hai, wo theek karna hai.');
  console.log('  Aam wajah: naya folder aadha unzip hua. Dobara unzip karke UPDATE_TOOL.bat chalao.');
} else {
  console.log('  Sab theek hai. Ab START_HERE.bat chalao.');
}
console.log('='.repeat(62));
process.exit(bad ? 2 : 0);
