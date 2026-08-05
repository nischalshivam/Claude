// ============================================================
//  EDL (M5.0-A) — editor ka apna database (project-edl-v1).
//
//  Kyun ye bana:
//  research JSON aur engine ki timeline.json editor ka database NAHI hai — wo
//  har run par dobara banti hai. Editor ko ek aisi file chahiye jo INSAAN ke
//  faisle rakhe (kaunsa asset, kitna trim, kaisa crop, approve ya nahi) aur
//  dobara khulne par bilkul waisi hi wapas aaye.
//
//  Do usool jo M4.2.1 se aate hain aur yahan bhi nahi tootenge:
//   1. Har visual decision ki pehchaan STHIR request_key se judi hai —
//      display number (MISSING 007) kabhi identity nahi.
//   2. Atomic write + revision. Har mutation `expected_revision` bhejti hai;
//      purana tab naye kaam ko overwrite nahi kar sakta (409).
//
//  M5.0-A mein EDL banti/dikhti/save-reload hoti hai. EDL ke transform/trim
//  edits ko ASLI render se jodna (EDL -> ffmpeg) M5.0-B ka kaam hai — abhi
//  render wahi DATA-folder waala rasta use karta hai jo already tested hai.
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const U = require('./util.js');

const SCHEMA = 'project-edl-v1';
const sha1 = s => crypto.createHash('sha1').update(String(s)).digest('hex');

// asset type kind/asset se
function assetType(shot) {
  const k = (shot.kind || '').toLowerCase();
  if (k === 'still' || k === 'graphic') return k === 'graphic' ? 'graphic' : 'image';
  if (shot.image && !shot.media_file && !shot.video) return 'image';
  return 'video';
}

// origin: ye shot kahan se aaya (audit ke liye)
function originOf(shot) {
  if (shot.manual) return 'USER';
  const a = shot.asset || '';
  if (a === 'EXACT_VIDEO') return 'AUTO_EXACT';
  if (a === 'CONTEXT_VIDEO') return 'AUTO_CONTEXT';
  if (a === 'VERIFIED_SOURCE_STILL') return 'AUTO_STILL';
  if (a === 'MONTAGE') return 'AUTO_MONTAGE';
  if (a === 'TEMPLATE_GRAPHIC_MEDIA') return 'AUTO_GRAPHIC';
  if (a === 'MISSING_PLACEHOLDER') return 'MISSING';
  return a || 'UNKNOWN';
}

// har shot ke liye ek path_token — browser ko kabhi raw path nahi milta,
// server isi token ko allow-list ke against resolve karta hai
function assetPath(shot) {
  return shot.media_file || shot.image || (Array.isArray(shot.images) && shot.images[0]) || null;
}

/**
 * Ek job (draft/final) ke artifacts se EDL banao.
 * @param {string} jobId
 * @param {object} opts { projectId, requestKeyByRange, criticalityByKey }
 */
