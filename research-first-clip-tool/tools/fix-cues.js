#!/usr/bin/env node
// ============================================================
//  FIX-CUES — narration cue ki galti LOCAL SRT se theek karta hai. Koi AI nahi.
//
//  Problem: `script_cue_exact` wo line hai jisse engine dhoondhta hai ki ye beat
//  narration mein KAHAN aata hai. Research AI aksar isse thoda badal kar likh
//  deta hai ("...evidence, s..." ki jagah apne shabd). Tab locator bilkul sahi
//  hone par bhi clip nahi lagti — engine ko pata hi nahi chalta ki lagani kahan hai.
//
//  Asli Candace pack mein aise 10 moments the. Inke liye kisi Genspark/Gemini
//  ki zaroorat NAHI hai: sahi jawab pehle se voiceover.srt mein padha hai.
//  Ye tool har kharab cue ke liye SRT se HUBAHU text nikaal kar dikhata hai,
//  aur --apply par pack mein likh deta hai.
//
//    node tools/fix-cues.js input/scene-research.json input/voiceover.srt
//    node tools/fix-cues.js input/scene-research.json input/voiceover.srt --apply
//
//  Suraksha: wahi cue badalta hai jiska naya text SRT mein saaf-saaf ek hi jagah
//  milta ho (unique). Do jagah match ho to chhod deta hai — warna clip galat
//  jagah lag jayegi. Aur badla hua text HAMESHA SRT ka hi hota hai, banaya hua nahi.
// ============================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const validate = require(path.join(ROOT, 'src', 'validate.js'));
const SUB = require(path.join(ROOT, 'src', 'subtitles.js'));
const align = require(path.join(ROOT, 'src', 'align.js'));
const F = require(path.join(ROOT, 'lib', 'fuzzy.js'));

const argv = process.argv.slice(2);
const flags = argv.filter(a => a.startsWith('--'));
const args = argv.filter(a => !a.startsWith('--'));
const has = f => flags.includes('--' + f);
const packFile = args[0] || path.join(ROOT, 'input', 'scene-research.json');
const srtFile = args[1] || path.join(ROOT, 'input', 'voiceover.srt');

const line = (c = '=') => console.log(c.repeat(72));
const die = m => { console.log('  [FAIL] ' + m); process.exit(1); };

let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch {}
const ACC = (cfg.align || {}).acceptSimilarity ?? 0.92;
const MARGIN = (cfg.align || {}).runnerUpMargin ?? 0.08;

line(); console.log('  CUE FIX — narration cue ko voiceover.srt se hubahu milao (bina AI ke)'); line();

if (!fs.existsSync(packFile)) die(`pack nahi mila: ${packFile}`);
if (!fs.existsSync(srtFile)) die(`voiceover.srt nahi mila: ${srtFile}`);
const v = validate.validateFile(packFile);
if (!v.ok) { (v.errors || []).slice(0, 6).forEach(e => console.log('  [FAIL] ' + e)); die('pack invalid hai.'); }
const cues = SUB.parseFile(srtFile);
if (!cues.length) die('voiceover.srt parse nahi hui (0 cues).');

const raw = JSON.parse(fs.readFileSync(packFile, 'utf8'));
const momentsRaw = {};
for (const pk of (raw.packs || [])) for (const m of (pk.moments || [])) momentsRaw[m.moment_id] = m;

// ek window ka asli SRT text (jo hubahu narration mein bola gaya hai)
const windowText = w => cues.slice(w.i, w.j + 1).map(c => c.text).join(' ').replace(/\s+/g, ' ').trim();

