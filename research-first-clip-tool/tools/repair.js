#!/usr/bin/env node
// ============================================================
//  REPAIR — pack ki kamiyon ke liye CHHOTE, KHUD-MUKHTAR prompts banata hai.
//
//  Pehle kya galat tha:
//  NEEDS_RESEARCH.txt kehta tha "poora text USI Genspark chat mein paste karo
//  jisme pack bana tha". Genspark ek account par 24 ghante mein ek hi jawab deta
//  hai — yaani har video ek purani, khatam ho chuki chat par atak jati thi.
//  10-15 video/din us tarike se mumkin hi nahi tha.
//
//  Ab: har prompt apne aap mein poora hai. Usme sources ke URL, unki NAAPI HUI
//  duration/captions, narration ki lines, moment IDs, aur wapas kya bhejna hai —
//  sab andar likha hai. Use KISI BHI nayi chat, naye account ya doosre tool
//  (Gemini, ChatGPT, Perplexity — jiske paas live web ho) mein paste kar do.
//  Purani chat ki koi zaroorat nahi.
//
//  Ek prompt = 12-18 moments (default), taaki jawab beech mein na tootey.
//
//    node tools/repair.js                          (input/scene-research.json)
//    node tools/repair.js --batch=15
//
//  Jawab aane par: JSON files output/repair/responses/ mein daal do (naam kuch
//  bhi), phir:  node tools/apply-repair.js
// ============================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const U = require(path.join(ROOT, 'src', 'util.js'));
const validate = require(path.join(ROOT, 'src', 'validate.js'));
const SCOPE = require(path.join(ROOT, 'src', 'scope.js'));

const argv = process.argv.slice(2);
const flags = argv.filter(a => a.startsWith('--'));
const files = argv.filter(a => !a.startsWith('--'));
const val = (f, d) => { const x = flags.find(y => y.startsWith('--' + f + '=')); return x ? x.slice(f.length + 3) : d; };

const packFile = files[0] || path.join(ROOT, 'input', 'scene-research.json');
const outRoot = val('out', path.join(ROOT, 'output'));
const outDir = path.join(outRoot, 'repair');
const BATCH = Math.max(4, Math.min(24, parseInt(val('batch', '15'), 10) || 15));

const die = m => { console.log('  [FAIL] ' + m); process.exit(1); };
const line = (c = '=') => console.log(c.repeat(72));
const rel = p => { const r = path.relative(ROOT, p); return r.startsWith('..') ? p : r; };

line(); console.log('  REPAIR PROMPTS — chhote, khud-mukhtar (kisi bhi nayi chat mein chalenge)'); line();

if (!fs.existsSync(packFile)) die(`pack nahi mila: ${packFile}`);
const v = validate.validateFile(packFile);
if (!v.ok) { (v.errors || []).slice(0, 8).forEach(e => console.log('  [FAIL] ' + e)); die('pack invalid hai.'); }
const pack = v.pack;
const packSha = U.hashFile(packFile);

const idx = SCOPE.indexPack(pack);
const packById = {}; for (const pk of pack.packs) packById[pk.pack_id] = pk;
const sourcesById = {};
for (const pk of pack.packs) for (const s of (pk.sources || [])) sourcesById[s.source_id] = { ...s, pack_id: pk.pack_id };
const showPacks = pack.packs.filter(pk => !SCOPE.isGraphic(pk.scope)).map(pk => pk.pack_id);

// ---------- CHECKPACK ki naapi hui baat (ho to) ----------
let rep = null;
try { rep = JSON.parse(fs.readFileSync(path.join(outRoot, 'pack-report.json'), 'utf8')); } catch {}
const repFresh = !!(rep && rep.pack_sha256 === packSha);
const deadIds = new Set(repFresh ? ((rep.live_verify || {}).dead_sources || []).map(d => d.source_id) : []);
const badDlg = repFresh ? ((rep.live_verify || {}).dialogue_not_found || []) : [];
const badTime = repFresh ? ((rep.live_verify || {}).bad_exact_time || []) : [];
const alignBad = repFresh ? (rep.align_problem_moments || []) : [];

// ---------- har moment ko ek category do ----------
//  Ye sirf "jiske paas kuch nahi" wale moments nahi chunta. M3.6 ki galti yahi
//  thi: jis moment ka locator MAUJOOD tha par CHECKPACK ne use TOOTA hua sabit
//  kar diya, wo kisi batch mein aata hi nahi tha — yaani wo kabhi theek hi nahi hota.
const all = [];
for (const pk of pack.packs) for (const m of (pk.moments || [])) all.push({ m, pk });
all.sort((a, b) => (a.m.script_order ?? 0) - (b.m.script_order ?? 0));