function buildFromJob(jobId, opts = {}) {
  const man = readJson(U.p(jobId, 'render-manifest.json'));
  const tl = readJson(U.p(jobId, 'timeline.json'));
  const gap = readJson(U.p(jobId, 'gap-plan.json'));
  if (!man && !tl) throw new Error(`job ${jobId} mein na render-manifest, na timeline — pehle draft banao`);

  // Newly uploaded manual media can be reflected in the editor immediately
  // through a live timeline override, without waiting for a full render.
  const liveTl = opts.timelineOverride || null;
  const shots = (liveTl && liveTl.slots) || (man && man.shots) || (tl && tl.slots) || [];
  const dur = (man && man.duration) || {};
  const total = (liveTl && liveTl.total) || dur.audio || dur.timeline || (tl && tl.total) || 0;
  const previewOffset = (liveTl && liveTl.preview_offset) || (man && man.preview_offset) || (tl && tl.preview_offset) || 0;

  // gap-plan se request_key ranges (jahan user media chahiye)
  const gapRequests = (gap && gap.requests) || [];
  const keyForShot = shot => {
    if (shot.manual_request_key) return shot.manual_request_key;
    if (shot.manual_request_id) return 'REQ_' + String(shot.manual_request_id).split('__').pop();
    // slot range se overlapping gap request dhoondho
    const s = shot.start + previewOffset, e = shot.end + previewOffset;
    for (const r of gapRequests) {
      const rs = r.range.start_sec, re = r.range.end_sec;
      if (Math.min(e, re) - Math.max(s, rs) > 0.05) return r.request_key;
    }
    return null;
  };

  const video_main = shots.map((sh, idx) => {
    const p = assetPath(sh);
    const type = assetType(sh);
    const start = +(Number(sh.start) + previewOffset).toFixed(3);
    const end = +(Number(sh.end) + previewOffset).toFixed(3);
    const src_in = sh.media_start != null ? +Number(sh.media_start).toFixed(3)
      : (sh.clip_start != null ? +Number(sh.clip_start).toFixed(3) : 0);
    const src_out = sh.media_start != null && sh.dur != null
      ? +(Number(sh.media_start) + Number(sh.dur)).toFixed(3) : null;
    return {
      shot_id: 'SHOT_' + String(idx).padStart(4, '0'),
      slot_id: 'SLOT_' + String(sh.i != null ? sh.i : idx).padStart(4, '0'),
      request_key: keyForShot(sh),
      display_label: sh.missing_label || null,
      moment_ids: sh.moment_id ? [sh.moment_id] : (sh.moment_ids || []),
      timeline: { start, end },
      asset: {
        asset_id: p ? 'ASSET_' + sha1(p).slice(0, 12) : null,
        sha256: sh.manual_sha256 || null,
        path_token: p ? sha1(p) : null,
        path: p,                       // server-side only; browser ko token milta hai
        type,
        source_in: src_in,
        source_out: src_out,
      },
      transform: { fit: 'fill', crop_x: 0.5, crop_y: 0.5, scale: 1.0, rotation: 0, opacity: 1, blur_bg: type === 'image' },
      provenance: {
        origin: originOf(sh),
        source_id: sh.actual_source_id || sh.source_id || null,
        scope_relation: sh.scope_relation || null,
        url: sh.url || null,
      },
      approval: {
        required: String(sh.criticality || 'NORMAL').toUpperCase() !== 'NORMAL',
        status: null,                  // readiness/approval se live bharta hai
        criticality: String(sh.criticality || 'NORMAL').toUpperCase(),
      },
      cue: sh.cue || null,
      missing: originOf(sh) === 'MISSING',
    };
  });

  return {
    schema: SCHEMA,
    project_id: opts.projectId || 'current',
    source_job: jobId,
    revision: 1,
    generated_at: new Date().toISOString(),
    duration_sec: +Number(total).toFixed(3),
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    content_locked: false,
    duration: dur,
    tracks: { video_main, captions: [], voiceover: [], overlays: [], music: [] },
  };
}

// ---------- store (atomic + revisions) ----------
function projectRoot(root) { return path.join(root || U.ROOT, 'project'); }
function edlPath(root) { return path.join(projectRoot(root), 'project.edl.json'); }
function revDir(root) { return path.join(projectRoot(root), 'revisions'); }

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function read(root) { return readJson(edlPath(root)); }

function writeAtomic(root, edl) {
  const dir = projectRoot(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(revDir(root), { recursive: true });
  const p = edlPath(root);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(edl, null, 2));
  fs.renameSync(tmp, p);
  // har save ka ek snapshot — undo/rollback ke liye, kabhi overwrite nahi
  const snap = path.join(revDir(root), `rev-${String(edl.revision).padStart(5, '0')}.json`);
  try { if (!fs.existsSync(snap)) fs.writeFileSync(snap, JSON.stringify(edl, null, 2)); } catch {}
  return edl;
}

function validate(edl) {
  const errs = [];
  if (!edl || edl.schema !== SCHEMA) errs.push('schema galat hai');
  if (!edl || typeof edl.revision !== 'number') errs.push('revision number nahi hai');
  const t = (edl && edl.tracks && edl.tracks.video_main) || [];
  let prevEnd = -1;
  for (const s of t) {
    if (!s.timeline || s.timeline.end <= s.timeline.start) errs.push(`${s.shot_id}: timeline range galat`);
    if (s.timeline && s.timeline.start + 0.001 < prevEnd) errs.push(`${s.shot_id}: overlap`);
    prevEnd = s.timeline ? s.timeline.end : prevEnd;
    if (s.transform) {
      const tr = s.transform;
      for (const k of ['crop_x', 'crop_y']) if (tr[k] < 0 || tr[k] > 1) errs.push(`${s.shot_id}: ${k} 0..1 se bahar`);
      if (tr.scale <= 0 || tr.scale > 8) errs.push(`${s.shot_id}: scale galat`);
      if (tr.opacity < 0 || tr.opacity > 1) errs.push(`${s.shot_id}: opacity 0..1 se bahar`);
    }
  }
  return { ok: errs.length === 0, errors: errs };
}

// UI se aane wale patch — SIRF ye fields badal sakte hain (allow-list).
// Narration timing, slot range, asset identity, approval — yahan se nahi badalte.
const TRANSFORM_KEYS = new Set(['fit', 'crop_x', 'crop_y', 'scale', 'rotation', 'opacity', 'blur_bg']);
const ASSET_TRIM_KEYS = new Set(['source_in', 'source_out']);

