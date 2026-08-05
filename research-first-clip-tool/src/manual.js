// ============================================================
//  MANUAL MEDIA (M4) — user ki apni images/videos ko gap mein lagana.
//
//  Yahan do cheezein jaan-boojh kar NAHI ki gayi:
//   1. Koi AI andaza nahi lagata ki 10 files mein se kaunsi file kis line par
//      lagni chahiye. Ye engine deterministic hai; wo semantics samajhta hi
//      nahi. Isliye order INSAAN batata hai — filename ke aage 01_, 02_, 03_
//      (ya UI mein drag). Jo tool nahi jaanta, wo jaanne ka dikhawa nahi karega.
//   2. User ki original file kabhi badli/delete nahi hoti. Kaam karne wali copy
//      job cache mein banti hai.
//
//  Har file ka SHA-256 nikalta hai — usi se pata chalta hai ki media badla hai
//  ya nahi, aur usi se sirf zaroori hisse dobara render hote hain (poora
//  3-ghante ka kaam nahi).
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const U = require('./util.js');
const approval = require('./approval.js');

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const sha256File = f => {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(f));
  return h.digest('hex');
};

// "10_x.jpg" 2_x.jpg ke BAAD aana chahiye — plain string sort ulta karta hai
function naturalCmp(a, b) {
  const ax = String(a).match(/(\d+|\D+)/g) || [], bx = String(b).match(/(\d+|\D+)/g) || [];
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const x = ax[i], y = bx[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { const d = parseInt(x, 10) - parseInt(y, 10); if (d) return d; }
    else { const d = x.toLowerCase().localeCompare(y.toLowerCase()); if (d) return d; }
  }
  return 0;
}

// ============================================================
//  STHIR PEHCHAAN (M4.2.1) — poore tool mein EK hi key.
//
//  `request_id` mein display number hota hai (MISSING_007__ab12cd34). Ek gap
//  bharte hi baaki gaps ka number badal jata hai — yaani request_id BADALTA
//  hai. Isliye wo kabhi identity nahi ban sakti.
//  `request_key` (REQ_ab12cd34) sirf jagah+moments se banti hai aur kabhi nahi
//  badalti. Overrides, approval, ordering, trim, reuse, fingerprint — sab isi
//  se judte hain.
//
//  M4.2 mein scan() to key se dekhta tha, par applyToTimeline() abhi bhi
//  request_id se dhoondhta tha. Nateeja: dashboard "reuse on" dikhata tha aur
//  renderer usi request ko reuse ke bina lagata tha — do alag sach.
// ============================================================
function requestKey(req) {
  if (!req) return null;
  if (req.request_key) return String(req.request_key);
  const id = String(req.request_id || '');
  if (!id) return null;
  const tail = id.split('__').pop();
  return tail ? `REQ_${tail}` : null;
}

/** Overrides mein se is request ka entry — pehle sthir key se, phir purani id se. */
function overrideFor(overrides, req) {
  const list = (overrides && overrides.requests) || [];
  const key = requestKey(req);
  if (key) { const hit = list.find(x => requestKey(x) === key); if (hit) return hit; }
  const id = req && req.request_id;
  if (id) { const hit = list.find(x => x.request_id === id); if (hit) return hit; }
  return {};
}

