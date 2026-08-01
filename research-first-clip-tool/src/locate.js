// ============================================================
//  Stage 3 — LOCATE. Har aligned moment ke locators ko concrete cut-window
//  mein badalta hai. Order: EXACT_TIME -> DIALOGUE -> (APPROX/SEARCH = M2).
//
//  Usool:
//   - EXACT_TIME bhi bounds/metadata pass kare tabhi (blind trust nahi).
//   - DIALOGUE asli captions se timestamp nikaale (M1 ka accuracy core).
//   - kuch resolve na ho -> fallback (graphic/text) ya NEEDS_SOURCE.
//   - random/unrelated footage KABHI nahi (handoff §14).
// ============================================================
const fs = require('fs');
const U = require('./util.js');
const SRC = require('./sources.js');
const SUB = require('./subtitles.js');

const TYPE_ORDER = { EXACT_TIME: 0, DIALOGUE: 1, APPROX_WINDOW: 2, SEARCH_ONLY: 3, UNRESOLVED: 4 };

module.exports = function locate(spec, cfg, st, aligned) {
  const id = spec.id;
  const sources = SRC.indexSources(spec.pack);
  const dcfg = cfg.dialogue;
  const clip = cfg.clip;

  const resolved = [];
  let nVideo = 0, nGraphic = 0, nNeeds = 0, nReview = 0;

  for (const m of aligned.moments) {
    const base = {
      moment_id: m.moment_id, pack_id: m._packId, scope: m._scope,
      script_cue_exact: m.script_cue_exact, purpose: m.purpose || '',
      must_show: m.must_show || [], must_not_show: m.must_not_show || [],
      beat_start: m.beat_start, beat_end: m.beat_end, align_flag: m.align_flag, align_score: m.align_score,
      preferred_clip_sec: m.preferred_clip_sec || null,
    };

    const locs = [...(m.locators || [])].sort((a, b) => (TYPE_ORDER[a.locator_type] ?? 9) - (TYPE_ORDER[b.locator_type] ?? 9));
    let hit = null;
    const attempts = [];

    for (const L of locs) {
      const src = sources[L.source_id];
      if (!src) { attempts.push({ type: L.locator_type, source_id: L.source_id, result: 'source not in pack' }); continue; }
      const meta = SRC.getMeta(id, src, cfg);
      if (!meta.available) { attempts.push({ type: L.locator_type, source_id: L.source_id, result: `source unavailable: ${meta.error || 'na'}` }); continue; }

      if (L.locator_type === 'EXACT_TIME') {
        let s = L.start_sec, e = L.end_sec;
        if (typeof s !== 'number' || typeof e !== 'number' || e <= s) { attempts.push({ type: 'EXACT_TIME', source_id: L.source_id, result: 'bad start/end' }); continue; }
        if (meta.duration && s >= meta.duration) { attempts.push({ type: 'EXACT_TIME', source_id: L.source_id, result: `start ${s}s > source duration ${Math.round(meta.duration)}s` }); continue; }
        if (meta.duration && e > meta.duration) e = meta.duration;   // clamp
        hit = { kind: 'video', source: src, meta, locator_type: 'EXACT_TIME', cut: { start: s, end: e }, decision: 'ACCEPT',
                score: null, recall: null, reason: `EXACT_TIME bounds ok (dur ${Math.round(meta.duration || 0)}s)`, confidence: L.confidence || 'HIGH' };
        break;
      }

      if (L.locator_type === 'DIALOGUE') {
        const subs = SRC.getSubs(id, src, cfg);
        if (!subs.cues || !subs.cues.length) { attempts.push({ type: 'DIALOGUE', source_id: L.source_id, result: `no captions (${subs.via}) -> M2 ASR` }); continue; }
        const match = SUB.locateDialogue(subs.cues, L.dialogue_exact, { variants: L.dialogue_variants_verified || [], anchors: L.nearby_context_terms || [] });
        const dec = SUB.decide(match, dcfg);
        if (dec.decision === 'ACCEPT' || dec.decision === 'REVIEW') {
          hit = { kind: 'video', source: src, meta, locator_type: 'DIALOGUE', cut: { start: match.start_sec, end: match.end_sec },
                  decision: dec.decision, score: match.score, recall: match.recall, reason: `DIALOGUE (${subs.via}): ${dec.reason}`,
                  matched: match.matched, confidence: L.confidence || 'MEDIUM' };
          break;
        }
        attempts.push({ type: 'DIALOGUE', source_id: L.source_id, result: `${dec.decision}: ${dec.reason}` });
        continue;
      }

      // APPROX_WINDOW / SEARCH_ONLY / UNRESOLVED -> Milestone 2
      attempts.push({ type: L.locator_type, source_id: L.source_id, result: 'deferred to Milestone 2' });
    }

    if (hit) {
      // cut window ko clip rules ke hisaab se trim/pad karo (video max 6s)
      const cut = shapeVideoWindow(hit, clip);
      const entry = { ...base, status: 'RESOLVED', kind: 'video', source_id: hit.source.source_id,
        source_kind: hit.meta.kind, url: hit.source.url || null, local_file: hit.source.local_file || null,
        locator_type: hit.locator_type, decision: hit.decision, score: hit.score, recall: hit.recall,
        reason: hit.reason, matched: hit.matched || null, cut, attempts };
      if (hit.decision === 'REVIEW') nReview++;
      resolved.push(entry); nVideo++;
      continue;
    }

    // ---- kuch resolve nahi hua -> fallback ----
    const fb = m.fallback || {};
    if (fb.type === 'TEXT_CARD' || fb.type === 'LOCAL_GRAPHIC') {
      resolved.push({ ...base, status: 'FALLBACK_GRAPHIC', kind: fb.type === 'TEXT_CARD' ? 'text' : 'graphic',
        fallback_text: fb.text || m.script_cue_exact, reason: `no source resolved -> ${fb.type}`, attempts });
      nGraphic++;
    } else {
      // STILL_FROM_PACK / ANOTHER_VERIFIED_MOMENT / NEEDS_SOURCE / none -> M1 mein NEEDS_SOURCE
      resolved.push({ ...base, status: 'NEEDS_SOURCE', kind: 'none',
        reason: fb.type ? `fallback ${fb.type} = Milestone 2 -> NEEDS_SOURCE` : 'no resolvable locator -> NEEDS_SOURCE', attempts });
      nNeeds++;
    }
  }

  const outFile = U.p(id, 'resolved.json');
  fs.writeFileSync(outFile, JSON.stringify(resolved, null, 2));
  U.ok(`located: ${nVideo} video (${nReview} review), ${nGraphic} graphic/text, ${nNeeds} NEEDS_SOURCE`);
  st.meta.locate = { video: nVideo, review: nReview, graphic: nGraphic, needsSource: nNeeds };
  return resolved;
};

// video window ko clip.videoMaxSeconds ke andar lao.
// DIALOGUE: line ke around thoda pad; phir 6s cap (beech se). EXACT_TIME: as given, 6s cap.
function shapeVideoWindow(hit, clip) {
  let { start, end } = hit.cut;
  if (hit.locator_type === 'DIALOGUE') {
    start = Math.max(0, start - (clip.dialoguePrePadSeconds || 0));
    end = end + (clip.dialoguePostPadSeconds || 0);
  }
  let dur = end - start;
  const max = clip.videoMaxSeconds || 6;
  const min = clip.videoMinSeconds || 2;
  if (dur > max) { const mid = start + dur / 2; start = Math.max(0, mid - max / 2); end = start + max; dur = max; }
  if (dur < min) { end = start + min; dur = min; }
  return { start: +start.toFixed(3), end: +end.toFixed(3), dur: +dur.toFixed(3) };
}