const fixes = [], skipped = [];
for (const pk of (v.pack.packs || [])) for (const m of (pk.moments || [])) {
  const cur = String(m.script_cue_exact || '');
  const { best, runnerUp } = align.bestWindows(cues, cur);
  if (!best) { skipped.push({ id: m.moment_id, why: 'SRT mein iska koi mel hi nahi mila — ye beat shayad narration mein hai hi nahi' }); continue; }
  const ru = runnerUp ? runnerUp.score : 0;
  const flag = best.score < ACC ? 'REVIEW' : ((best.score - ru) < MARGIN ? 'AMBIGUOUS' : 'OK');
  if (flag === 'OK') continue;                       // ye cue pehle se theek hai

  const proposed = windowText(best);
  if (!proposed || proposed.length < 12) { skipped.push({ id: m.moment_id, why: 'SRT window bahut chhota hai' }); continue; }
  if (F.score(proposed, cur).score >= 0.999) { skipped.push({ id: m.moment_id, why: 'text pehle se wahi hai — problem cue mein nahi' }); continue; }

  // NAYA cue khud check karo: kya wo ab saaf-saaf ek hi jagah milta hai?
  // (Ye zaroori hai — warna hum ek galti ki jagah doosri galti likh denge.)
  const after = align.bestWindows(cues, proposed);
  const ru2 = after.runnerUp ? after.runnerUp.score : 0;
  const ok2 = after.best && after.best.score >= ACC && (after.best.score - ru2) >= MARGIN;
  if (!ok2) {
    skipped.push({ id: m.moment_id, why: `SRT mein ye line ek se zyada jagah milti hai (margin ${(after.best ? after.best.score - ru2 : 0).toFixed(2)}) — haath se chuno` });
    continue;
  }
  fixes.push({ id: m.moment_id, pack_id: pk.pack_id, was: cur, now: proposed,
    flag, at: best.start, score: +best.score.toFixed(3) });
}

if (!fixes.length && !skipped.length) {
  console.log('  Saare cues pehle se narration se hubahu milte hain — kuch karna nahi hai.');
  line(); process.exit(0);
}

if (fixes.length) {
  console.log(`  ${fixes.length} cue LOCAL hi theek ho sakte hain (koi AI nahi chahiye):\n`);
  for (const f of fixes) {
    console.log(`  ${f.id}  [${f.flag}]  narration mein ${Math.floor(f.at / 60)}:${String(Math.floor(f.at % 60)).padStart(2, '0')} par`);
    console.log(`     abhi : ${JSON.stringify(f.was.slice(0, 96))}`);
    console.log(`     sahi : ${JSON.stringify(f.now.slice(0, 96))}`);
    console.log('');
  }
}
if (skipped.length) {
  console.log(`  ${skipped.length} cue automatic theek NAHI ho sakte — inhe insaan ko dekhna hoga:`);
  skipped.slice(0, 12).forEach(s => console.log(`     ${s.id.padEnd(12)} ${s.why}`));
  if (skipped.length > 12) console.log(`     ...aur ${skipped.length - 12}`);
  console.log('');
}

if (!has('apply')) {
  line('-');
  console.log('  Ye sirf DIKHAYA hai, lagaya nahi. Lagane ke liye:');
  console.log(`    node tools/fix-cues.js ${path.relative(ROOT, packFile)} ${path.relative(ROOT, srtFile)} --apply`);
  console.log('  (backup .bak ban jayega, aur uske baad CHECKPACK dobara chalana.)');
  line();
  process.exit(fixes.length ? 2 : 0);
}

if (!fixes.length) { console.log('  Lagane ko kuch nahi hai.'); line(); process.exit(0); }
for (const f of fixes) { const m = momentsRaw[f.id]; if (m) m.script_cue_exact = f.now; }
const tmp = packFile + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
fs.copyFileSync(packFile, packFile + '.bak');
fs.renameSync(tmp, packFile);
const v2 = validate.validateFile(packFile);
if (!v2.ok) {
  fs.copyFileSync(packFile + '.bak', packFile);
  (v2.errors || []).slice(0, 6).forEach(e => console.log('  ' + e));
  die('badla hua pack validate nahi hua — purana wapas laga diya.');
}
line();
console.log(`  ${fixes.length} cue theek kar diye. (backup: ${path.basename(packFile)}.bak)`);
console.log('  Ab CHECKPACK.bat chalao — alignment wala check ab saaf hona chahiye.');
line();
process.exit(0);