/** Ek file ko kholo aur sach mein dekho ki wo chalti hai ya nahi. */
function inspectFile(abs) {
  const ext = path.extname(abs).toLowerCase();
  const base = path.basename(abs);
  const out = { file: base, path: abs, ext, ok: false, type: null, problem: null, warnings: [] };
  let st;
  try { st = fs.statSync(abs); } catch { out.problem = 'file padhi nahi ja saki'; return out; }
  if (!st.isFile()) { out.problem = 'ye file nahi hai'; return out; }
  if (st.size === 0) { out.problem = 'file khaali hai (0 byte)'; return out; }
  out.size = st.size;

  if (VIDEO_EXT.has(ext)) out.type = 'VIDEO';
  else if (IMAGE_EXT.has(ext)) out.type = 'IMAGE';
  else { out.problem = `is type ki file support nahi (${ext || 'koi extension nahi'}) — mp4/mov/mkv/webm ya jpg/png/webp do`; return out; }

  // IMAGE ke paas duration hoti hi nahi — usse video ke rules par mat naapo.
  // (strict probe duration maangta hai, isliye har JPEG "kharab" nikal raha tha.)
  const p = U.probe(abs, { strict: out.type === 'VIDEO' });
  if (!p.ok || !p.width || !p.height) {
    out.problem = out.type === 'IMAGE'
      ? 'ye image khul nahi rahi — kharab file hai ya naam badal kar rakhi gayi hai'
      : 'ye video khul nahi rahi — kharab/adhoori file lagti hai';
    return out;
  }
  out.width = p.width || 0; out.height = p.height || 0;

  if (out.type === 'VIDEO') {
    if (!p.duration || p.duration < 0.4) { out.problem = 'video ki lambai pata nahi chali ya bahut chhoti hai'; return out; }
    out.duration = +p.duration.toFixed(3);
    if (out.duration < 2) out.warnings.push('2 second se chhoti video — ek shot bharne ke liye kam pad sakti hai');
  }
  if (out.width && out.height) {
    if (out.width < 640) out.warnings.push(`resolution kam hai (${out.width}x${out.height}) — 1080p video mein dhundhla dikhega`);
    const ar = out.width / out.height;
    if (ar < 0.9) out.warnings.push('portrait media — side mein blur background lagega (chehre stretch nahi honge)');
    else if (ar > 2.6) out.warnings.push('bahut chaudi file — upar-neeche crop ho sakta hai');
  }
  out.sha256 = sha256File(abs);
  out.ok = true;
  return out;
}

/** Ek request folder ke media/ ko padho. Order: overrides > filename. */
function readRequestMedia(reqDir, override) {
  const mediaDir = path.join(reqDir, 'media');
  if (!fs.existsSync(mediaDir)) return { files: [], bad: [] };
  let names = fs.readdirSync(mediaDir).filter(n => !n.startsWith('.'));
  names.sort(naturalCmp);

  const files = [], bad = [];
  for (const n of names) {
    const abs = path.join(mediaDir, n);
    // containment: media folder ke bahar kuch bhi nahi
    if (!U.isInside(mediaDir, abs)) { bad.push({ file: n, problem: 'path folder ke bahar jata hai' }); continue; }
    const info = inspectFile(abs);
    if (info.ok) files.push(info); else bad.push(info);
  }

  // user ne UI se order/trim diya ho to wahi jeetega
  if (override && Array.isArray(override.files) && override.files.length) {
    const byName = {}; for (const f of files) byName[f.file] = f;
    const ordered = [];
    for (const o of override.files.slice().sort((a, b) => (a.order || 0) - (b.order || 0))) {
      const f = byName[path.basename(o.relative_path || o.file || '')];
      if (!f) continue;
      ordered.push({ ...f, trim_start_sec: o.trim_start_sec, trim_end_sec: o.trim_end_sec,
        assigned_moment_ids: o.assigned_moment_ids || [] });
      delete byName[f.file];
    }
    for (const f of files) if (byName[f.file]) ordered.push(f);   // jo UI mein nahi the, peeche
    return { files: ordered, bad };
  }
  return { files, bad };
}

/**
 * Ek request ke liye shots banao.
 *  - shot ~4-6s (config se), ek image 7.5s se zyada kabhi nahi
 *  - lagatar do shots par ek hi file nahi (jab tak doosri file maujood ho)
 *  - media kam pade to reuse SIRF tab jab user ne allow_reuse kaha ho
 */
