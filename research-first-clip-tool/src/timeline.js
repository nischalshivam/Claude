// ============================================================
//  Stage 7 — SHOT PLANNER + ZERO-CARD TIMELINE (M2)
//
//  M1.3 ka problem: 1 moment = 1 slot. 20-second beat par 6-second clip ka
//  aakhri frame 14 second freeze hota tha, aur jahan clip nahi thi wahan
//  full-screen "NEEDS SOURCE" diagnostic card chal jata tha (video ka ~61%).
//
//  Ab:
//   1. Poori narration [0..total] EXACTLY tile hoti hai (koi drift nahi).
//   2. Har moment ka window 4-6 second ke SHOTS mein tootta hai (SRT cue
//      boundaries par), taaki lamba static frame kabhi na aaye.
//   3. Micro-gaps (<=1.5s) adjacent visual mein absorb — koi flash card nahi.
//   4. Har shot ko FALLBACK LADDER se visual milta hai:
//        clip -> (uske baad) same-source keyframe still -> montage
//        -> designed graphic. Production mein diagnostic card kabhi nahi.
//   5. Scope safety: keyframe sirf usi moment ke approved source se.
// ============================================================
const fs = require('fs');
const U = require('./util.js');
const SUB = require('./subtitles.js');
const KF = require('./keyframes.js');

