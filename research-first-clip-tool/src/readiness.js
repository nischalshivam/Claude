// ============================================================
//  READINESS (M4.2) — project ki haalat par EK hi sach.
//
//  Kyun ye bana:
//  Asli run mein dashboard ne kaha "HYBRID READY — 23/23", aur usi ke turant
//  baad engine ne kaha "25 slots par koi asli media nahi hai (16 CRITICAL)".
//  Do alag jagah do alag hisaab lag rahe the:
//    - manual.scan()  ne "file maujood hai" ko manzoori maan liya
//    - effectivegate  critical beats par SAAF-SAAF manzoori maangta hai
//  Ab dono ek hi function poochte hain. UI wahi bolegi jo gate karega.
//
//  Ek usool: CRITICAL beat (HOOK / HARD_EVIDENCE) par file rakh dena kaafi
//  nahi hai. Wahan galat visual chhap jana sabse mehnga hai, isliye insaan ka
//  ek saaf "haan" chahiye — APPROVE_MEDIA.txt ya dashboard ka tick.
// ============================================================
'use strict';
// Yahan ab koi fs/path nahi — request.json aur approval dono manual.js se aate
// hain. Pehle readiness apni alag reading karta tha, isliye do jagah do jawab
// ban jate the (wahi "HYBRID READY 23/23" banaam "16 CRITICAL" wala jhagda).
const approval = require('./approval.js');

// ek hi jagah likhe hue states — UI, CLI, gate aur job-result sab yahi bolte hain
const STATE = {
  NO_DRAFT: 'NO_DRAFT',
  NEEDS_MEDIA: 'NEEDS_MEDIA',                       // kuch jagah bilkul khaali
  NEEDS_MORE_MEDIA: 'NEEDS_MORE_MEDIA',             // file hai par range bhar nahi rahi
  NEEDS_CRITICAL_APPROVAL: 'NEEDS_CRITICAL_APPROVAL', // media hai, insaan ka haan baaki
  READY_FOR_CONTENT_REVIEW: 'READY_FOR_CONTENT_REVIEW', // sab bhara — final ban sakta hai
  AUTO_READY: 'AUTO_READY',                         // draft ban chuka aur koi gap nahi
};

const HUMAN = {
  NO_DRAFT: 'Abhi draft banaya hi nahi gaya — pehle draft chalao, tab pata chalega kahan media chahiye.',
  NEEDS_MEDIA: 'Kuch jagah abhi bilkul khaali hain — unme apni image/video daalni hai.',
  NEEDS_MORE_MEDIA: 'Kuch jagah par media hai par poora range nahi bhar raha — ek-do file aur chahiye.',
  NEEDS_CRITICAL_APPROVAL: 'Media aa chuka hai. Ab zaroori beats par aapka saaf "haan" chahiye.',
  READY_FOR_CONTENT_REVIEW: 'Sab jagah bhar chuki aur zaroori beats approve hain — final ban sakta hai.',
  AUTO_READY: 'Draft ban chuka hai aur koi khaali jagah nahi bachi — final automatic ban sakta hai.',
};

// ============================================================
//  PROJECT STATE (M4.2.1 / M5 ke liye) — poore project ka safar.
//
//  Upar wale STATE sirf "media wali" haalat batate hain. M5 ka editor pehli
//  screen se aakhri export tak yahi enum padhega, isliye ye ek hi jagah likha
//  hai. Ek usool: draft banne SE PEHLE "koi gap nahi hai" ko kabhi "video poori
//  ban chuki" nahi kehna — wahi jhooth M4.2 mein AUTO_READY bolta tha.
// ============================================================
const PROJECT_STATE = {
  NO_INPUTS: 'NO_INPUTS',                     // pack/SRT hai hi nahi
  INPUTS_INVALID: 'INPUTS_INVALID',           // hai par schema/validation fail
  READY_TO_RESEARCH: 'READY_TO_RESEARCH',     // pack check maang raha hai
  READY_TO_DRAFT: 'READY_TO_DRAFT',           // sab taiyaar, draft chala sakte ho
  DRAFT_RUNNING: 'DRAFT_RUNNING',
  NO_DRAFT: 'NO_DRAFT',                       // chala hi nahi / adhoora raha
  NEEDS_MEDIA: 'NEEDS_MEDIA',
  NEEDS_MORE_MEDIA: 'NEEDS_MORE_MEDIA',
  NEEDS_CRITICAL_APPROVAL: 'NEEDS_CRITICAL_APPROVAL',
  READY_FOR_CONTENT_REVIEW: 'READY_FOR_CONTENT_REVIEW',
  CONTENT_LOCKED: 'CONTENT_LOCKED',           // M5: content freeze, ab style
  STYLE_READY: 'STYLE_READY',                 // M5: template chun liya
  EXPORT_RUNNING: 'EXPORT_RUNNING',
  EXPORT_FAILED: 'EXPORT_FAILED',
  FINAL_READY: 'FINAL_READY',
};