function buildShotsForRequest(req, media, opts = {}) {
  const cfg = opts.cfg || {};
  const shotsCfg = cfg.shots || {};
  const target = shotsCfg.targetSeconds || 5;
  const a = req.range.start_sec, b = req.range.end_sec;
  const dur = b - a;
  if (!media.length) return { shots: [], short: dur, used: [] };

  // kitne shots — har shot ~target second
  const allowReuse = !!opts.allow_reuse;
  // Human-fill contract: the file count is the edit decision. One supplied
  // asset fills the complete request; N supplied assets divide it into N
  // equal, gap-free shots. Reuse is an optional pacing mode, not a coverage
  // prerequisite.
  const n = allowReuse
    ? Math.max(media.length, Math.max(1, Math.round(dur / target)))
    : media.length;
  const rkey = requestKey(req);
  const shots = [];
  const used = new Set();
  let vi = 0;                    // media pointer
  let lastFile = null;
  const videoCursor = {};        // har video mein kahan tak pahunch chuke hain

  for (let k = 0; k < n; k++) {
    const s0 = +(a + (dur * k) / n).toFixed(3);
    const s1 = +(a + (dur * (k + 1)) / n).toFixed(3);
    const shotDur = +(s1 - s0).toFixed(3);

    let pick = null;
    // ek chakkar lagao: agli aisi file dhoondho jo pichhle shot wali na ho
    for (let t = 0; t < media.length; t++) {
      const cand = media[(vi + t) % media.length];
      if (media.length > 1 && cand.file === lastFile) continue;
      if (!allowReuse && used.has(cand.file)) continue;
      pick = cand; vi = (vi + t + 1) % media.length; break;
    }
    if (!pick) {
      if (!allowReuse) break; // defensive only: n === media.length
      pick = media[vi % media.length]; vi++;
    }
    used.add(pick.file); lastFile = pick.file;

    if (pick.type === 'IMAGE') {
      shots.push({ kind: 'still', start: s0, end: s1, dur: shotDur, image: pick.path,
        asset: 'USER_IMAGE', scope_relation: 'USER_APPROVED', manual: true,
        manual_request_key: rkey, manual_request_id: req.request_id, manual_sha256: pick.sha256, manual_file: pick.file,
        moment_id: (req.moment_ids || [])[0] || null, pack_ids: req.pack_ids,
        cue: req.narration_exact, why: `aapki di hui image (${pick.file})` });
    } else {
      const trimA = Math.max(0, Number(pick.trim_start_sec) || 0);
      const trimB = pick.trim_end_sec != null ? Math.min(pick.duration, Number(pick.trim_end_sec)) : pick.duration;
      const span = Math.max(0.5, trimB - trimA);
      let at = videoCursor[pick.file] == null ? trimA : videoCursor[pick.file];
      if (at + shotDur > trimB) at = trimA;                  // wapas shuruat par
      videoCursor[pick.file] = at + shotDur;
      shots.push({ kind: 'context_video', start: s0, end: s1, dur: shotDur,
        media_file: pick.path, media_start: +at.toFixed(3),
        asset: 'USER_VIDEO', scope_relation: 'USER_APPROVED', manual: true,
        manual_request_key: rkey, manual_request_id: req.request_id, manual_sha256: pick.sha256, manual_file: pick.file,
        moment_id: (req.moment_ids || [])[0] || null, pack_ids: req.pack_ids,
        cue: req.narration_exact, why: `aapki di hui video (${pick.file} @${at.toFixed(1)}s of ${span.toFixed(1)}s)` });
    }
  }
  // Kitni baar ek hi file dobara lagi — ye chhupana nahi chahiye. Adjacent
  // duplicate to pehle se roka hua hai, par "3 file 20 second par" ka matlab
  // hai ki wahi visual do baar dikhega. User ko ye pata hona chahiye.
  const reused = Math.max(0, shots.length - used.size);
  const coveredTo = shots.length ? shots[shots.length - 1].end : a;
  return { shots, short: +Math.max(0, b - coveredTo).toFixed(3), used: [...used], reused };
}

