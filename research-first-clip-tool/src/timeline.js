// ============================================================
//  Stage 7 — BEAT-DRIVEN TIMELINE (no drift).
//  Poori narration [0..total] EXACTLY tile hoti hai (koi gap dropped nahi,
//  koi time skip nahi — P1-8):
//    - RESOLVED video      -> clip (final mein)
//    - NEEDS_REVIEW        -> review card (report mein clip, final mein card) P1-3
//    - FALLBACK_GRAPHIC    -> graphic/text card
//    - NEEDS_SOURCE        -> needs_source card
//    - uncovered gaps      -> narration text card (chhote gaps adjacent mein merge)
//  Guarantee: sum(slot.dur) == total (assertion test).
// ============================================================
const fs = require('fs');
const U = require('./util.js');
const SUB = require('./subtitles.js');

const MERGE_GAP = 0.4;   // is se chhota gap adjacent visual mein absorb (micro-card se bachne ko)

function narrationTextFor(cues, a, b) {
  const parts = [];
  for (const c of cues) if (c.end > a && c.start < b) parts.push(c.text);
  return parts.join(' ').trim();
}

module.exports = function timeline(spec, cfg, st, resolved, total) {
  const id = spec.id;
  const cues = SUB.parseFile(spec.srt);
  if (!total) total = cues.length ? cues[cues.length - 1].end : 0;
  total = +total.toFixed(3);

  // placeable moments (beat_start hai) -> anchors, non-overlapping [start,end]
  const anchors = resolved.filter(e => e.beat_start != null)
    .map(e => ({ e, start: Math.max(0, +e.beat_start), end: Math.min(total, Math.max(+e.beat_start + 0.5, +(e.beat_end ?? e.beat_start + 3))) }))
    .sort((a, b) => a.start - b.start);
  // clamp overlaps (next.start se aage prev.end na jaye)
  for (let i = 0; i < anchors.length - 1; i++) if (anchors[i].end > anchors[i + 1].start) anchors[i].end = anchors[i + 1].start;
  // micro-gaps merge: agla anchor thoda door ho to uska start peeche kheecho
  for (let i = 0; i < anchors.length - 1; i++) { const g = anchors[i + 1].start - anchors[i].end; if (g > 0 && g < MERGE_GAP) anchors[i].end = anchors[i + 1].start; }

  const slots = [];
  const push = (kind, start, end, extra = {}) => { if (end - start <= 0.001) return; slots.push({ i: slots.length, kind, start: +start.toFixed(3), end: +end.toFixed(3), dur: +(end - start).toFixed(3), ...extra }); };
  const gapCard = (a, z) => {
    if (z - a <= 0.001) return;
    if (slots.length && (z - a) < MERGE_GAP) { const L = slots[slots.length - 1]; L.end = +z.toFixed(3); L.dur = +(L.end - L.start).toFixed(3); return; }  // absorb into prev
    push('text', a, z, { label: 'gap', text: narrationTextFor(cues, a, z), reason: 'no research moment for this narration' });
  };

  const slotForAnchor = (e, start, end) => {
    const common = {
      moment_id: e.moment_id, pack_id: e.pack_id, source_id: e.source_id || null,
      url: e.url || null, local_file: e.local_file || null, locator_type: e.locator_type || null,
      decision: e.decision || null, score: e.score, recall: e.recall, reason: e.reason || '',
      review_reason: e.review_reason || null, align_flag: e.align_flag, must_show: e.must_show || [],
      cue: e.script_cue_exact, qa: e.qa || null,
    };
    if (e.status === 'RESOLVED' && e.clip) push('video', start, end, { ...common, video: e.clip, clip_dur: e.cut && e.cut.dur });
    else if (e.status === 'NEEDS_REVIEW') push('needs_review', start, end, { ...common, text: e.script_cue_exact, label: 'NEEDS REVIEW', review_clip: e.clip || null });
    else if (e.status === 'FALLBACK_GRAPHIC') push(e.kind === 'text' ? 'text' : 'graphic', start, end, { ...common, text: e.fallback_text || e.script_cue_exact, label: 'fallback' });
    else push('needs_source', start, end, { ...common, text: e.script_cue_exact, label: 'NEEDS SOURCE' });
  };

  let cursor = 0;
  for (const a of anchors) {
    if (a.start - cursor > 0.001) gapCard(cursor, a.start);
    // gapCard ne prev extend kiya ho to slot uski jagah start ho — anchor start ko cursor/prev-end se align
    const startAligned = slots.length ? Math.max(a.start, slots[slots.length - 1].end) : a.start;
    // agar leading gap tha aur koi slot nahi bana (start~0) to startAligned=a.start
    const s = Math.min(startAligned, a.end);
    slotForAnchor(a.e, s, a.end);
    cursor = a.end;
  }
  if (total - cursor > 0.001) gapCard(cursor, total);
  // agar bilkul anchors nahi the
  if (!slots.length && total > 0.001) push('text', 0, total, { label: 'gap', text: narrationTextFor(cues, 0, total) });

  // drift guard: slots ko exactly [0,total] tile karna chahiye
  let sum = 0; for (const s of slots) sum += s.dur;
  const drift = +(total - sum).toFixed(3);
  if (Math.abs(drift) > 0.05 && slots.length) { const L = slots[slots.length - 1]; L.end = +(L.end + drift).toFixed(3); L.dur = +(L.end - L.start).toFixed(3); }

  const tlFile = U.p(id, 'timeline.json');
  fs.writeFileSync(tlFile, JSON.stringify({ total, slots }, null, 2));

  const by = k => slots.filter(s => s.kind === k).length;
  sum = 0; for (const s of slots) sum += s.dur;
  U.ok(`timeline: ${slots.length} slots (sum ${sum.toFixed(2)}s vs total ${total.toFixed(2)}s) — video ${by('video')}, review ${by('needs_review')}, text ${by('text')}, graphic ${by('graphic')}, needs_source ${by('needs_source')}`);
  st.meta.timeline = { slots: slots.length, video: by('video'), review: by('needs_review'), needsSource: by('needs_source'), total, sum: +sum.toFixed(2) };
  return { total, slots };
};