/**
 * Poore project ki haalat — jo cheezein CLI/UI ko pata hain unse.
 * Sab kuch OPTIONAL hai; jo nahi bataya wo "pata nahi" mana jata hai.
 *
 * @param {object} f {
 *   hasPack, hasSrt, inputsValid, packChecked,
 *   draftExists, jobRunning, exportRunning, exportFailed, finalExists,
 *   contentLocked, styleChosen, media  // media = evaluate() ka nateeja
 * }
 */
function projectState(f = {}) {
  if (f.exportRunning) return PROJECT_STATE.EXPORT_RUNNING;
  if (f.jobRunning) return PROJECT_STATE.DRAFT_RUNNING;
  if (f.finalExists) return PROJECT_STATE.FINAL_READY;
  if (f.exportFailed) return PROJECT_STATE.EXPORT_FAILED;
  if (f.hasPack === false || f.hasSrt === false) return PROJECT_STATE.NO_INPUTS;
  if (f.inputsValid === false) return PROJECT_STATE.INPUTS_INVALID;
  if (f.packChecked === false) return PROJECT_STATE.READY_TO_RESEARCH;
  if (!f.draftExists) {
    // draft se pehle DATA requests ho hi nahi sakti — aur agar purani padi hain
    // to wo is draft ka sach nahi hain
    return f.hasPack === false ? PROJECT_STATE.NO_INPUTS
      : (f.everDrafted ? PROJECT_STATE.NO_DRAFT : PROJECT_STATE.READY_TO_DRAFT);
  }
  const m = f.media || {};
  if (m.state && m.state !== STATE.AUTO_READY && m.state !== STATE.READY_FOR_CONTENT_REVIEW) return m.state;
  if (f.styleChosen) return PROJECT_STATE.STYLE_READY;
  if (f.contentLocked) return PROJECT_STATE.CONTENT_LOCKED;
  return PROJECT_STATE.READY_FOR_CONTENT_REVIEW;
}

const isCritical = c => { const x = String(c || 'NORMAL').toUpperCase(); return x === 'HOOK' || x === 'HARD_EVIDENCE'; };

/**
 * Har request ki poori haalat.
 * @param {string} dataRoot
 * @param {object} manual   src/manual.js (circular require se bachne ke liye inject)
 * @param {object} cfg
 */