/** Poora DATA folder padho aur har request ka status batao. */
function scan(dataRoot, opts = {}) {
  const out = { schema: 'manual-scan-v1', generated_at: new Date().toISOString(), requests: [] };
  if (!fs.existsSync(dataRoot)) return out;
  const overrides = readOverrides(dataRoot);

  for (const name of fs.readdirSync(dataRoot)) {
    if (!/^MISSING_\d{3}__/.test(name)) continue;
    const dir = path.join(dataRoot, name);
    let req = null;
    try { req = JSON.parse(fs.readFileSync(path.join(dir, 'request.json'), 'utf8')); } catch { continue; }
    const key = requestKey(req);
    const ov = overrideFor(overrides, req);
    const { files, bad } = readRequestMedia(dir, ov);
    const built = buildShotsForRequest(req, files, { cfg: opts.cfg, allow_reuse: !!ov.allow_reuse });
    const enough = files.length > 0 && built.short === 0;
    // "approved" ka default: agar user ne UI se saaf mana nahi kiya, to file
    // daal dena hi manzoori hai. Explorer se kaam karne walon ko checkbox
    // dhoondhne ki zaroorat nahi honi chahiye.
    const approved = ov.approved === false ? false : files.length > 0;
    out.requests.push({
      request_id: req.request_id, request_key: key, folder: name, dir,
      // poori request bhi saath rakho — readiness/approval ise dobara disk se
      // padhte the aur kabhi-kabhi do alag jawab bana lete the
      request: req, criticality: String(req.criticality || 'NORMAL').toUpperCase(),
      range: req.range, moment_ids: req.moment_ids, narration_exact: req.narration_exact,
      // trim/order bhi fingerprint ka hissa hai — inhe chhupana matlab
      // "media wahi hai" ka jhooth (M4.2.1)
      files: files.map(f => ({ file: f.file, type: f.type, sha256: f.sha256, duration: f.duration || null,
        width: f.width || null, height: f.height || null, warnings: f.warnings,
        trim_start_sec: f.trim_start_sec == null ? null : +Number(f.trim_start_sec).toFixed(3),
        trim_end_sec: f.trim_end_sec == null ? null : +Number(f.trim_end_sec).toFixed(3) })),
      invalid: bad.map(b => ({ file: b.file, problem: b.problem })),
      allow_reuse: !!ov.allow_reuse, approved,
      needed_seconds: req.range.duration_sec,
      short_seconds: +built.short.toFixed(2),
      shots: built.shots.length,
      reused_shots: built.reused || 0,
      unique_recommended: Math.max(1, Math.ceil((req.range.duration_sec || 0) / 6)),
      status: !files.length ? 'WAITING_FOR_MEDIA'
        : (!enough ? 'NEEDS_MORE_MEDIA' : (approved ? 'READY' : 'NEEDS_APPROVAL')),
    });
  }
  out.requests.sort((a, b) => a.range.start_sec - b.range.start_sec);
  out.ready = out.requests.every(r => r.status === 'READY');
  out.waiting = out.requests.filter(r => r.status !== 'READY').length;
  return out;
}