/**
 * EDL patch — command-based, revision-guarded.
 * @param {string} root
 * @param {object} body { expected_revision, ops:[{shot_id, transform?, trim?}] }
 * @returns {{ ok, code?, edl?, message? }}
 */
function patch(root, body) {
  const edl = read(root);
  if (!edl) return { ok: false, code: 'NO_EDL', message: 'abhi koi EDL nahi — pehle draft se banao' };
  if (typeof body.expected_revision === 'number' && body.expected_revision !== edl.revision) {
    return { ok: false, code: 'REVISION_CONFLICT', message: `aapke paas rev ${body.expected_revision}, disk par ${edl.revision} — page refresh karo`, revision: edl.revision };
  }
  if (edl.content_locked && !body.allow_locked) {
    return { ok: false, code: 'CONTENT_LOCKED', message: 'content lock hai — pehle unlock karo' };
  }
  const byId = {};
  for (const s of edl.tracks.video_main) byId[s.shot_id] = s;
  const touched = [];
  for (const op of (body.ops || [])) {
    const s = byId[op.shot_id];
    if (!s) return { ok: false, code: 'NO_SHOT', message: `shot ${op.shot_id} nahi mila` };
    if (op.transform) {
      for (const k of Object.keys(op.transform)) if (TRANSFORM_KEYS.has(k)) s.transform[k] = op.transform[k];
    }
    if (op.trim) {
      for (const k of Object.keys(op.trim)) if (ASSET_TRIM_KEYS.has(k)) s.asset[k] = op.trim[k];
    }
    // Ye shot ab USER ne edit kiya — final render isi flag ko dekh kar parity
    // lagata hai (auto clip ke natural source_in ko galti se "edit" na maane).
    s.user_edited = true;
    touched.push(op.shot_id);
  }
  const v = validate(edl);
  if (!v.ok) return { ok: false, code: 'INVALID', message: v.errors.join('; '), errors: v.errors };
  edl.revision += 1;
  edl.updated_at = new Date().toISOString();
  writeAtomic(root, edl);
  return { ok: true, edl, revision: edl.revision, touched };
}

/**
 * Draft ke artifacts se EDL (re)build — par maujooda transform/trim edits bachao.
 * Reload par user ki mehnat kabhi nahi khoti.
 */
function rebuild(root, jobId, opts = {}) {
  const fresh = buildFromJob(jobId, opts);
  const old = read(root);
  if (old && old.tracks && old.tracks.video_main) {
    // A single missing request commonly expands to several shots. Keying only
    // by request_key made every fresh shot inherit the LAST shot's crop/trim.
    // Preserve per-asset occurrence instead: request/slot + asset + ordinal.
    const keyed = shots => {
      const seen = {}, out = [];
      for (const s of shots) {
        const base = `${s.request_key || s.slot_id}|${(s.asset && (s.asset.sha256 || s.asset.asset_id || s.asset.path_token)) || 'none'}`;
        const n = seen[base] || 0; seen[base] = n + 1;
        out.push([`${base}|${n}`, s]);
      }
      return out;
    };
    const oldByKey = Object.fromEntries(keyed(old.tracks.video_main));
    for (const [k, s] of keyed(fresh.tracks.video_main)) {
      const o = oldByKey[k];
      if (o) {
        s.transform = { ...s.transform, ...o.transform };
        if (o.user_edited) s.user_edited = true;   // user edit rebuild mein bhi bacha rahe
        if (o.asset && s.asset) {
          if (o.asset.source_in != null) s.asset.source_in = o.asset.source_in;
          if (o.asset.source_out != null) s.asset.source_out = o.asset.source_out;
        }
      }
    }
    fresh.revision = old.revision + 1;   // reload bhi ek naya revision
  }
  return writeAtomic(root, fresh);
}

