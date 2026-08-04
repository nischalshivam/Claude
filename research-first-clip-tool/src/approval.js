// ============================================================
//  APPROVAL (M4.2.1) — critical beat par insaan ki "haan" ko MEDIA se baandhna.
//
//  Kyun ye bana:
//  M4.2 tak manzoori do mein se kisi bhi tarah mil jati thi —
//    - manual-overrides.json mein approved:true, ya
//    - folder mein APPROVE_MEDIA.txt naam ki khaali file
//  Dono mein ek hi kami thi: manzoori kisi cheez se BANDHI hui nahi thi.
//  User file A dekh kar approve karta, phir usi naam se file B rakh deta, aur
//  purani "haan" chalti rehti thi. Wahi audio/pack badalne par bhi hota tha.
//  HOOK/HARD_EVIDENCE beat par yahi sabse mehnga jhooth hai.
//
//  Ab har manzoori ek RECORD hai jisme teen fingerprint hain:
//    media_fingerprint    kaunsi files, kis order mein, kis trim ke saath, reuse on/off
//    request_fingerprint  kaunsi jagah (range), kaunse moments, kya dikhna chahiye, criticality
//    input_fingerprint    pack / SRT / audio
//  Teeno abhi bhi match karein tabhi manzoori zinda hai. Ek bhi badla to
//  status EXPIRED — aur tool SAAF-SAAF kehta hai ki kyun.
//
//  Explorer wale user ke liye APPROVE_MEDIA.txt waisa hi aasan hai. Farak sirf
//  itna hai ki wo ab ek PERMANENT sentinel nahi, ek CONFIRMATION hai: pehli
//  baar dikhte hi uska record ban jata hai. Baad mein media badla to wahi file
//  padi rehne se manzoori wapas nahi aati — use APPROVAL_EXPIRED.txt bana diya
//  jata hai (andar wajah likhi hoti hai) aur nayi haan maangi jati hai.
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./util.js');

const FILE = 'manual-approvals.json';
const SENTINEL = 'APPROVE_MEDIA.txt';
const EXPIRED = 'APPROVAL_EXPIRED.txt';

const STATUS = {
  NOT_REQUIRED: 'NOT_REQUIRED',
  APPROVED: 'APPROVED',
  PENDING: 'PENDING',
  EXPIRED: 'EXPIRED',
};

// ---------- fingerprints ----------

/**
 * Media ka fingerprint — SIRF wo cheezein jo screen par dikhne wale visual ko
 * badalti hain: kaunsi file, kis order mein, kitna trim, reuse on/off.
 * Filename badalne se bhi ye badlega (kyunki order filename se tay hota hai).
 */
function mediaFingerprint(scanReq) {
  const files = (scanReq && scanReq.files) || [];
  const bits = files.map((f, i) => [
    i, f.file, f.sha256 || 'na',
    f.trim_start_sec == null ? '' : Number(f.trim_start_sec).toFixed(3),
    f.trim_end_sec == null ? '' : Number(f.trim_end_sec).toFixed(3),
  ].join(':'));
  bits.push(`reuse=${scanReq && scanReq.allow_reuse ? 1 : 0}`);
  return U.hashStr(bits.join('|'));
}

/**
 * Request ka fingerprint — wo jagah jiske liye haan di gayi thi.
 * Display number (MISSING 007) aur folder ka naam JAAN-BOOJH kar isme NAHI hain:
 * sirf number badalne se manzoori nahi marni chahiye.
 */
function requestFingerprint(req) {
  const r = (req && req.range) || {};
  const bits = [
    Number(r.start_sec || 0).toFixed(3),
    Number(r.end_sec || 0).toFixed(3),
    ((req && req.moment_ids) || []).slice().sort().join(','),
    ((req && req.must_show) || []).slice().sort().join('|'),
    ((req && req.must_not_show) || []).slice().sort().join('|'),
    String((req && req.criticality) || 'NORMAL').toUpperCase(),
  ];
  return U.hashStr(bits.join('::'));
}