module.exports = function timeline(spec, cfg, st, resolved, total) {
  const id = spec.id;
  const S = cfg.shots || {};
  const TARGET = S.targetSeconds || 5;
  const MINS = S.minSeconds || 3;
  const MAXS = S.maxSeconds || 7.5;
  const ABSORB = S.gapAbsorbSeconds || 1.5;
  const production = (cfg.output && cfg.output.mode) !== 'review';

  const cues = SUB.parseFile(spec.srt);
  if (!total) total = cues.length ? cues[cues.length - 1].end : 0;
  total = +total.toFixed(3);

  // keyframe bank (already-downloaded approved sources se) — card-killer
  let bank = {};
  if ((cfg.fallback || {}).useKeyframes !== false) {
    try { bank = KF.buildBank(spec, cfg, id, resolved); } catch (e) { U.warn('keyframe bank fail: ' + e.message.slice(0, 80)); }
    const nSrc = Object.keys(bank).length;
    const nFr = Object.values(bank).reduce((a, b) => a + b.frames.length, 0);
    U.log(`   keyframe bank: ${nFr} frames from ${nSrc} approved source(s) — ye stills cards ki jagah lagengi`);
  }

  // ---- anchors: har moment ka narration window ----
  const anchors = resolved.filter(e => e.beat_start != null)
    .map(e => ({ e, start: Math.max(0, +e.beat_start), end: Math.min(total, Math.max(+e.beat_start + 0.5, +(e.beat_end ?? e.beat_start + 3))) }))
    .sort((a, b) => a.start - b.start);
  for (let i = 0; i < anchors.length - 1; i++) if (anchors[i].end > anchors[i + 1].start) anchors[i].end = anchors[i + 1].start;

  // micro-gaps absorb: chhota gap adjacent anchor mein mila do (koi flash card nahi)
  let absorbed = 0;
  for (let i = 0; i < anchors.length - 1; i++) {
    const g = anchors[i + 1].start - anchors[i].end;
    if (g > 0 && g <= ABSORB) { anchors[i].end = anchors[i + 1].start; absorbed++; }
  }
  if (anchors.length) {
    if (anchors[0].start > 0 && anchors[0].start <= ABSORB) { anchors[0].start = 0; absorbed++; }
    const last = anchors[anchors.length - 1];
    if (total - last.end > 0 && total - last.end <= ABSORB) { last.end = total; absorbed++; }
  }

  // ---- shot boundaries: window ko SRT cue boundaries par 4-6s tukdon mein todo ----
  function shotSpans(a, b) {
    const span = b - a;
    if (span <= MAXS) return [[a, b]];
    const nShots = Math.max(2, Math.round(span / TARGET));
    const ideal = span / nShots;
    const bounds = [a];
    for (let k = 1; k < nShots; k++) {
      const want = a + ideal * k;
      // nazdeeki cue boundary par snap (natural pause par cut)
      let best = want, bestD = 1e9;
      for (const c of cues) {
        for (const t of [c.start, c.end]) {
          if (t <= bounds[bounds.length - 1] + MINS * 0.6 || t >= b - MINS * 0.6) continue;
          const d = Math.abs(t - want);
          if (d < bestD) { bestD = d; best = t; }
        }
      }
      bounds.push(+best.toFixed(3));
    }
    bounds.push(b);
    const out = [];
    for (let k = 0; k < bounds.length - 1; k++) if (bounds[k + 1] - bounds[k] > 0.05) out.push([bounds[k], bounds[k + 1]]);
    return out;
  }

  const slots = [];
  const usedFrames = new Set();
  let lastVisualKey = null;
  const push = (o) => { if (o.end - o.start <= 0.001) return; slots.push({ i: slots.length, ...o, start: +o.start.toFixed(3), end: +o.end.toFixed(3), dur: +(o.end - o.start).toFixed(3) }); };

  function commonOf(e) {
    return {
      moment_id: e.moment_id, pack_id: e.pack_id, source_id: e.source_id || null,
      url: e.url || null, locator_type: e.locator_type || null, decision: e.decision || null,
      score: e.score, reason: e.reason || '', review_reason: e.review_reason || null,
      align_flag: e.align_flag, must_show: e.must_show || [], cue: e.script_cue_exact, qa: e.qa || null,
    };
  }
  // moment ke liye allowed sources (scope-safe): uske apne candidates ke source IDs
  const allowedOf = e => {
    const ids = new Set();
    for (const c of (e.candidates && e.candidates.length ? e.candidates : [e])) if (c.source_id) ids.add(c.source_id);
    return [...ids];
  };

  let statAssets = { video: 0, still: 0, montage: 0, graphic: 0, card: 0 };

  for (const a of anchors) {
    const e = a.e;
    const common = commonOf(e);
    // SIRF verified (RESOLVED) clip hi exact video ki tarah lagti hai.
    // NEEDS_REVIEW (ambiguous dialogue / doubtful match) ki clip production mein
    // NAHI chalti — par uski jagah card bhi nahi aata: usi approved source ka
    // keyframe still lagta hai (scope-correct, aur galat scene claim nahi karta).
    // Review mode mein wo clip report/review video mein dikhti hai.
    const hasClip = e.status === 'RESOLVED' && e.clip && fs.existsSync(U.p(id, e.clip));
    const allowed = allowedOf(e);
    const nearSec = e.cut ? e.cut.start : null;

    // ---- KEY IDEA: video shot kabhi clip se LAMBA nahi hota (isliye koi frozen
    //      frame nahi). Clip apni poori length chalti hai; bacha hua waqt stills/
    //      graphics se bharta hai. Baaki shots 4-6s ke.
    const clipDur = hasClip ? Math.max(0.5, (e.cut && e.cut.dur) || 0) : 0;
    const segs = [];
    let cur = a.start;
    if (hasClip) {
      const len = Math.min(clipDur, a.end - cur);
      if (len > 0.35) { segs.push({ type: 'video', a: cur, b: cur + len }); cur += len; }
    }
    for (const [s0, s1] of shotSpans(cur, a.end)) segs.push({ type: 'fill', a: s0, b: s1 });

    for (let si = 0; si < segs.length; si++) {
      const { type, a: s0, b: s1 } = segs[si];

      // 1) EXACT CLIP (poori length, freeze ki zaroorat nahi)
      if (type === 'video') {
        push({ kind: 'video', start: s0, end: s1, ...common, video: e.clip, clip_dur: clipDur, asset: 'EXACT_VIDEO' });
        statAssets.video++; lastVisualKey = 'clip:' + e.clip;
        continue;
      }

      // 2) SAME-SOURCE KEYFRAME STILL (scope-correct image — card ki jagah)
      const picks = KF.pickFrames(bank, allowed, usedFrames, 1, nearSec);
      if (picks.length) {
        picks.forEach(p => usedFrames.add(p.file));
        push({ kind: 'still', start: s0, end: s1, ...common, image: picks[0].file, image_source: picks[0].source_id,
               image_time: picks[0].t, asset: 'VERIFIED_SOURCE_STILL' });
        statAssets.still++; lastVisualKey = 'kf:' + picks[0].file;
        continue;
      }

      // 3) apni hi clip se still (jab poori source available nahi)
      if (hasClip) {
        const stl = KF.stillFromClip(id, cfg, e.clip, si % 2 ? 0.75 : 0.3);
        if (stl && !usedFrames.has(stl)) {
          usedFrames.add(stl);
          push({ kind: 'still', start: s0, end: s1, ...common, image: stl, image_source: e.source_id, asset: 'VERIFIED_SOURCE_STILL' });
          statAssets.still++; continue;
        }
      }

      // 4) designed editorial graphic (production-safe) — text research/script se
      const gtext = (e.fallback_text || e.script_cue_exact || '').trim();
      if (production) {
        push({ kind: 'graphic', start: s0, end: s1, ...common, text: gtext, label: '', asset: 'EDITORIAL_GRAPHIC' });
        statAssets.graphic++;
      } else {
        // review/debug mode: diagnostic card (status dikhta hai)
        const kind = e.status === 'NEEDS_SOURCE' ? 'needs_source' : (e.status === 'NEEDS_REVIEW' ? 'needs_review' : 'text');
        push({ kind, start: s0, end: s1, ...common, text: gtext, label: kind === 'needs_source' ? 'NEEDS SOURCE' : (kind === 'needs_review' ? 'NEEDS REVIEW' : ''), asset: 'LOW_CONFIDENCE_FALLBACK' });
        statAssets.card++;
      }
    }
  }

  // uncovered gaps (bade) — inhe bhi visual milta hai, card nahi
  const filled = [];
  let cursor = 0;
  for (const s of slots) {
    if (s.start - cursor > 0.001) filled.push({ a: cursor, b: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (total - cursor > 0.001) filled.push({ a: cursor, b: total });
  for (const g of filled) {
    const picks = KF.pickFrames(bank, Object.keys(bank), usedFrames, 1, null);
    const text = cues.filter(c => c.end > g.a && c.start < g.b).map(c => c.text).join(' ').trim();
    if (picks.length) {
      usedFrames.add(picks[0].file);
      slots.push({ i: slots.length, kind: 'still', start: +g.a.toFixed(3), end: +g.b.toFixed(3), dur: +(g.b - g.a).toFixed(3),
        image: picks[0].file, image_source: picks[0].source_id, cue: text, asset: 'VERIFIED_SOURCE_STILL', label: 'bridge' });
      statAssets.still++;
    } else {
      slots.push({ i: slots.length, kind: 'graphic', start: +g.a.toFixed(3), end: +g.b.toFixed(3), dur: +(g.b - g.a).toFixed(3),
        text, cue: text, asset: 'EDITORIAL_GRAPHIC', label: 'bridge' });
      statAssets.graphic++;
    }
  }
  slots.sort((a, b) => a.start - b.start);
  slots.forEach((s, i) => { s.i = i; });

  // drift guard
  let sum = 0; for (const s of slots) sum += s.dur;
  const drift = +(total - sum).toFixed(3);
  if (Math.abs(drift) > 0.05 && slots.length) { const L = slots[slots.length - 1]; L.end = +(L.end + drift).toFixed(3); L.dur = +(L.end - L.start).toFixed(3); }

  fs.writeFileSync(U.p(id, 'timeline.json'), JSON.stringify({ total, slots }, null, 2));

  const secOf = k => slots.filter(s => s.kind === k).reduce((a, s) => a + s.dur, 0);
  const pct = x => total ? Math.round(x / total * 100) : 0;
  sum = 0; for (const s of slots) sum += s.dur;
  U.ok(`timeline: ${slots.length} shots (sum ${sum.toFixed(2)}s vs total ${total.toFixed(2)}s)`);
  U.log(`   video ${pct(secOf('video'))}% | stills ${pct(secOf('still'))}% | graphics ${pct(secOf('graphic'))}% | diagnostic cards ${pct(secOf('needs_source') + secOf('needs_review') + secOf('text'))}%`);
  U.log(`   micro-gaps absorbed: ${absorbed} (M1.3 mein ye flash cards bante the)`);
  st.meta.timeline = { shots: slots.length, total, videoPct: pct(secOf('video')), stillPct: pct(secOf('still')),
    graphicPct: pct(secOf('graphic')), cardPct: pct(secOf('needs_source') + secOf('needs_review') + secOf('text')), absorbed, assets: statAssets };
  return { total, slots };
};
