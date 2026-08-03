// ============================================================
//  EFFECTIVE GATE (M4.1) — final timeline par EK hi faisla.
//
//  Kyun ye file bani:
//  M4 mein criticality ka gate timeline.js ke andar tha, aur wo THROW karta tha.
//  User ka apna media (DATA folder) timeline ke BAAD lagta hai. Matlab critical
//  beat ke liye user file de bhi de, wo kabhi lagti hi nahi thi — timeline pehle
//  hi mar jati thi. Asli 897-second run yahin ruka: 13 HOOK/HARD_EVIDENCE beats,
//  render kabhi chala hi nahi, DATA folder bana hi nahi.
//
//  Ab tarteeb ye hai:
//     candidate timeline  ->  manual media lagao  ->  YE GATE  ->  render
//
//  Aur ye gate ek hi jagah likha hai. Pehle criticality ka hisaab timeline mein
//  tha, gap ka hisaab gapplan mein, aur pack ka hisaab run.js mein — teen alag
//  jagah, teen alag jawab. Ab CLI, UI aur tests sab yahi call karte hain.
//
//  Do haalat, do alag natije:
//    draft      -> har blocker ek numbered placeholder + DATA request ban jata hai
//    production -> ek bhi blocker ho to export rukta hai (final mein placeholder
//                  kabhi nahi)
// ============================================================
'use strict';

// jin assets ka matlab hai "yahan sach mein media hai"
const REAL_MEDIA = new Set([
  'EXACT_VIDEO', 'CONTEXT_VIDEO', 'VERIFIED_SOURCE_STILL', 'MONTAGE',
  'TEMPLATE_GRAPHIC_MEDIA', 'USER_VIDEO', 'USER_IMAGE', 'USER_MONTAGE',
]);
// user ka apna media — ye critical beat ko bhi bhar sakta hai, par sirf tab
// jab user ne saaf-saaf approve kiya ho (manual.js `approved` set karta hai)
const USER_MEDIA = new Set(['USER_VIDEO', 'USER_IMAGE', 'USER_MONTAGE']);
// ye "kuch nahi hai" ke alag-alag naam hain
const EMPTY = new Set([
  'GENERIC_TEXT_GRAPHIC', 'DIAGNOSTIC_CARD', 'RENDER_FAILURE_FALLBACK',
  'LOW_CONFIDENCE_FALLBACK', 'MISSING_PLACEHOLDER',
]);

const isCritical = c => { const x = String(c || 'NORMAL').toUpperCase(); return x === 'HOOK' || x === 'HARD_EVIDENCE'; };

/**
 * Ek slot par faisla.
 * @returns { ok, code } — code sirf tab jab ok=false
 */
function judgeSlot(slot, e) {
  const asset = slot.asset || (slot.kind === 'video' ? 'EXACT_VIDEO' : null);
  // timeline ke slots par abhi `asset` planned hota hai; render ke baad actual.
  // Dono par ye function chalta hai, isliye kind se bhi samajh lete hain.
  const planned = asset || ({
    video: 'EXACT_VIDEO', context_video: 'CONTEXT_VIDEO', still: 'VERIFIED_SOURCE_STILL',
    montage: 'MONTAGE', graphic: 'TEMPLATE_GRAPHIC_MEDIA',
  }[slot.kind]) || 'GENERIC_TEXT_GRAPHIC';

  if (EMPTY.has(planned)) return { ok: false, code: planned === 'GENERIC_TEXT_GRAPHIC' ? 'GENERIC_CARD' : 'NO_MEDIA_ASSET' };
  if (!REAL_MEDIA.has(planned)) return { ok: false, code: 'NO_MEDIA_ASSET' };

  // graphic slot media-backed tabhi hai jab uske peeche sach mein koi image ho
  if (planned === 'TEMPLATE_GRAPHIC_MEDIA' && !slot.image && !(slot.images || []).length) {
    return { ok: false, code: 'NO_MEDIA_ASSET' };
  }
  // galat episode/show ka footage — render ho jaata hai par lagna nahi chahiye
  const rel = slot.scope_relation;
  if (rel && !['SAME_EPISODE', 'GRAPHIC', 'NONE', 'USER_APPROVED', 'UNKNOWN'].includes(rel)) {
    return { ok: false, code: 'WRONG_SCOPE' };
  }
  return { ok: true };
}

