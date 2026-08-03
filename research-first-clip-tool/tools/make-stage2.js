#!/usr/bin/env node
// ============================================================
//  MAKE-STAGE2 — do-stage research ka DOOSRA prompt banata hai.
//
//  Do-stage system:
//    STAGE 1 (pehla Genspark account): script ko beats mein baanto + ASLI,
//            chalne wale source videos dhoondho. Timestamps ki zaroorat nahi.
//            -> prompts/STAGE1_SOURCES_AND_BEATS_PROMPT.txt
//    STAGE 2 (doosra account): stage-1 ke sources ko KHOLO, verify karo, aur
//            har beat ka asli timestamp/dialogue/frame nikaalo.
//            -> ye tool wahi prompt banata hai
//
//  Kyun do stage: ek hi prompt mein "script baanto + video dhoondho + verify karo
//  + timestamp nikaalo" maangne par model ka poora budget instructions follow
//  karne mein chala jata hai aur browsing reh jati hai. Alag-alag karne se har
//  stage ka kaam chhota hai, aur stage 2 stage-1 ke links ko VERIFY bhi karta hai
//  (alag account, alag session — jhoothe URL wahin pakde jate hain).
//
//    node tools/make-stage2.js input/scene-research.json
//    node tools/make-stage2.js input/scene-research.json --part=1/2
//
//  Jo JSON wapas aaye usse apply karo:
//    node tools/apply-stage2.js input/scene-research.json stage2.json
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

line(); console.log('  MAKE STAGE-2 PROMPT — verify + locators maangne wala prompt'); line();

if (!fs.existsSync(packFile)) die(`pack nahi mila: ${packFile}`);
const v = validate.validateFile(packFile);
if (!v.ok) { (v.errors || []).slice(0, 8).forEach(e => console.log('  [FAIL] ' + e)); die('pack invalid hai.'); }
const pack = v.pack;

// ---------- sources ----------
const sourcesById = {};
for (const pk of pack.packs) for (const s of (pk.sources || [])) sourcesById[s.source_id] = { ...s, pack_id: pk.pack_id };
const usable = Object.values(sourcesById).filter(s => s.url || s.local_file);
const placeholderish = Object.values(sourcesById).filter(s => (s.inspection_status || '') === 'METADATA_ONLY');

// ---------- CHECKPACK ka verified data (agar maujood ho) ----------
//  Ye sabse kaam ki cheez hai jo hum stage 2 ko de sakte hain: hum LOCALLY khol
//  kar dekh chuke hain ki kaunsa URL chalta hai, kitna lamba hai, aur uspar
//  captions hain ya nahi. Wo sach stage 2 ko de dene se uska aadha kaam bach
//  jata hai — aur wo dead sources par timestamp banane ki koshish nahi karega.
const reportFile = val('report', path.join(outDir, 'pack-report.json'));
let verified = null;
try {
  const r = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  if (r && r.live_verify && r.live_verify.ran !== false) verified = r;
} catch (e) { /* report nahi hai — koi baat nahi */ }
const deadIds = new Set(verified ? (verified.live_verify.dead_sources || []).map(d => d.source_id) : []);
const badDialogue = verified ? (verified.live_verify.dialogue_not_found || []) : [];

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
if (!weak.length) die('is pack ke saare moments ke paas already locator/frame_hints hain — stage 2 ki zaroorat nahi.');

// part split
const per = Math.ceil(weak.length / partTot);
const slice = weak.slice((partNo - 1) * per, partNo * per);
if (!slice.length) die(`part ${partNo}/${partTot} khaali hai (sirf ${weak.length} moments hain).`);