const badDlgBy = {}; for (const d of badDlg) (badDlgBy[d.moment_id] = badDlgBy[d.moment_id] || []).push(d);
const badTimeBy = {}; for (const d of badTime) (badTimeBy[d.moment_id] = badTimeBy[d.moment_id] || []).push(d);
const alignBy = {}; for (const a of alignBad) alignBy[a.moment_id] = a;

const CAT = {
  BLOCKING_SOURCES: [], BROKEN_LOCATORS: [], MISSING_EXACT: [], GRAPHIC_HINTS: [], MISSING_CRITICALITY: [],
};
for (const row of all) {
  const { m, pk } = row;
  const graphic = SCOPE.isGraphic(pk.scope);
  const locs = (m.locators || []).filter(L => L.locator_type === 'EXACT_TIME' || L.locator_type === 'DIALOGUE');
  const hints = ((m.fallback_plan || {}).frame_hints || []);
  const onDead = locs.some(L => deadIds.has(L.source_id)) || hints.some(h => deadIds.has(h.source_id));
  const broken = !!(badDlgBy[m.moment_id] || badTimeBy[m.moment_id]);
  row.align = alignBy[m.moment_id] || null;

  if (onDead) CAT.BLOCKING_SOURCES.push(row);
  else if (broken) CAT.BROKEN_LOCATORS.push(row);
  else if (!locs.length && !hints.length) (graphic ? CAT.GRAPHIC_HINTS : CAT.MISSING_EXACT).push(row);
  if (!m.criticality) CAT.MISSING_CRITICALITY.push(row);
}

// cue-mismatch alag se: ye LOCAL theek hota hai, AI ki zaroorat nahi
const cueProblems = alignBad.length;

// ---------- prompt ke tukde ----------
const sourceBlock = (P, wantIds) => {
  const want = new Set(wantIds);
  for (const pk of pack.packs) {
    const srcs = (pk.sources || []).filter(s => want.has(s.source_id));
    if (!srcs.length) continue;
    const sc = pk.scope || {};
    P(`  ${pk.pack_id}  [${sc.kind}] ${sc.title}${sc.episode_title ? ` — S${sc.season}E${sc.episode_number} "${sc.episode_title}"` : (sc.year ? ` (${sc.year})` : '')}`);
    for (const s of srcs) {
      const dead = deadIds.has(s.source_id) || s.availability_status === 'DEAD';
      if (dead) {
        P(`     source_id: ${s.source_id}   *** CONFIRMED DEAD — NEEDS REPLACEMENT ***`);
        P(`     ${s.url || s.local_file}`);
        P('     We opened this URL ourselves. It does not play. Do not write timestamps against it.');
      } else {
        const measured = s.availability_status === 'WORKING' || (repFresh && !dead);
        P(`     source_id: ${s.source_id}${measured ? '   [CONFIRMED WORKING — we opened it]' : ''}`);
        P(`     ${s.url || ('local file: ' + s.local_file)}`);
        const bits = [];
        if (s.duration_sec) bits.push(`duration ${s.duration_sec}s`);
        if (typeof s.has_captions === 'boolean') bits.push(s.has_captions ? 'has captions' : 'NO CAPTIONS — dialogue locators will not work here, use EXACT_TIME');
        if (bits.length) P(`     ${measured ? 'measured' : 'claimed'}: ${bits.join(', ')}`);
      }
    }
    P('');
  }
};

