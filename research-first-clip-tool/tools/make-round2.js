#!/usr/bin/env node
// ============================================================
//  MAKE-ROUND2 — "sirf locators chahiye" wala focused prompt banata hai.
//
//  Kyun: aksar research AI script ko theek-theek beats mein baant deta hai
//  (cues exact, coverage poori) par ASLI research nahi karta — na timestamps,
//  na dialogue, bas placeholder sources. Aisa pack render nahi ho sakta, par
//  usme ka SEGMENTATION bilkul sahi hota hai. Use phenkna bewakoofi hai.
//
//  Ye tool wo segmentation utha kar ek chhota, focused prompt banata hai jisme
//  AI ka kaam sirf ITNA hai: "in sources ke andar in moments ko dhoondho aur
//  timestamp/dialogue do". Na script padhna, na beats banana, na source dhoondna
//  — isliye ek hi message mein asli research hone ka chance kai guna badh jata hai.
//
//  Pehle pack ke `sources` mein ASLI URLs daalo (ya local_file), phir:
//    node tools/make-round2.js input/scene-research.json
//    node tools/make-round2.js input/scene-research.json --part=1/2
//
//  Jo JSON wapas aaye usse apply karo:
//    node tools/apply-round2.js input/scene-research.json round2.json
// ============================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const validate = require(path.join(ROOT, 'src', 'validate.js'));

const argv = process.argv.slice(2);
const flags = argv.filter(a => a.startsWith('--'));
const files = argv.filter(a => !a.startsWith('--'));
const val = (f, d) => { const x = flags.find(y => y.startsWith('--' + f + '=')); return x ? x.slice(f.length + 3) : d; };

const packFile = files[0] || path.join(ROOT, 'input', 'scene-research.json');
const outDir = val('out', path.join(ROOT, 'output'));
const partSpec = val('part', '1/1');
const [partNo, partTot] = partSpec.split('/').map(n => Math.max(1, parseInt(n, 10) || 1));

const die = m => { console.log('  [FAIL] ' + m); process.exit(1); };
const line = (c = '=') => console.log(c.repeat(66));

line(); console.log('  MAKE ROUND-2 PROMPT — sirf locators maangne wala prompt'); line();

if (!fs.existsSync(packFile)) die(`pack nahi mila: ${packFile}`);
const v = validate.validateFile(packFile);
if (!v.ok) { (v.errors || []).slice(0, 8).forEach(e => console.log('  [FAIL] ' + e)); die('pack invalid hai.'); }
const pack = v.pack;

// ---------- sources ----------
const sourcesById = {};
for (const pk of pack.packs) for (const s of (pk.sources || [])) sourcesById[s.source_id] = { ...s, pack_id: pk.pack_id };
const usable = Object.values(sourcesById).filter(s => s.url || s.local_file);
const placeholderish = Object.values(sourcesById).filter(s => (s.inspection_status || '') === 'METADATA_ONLY');

// ---------- moments ko script order mein lao ----------
// pack ka order source-wise ho sakta hai; prompt padhne wale ke liye script
// order zyada samajhne layak hai.
const all = [];
for (const pk of pack.packs) for (const m of (pk.moments || [])) all.push({ m, pk });
const seq = pack.script_order || null;
all.sort((a, b) => (a.m.script_order ?? 0) - (b.m.script_order ?? 0));   // field na ho to original order

// weak = jise locator ya frame_hints chahiye
const weak = all.filter(({ m }) => {
  const L = (m.locators || []).filter(x => x.locator_type === 'EXACT_TIME' || x.locator_type === 'DIALOGUE');
  const h = ((m.fallback_plan || {}).frame_hints || []);
  return !L.length && !h.length;
});
if (!weak.length) die('is pack ke saare moments ke paas already locator/frame_hints hain — round 2 ki zaroorat nahi.');

// part split
const per = Math.ceil(weak.length / partTot);
const slice = weak.slice((partNo - 1) * per, partNo * per);
if (!slice.length) die(`part ${partNo}/${partTot} khaali hai (sirf ${weak.length} moments hain).`);