// ============================================================
//  P0-A: EDL -> RENDER PARITY (M5.0-B)
//  Editor mein kiye gaye crop/scale/fit/trim ab FINAL render tak pahunchte hain.
//  Pehle EDL sirf preview thi; edl.js khud kehta tha "render EDL se M5.0-B mein
//  judega". Ab judta hai.
//
//  Milane ka tareeka WAHI occurrence-key hai jo rebuild() use karta hai:
//    (request_key | asset-identity | ordinal)
//  taaki ek hi request ke kai shots apna-apna crop/trim rakhein — display
//  number se kabhi nahi.
// ============================================================
const near = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.001;
// Ek shot "edited" TABHI hai jab user ne use PATCH kiya ho (user_edited flag).
// Pehle iska andaza source_in>0 se lagta tha — par auto clip ka source_in
// naturally >0 hota hai (wo source mein us waqt se shuru hota hai), edit nahi.
// Us false-positive se un-edited context clip bhi "edited" gina jata tha.
function shotIsEdited(sh) {
  if (sh.user_edited) return true;
  // backward-compat: purani EDL bina flag ke — sirf transform (default se alag)
  const t = sh.transform || {};
  return (t.fit && t.fit !== 'fill') || !near(t.scale, 1) || !near(t.crop_x, 0.5) || !near(t.crop_y, 0.5) || !near(t.rotation, 0);
}
function occKey(base, seen) { const n = seen[base] || 0; seen[base] = n + 1; return `${base}|${n}`; }
function edlShotBase(sh) { return `${sh.request_key || sh.slot_id}|${(sh.asset && (sh.asset.sha256 || sh.asset.asset_id || sh.asset.path_token)) || 'none'}`; }
function slotAssetPath(s) { return s.media_file || s.image || s.video || (Array.isArray(s.images) && s.images[0]) || null; }
function slotBase(s) {
  const rk = s.manual_request_key || ('SLOT_' + (s.i != null ? String(s.i).padStart(4, '0') : 'x'));
  const p = slotAssetPath(s);
  const assetId = s.manual_sha256 || (p ? ('ASSET_' + sha1(p).slice(0, 12)) : 'none');
  return `${rk}|${assetId}`;
}

/**
 * Saved EDL ke edits ko timeline slots par chipka do (render se pehle).
 * SIRF wahi shots jinpar user ne sach mein edit kiya (default se alag) —
 * warna un-edited stills ka Ken Burns waisa ka waisa rahega.
 * @returns {{ applied, revision, edits:[] }}
 */
function reconcile(edl, slots) {
  if (!edl || !edl.tracks || !Array.isArray(edl.tracks.video_main)) return { applied: 0, edits: [] };
  const seenE = {}, edited = {};
  for (const sh of edl.tracks.video_main) {
    const k = occKey(edlShotBase(sh), seenE);
    if (shotIsEdited(sh)) edited[k] = {
      transform: sh.transform || {},
      source_in: Number((sh.asset && sh.asset.source_in) || 0),
      source_out: sh.asset ? sh.asset.source_out : null,
      shot_id: sh.shot_id,
    };
  }
  const seenS = {}, applied = [];
  for (const s of slots) {
    const e = edited[occKey(slotBase(s), seenS)];
    if (!e) continue;
    s.edl_transform = e.transform;
    if (e.source_in > 0) s.edl_source_in = e.source_in;
    if (e.source_out != null) s.edl_source_out = e.source_out;
    s.edl_shot_id = e.shot_id;
    applied.push({ i: s.i, shot_id: e.shot_id, fit: e.transform.fit, scale: e.transform.scale,
      crop_x: e.transform.crop_x, crop_y: e.transform.crop_y, source_in: e.source_in, source_out: e.source_out });
  }
  return { applied: applied.length, revision: edl.revision, edits: applied };
}

/**
 * SIRF user ke edits ka sthir signature. render_sig isme daalta hai taaki
 * editor mein crop/trim badalne par final render dobara bane (aur reconcile
 * chale) — par sirf rebuild se rev badalne par nahi. Revision se NAHI banate
 * kyunki rebuild har baar rev badha deta hai bina kisi asli edit ke.
 */
function editSignature(edl) {
  if (!edl || !edl.tracks || !Array.isArray(edl.tracks.video_main)) return 'none';
  const seen = {};
  const bits = [];
  for (const sh of edl.tracks.video_main) {
    const base = edlShotBase(sh); const n = seen[base] || 0; seen[base] = n + 1;
    if (!shotIsEdited(sh)) continue;
    const t = sh.transform || {}, a = sh.asset || {};
    bits.push(`${base}|${n}|${t.fit || 'fill'}|${t.scale}|${t.crop_x}|${t.crop_y}|${t.rotation}|${a.source_in}|${a.source_out}`);
  }
  return bits.length ? sha1(bits.sort().join('||')) : 'none';
}

// approval status EDL par live chadhao (readiness se) — store mein nahi rakhte,
// kyunki wo fingerprint se derive hota hai
function withApproval(edl, statusByKey) {
  if (!edl) return edl;
  for (const s of edl.tracks.video_main) {
    if (s.request_key && statusByKey[s.request_key]) s.approval.status = statusByKey[s.request_key];
  }
  return edl;
}

module.exports = {
  SCHEMA, buildFromJob, rebuild, read, writeAtomic, validate, patch, withApproval,
  reconcile, shotIsEdited, editSignature, projectRoot, edlPath, revDir,
};