const OUTPUT_CONTRACT = (P, batchId) => {
  P('======================================================================');
  P('OUTPUT FORMAT — return exactly this, nothing else');
  P('======================================================================');
  P('');
  P('Return ONE JSON object. No Markdown fences, no commentary before or after.');
  P('');
  P('{');
  P('  "schema_version": "research-repair-v2",');
  P(`  "batch_id": "${batchId}",`);
  P(`  "base_pack_sha256": "${packSha}",`);
  P('  "moment_updates": [');
  P('    {');
  P('      "moment_id": "P01_M02",');
  P('      "locators": [');
  P('        { "source_id": "P01_S01", "locator_type": "DIALOGUE",');
  P('          "dialogue_exact": "verbatim line copied from that source\'s captions",');
  P('          "nearby_context_terms": ["distinctive nearby word"],');
  P('          "verification_method": "TRANSCRIPT", "confidence": "HIGH" },');
  P('        { "source_id": "P01_S01", "locator_type": "EXACT_TIME",');
  P('          "start_sec": 412.0, "end_sec": 418.0,');
  P('          "verification_method": "WATCHED", "confidence": "HIGH" }');
  P('      ],');
  P('      "frame_hints": [');
  P('        { "source_id": "P01_S01", "time_sec": 409, "reason": "same scene, clean wide shot" }');
  P('      ]');
  P('    }');
  P('  ],');
  P('  "source_replacements": [');
  P('    { "source_id": "P03_S01", "url": "https://www.youtube.com/watch?v=WORKING_ID",');
  P('      "video_id": "WORKING_ID", "title": "Real title", "channel": "Real channel",');
  P('      "duration_sec": 1290, "source_kind": "OFFICIAL_EPISODE", "has_captions": true,');
  P('      "reason": "original was unavailable" }');
  P('  ],');
  P('  "source_updates": [');
  P('    { "source_id": "P01_S01", "duration_sec": 1312, "has_captions": true,');
  P('      "inspection_status": "TRANSCRIPT_CHECKED" }');
  P('  ],');
  P('  "unresolved": [');
  P('    { "moment_id": "P03_M07", "problem": "no working upload of this film exists publicly" }');
  P('  ]');
  P('}');
  P('');
  P('Include only the keys you actually have content for. An omitted moment is fine.');
  P('An invented timestamp is not — it produces a video showing the wrong scene.');
  P('Keep source_id values exactly as given; everything downstream is wired to them.');
  P('');
};

const STANDALONE_HEADER = (P, title, batchId, count) => {
  P('You are a precision footage researcher with live web access: you can open');
  P('video pages, play them, and read their captions/transcripts.');
  P('');
  P('THIS PROMPT IS SELF-CONTAINED. You have no prior conversation with us and you');
  P('do not need one. Everything required — the source URLs, their real measured');
  P('durations, the narration lines, and the exact output format — is written below.');
  P('Do not ask for missing context; if something is genuinely not here, report it');
  P('under "unresolved" at the end.');
  P('');
  P(`TASK: ${title}`);
  P(`BATCH: ${batchId}  (${count} items)`);
  P('');
  P('Do NOT rewrite narration, do NOT re-split beats, do NOT invent new moment IDs.');
  P('That work is finished. Spend your whole budget on opening videos and reporting');
  P('real seconds and real caption lines.');
  P('');
};

const RULES = (P) => {
  P('RULES');
  P('  - dialogue_exact must be copied verbatim from THAT source\'s captions. Not a');
  P('    paraphrase, not from memory, not the narration wording, and never two');
  P('    speakers\' lines joined. One continuous captioned utterance.');
  P('  - start_sec/end_sec are numbers in seconds (not "12:34"), inside that');
  P('    upload\'s real duration. Normal clip length 3-9s, and the action must');
  P('    already be happening at start_sec.');
  P('  - A timestamp belongs to ONE upload. Never carry a timestamp from a different');
  P('    upload of the same episode — intros and trims differ.');
  P('  - Give BOTH a DIALOGUE and an EXACT_TIME locator when you can. Dialogue');
  P('    survives an upload being offset; EXACT_TIME survives an upload having no');
  P('    captions. Together they survive both.');
  P('  - frame_hints are seconds where you actually saw something useful. Avoid');
  P('    transitions, black frames, credits and title cards. 2-3 per moment.');
  P('');
};

const momentBlock = (P, row) => {
  const { m, pk } = row;
  const graphic = SCOPE.isGraphic(pk.scope);
  const fp = m.fallback_plan || {};
  const allowed = (fp.allowed_pack_ids || []).length ? fp.allowed_pack_ids : (graphic ? showPacks : [pk.pack_id]);
  const sc = pk.scope || {};
  P(`--- ${m.moment_id}${graphic ? '   [ANALYSIS CARD — frame_hints only, no scene of its own]'
    : `   [${sc.title}${sc.episode_title ? ` / S${sc.season}E${sc.episode_number} "${sc.episode_title}"` : ''}]`}`);
  P(`    narration: "${m.script_cue_exact}"`);
  if (m.purpose) P(`    intent   : ${m.purpose}`);
  const must = m.must_show || fp.must_show || [];
  if (must.length) P(`    must show: ${must.join(', ')}`);
  const mustNot = m.must_not_show || fp.must_not_show || [];
  if (mustNot.length) P(`    must NOT show: ${mustNot.join(', ')}`);
  const useIds = allowed.flatMap(x => (packById[x] ? (packById[x].sources || []).map(s => s.source_id) : []));
  P(`    may use  : ${useIds.join(', ') || '(see source list above)'}`);
  // jo pehle se hai wo bhi dikhao — taaki researcher ko pata ho kya toota hai
  for (const d of (badDlgBy[m.moment_id] || [])) {
    P(`    BROKEN   : the dialogue line we were given is NOT in ${d.source_id}'s captions`);
    P(`               "${String(d.dialogue || '').slice(0, 78)}"`);
    P('               -> read the real captions and give a line that IS there.');
  }
  for (const d of (badTimeBy[m.moment_id] || [])) {
    P(`    BROKEN   : the timestamp we were given is outside ${d.source_id}'s real length`);
    P(`               ${String(d.why || '').slice(0, 78)}`);
  }
  P('');
};