console.log(`  pack   : ${path.basename(packFile)} — ${all.length} moments, ${usable.length} sources`);
console.log(`  weak   : ${weak.length} moments ko evidence chahiye`);
if (partTot > 1) console.log(`  part   : ${partNo}/${partTot} -> is prompt mein ${slice.length} moments`);
if (placeholderish.length) {
  console.log(`\n  [!] ${placeholderish.length}/${usable.length} sources abhi METADATA_ONLY hain (yaani AI ne inhe`);
  console.log('      sach mein khola hi nahi). Round-2 chalane se PEHLE inke URLs ko');
  console.log('      apne haath se asli, chalne wale URLs se badlo — warna round 2 bhi');
  console.log('      usi jhoothe source par timestamps banayega.');
  placeholderish.slice(0, 8).forEach(s => console.log(`        ${s.pack_id}/${s.source_id.padEnd(10)} ${String(s.url || s.local_file).slice(0, 52)}`));
}

// ---------- prompt ----------
const L = [];
const P = s => L.push(s);
const packById = {}; for (const pk of pack.packs) packById[pk.pack_id] = pk;
const showPacks = pack.packs.filter(pk => pk.scope && pk.scope.kind !== 'GRAPHIC').map(pk => pk.pack_id);

P('You are a precision footage researcher with live YouTube access, page opening,');
P('and caption/transcript inspection.');
P('');
P('This is a NARROW task. The script has already been segmented and approved. Do');
P('NOT re-segment it, do NOT write new beats, do NOT change any wording, and do');
P('NOT look for new videos. Your only job is to locate moments INSIDE the sources');
P('listed below and report where they are.');
P('');
P('Because the segmentation work is already done, spend your entire effort on the');
P('one thing that actually needs browsing: opening these sources, reading their');
P('captions, and reporting real timestamps and real quoted lines.');
P('');
P('OUTPUT ONLY a JSON array. No Markdown fences, no commentary, no text before or');
P('after. One element per moment_id you were able to locate. Omit any moment you');
P('genuinely could not locate — an omission is fine, an invented timestamp is not.');
P('');
P('======================================================================');
P('THE ONLY SOURCES YOU MAY USE');
P('======================================================================');
P('');
P('Use these exact source_id values. Do not invent new ones, do not substitute a');
P('different upload, and never use a source from a different show.');
P('');
for (const pk of pack.packs) {
  const srcs = (pk.sources || []).filter(s => s.url || s.local_file);
  if (!srcs.length) continue;
  P(`  ${pk.pack_id}  [${pk.scope.kind}] ${pk.scope.title}${pk.scope.episode_title ? ' — ' + pk.scope.episode_title : ''}`);
  for (const s of srcs) {
    P(`     source_id: ${s.source_id}`);
    P(`     ${s.url || ('local file: ' + s.local_file)}`);
    if (s.duration_sec) P(`     stated duration: ${s.duration_sec}s  (VERIFY this against the real upload)`);
  }
  P('');
}
P('FIRST STEP, BEFORE ANYTHING ELSE: open every URL above and confirm it plays,');
P('is the right show/episode, and note its REAL duration. If a URL is dead, wrong,');
P('or not the stated content, say so by returning it in the "broken_sources" object');
P('described at the end — and do not build timestamps on top of it.');
P('');
P('======================================================================');
P('WHAT TO RETURN FOR EACH MOMENT');
P('======================================================================');
P('');
P('For a moment tied to a specific scene, return locators. Give BOTH kinds when');
P('you can — this is the single most important instruction here:');
P('');
P('  {');
P('    "moment_id": "P07_M01",');
P('    "locators": [');
P('      { "source_id": "P07_S01", "locator_type": "DIALOGUE",');
P('        "dialogue_exact": "verbatim line copied from that source\'s captions",');
P('        "nearby_context_terms": ["distinctive nearby word"],');
P('        "verification_method": "TRANSCRIPT", "confidence": "HIGH" },');
P('      { "source_id": "P07_S01", "locator_type": "EXACT_TIME",');
P('        "start_sec": 412.0, "end_sec": 418.0,');
P('        "verification_method": "WATCHED", "confidence": "HIGH" }');
P('    ],');
P('    "frame_hints": [');
P('      { "source_id": "P07_S01", "time_sec": 409.0, "reason": "same scene, wide shot" }');
P('    ]');
P('  }');
P('');
P('WHY BOTH: the engine finds DIALOGUE by downloading that source\'s real captions,');
P('so dialogue self-corrects if the upload is offset by a few seconds — but it is');
P('worthless when an upload has no captions. EXACT_TIME is the opposite. Together');
P('they survive both failures. A moment with only one of them frequently ends up');
P('showing generic footage instead of the actual scene.');
P('');
P('RULES');
P('  - dialogue_exact must be copied verbatim from that source\'s captions. Not a');
P('    paraphrase, not remembered, not the narration\'s wording, and never two');
P('    speakers\' lines joined together. One continuous captioned utterance.');
P('  - start_sec/end_sec are seconds (numbers), not "12:34" strings, and must be');
P('    inside that upload\'s real duration. Normal clip length is 3-9 seconds and');
P('    the action must already be happening at start_sec.');
P('  - Timestamps belong to ONE upload. Never carry a timestamp from a different');
P('    upload of the same episode — intros and trims differ.');
P('  - frame_hints are seconds where you actually saw something useful. The engine');
P('    has no image search; it cannot find "a shot of her looking defeated", but it');
P('    can jump to second 412 of a video you already checked. 2-3 hints per moment.');
P('  - Avoid transitions, black frames, credits and title cards in frame_hints.');
P('');
P('FOR ANALYSIS / GRAPHIC MOMENTS (marked ANALYSIS below): these have no scene of');
P('their own. Do not invent one. Return frame_hints only, pointing at seconds in');
P('the show sources that visually suit the line being narrated:');
P('');
P('  { "moment_id": "P10_M04", "frame_hints": [');
P('      { "source_id": "P01_S01", "time_sec": 305, "reason": "Candace alone, clear frame" },');
P('      { "source_id": "P07_S01", "time_sec": 88,  "reason": "empty backyard" } ] }');
P('');
if (showPacks.length) P(`Analysis moments may use sources from these packs only: ${showPacks.join(', ')}`);
P('');
P('======================================================================');
P(`MOMENTS TO LOCATE${partTot > 1 ? `  (PART ${partNo} OF ${partTot})` : ''}  — ${slice.length} total`);
P('======================================================================');
P('');
P('The narration text is given so you can tell which scene is meant. It is NOT to');
P('be edited, re-split, or returned.');
P('');
for (const { m, pk } of slice) {
  const isG = pk.scope && pk.scope.kind === 'GRAPHIC';
  const fp = m.fallback_plan || {};
  const allowed = (fp.allowed_pack_ids || []).length ? fp.allowed_pack_ids : (isG ? showPacks : [pk.pack_id]);
  P(`--- ${m.moment_id}${isG ? '   [ANALYSIS — frame_hints only]' : `   [${pk.scope.title}${pk.scope.episode_title ? ' / ' + pk.scope.episode_title : ''}]`}`);
  P(`    narration: "${m.script_cue_exact}"`);
  if (m.purpose) P(`    intent   : ${m.purpose}`);
  const must = m.must_show || fp.must_show || [];
  if (must.length) P(`    must show: ${must.join(', ')}`);
  P(`    may use  : ${allowed.map(x => (packById[x] ? (packById[x].sources || []).map(s => s.source_id).join('/') : x)).filter(Boolean).join(', ') || '(see source list above)'}`);
  P('');
}
P('======================================================================');
P('OUTPUT');
P('======================================================================');
P('');
P('Return exactly one JSON array. Each element:');
P('  { "moment_id": "...", "locators": [...], "frame_hints": [...] }');
P('(include whichever of locators/frame_hints you actually have).');
P('');
P('If any listed source turned out to be dead, wrong, or unusable, add ONE extra');
P('element at the end of the array in this shape, so it can be replaced:');
P('  { "broken_sources": [ { "source_id": "P02_S01", "problem": "video unavailable" } ] }');
P('');
P('Do not include moments you could not verify. Do not add explanation text.');
P('Do not stop partway through the array.');

fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, partTot > 1 ? `ROUND2_PROMPT_part${partNo}.txt` : 'ROUND2_PROMPT.txt');
fs.writeFileSync(outFile, L.join('\n') + '\n');

const rel = p => { const r = path.relative(ROOT, p); return r.startsWith('..') ? p : r; };
line();
console.log(`  likha: ${rel(outFile)}  (${Math.round(L.join('\n').length / 1024)} KB)`);
console.log('  isse Genspark/Gemini mein paste karo. Jo JSON array aaye use save karke:');
console.log(`     node tools/apply-round2.js ${rel(packFile)} round2.json`);
line();