function overridesPath(dataRoot) { return path.join(dataRoot, 'manual-overrides.json'); }
function readOverrides(dataRoot) {
  try { return JSON.parse(fs.readFileSync(overridesPath(dataRoot), 'utf8')); }
  catch { return { schema: 'manual-overrides-v1', requests: [] }; }
}
function writeOverrides(dataRoot, data) {
  fs.mkdirSync(dataRoot, { recursive: true });
  const p = overridesPath(dataRoot);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

/**
 * Manual media ka fingerprint — isse pata chalta hai ki timeline/render dobara
 * banana hai ya nahi.
 *
 * M4.2.1: yahan teen galtiyan theek hui hain —
 *   1. key ab request_key hai. Pehle request_id thi, jisme display number tha:
 *      sirf ek gap bharne se baaki sab ka number badal jata tha aur poora render
 *      bina kisi wajah ke dobara ho jata tha.
 *   2. trim/order bhi ismein hai — wo screen par dikhne wala visual badalte hain.
 *   3. approval ab ASLI status hai (approval records se), na ki "file rakhi hai
 *      to haan hai". Manzoori wapas lene par render_sig badalna hi chahiye,
 *      warna purani SUCCESS wali timeline reuse ho jati hai.
 */
function approvalStatuses(dataRoot, cfg, scanResult) {
  const s = scanResult || scan(dataRoot, { cfg });
  const overrides = readOverrides(dataRoot);
  const items = s.requests.map(r => ({
    key: r.request_key, dir: r.dir, scanReq: r, req: r.request || {},
    override: overrideFor(overrides, r.request || { request_key: r.request_key, request_id: r.request_id }),
  }));
  return { scan: s, statuses: approval.resolve(dataRoot, items, { write: true }) };
}

function fingerprint(dataRoot) {
  const { scan: s, statuses } = approvalStatuses(dataRoot, {});
  const bits = s.requests.map(r => {
    const files = r.files.map(f => `${f.file}@${String(f.sha256 || '').slice(0, 12)}` +
      `#${f.trim_start_sec == null ? '' : f.trim_start_sec}-${f.trim_end_sec == null ? '' : f.trim_end_sec}`).join(',');
    const ap = (statuses.get(r.request_key) || {}).status || 'PENDING';
    return `${r.request_key}:${files}:${r.allow_reuse ? 1 : 0}:${ap}`;
  });
  return U.hashStr(bits.sort().join('|') || 'none');
}

/**
 * Automatic timeline mein user ke shots daal do. Jo slots is range mein aate
 * hain wo hat jaate hain — aur user ka media SIRF isi range mein rehta hai.
 */
function applyToTimeline(tl, dataRoot, cfg) {
  const s = scan(dataRoot, { cfg });
  const ready = s.requests.filter(r => r.status === 'READY');
  if (!ready.length) return { tl, applied: 0, requests: [] };

  const off = tl.preview_offset || 0;
  const overrides = readOverrides(dataRoot);
  let slots = tl.slots.slice();
  let applied = 0;
  for (const r of ready) {
    const dir = r.dir;
    const req = r.request;
    if (!req) continue;
    // ---- STHIR KEY (M4.2.1) ----
    //  Yahan pehle `x.request_id === r.request_id` tha. request_id mein display
    //  number hota hai, aur UI override sthir key se likhta hai — isliye ek gap
    //  bharte hi (jab baaki sab renumber ho jate the) reuse/order/trim yahan
    //  MILTE HI NAHI THE. Dashboard "reuse on, 20s bhar gaya" kehta tha aur
    //  renderer usi request ko reuse ke bina lagata tha.
    const ov = overrideFor(overrides, req);
    const { files } = readRequestMedia(dir, ov);
    const built = buildShotsForRequest(req, files, { cfg, allow_reuse: !!ov.allow_reuse });
    if (!built.shots.length) continue;

    // timeline ke local waqt mein laao (preview 0 se shuru hoti hai)
    const a = req.range.start_sec - off, b = req.range.end_sec - off;
    if (b <= 0 || a >= (tl.total || 0)) continue;               // ye range is preview mein hai hi nahi
    slots = slots.filter(x => !(x.end > a + 0.01 && x.start < b - 0.01));
    for (const sh of built.shots) {
      slots.push({ ...sh, start: +(sh.start - off).toFixed(3), end: +(sh.end - off).toFixed(3) });
    }
    applied++;
  }
  slots.sort((x, y) => x.start - y.start);
  slots.forEach((x, i) => { x.i = i; });
  return { tl: { ...tl, slots }, applied,
    requests: ready.map(r => r.request_key), labels: ready.map(r => (r.request || {}).label || r.request_id) };
}

/**
 * Jin requests ko user ne SAAF-SAAF approve kiya hai.
 *
 * Critical beat (HOOK/HARD_EVIDENCE) par sirf file copy kar dena kaafi nahi —
 * wahan galat visual chup-chaap chhap jana sabse mehnga hai. Do raaste hain,
 * dono barabar:
 *   - UI ka checkbox  (manual-overrides.json mein approved: true)
 *   - folder mein APPROVE_MEDIA.txt naam ki khaali file bana do
 * JSON haath se likhne ki zaroorat kabhi nahi.
 */
function approvedRequestIds(dataRoot, cfg) {
  const out = new Set();
  const { scan: s, statuses } = approvalStatuses(dataRoot, cfg);
  for (const r of s.requests) {
    if (!r.files.length) continue;
    // SIRF sthir key — ek request = ek entry. (Gate ke liye purani request_id
    // ka fallback readiness.approvedKeys() deta hai, taaki purani timeline.json
    // bhi chal jaye; yahan ginti saaf rehni chahiye.)
    if ((statuses.get(r.request_key) || {}).status === approval.STATUS.APPROVED) out.add(r.request_key);
  }
  return out;
}

module.exports = { scan, applyToTimeline, fingerprint, approvedRequestIds, inspectFile, naturalCmp,
  buildShotsForRequest, readRequestMedia, readOverrides, writeOverrides, overridesPath,
  requestKey, overrideFor, approvalStatuses };