function inputFingerprint(req) {
  const f = (req && req.input_fingerprint) || {};
  return {
    pack_sha256: f.pack_sha256 || null,
    srt_sha256: f.srt_sha256 || null,
    audio_signature: f.audio_signature || null,
  };
}

function sameInput(a, b) {
  // jo value pehle likhi hi nahi gayi thi uspar faisla nahi karte (purane packs)
  for (const k of ['pack_sha256', 'srt_sha256', 'audio_signature']) {
    if (a[k] && b[k] && a[k] !== b[k]) return false;
  }
  return true;
}

// ---------- record store ----------
function storePath(dataRoot) { return path.join(dataRoot, FILE); }

function read(dataRoot) {
  try {
    const d = JSON.parse(fs.readFileSync(storePath(dataRoot), 'utf8'));
    if (!Array.isArray(d.approvals)) d.approvals = [];
    return d;
  } catch { return { schema: 'manual-approvals-v1', approvals: [] }; }
}

function write(dataRoot, data) {
  fs.mkdirSync(dataRoot, { recursive: true });
  const p = storePath(dataRoot);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

function recordFor(store, key) {
  return (store.approvals || []).find(a => a.request_key === key) || null;
}

function putRecord(store, rec) {
  const i = (store.approvals || []).findIndex(a => a.request_key === rec.request_key);
  if (i >= 0) store.approvals[i] = rec; else store.approvals.push(rec);
  return rec;
}

// ---------- judgement ----------

/**
 * Ek record abhi bhi valid hai ya nahi — sirf padhna, kuch likhna nahi.
 * @returns {{status, reason}}
 */
function judge(rec, want) {
  if (!rec || rec.approved !== true) return { status: STATUS.PENDING, reason: 'abhi kisi ne approve nahi kiya' };
  if (rec.media_fingerprint !== want.media_fingerprint) {
    return { status: STATUS.EXPIRED, reason: 'manzoori ke baad media badal gaya (file, order, trim ya reuse) — dobara dekh kar haan chahiye' };
  }
  if (rec.request_fingerprint !== want.request_fingerprint) {
    return { status: STATUS.EXPIRED, reason: 'ye jagah hi badal gayi (range/moments/criticality) — dobara haan chahiye' };
  }
  if (!sameInput(rec.input_fingerprint || {}, want.input_fingerprint || {})) {
    return { status: STATUS.EXPIRED, reason: 'script, voiceover ya research pack badla hai — purani manzoori ab valid nahi' };
  }
  return { status: STATUS.APPROVED, reason: null };
}

function statFile(f) {
  try { const s = fs.statSync(f); return { mtime: Math.round(s.mtimeMs), size: s.size }; } catch { return null; }
}
const sameStat = (a, b) => !!a && !!b && a.mtime === b.mtime && a.size === b.size;

/**
 * Har request ka approval status nikalo — aur zaroorat ho to record materialize
 * karo / expire karo.
 *
 * @param {string} dataRoot
 * @param {Array}  items    [{ key, dir, scanReq, req, override }]
 * @param {object} opts     { write: true }
 * @returns {Map<string,{status,reason,record,approved_at}>}
 */
function resolve(dataRoot, items, opts = {}) {
  const doWrite = opts.write !== false;
  const store = read(dataRoot);
  const out = new Map();
  let dirty = false;

  for (const it of items) {
    const key = it.key;
    if (!key) continue;
    const want = {
      media_fingerprint: mediaFingerprint(it.scanReq),
      request_fingerprint: requestFingerprint(it.req),
      input_fingerprint: inputFingerprint(it.req),
    };
    const hasMedia = ((it.scanReq && it.scanReq.files) || []).length > 0;
    let rec = recordFor(store, key);
    const ov = it.override || {};
    const sentinelFile = it.dir ? path.join(it.dir, SENTINEL) : null;
    const sentinel = sentinelFile ? statFile(sentinelFile) : null;

    // ---- 1. UI ne saaf mana kiya -> record hata do ----
    if (ov.approved === false && rec) {
      rec = putRecord(store, { ...rec, approved: false, revoked_at: new Date().toISOString(), source: 'UI_REVOKED' });
      dirty = true;
    }

    // ---- 2. nayi confirmation? ----
    //  Do raaste, dono barabar:
    //    (a) APPROVE_MEDIA.txt jo pehle dekhi hi nahi gayi (ya user ne dobara chhui hai)
    //    (b) UI/overrides ka approved:true jiska abhi koi record nahi (purane
    //        version se aa raha ho sakta hai — ek baar bind kar dete hain)
    const sentinelIsNew = sentinel && (!rec || !sameStat(rec.sentinel, sentinel));
    const legacyOverride = ov.approved === true && !rec;
    if (hasMedia && (sentinelIsNew || legacyOverride)) {
      rec = putRecord(store, {
        request_key: key,
        approved: true,
        approved_at: new Date().toISOString(),
        source: sentinelIsNew ? 'APPROVE_MEDIA.txt' : 'OVERRIDE',
        media_fingerprint: want.media_fingerprint,
        request_fingerprint: want.request_fingerprint,
        input_fingerprint: want.input_fingerprint,
        sentinel: sentinel || null,
        // sirf insaan ke padhne ke liye — kabhi identity nahi
        display_request_id: (it.req && it.req.request_id) || null,
        display_label: (it.req && it.req.label) || null,
      });
      dirty = true;
    }

    // ---- 3. faisla ----
    const j = judge(rec, want);

    // ---- 4. EXPIRED: sentinel ko chup-chaap dobara chalne mat do ----
    //  Purani APPROVE_MEDIA.txt padi rehne se manzoori wapas nahi aani chahiye.
    //  Use APPROVAL_EXPIRED.txt bana dete hain — andar wajah likhi hai, aur
    //  nayi haan ke liye user ko phir se APPROVE_MEDIA.txt banani padegi.
    if (j.status === STATUS.EXPIRED && doWrite && sentinelFile && fs.existsSync(sentinelFile)) {
      try {
        const dest = path.join(it.dir, EXPIRED);
        fs.writeFileSync(dest,
          'PURANI MANZOORI AB VALID NAHI HAI\n' +
          '=================================\n\n' +
          `Wajah: ${j.reason}\n\n` +
          'Ye zaroori beat hai (HOOK / HARD_EVIDENCE). Yahan galat visual chhap jana\n' +
          'sabse mehnga hai, isliye tool purani haan ko naye media par nahi chipkata.\n\n' +
          'Ab kya karo:\n' +
          '  1. media\\ folder ki files ek baar dekh lo\n' +
          '  2. theek lagen to is folder mein NAYI khaali file banao: APPROVE_MEDIA.txt\n' +
          '  3. ya dashboard (START_UI.bat) mein is card par tick laga do\n');
        fs.rmSync(sentinelFile, { force: true });
      } catch {}
    }

    out.set(key, { status: j.status, reason: j.reason, record: rec || null });
  }

  if (dirty && doWrite) { try { write(dataRoot, store); } catch {} }
  return out;
}

/** UI/CLI se seedhi manzoori — record turant fingerprint ke saath likh do. */
function approve(dataRoot, key, { scanReq, req, source = 'UI' }) {
  const store = read(dataRoot);
  const rec = putRecord(store, {
    request_key: key,
    approved: true,
    approved_at: new Date().toISOString(),
    source,
    media_fingerprint: mediaFingerprint(scanReq),
    request_fingerprint: requestFingerprint(req),
    input_fingerprint: inputFingerprint(req),
    sentinel: null,
    display_request_id: (req && req.request_id) || null,
    display_label: (req && req.label) || null,
  });
  write(dataRoot, store);
  return rec;
}

/** Manzoori wapas lo (tick hatao). Record rehta hai — history mit ti nahi. */
function revoke(dataRoot, key) {
  const store = read(dataRoot);
  const old = recordFor(store, key);
  putRecord(store, { ...(old || { request_key: key }), request_key: key, approved: false,
    revoked_at: new Date().toISOString(), source: 'UI_REVOKED', sentinel: null });
  write(dataRoot, store);
}

module.exports = {
  resolve, approve, revoke, judge, read, write, recordFor,
  mediaFingerprint, requestFingerprint, inputFingerprint,
  STATUS, FILE, SENTINEL, EXPIRED,
};