/**
 * Poore timeline par faisla.
 *
 * @param {object}   tl        { total, slots }
 * @param {Array}    resolved  locate/QA ka nateeja (criticality + status ke liye)
 * @param {object}   opts      { mode: 'production'|'draft'|'review', approvedRequests:Set }
 * @returns {{ ok, blockers, critical, mode, counts }}
 */
function evaluate(tl, resolved, opts = {}) {
  const mode = opts.mode || 'production';
  const approved = opts.approvedRequests instanceof Set ? opts.approvedRequests : new Set();
  const byMoment = {};
  for (const e of (resolved || [])) byMoment[e.moment_id] = e;

  const blockers = [];
  const critical = [];
  const counts = { slots: 0, media: 0, empty: 0, user: 0 };

  for (const s of (tl.slots || [])) {
    counts.slots++;
    const e = byMoment[s.moment_id] || {};
    const crit = s.criticality || e.criticality || 'NORMAL';
    const j = judgeSlot(s, e);
    const asset = s.asset || '';
    if (USER_MEDIA.has(asset)) counts.user++;

    if (!j.ok) {
      counts.empty++;
      blockers.push({ i: s.i, start: s.start, end: s.end, moment_id: s.moment_id || null,
        pack_id: s.pack_id || null, criticality: crit, code: j.code, cue: s.cue || null });
      if (isCritical(crit)) critical.push(s.moment_id || `slot_${s.i}`);
      continue;
    }
    counts.media++;

    // ---- CRITICAL BEATS ----
    //  HARD_EVIDENCE: asli exact clip chahiye. HOOK: exact clip ya us scene ka
    //  materialized frame. Aur DONO ke liye ek doosra raasta bhi hai — user ka
    //  apna media, par SIRF tab jab usne us request ko saaf-saaf approve kiya ho.
    //  (Sirf file copy kar dena kaafi nahi — critical beat par ye faisla insaan
    //   ka hona chahiye, warna galat visual chup-chaap chhap jayega.)
    if (isCritical(crit)) {
      const c = String(crit).toUpperCase();
      const exact = asset === 'EXACT_VIDEO' || s.kind === 'video';
      const hinted = s.hint_time != null || (Array.isArray(s.hint_times) && s.hint_times.length > 0);
      const userOk = USER_MEDIA.has(asset) && s.manual_request_id && approved.has(s.manual_request_id);
      const ok = userOk || (c === 'HARD_EVIDENCE' ? exact : (exact || hinted));
      if (!ok) {
        critical.push(s.moment_id || `slot_${s.i}`);
        blockers.push({ i: s.i, start: s.start, end: s.end, moment_id: s.moment_id || null,
          pack_id: s.pack_id || null, criticality: c, code: 'CRITICAL_NO_EXACT',
          got: asset || s.kind, cue: s.cue || null });
      }
    }
  }

  const uniqCritical = [...new Set(critical)];
  return {
    ok: blockers.length === 0,
    mode,
    blockers,
    critical: uniqCritical,
    counts,
    // draft mein ye "ruko" nahi, "yahan placeholder lagao" ka matlab rakhta hai
    blocks_render: mode === 'production' && blockers.length > 0,
  };
}

/** Jin slots par media nahi hai unke index — render inhi par placeholder lagayega. */
function blockedSlotIndexes(result) {
  return new Set(result.blockers.map(b => b.i));
}

module.exports = { evaluate, judgeSlot, blockedSlotIndexes, REAL_MEDIA, USER_MEDIA, EMPTY, isCritical };
