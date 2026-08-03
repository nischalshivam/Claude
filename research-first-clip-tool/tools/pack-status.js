#!/usr/bin/env node
// ============================================================
//  PACK-STATUS — menu ke liye ek line ka SACH.
//
//  Pehle START_HERE sirf itna dekhta tha ki output/pack-report.json file
//  MAUJOOD hai ya nahi, aur "pack check: ho chuka" likh deta tha — chahe wo
//  report kisi purane pack ki ho, ya usme 5 check fail hon. Asli run mein user
//  ne yahi line padhi, option 5 dabaya, aur exit code 3 khaya.
//
//  Ab menu ye tool poochta hai. Ye report ke hash sach mein milate hai:
//    NOT_CHECKED        report hai hi nahi
//    STALE              report kisi aur pack/SRT ki hai — option 2 dobara
//    NEEDS_RESEARCH     taaza hai par pack fail hai -> preview OK, export nahi
//    DIAGNOSTIC_READY   NEEDS_RESEARCH ka hi doosra naam (criticality baaki hai)
//    PRODUCTION_READY   sab paas — option 8 chal sakta hai
//
//    node tools/pack-status.js            (ek line, menu ke liye)
//    node tools/pack-status.js --json
//  Exit: 0 production ready, 2 kaam baaki, 1 check hi nahi hua
// ============================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const U = require(path.join(ROOT, 'src', 'util.js'));

const flags = process.argv.slice(2).filter(a => a.startsWith('--'));
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const packFile = args[0] || path.join(ROOT, 'input', 'scene-research.json');
const srtFile = args[1] || path.join(ROOT, 'input', 'voiceover.srt');
const repFile = args[2] || path.join(ROOT, 'output', 'pack-report.json');

let state = 'NOT_CHECKED', detail = 'option 2 pehle chalao', code = 1;
let rep = null;
if (!fs.existsSync(packFile)) {
  state = 'NO_PACK'; detail = 'input\\scene-research.json nahi hai';
} else {
  try { rep = JSON.parse(fs.readFileSync(repFile, 'utf8')); } catch {}
  if (!rep) { state = 'NOT_CHECKED'; detail = 'option 2 pehle chalao (5-8 tab tak block hain)'; }
  else {
    const packHash = U.hashFile(packFile);
    const srtHash = fs.existsSync(srtFile) ? U.hashFile(srtFile) : null;
    const packSame = String(rep.pack_sha256 || '').toUpperCase() === String(packHash).toUpperCase();
    const srtSame = !srtHash || String(rep.srt_sha256 || '').toUpperCase() === String(srtHash).toUpperCase();
    if (!packSame || !srtSame) {
      state = 'STALE';
      detail = `report ${!packSame ? 'purane pack' : 'purani voiceover'} ki hai — option 2 dobara chalao`;
      code = 2;
    } else if (rep.pass === true && !rep.missing_criticality) {
      state = 'PRODUCTION_READY'; detail = 'sab paas — option 8 chal sakta hai'; code = 0;
    } else if (rep.pass === true) {
      state = 'DIAGNOSTIC_READY';
      detail = `checks paas, par ${rep.missing_criticality} moments par criticality nahi (option 8 ruka hai)`;
      code = 2;
    } else {
      state = 'NEEDS_RESEARCH';
      const n = (rep.failed_checks || []).length;
      detail = `${n} check fail — preview (5/6/7) chalega, poora export (8) nahi`;
      code = 2;
    }
  }
}

if (flags.includes('--json')) {
  console.log(JSON.stringify({ state, detail, pass: rep ? rep.pass : null,
    failed_checks: rep ? (rep.failed_checks || []).length : null,
    missing_criticality: rep ? (rep.missing_criticality || 0) : null }, null, 2));
} else {
  console.log(`${state}  (${detail})`);
}
process.exit(code);