function requests(dataRoot, manual, cfg) {
  // EK hi scan, EK hi approval resolve — pehle readiness apni alag request.json
  // padhta tha aur manual.js apni, isliye do jagah do jawab ban jaate the.
  const { scan, statuses } = manual.approvalStatuses(dataRoot, cfg);

  return (scan.requests || []).map(r => {
    const req = r.request || {};
    const key = r.request_key;
    const crit = String(req.criticality || 'NORMAL').toUpperCase();
    const needApproval = isCritical(crit);
    const ap = statuses.get(key) || { status: approval.STATUS.PENDING, reason: null };

    let media_status = 'EMPTY';
    if (r.files.length && r.short_seconds > 0) media_status = 'SHORT';
    else if (r.files.length) media_status = 'VALID';

    // NORMAL beat par manzoori maangi hi nahi jati — par record phir bhi
    // banta rehta hai (M5 mein har shot ka approval history chahiye hoga).
    let approval_status = 'NOT_REQUIRED';
    if (needApproval) approval_status = ap.status === approval.STATUS.APPROVED ? 'APPROVED'
      : (ap.status === approval.STATUS.EXPIRED ? 'EXPIRED' : 'PENDING');

    const reasons = [];
    if (media_status === 'EMPTY') reasons.push('abhi koi file nahi daali');
    if (media_status === 'SHORT') reasons.push(`${r.short_seconds}s aur chahiye (ya "reuse" on karo)`);
    if (approval_status === 'EXPIRED') reasons.push(`manzoori expire ho gayi — ${ap.reason}`);
    else if (approval_status === 'PENDING') reasons.push(`ye ${crit} beat hai — aapka saaf "haan" chahiye`);
    for (const b of r.invalid) reasons.push(`${b.file}: ${b.problem}`);

    // Ye ROKTA nahi — par chhupana bhi nahi chahiye. Kam files par wahi visual
    // dobara dikhega; user chahe to aur media daal sakta hai.
    const notes = [];
    if (r.reused_shots > 0) {
      notes.push(`${r.files.length} file se ${r.shots} shot bane — ${r.reused_shots} jagah wahi file dobara lagi hai. ` +
        `Alag-alag dikhna ho to ~${r.unique_recommended} file do.`);
    }

    const blocking = media_status !== 'VALID' || approval_status === 'PENDING' || approval_status === 'EXPIRED';
    return {
      notes,
      request_key: key, request_id: r.request_id, folder: r.folder, dir: r.dir,
      label: req.label || null, range: r.range, criticality: crit,
      narration_exact: r.narration_exact,
      files: r.files, invalid: r.invalid,
      media_status, approval_required: needApproval, approval_status,
      approval_reason: ap.reason || null,
      approved_at: (ap.record && ap.record.approved_at) || null,
      allow_reuse: r.allow_reuse, short_seconds: r.short_seconds,
      blocking, reasons,
    };
  });
}

/**
 * Poore project ka ek state. UI ka Final button, CLI ka gate aur job-result —
 * teeno yahi padhte hain, isliye teeno ek hi baat bolte hain.
 */
function evaluate(dataRoot, manual, cfg, opts = {}) {
  const rs = requests(dataRoot, manual, cfg);
  if (!rs.length) {
    // ---- NO_DRAFT !== AUTO_READY (M4.2.1) ----
    //  "koi request nahi" ke do bilkul alag matlab hain:
    //    draft ban chuka hai -> sach mein koi khaali jagah nahi (AUTO_READY)
    //    draft bana hi nahi  -> abhi kuch pata hi nahi (NO_DRAFT)
    //  M4.2 dono ko AUTO_READY kehta tha, yaani ek khaali project bhi "video
    //  automatic poori ban sakti hai" bolta tha. Ab callers batate hain.
    const drafted = opts.draftExists !== false;
    const state = drafted ? STATE.AUTO_READY : STATE.NO_DRAFT;
    return { state, human: HUMAN[state], total: 0, ready: 0, blocking: [], requests: [],
      can_export: drafted };
  }

  const blocking = rs.filter(r => r.blocking);
  const ready = rs.length - blocking.length;
  let state = STATE.READY_FOR_CONTENT_REVIEW;
  if (blocking.some(r => r.media_status === 'EMPTY')) state = STATE.NEEDS_MEDIA;
  else if (blocking.some(r => r.media_status === 'SHORT')) state = STATE.NEEDS_MORE_MEDIA;
  else if (blocking.some(r => r.approval_status === 'PENDING' || r.approval_status === 'EXPIRED')) state = STATE.NEEDS_CRITICAL_APPROVAL;

  return {
    state, human: HUMAN[state], total: rs.length, ready,
    blocking: blocking.map(r => ({ request_key: r.request_key, folder: r.folder,
      media_status: r.media_status, approval_status: r.approval_status,
      approval_reason: r.approval_reason, reasons: r.reasons })),
    requests: rs,
    // final tabhi jab har request bhari AUR har zaroori beat approve
    can_export: blocking.length === 0,
  };
}

/** Jin requests ko approve kiya ja chuka hai — effective gate isse poochta hai. */
function approvedKeys(dataRoot, manual, cfg) {
  const out = new Set();
  for (const r of requests(dataRoot, manual, cfg)) {
    if (r.media_status === 'VALID' && r.approval_status !== 'PENDING') {
      out.add(r.request_key);
      if (r.request_id) out.add(r.request_id);   // purane packs ke liye
    }
  }
  return out;
}

module.exports = { evaluate, requests, approvedKeys, projectState, STATE, HUMAN, PROJECT_STATE, isCritical };
