// ============================================================
//  Stage 1 — RESEARCH PACK VALIDATION (scene-research-pack-v1)
//
//  Handoff §1/§10 rules:
//   - schema shape + enums
//   - duplicate pack_id / source_id / moment_id
//   - locator ke type ke hisaab se zaroori fields (EXACT_TIME -> start/end,
//     DIALOGUE -> dialogue_exact)
//   - timestamp sanity (start>=0, end>start). Duration-bounds Stage 3 mein
//     (source metadata aane ke baad).
//   - HIGH confidence + METADATA_ONLY source = reject
//   - locator ka source_id pack ki sources mein hona chahiye
//   - >=70% moments EXACT_TIME/DIALOGUE na hon to warn RESEARCH_INCOMPLETE
//
//  errors[] => job rukega. warnings[] => chalega par report mein dikhega.
// ============================================================
const fs = require('fs');

const ENUM = {
  scopeKind: ['SERIES', 'FILM', 'DOCUMENTARY', 'REAL_WORLD', 'GRAPHIC', 'MULTI_SOURCE'],
  visual: ['EXACT_SCENE', 'CONTEXT_SCENE', 'LOCAL_GRAPHIC', 'MULTI_SOURCE_MONTAGE', 'STILL_FROM_VERIFIED_SOURCE'],
  sourceKind: ['OFFICIAL_EPISODE', 'OFFICIAL_CLIP', 'LICENSED_UPLOAD', 'CLEAN_SCENE', 'COMPILATION', 'OTHER'],
  inspection: ['VERIFIED_WATCHED', 'TRANSCRIPT_CHECKED', 'METADATA_ONLY'],
  locator: ['EXACT_TIME', 'DIALOGUE', 'APPROX_WINDOW', 'SEARCH_ONLY', 'UNRESOLVED'],
  confidence: ['HIGH', 'MEDIUM', 'LOW', 'NONE'],
  fallback: ['ANOTHER_VERIFIED_MOMENT', 'STILL_FROM_PACK', 'LOCAL_GRAPHIC', 'MULTI_SOURCE_MONTAGE', 'TEXT_CARD', 'NEEDS_SOURCE'],
};

const isNum = x => typeof x === 'number' && !Number.isNaN(x);
const looksUrl = u => typeof u === 'string' && /^https?:\/\/\S+$/i.test(u);