// ---------- batches likho ----------
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.join(outDir, 'responses'), { recursive: true });
// purane batch files hata do — warna pichhli baar ke stale prompts padhe reh jate hain
for (const f of fs.readdirSync(outDir)) {
  if (/^\d\d_.*\.txt$/.test(f)) fs.unlinkSync(path.join(outDir, f));
}

const manifest = { schema: 'repair-manifest-v1', generated_at: new Date().toISOString(),
  pack_file: path.basename(packFile), base_pack_sha256: packSha, batch_size: BATCH,
  report_fresh: repFresh, batches: [], local_fixes: [] };
let fileNo = 0;
const writeBatch = (kind, title, rows, extra) => {
  if (!rows.length) return;
  const chunks = [];
  for (let i = 0; i < rows.length; i += BATCH) chunks.push(rows.slice(i, i + BATCH));
  chunks.forEach((rows2, k) => {
    fileNo++;
    const batchId = chunks.length > 1 ? `${kind.toLowerCase()}-${String(k + 1).padStart(2, '0')}` : kind.toLowerCase();
    const name = `${String(fileNo).padStart(2, '0')}_${kind}${chunks.length > 1 ? `_${String(k + 1).padStart(2, '0')}` : ''}.txt`;
    const L = []; const P = s => L.push(s);
    STANDALONE_HEADER(P, title, batchId, rows2.length);
    if (extra) extra(P, rows2);
    P('======================================================================');
    P('SOURCES YOU MAY USE');
    P('======================================================================');
    P('');
    const ids = new Set();
    for (const r of rows2) {
      const fp = r.m.fallback_plan || {};
      const allowed = (fp.allowed_pack_ids || []).length ? fp.allowed_pack_ids
        : (SCOPE.isGraphic(r.pk.scope) ? showPacks : [r.pk.pack_id]);
      for (const pid of allowed) for (const s of ((packById[pid] || {}).sources || [])) ids.add(s.source_id);
      for (const L2 of (r.m.locators || [])) if (L2.source_id) ids.add(L2.source_id);
    }
    sourceBlock(P, ids);
    if (repFresh) {
      P('The durations and caption flags above are NOT claims from an earlier');
      P('researcher — we opened every one of these URLs ourselves and measured them.');
      P('Trust them. You do not need to re-verify anything marked CONFIRMED WORKING.');
      P('');
    }
    RULES(P);
    P('======================================================================');
    P(`MOMENTS IN THIS BATCH — ${rows2.length}`);
    P('======================================================================');
    P('');
    P('The narration text is given only so you can tell which scene is meant.');
    P('It is not to be edited, re-split, or returned.');
    P('');
    for (const r of rows2) momentBlock(P, r);
    OUTPUT_CONTRACT(P, batchId);
    fs.writeFileSync(path.join(outDir, name), L.join('\n') + '\n');
    manifest.batches.push({ file: name, batch_id: batchId, kind, moments: rows2.map(r => r.m.moment_id) });
    console.log(`  ${name.padEnd(34)} ${String(rows2.length).padStart(3)} moments`);
  });
};

