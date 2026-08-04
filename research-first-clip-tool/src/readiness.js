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
const fs = require('fs');
const path = require('path');

// ek hi jagah likhe hue states — UI, CLI, gate aur job-result sab yahi bolte hain
const STATE = {
  NO_DRAFT: 'NO_DRAFT',
  NEEDS_MEDIA: 'NEEDS_MEDIA',                       // kuch jagah bilkul khaali
  NEEDS_MORE_MEDIA: 'NEEDS_MORE_MEDIA',             // file hai par range bhar nahi rahi
  NEEDS_CRITICAL_APPROVAL: 'NEEDS_CRITICAL_APPROVAL', // media hai, insaan ka haan baaki
  READY_FOR_CONTENT_REVIEW: 'READY_FOR_CONTENT_REVIEW', // sab bhara — final ban sakta hai
  AUTO_READY: 'AUTO_READY',                         // koi gap tha hi nahi
};

const HUMAN = {
  NO_DRAFT: 'Abhi draft banaya hi nahi gaya.',
  NEEDS_MEDIA: 'Kuch jagah abhi bilkul khaali hain — unme apni image/video daalni hai.',
  NEEDS_MORE_MEDIA: 'Kuch jagah par media hai par poora range nahi bhar raha — ek-do file aur chahiye.',
  NEEDS_CRITICAL_APPROVAL: 'Media aa chuka hai. Ab zaroori beats par aapka saaf "haan" chahiye.',
  READY_FOR_CONTENT_REVIEW: 'Sab jagah bhar chuki aur zaroori beats approve hain — final ban sakta hai.',
  AUTO_READY: 'Koi khaali jagah hai hi nahi — video automatic hi poori ban sakti hai.',
};

const isCritical = c => { const x = String(c || 'NORMAL').toUpperCase(); return x === 'HOOK' || x === 'HARD_EVIDENCE'; };

/**
 * Har request ki poori haalat.
 * @param {string} dataRoot
 * @param {object} manual   src/manual.js (circular require se bachne ke liye inject)
 * @param {object} cfg
 */
function requests(dataRoot, manual, cfg) {
  const scan = manual.scan(dataRoot, { cfg });
  const ov = manual.readOverrides(dataRoot);
  const byKey = {};
  for (const r of (ov.requests || [])) byKey[r.request_key || r.request_id] = r;

  return (scan.requests || []).map(r => {
    let req = {};
    try { req = JSON.parse(fs.readFileSync(path.join(r.dir, 'request.json'), 'utf8')); } catch {}
    const key = req.request_key || ('REQ_' + String(r.request_id || r.folder).split('__').pop());
    const crit = req.criticality || 'NORMAL';
    const needApproval = isCritical(crit);
    const e = byKey[key] || byKey[r.request_id] || {};
    const fileApproved = fs.existsSync(path.join(r.dir, 'APPROVE_MEDIA.txt'));
    const approved = e.approved === true || fileApproved;

    let media_status = 'EMPTY';
    if (r.files.length && r.short_seconds > 0) media_status = 'SHORT';
    else if (r.files.length) media_status = 'VALID';

    let approval_status = 'NOT_REQUIRED';
    if (needApproval) approval_status = approved ? 'APPROVED' : 'PENDING';

    const reasons = [];
    if (media_status === 'EMPTY') reasons.push('abhi koi file nahi daali');
    if (media_status === 'SHORT') reasons.push(`${r.short_seconds}s aur chahiye (ya "reuse" on karo)`);
    if (approval_status === 'PENDING') reasons.push(`ye ${crit} beat hai — aapka saaf "haan" chahiye`);
    for (const b of r.invalid) reasons.push(`${b.file}: ${b.problem}`);

    const blocking = media_status !== 'VALID' || approval_status === 'PENDING';
    return {
      request_key: key, request_id: r.request_id, folder: r.folder, dir: r.dir,
      label: req.label || null, range: r.range, criticality: crit,
      narration_exact: r.narration_exact,
      files: r.files, invalid: r.invalid,
      media_status, approval_required: needApproval, approval_status,
      allow_reuse: r.allow_reuse, short_seconds: r.short_seconds,
      blocking, reasons,
    };
  });
}

/**
 * Poore project ka ek state. UI ka Final button, CLI ka gate aur job-result —
 * teeno yahi padhte hain, isliye teeno ek hi baat bolte hain.
 */
function evaluate(dataRoot, manual, cfg) {
  const rs = requests(dataRoot, manual, cfg);
  if (!rs.length) return { state: STATE.AUTO_READY, human: HUMAN.AUTO_READY, total: 0, ready: 0, blocking: [], requests: [] };

  const blocking = rs.filter(r => r.blocking);
  const ready = rs.length - blocking.length;
  let state = STATE.READY_FOR_CONTENT_REVIEW;
  if (blocking.some(r => r.media_status === 'EMPTY')) state = STATE.NEEDS_MEDIA;
  else if (blocking.some(r => r.media_status === 'SHORT')) state = STATE.NEEDS_MORE_MEDIA;
  else if (blocking.some(r => r.approval_status === 'PENDING')) state = STATE.NEEDS_CRITICAL_APPROVAL;

  return {
    state, human: HUMAN[state], total: rs.length, ready,
    blocking: blocking.map(r => ({ request_key: r.request_key, folder: r.folder,
      media_status: r.media_status, approval_status: r.approval_status, reasons: r.reasons })),
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

module.exports = { evaluate, requests, approvedKeys, STATE, HUMAN, isCritical };