console.log(`  pack   : ${path.basename(packFile)} — ${all.length} moments, ${usable.length} sources`);
console.log(`  weak   : ${weak.length} moments ko evidence chahiye`);
if (partTot > 1) console.log(`  part   : ${partNo}/${partTot} -> is prompt mein ${slice.length} moments`);
if (placeholderish.length) {
  console.log(`\n  [!] ${placeholderish.length}/${usable.length} sources abhi METADATA_ONLY hain (yaani AI ne inhe`);
  console.log('      sach mein khola hi nahi). Stage-2 chalane se PEHLE inke URLs ko');
  console.log('      apne haath se asli, chalne wale URLs se badlo — warna stage 2 bhi');
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
P('THIS IS STAGE 2 OF 2. Another researcher already did stage 1: they split the');
P('script into beats and found candidate source videos. Their work is below.');
P('');
P('Your job is exactly two things:');
P('  A) VERIFY their sources. Open every URL. Confirm it plays publicly right now,');
P('     is the right show/episode, and note its REAL duration. Stage-1 researchers');
P('     sometimes return plausible-looking URLs they never opened — catching that');
P('     is part of your job, and it is why a different researcher does this stage.');
P('  B) For each moment listed, report WHERE it is: a verbatim caption line and/or');
P('     a real timestamp inside those sources.');
P('');
P('Do NOT re-segment the script, do NOT write new beats, and do NOT change any');
P('narration wording. That work is finished and approved.');
P('');
P('Because segmentation and searching are already done, spend your entire budget on');
P('the part that actually needs browsing: opening these videos, reading their');
P('captions, and reporting real seconds.');
P('');
P('OUTPUT ONLY a JSON array. No Markdown fences, no commentary, no text before or');
P('after. One element per moment_id you were able to locate. Omit any moment you');
P('genuinely could not locate — an omission is fine, an invented timestamp is not.');
P('');
P('======================================================================');
P('STEP A — VERIFY THESE SOURCES FIRST');
P('======================================================================');
P('');
P('Open each URL below before writing a single timestamp.');
P('');
for (const pk of pack.packs) {
  const srcs = (pk.sources || []).filter(s => s.url || s.local_file);
  if (!srcs.length) continue;
  P(`  ${pk.pack_id}  [${pk.scope.kind}] ${pk.scope.title}${pk.scope.episode_title ? ' — ' + pk.scope.episode_title : ''}`);
  for (const s of srcs) {
    const unopened = (s.inspection_status || 'METADATA_ONLY') === 'METADATA_ONLY';
    const dead = deadIds.has(s.source_id);
    if (dead) {
      P(`     source_id: ${s.source_id}   *** CONFIRMED DEAD — REPLACE THIS ONE ***`);
      P(`     ${s.url || s.local_file}   <- we opened this ourselves; it does not play`);
      P('     Do not write any timestamp against this URL. Find a working upload of');
      P('     the same episode/film and return it under "replace_sources".');
    } else if (verified) {
      // hum khud khol chuke hain — ye ANUMAAN nahi, naapi hui baat hai
      P(`     source_id: ${s.source_id}   [CONFIRMED WORKING]`);
      P(`     ${s.url || ('local file: ' + s.local_file)}`);
      P(`     verified: ${s.duration_sec ? s.duration_sec + 's' : 'duration unknown'}${s.has_captions === false ? ', NO CAPTIONS — use EXACT_TIME here, dialogue will not work' : (s.has_captions === true ? ', has captions' : '')}`);
    } else {
      P(`     source_id: ${s.source_id}${unopened ? '   *** NOT OPENED IN STAGE 1 — VERIFY THIS ONE CAREFULLY ***' : ''}`);
      P(`     ${s.url || ('local file: ' + s.local_file)}`);
      if (s.duration_sec) P(`     stage-1 claims: ${s.duration_sec}s${typeof s.has_captions === 'boolean' ? `, captions ${s.has_captions}` : ''}  (${unopened ? 'UNVERIFIED GUESS — check both' : 'confirm both'})`);
    }
  }
  P('');
}
if (verified) {
  P('IMPORTANT: the durations and caption flags above are NOT stage-1 claims. We');
  P('opened every one of these URLs ourselves and measured them. Trust them.');
  P(`${deadIds.size} of ${usable.length} were confirmed dead and are marked above.`);
  P('');
  P('So your priorities, in order:');
  P(`  1. Replace the ${deadIds.size} dead source(s). Everything attached to them is`);
  P('     currently unusable, and that is the largest single loss in this pack.');
  P('  2. Produce locators for the moments listed below.');
  P('  You do NOT need to re-verify the sources marked CONFIRMED WORKING. Their');
  P('  duration and caption status are already measured facts.');
  P('');
  if (badDialogue.length) {
    P('Also: we searched the real captions for the dialogue lines stage 1 gave, and');
    P('these were NOT found. Whoever wrote them was working from memory. Replace');
    P('them with lines you actually read in the captions:');
    badDialogue.slice(0, 12).forEach(d => P(`  ${d.moment_id} (${d.source_id}): "${String(d.dialogue || '').slice(0, 64)}"`));
    P('');
  }
} else if (placeholderish.length) {
  P(`NOTE: ${placeholderish.length} of these were marked METADATA_ONLY by stage 1 — the`);
  P('researcher found them in search results but never opened them. Their stated');
  P('duration and caption flags are guesses, and some may not exist at all. Start');
  P('with those. Every timestamp you write on an unopened source is a coin flip.');
  P('');
}
P('For each source, one of three things is true:');
P('');
P('  1. IT WORKS. It plays, it is the right content. Use it. If its real duration');
P('     differs from the stated one, report the real number (see "source_updates").');
P('');
P('  2. IT IS DEAD OR WRONG — unavailable, private, region-locked, or simply not');
P('     the show/episode it claims. FIND A REPLACEMENT YOURSELF for that same');
P('     episode/film, following the source-quality rules below, and return it under');
P('     "replace_sources" keeping the SAME source_id. This is expected and');
P('     welcome — a stage-1 mistake fixed here costs nothing; carried forward it');
P('     ruins every moment attached to it.');
P('');
P('  3. IT WORKS BUT HAS NO CAPTIONS. Say so in source_updates (has_captions');
P('     false). For those, EXACT_TIME becomes essential, because the engine cannot');
P('     find a spoken line in a video with no subtitles.');
P('');
P('REPLACEMENT SOURCE QUALITY: prefer an official network/studio channel full');
P('episode, then an official clip, then a licensed upload, then a clean scene');
P('upload you inspected. Reject anything with a reaction host, facecam,');
P('picture-in-picture, review commentary, fan edit, AMV, speed change, mirroring,');
P('heavy watermark or burned-in subtitles, or the wrong version of the show.');
P('Prefer uploads that HAVE captions. Never substitute footage from a different');
P('show — the moment would then show the wrong series entirely.');
P('');
P('======================================================================');
P('STEP B — WHAT TO RETURN FOR EACH MOMENT');
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
P('Return exactly one JSON array. Most elements are moments:');
P('  { "moment_id": "...", "locators": [...], "frame_hints": [...] }');
P('(include whichever of locators/frame_hints you actually have).');
P('');
P('Then, at the END of the array, add these three report objects. Include each one');
P('only if it has content — they are how stage-1 mistakes get repaired:');
P('');
P('  { "source_updates": [');
P('      { "source_id": "P01_S01", "duration_sec": 1312, "has_captions": true,');
P('        "inspection_status": "TRANSCRIPT_CHECKED" } ] }');
P('');
P('  { "replace_sources": [');
P('      { "source_id": "P02_S01",');
P('        "url": "https://www.youtube.com/watch?v=REAL_WORKING_ID",');
P('        "video_id": "REAL_WORKING_ID", "title": "Real title",');
P('        "channel": "Real channel", "duration_sec": 1290,');
P('        "source_kind": "OFFICIAL_EPISODE", "has_captions": true,');
P('        "reason": "original URL was unavailable" } ] }');
P('');
P('  { "broken_sources": [');
P('      { "source_id": "P05_S01", "problem": "video unavailable, no replacement found" } ] }');
P('');
P('Use replace_sources when you FOUND a working substitute; broken_sources only');
P('when you could not. Keep the original source_id in both cases — everything else');
P('in the project is already wired to it.');
P('');
P('Do not include moments you could not verify. Do not add explanation text.');
P('Do not stop partway through the array.');

fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, partTot > 1 ? `STAGE2_PROMPT_part${partNo}.txt` : 'STAGE2_PROMPT.txt');
fs.writeFileSync(outFile, L.join('\n') + '\n');

const rel = p => { const r = path.relative(ROOT, p); return r.startsWith('..') ? p : r; };
line();
console.log(`  likha: ${rel(outFile)}  (${Math.round(L.join('\n').length / 1024)} KB)`);
console.log('  isse Genspark/Gemini mein paste karo. Jo JSON array aaye use save karke:');
console.log(`     node tools/apply-stage2.js ${rel(packFile)} stage2.json`);
line();