writeBatch('BLOCKING_SOURCES', 'Replace dead sources, then re-locate the moments that depended on them',
  CAT.BLOCKING_SOURCES, (P) => {
    P('PRIORITY: the sources marked CONFIRMED DEAD below are the single biggest loss');
    P('in this project — every moment listed here depends on them and currently has');
    P('no usable footage at all.');
    P('');
    P('Find a working public upload of the SAME episode/film. Prefer, in order: an');
    P('official network/studio channel full episode, an official clip, a licensed');
    P('upload, then a clean scene upload you inspected. Reject anything with a');
    P('reaction host, facecam, picture-in-picture, review commentary, fan edit, AMV,');
    P('speed change, mirroring, heavy watermark or burned-in subtitles, or the wrong');
    P('version of the show. Prefer uploads that HAVE captions. Never substitute');
    P('footage from a different show — that would put the wrong series on screen.');
    P('');
    P('Return the replacement under "source_replacements" keeping the SAME source_id,');
    P('then give locators for the moments below against that new URL.');
    P('');
    P('If no acceptable upload exists, say so in "unresolved" rather than settling');
    P('for a poor one. An honest gap is cheaper to fix than wrong footage.');
    P('');
  });
writeBatch('BROKEN_LOCATORS', 'Fix locators that we tested and proved wrong', CAT.BROKEN_LOCATORS, (P) => {
  P('Each moment below already HAS a locator — we tested it against the real');
  P('captions/duration and it failed. The specific failure is printed with each');
  P('moment. Replace it with something you actually read or watched.');
  P('');
});
writeBatch('MISSING_EXACT', 'Find the exact scene for these narration beats', CAT.MISSING_EXACT);
writeBatch('GRAPHIC_HINTS', 'Give real frames for analysis cards', CAT.GRAPHIC_HINTS, (P) => {
  P('These are ANALYSIS moments: commentary lines with no scene of their own. Do NOT');
  P('invent a scene for them. Return frame_hints only — seconds inside the show');
  P('sources where a frame visually suits the line being narrated. A still from the');
  P('real show behind the text is always better than a plain text card.');
  P('');
  if (showPacks.length) { P(`Analysis moments may use sources from these packs only: ${showPacks.join(', ')}`); P(''); }
});

// ---------- jo LOCAL theek hota hai, uske liye prompt banate hi nahi ----------
if (cueProblems) {
  manifest.local_fixes.push({ kind: 'CUE_MISMATCH', count: cueProblems, tool: 'tools/fix-cues.js' });
}
if (CAT.MISSING_CRITICALITY.length) {
  manifest.local_fixes.push({ kind: 'MISSING_CRITICALITY', count: CAT.MISSING_CRITICALITY.length, tool: 'tools/migrate-pack.js' });
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

line();
if (!repFresh) {
  console.log('  [!] Is pack ka taaza CHECKPACK nahi mila.');
  console.log('      Iske bina ye tool ye nahi jaan sakta ki kaunsa source MAR chuka hai aur');
  console.log('      kaunsa locator TOOTA hua hai — yaani "dead source" aur "broken locator"');
  console.log('      wale batch ban hi nahi paate. Pehle CHECKPACK.bat chalao, phir ye.');
  console.log('');
}
if (!manifest.batches.length) console.log('  Kisi AI ki zaroorat nahi — koi moment aisa nahi jise research chahiye.');
else {
  console.log(`  ${manifest.batches.length} prompt files: ${rel(outDir)}\\`);
  console.log('');
  console.log('  KAISE CHALANA HAI:');
  console.log('   1. Ek file kholo, poora text copy karo.');
  console.log('   2. KISI BHI nayi chat mein paste kar do (Genspark, Gemini, ChatGPT, Perplexity —');
  console.log('      jiske paas live web ho). Purani chat ki ZAROORAT NAHI hai.');
  console.log(`   3. Jo JSON aaye use ${rel(path.join(outDir, 'responses'))}\\ mein save kar do.`);
  console.log('      Naam kuch bhi rakho (batch1.json, x.json — koi farak nahi).');
  console.log('   4. Saari files aa jaayein (ya jitni aayein), phir: REPAIR.bat -> "jawab lagao"');
  console.log('');
  console.log('   Ek din mein ek hi jawab mile to bhi chalega — files jama karte raho,');
  console.log('   apply tool jitni milengi utni laga dega aur baaki ka hisaab rakhega.');
}
if (manifest.local_fixes.length) {
  console.log('');
  console.log('  YE CHEEZEIN KISI AI SE NAHI, YAHIN THEEK HOTI HAIN:');
  for (const f of manifest.local_fixes) {
    if (f.kind === 'CUE_MISMATCH') console.log(`   - ${f.count} narration cue galat hain -> node tools/fix-cues.js  (voiceover.srt se hubahu)`);
    if (f.kind === 'MISSING_CRITICALITY') console.log(`   - ${f.count} moments par criticality nahi -> node tools/migrate-pack.js`);
  }
}
line();
process.exit(0);