function validatePackObject(pack) {
  const errors = [];
  const warnings = [];

  if (!pack || typeof pack !== 'object') return { ok: false, errors: ['pack JSON object nahi hai'], warnings: [] };
  if (pack.schema_version !== 'scene-research-pack-v1')
    errors.push(`schema_version "scene-research-pack-v1" hona chahiye (mila: ${JSON.stringify(pack.schema_version)})`);
  if (!pack.project_title) warnings.push('project_title khaali hai');
  if (!Array.isArray(pack.packs) || !pack.packs.length) {
    errors.push('packs[] khaali/missing hai');
    return { ok: false, errors, warnings };
  }

  const seenPackIds = new Set();
  const seenMomentIds = new Set();
  const allSourceIds = new Set();          // reuse ke liye global source map
  let momentCount = 0;
  let exactOrDialogue = 0;
  const sourcesById = {};

  // pehle sab sources index karo (reuse across packs allow)
  for (const pk of pack.packs) {
    for (const s of (pk.sources || [])) {
      if (s && s.source_id) { allSourceIds.add(s.source_id); sourcesById[s.source_id] = s; }
    }
  }

  for (const pk of pack.packs) {
    const pid = pk.pack_id || '(no pack_id)';
    if (!pk.pack_id) errors.push('kisi pack ka pack_id missing');
    else if (seenPackIds.has(pk.pack_id)) errors.push(`duplicate pack_id: ${pk.pack_id}`);
    else seenPackIds.add(pk.pack_id);

    if (!pk.scope || !pk.scope.kind) errors.push(`[${pid}] scope.kind missing`);
    else if (!ENUM.scopeKind.includes(pk.scope.kind)) errors.push(`[${pid}] scope.kind galat: ${pk.scope.kind}`);
    if (pk.scope && !pk.scope.title) warnings.push(`[${pid}] scope.title khaali`);
    if (pk.visual_mode && !ENUM.visual.includes(pk.visual_mode)) errors.push(`[${pid}] visual_mode galat: ${pk.visual_mode}`);

    // sources
    const localSourceIds = new Set();
    for (const s of (pk.sources || [])) {
      const sid = s.source_id || '(no source_id)';
      if (!s.source_id) errors.push(`[${pid}] source ka source_id missing`);
      else if (localSourceIds.has(s.source_id)) errors.push(`[${pid}] duplicate source_id: ${s.source_id}`);
      else localSourceIds.add(s.source_id);

      const hasUrl = looksUrl(s.url);
      const hasLocal = typeof s.local_file === 'string' && s.local_file.trim();
      if (!hasUrl && !hasLocal && (!pk.scope || pk.scope.kind !== 'GRAPHIC'))
        errors.push(`[${pid}/${sid}] na valid url na local_file`);
      if (s.url && !looksUrl(s.url)) errors.push(`[${pid}/${sid}] url invalid: ${String(s.url).slice(0, 50)}`);
      if (s.source_kind && !ENUM.sourceKind.includes(s.source_kind)) warnings.push(`[${pid}/${sid}] source_kind unknown: ${s.source_kind}`);
      if (s.inspection_status && !ENUM.inspection.includes(s.inspection_status)) warnings.push(`[${pid}/${sid}] inspection_status unknown: ${s.inspection_status}`);
    }

    // moments
    if (!Array.isArray(pk.moments) || !pk.moments.length) { errors.push(`[${pid}] moments[] khaali`); continue; }
    for (const m of pk.moments) {
      momentCount++;
      const mid = m.moment_id || '(no moment_id)';
      if (!m.moment_id) errors.push(`[${pid}] moment ka moment_id missing`);
      else if (seenMomentIds.has(m.moment_id)) errors.push(`duplicate moment_id: ${m.moment_id}`);
      else seenMomentIds.add(m.moment_id);

      if (!m.script_cue_exact || !String(m.script_cue_exact).trim())
        errors.push(`[${mid}] script_cue_exact khaali (narration se match nahi ho payega)`);
      if (m.visual_role && !ENUM.visual.includes(m.visual_role)) warnings.push(`[${mid}] visual_role unknown: ${m.visual_role}`);
      if (m.fallback && m.fallback.type && !ENUM.fallback.includes(m.fallback.type))
        warnings.push(`[${mid}] fallback.type unknown: ${m.fallback.type}`);

      const locs = Array.isArray(m.locators) ? m.locators : [];
      if (!locs.length) { warnings.push(`[${mid}] koi locator nahi — UNRESOLVED treat hoga (NEEDS_SOURCE)`); continue; }

      let momentHasExactOrDialogue = false;
      for (let i = 0; i < locs.length; i++) {
        const L = locs[i];
        const tag = `${mid}/loc${i}`;
        if (!L.locator_type || !ENUM.locator.includes(L.locator_type)) { errors.push(`[${tag}] locator_type galat: ${L.locator_type}`); continue; }
        if (!L.source_id) errors.push(`[${tag}] source_id missing`);
        else if (!allSourceIds.has(L.source_id)) errors.push(`[${tag}] source_id "${L.source_id}" kisi pack ki sources mein nahi`);
        if (L.confidence && !ENUM.confidence.includes(L.confidence)) warnings.push(`[${tag}] confidence unknown: ${L.confidence}`);

        // HIGH confidence + METADATA_ONLY source = reject (handoff Stage 1)
        const src = sourcesById[L.source_id];
        if (L.confidence === 'HIGH' && src && src.inspection_status === 'METADATA_ONLY')
          errors.push(`[${tag}] HIGH confidence par source "${L.source_id}" METADATA_ONLY hai (verify nahi hua) — reject`);

        if (L.locator_type === 'EXACT_TIME') {
          if (!isNum(L.start_sec) || !isNum(L.end_sec)) errors.push(`[${tag}] EXACT_TIME ke liye start_sec & end_sec numbers hone chahiye`);
          else {
            if (L.start_sec < 0) errors.push(`[${tag}] start_sec negative`);
            if (L.end_sec <= L.start_sec) errors.push(`[${tag}] end_sec (${L.end_sec}) start_sec (${L.start_sec}) se bada hona chahiye`);
          }
          momentHasExactOrDialogue = true;
        } else if (L.locator_type === 'DIALOGUE') {
          if (!L.dialogue_exact || !String(L.dialogue_exact).trim()) errors.push(`[${tag}] DIALOGUE ke liye dialogue_exact chahiye`);
          momentHasExactOrDialogue = true;
        } else if (L.locator_type === 'APPROX_WINDOW') {
          if (!isNum(L.start_sec) || !isNum(L.end_sec)) warnings.push(`[${tag}] APPROX_WINDOW ka start/end missing (M2 mein verify hoga)`);
        }
      }
      if (momentHasExactOrDialogue) exactOrDialogue++;
    }
  }

  // >=70% EXACT_TIME/DIALOGUE
  const ratio = momentCount ? exactOrDialogue / momentCount : 0;
  if (momentCount && ratio < 0.7)
    warnings.push(`RESEARCH_INCOMPLETE: sirf ${Math.round(ratio * 100)}% moments EXACT_TIME/DIALOGUE hain (target >=70%). Baaki NEEDS_SOURCE/fallback ho sakte hain.`);

  const stats = { packs: pack.packs.length, sources: allSourceIds.size, moments: momentCount, exactOrDialogue, exactOrDialoguePct: Math.round(ratio * 100) };
  return { ok: errors.length === 0, errors, warnings, stats };
}

function validateFile(jsonPath) {
  if (!fs.existsSync(jsonPath)) return { ok: false, errors: [`research pack file nahi mili: ${jsonPath}`], warnings: [] };
  let pack;
  try { pack = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); }
  catch (e) { return { ok: false, errors: [`research pack JSON parse fail: ${e.message}`], warnings: [] }; }
  const res = validatePackObject(pack);
  res.pack = pack;
  return res;
}

module.exports = { validateFile, validatePackObject, ENUM };
