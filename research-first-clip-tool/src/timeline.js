// ============================================================
//  Stage 7 — BEAT-DRIVEN TIMELINE.
//  Har resolved moment apne narration window [beat_start, beat_end] par
//  baithta hai. Poori narration [0..total] tile hoti hai:
//    - RESOLVED video  -> video slot (clip)
//    - FALLBACK_GRAPHIC-> graphic/text slot
//    - NEEDS_SOURCE    -> honest "NEEDS SOURCE" card (random footage NAHI)
//    - uncovered gaps  -> narration text card (SRT se)
//  Overlaps resolve, gaps fill -> render ko continuous timeline milti hai.
// ============================================================
const fs = require('fs');
const U = require('./util.js');
const SUB = require('./subtitles.js');

const GAP_MIN = 0.5;

function narrationTextFor(cues, a, b) {
  const parts = [];
  for (const c of cues) { if (c.end > a && c.start < b) parts.push(c.text); }
  return parts.join(' ').trim();
}

module.exports = function timeline(spec, cfg, st, resolved, total) {
  const id = spec.id;
  const cues = SUB.parseFile(spec.srt);
  if (!total) total = cues.length ? cues[cues.length - 1].end : 0;

  // sirf placeable moments (beat_start hai)
  const placed = resolved.filter(e => e.beat_start != null).sort((a, b) => a.beat_start - b.beat_start);

  const slots = [];
  const push = (kind, start, end, extra = {}) => {
    if (end - start < 0.25) return;
    slots.push({ i: slots.length, kind, start: +start.toFixed(2), end: +end.toFixed(2), dur: +(end - start).toFixed(2), ...extra });
  };

  let cursor = 0;
  for (let k = 0; k < placed.length; k++) {
    const e = placed[k];
    const nextStart = k + 1 < placed.length ? placed[k + 1].beat_start : total;
    let start = Math.max(e.beat_start, cursor);
    let end = Math.min(Math.max(e.beat_end || e.beat_start + 3, start + 1), nextStart, total);
    if (end <= start) end = Math.min(start + 2, nextStart, total);

    // leading gap (narration text card)
    if (start - cursor > GAP_MIN) push('text', cursor, start, { label: 'gap', text: narrationTextFor(cues, cursor, start), reason: 'no research moment for this narration' });

    const common = {
      moment_id: e.moment_id, pack_id: e.pack_id, source_id: e.source_id || null,
      url: e.url || null, local_file: e.local_file || null, locator_type: e.locator_type || null,
      decision: e.decision || null, score: e.score, recall: e.recall, reason: e.reason || '',
      align_flag: e.align_flag, must_show: e.must_show || [], cue: e.script_cue_exact,
      qa: e.qa || null,
    };

    if (e.status === 'RESOLVED' && e.clip) {
      push('video', start, end, { ...common, video: e.clip, clip_dur: e.cut.dur });
    } else if (e.status === 'FALLBACK_GRAPHIC') {
      push(e.kind === 'text' ? 'text' : 'graphic', start, end, { ...common, text: e.fallback_text || e.script_cue_exact, label: 'fallback' });
    } else { // NEEDS_SOURCE
      push('needs_source', start, end, { ...common, text: e.script_cue_exact, label: 'NEEDS SOURCE' });
    }
    cursor = end;
  }
  // trailing gap
  if (total - cursor > GAP_MIN) push('text', cursor, total, { label: 'gap', text: narrationTextFor(cues, cursor, total), reason: 'no research moment (tail)' });

  const tlFile = U.p(id, 'timeline.json');
  fs.writeFileSync(tlFile, JSON.stringify({ total: +total.toFixed(2), slots }, null, 2));

  const by = k => slots.filter(s => s.kind === k).length;
  U.ok(`timeline: ${slots.length} slots — video ${by('video')}, graphic ${by('graphic')}, text ${by('text')}, needs_source ${by('needs_source')}`);
  st.meta.timeline = { slots: slots.length, video: by('video'), text: by('text'), needsSource: by('needs_source'), total: +total.toFixed(1) };
  return { total, slots };
};
