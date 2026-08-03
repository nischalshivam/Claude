// ============================================================
//  GAP PLANNER (M4) — "kahan-kahan media nahi mila" ko INSAAN ke kaam
//  layak folders mein badalta hai.
//
//  Kyun ye bana:
//  Kuch footage public internet par hai hi nahi. Candace project mein P03 (movie)
//  ke dono uploads mar chuke hain — 21 moments, ~162 second. Genspark, Gemini,
//  Claude, koi bhi us scene ka clip nahi bana sakta. Ab tak iska nateeja ye tha
//  ki poora render ruk jata tha aur video kabhi banti hi nahi thi.
//
//  Ab: tool jo bana sakta hai wo banata hai, aur jo nahi bana wo saaf-saaf
//  bata deta hai — asli video-time, narration ke shabd, kya dikhna chahiye,
//  kya nahi, aur search karne ke liye keywords. User apni images/videos ek
//  folder mein daal deta hai, aur video poori ban jati hai.
//
//  Do usool jo kabhi nahi tootenge:
//   1. Waqt hamesha POORE audio ka hota hai (preview ka rebased waqt nahi) —
//      warna user 2:03 dhoondhta rahega aur gap 12:03 par hoga.
//   2. Request ID sthir hai. Wahi inputs = wahi ID = wahi folder. Dobara
//      chalane par user ka daala hua media kho nahi jata.
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const U = require('./util.js');

// media na hone ki wajahein — user ko inhi shabdon mein dikhti hain
const REASON_TEXT = {
  NO_LOCATOR: 'research ne is beat ke liye koi scene bataya hi nahi',
  DEAD_SOURCE: 'jo video bataya tha wo ab YouTube par nahi hai (hata/private ho gaya)',
  DOWNLOAD_FAILED: 'source mila par download/cut nahi ho paya',
  QA_REJECTED: 'clip bani par quality check mein reject hui (kaali/jami hui/duplicate)',
  NO_MEDIA_ASSET: 'is beat ke liye koi asli frame/image plan mein tha hi nahi',
  GENERIC_CARD: 'yahan sirf plain text card lagta — koi asli footage nahi',
  MISSING_FILE: 'plan mein media tha par file disk par nahi mili',
  CRITICAL_NO_EXACT: 'ye zaroori beat hai aur iske paas exact footage nahi hai',
  WRONG_SCOPE: 'yahan doosre episode/show ka footage lag raha tha — wo allowed nahi',
  USER_FLAGGED: 'aapne shot review mein ise galat mark kiya tha',
};

// jin assets ka matlab hai "yahan sach mein kuch nahi hai"
const BLOCKING_ASSETS = new Set([
  'GENERIC_TEXT_GRAPHIC', 'DIAGNOSTIC_CARD', 'RENDER_FAILURE_FALLBACK',
  'LOW_CONFIDENCE_FALLBACK', 'MISSING_PLACEHOLDER',
]);
// ye theek hain — inpar user se media maangna bekaar hai
const OK_ASSETS = new Set([
  'EXACT_VIDEO', 'CONTEXT_VIDEO', 'VERIFIED_SOURCE_STILL', 'MONTAGE',
  'TEMPLATE_GRAPHIC_MEDIA', 'USER_VIDEO', 'USER_IMAGE', 'USER_MONTAGE',
]);

const mmss = t => `${String(Math.floor(t / 60)).padStart(2, '0')}m${String(Math.floor(t % 60)).padStart(2, '0')}s`;
const clock = t => {
  const s = Math.max(0, t);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}.${String(Math.round((s % 1) * 1000)).padStart(3, '0')}`;
};
const sha8 = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);

// narration se kaam ke search words — stopwords hata kar
const STOP = new Set(('a an the and or but if then than that this these those is are was were be been being of to in on at by for with from as it its into about over after before her his their they she he you i we not no so what which who whom whose when where why how all any both each few more most other some such only own same too very can will just don should now'
).split(/\s+/));
function keywords(text, scope) {
  const words = String(text || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/)
    .filter(w => w.length > 3 && !STOP.has(w));
  const seen = new Set(), out = [];
  for (const w of words) { if (!seen.has(w)) { seen.add(w); out.push(w); } if (out.length >= 6) break; }
  const title = (scope && scope.title) || '';
  const ep = (scope && scope.episode_title) || '';
  const q = [];
  if (title) q.push(`${title} ${ep} ${out.slice(0, 3).join(' ')}`.replace(/\s+/g, ' ').trim());
  if (title) q.push(`${title} ${out.slice(0, 4).join(' ')} scene`.replace(/\s+/g, ' ').trim());
  q.push(`${title || ''} ${out.slice(0, 5).join(' ')}`.replace(/\s+/g, ' ').trim());
  return q.filter(Boolean).slice(0, 3);
}

/**
 * Har shot ko dekh kar batao ki ye blocking hai, upgrade-worthy hai, ya theek hai.
 * `resolvedById` locate/QA ka nateeja hai (kyun toota, iske liye).
 */
function classifyShot(shot, resolvedById) {
  const asset = shot.asset || '';
  const e = resolvedById[shot.moment_id] || {};
  const crit = String(shot.criticality || e.criticality || 'NORMAL').toUpperCase();
  const isCritical = crit === 'HOOK' || crit === 'HARD_EVIDENCE';

  if (BLOCKING_ASSETS.has(asset)) {
    const codes = [];
    if (asset === 'MISSING_PLACEHOLDER' || asset === 'RENDER_FAILURE_FALLBACK') codes.push('MISSING_FILE');
    else if (asset === 'GENERIC_TEXT_GRAPHIC') codes.push('GENERIC_CARD');
    else codes.push('NO_MEDIA_ASSET');
    if (e.status === 'NEEDS_SOURCE') codes.push((e.candidates || []).length ? 'DOWNLOAD_FAILED' : 'NO_LOCATOR');
    if (e.qa && e.qa.ok === false) codes.push('QA_REJECTED');
    return { level: 'BLOCKING', codes: [...new Set(codes)] };
  }
  // galat scope ka footage — ye technically render ho gaya par lagna nahi chahiye
  const rel = shot.scope_relation;
  if (rel && !['SAME_EPISODE', 'GRAPHIC', 'NONE', 'USER_APPROVED'].includes(rel)) {
    return { level: 'BLOCKING', codes: ['WRONG_SCOPE'] };
  }
  if (isCritical && !['EXACT_VIDEO', 'USER_VIDEO', 'USER_IMAGE', 'USER_MONTAGE'].includes(asset)) {
    return { level: 'BLOCKING', codes: ['CRITICAL_NO_EXACT'] };
  }
  if (!OK_ASSETS.has(asset)) return { level: 'BLOCKING', codes: ['NO_MEDIA_ASSET'] };
  // theek hai, par behtar ho sakta hai
  if (e.status === 'NEEDS_REVIEW') return { level: 'OPTIONAL', codes: ['WEAK_MATCH'] };
  if (asset === 'CONTEXT_VIDEO') return { level: 'OPTIONAL', codes: ['CONTEXT_ONLY'] };
  return { level: 'OK', codes: [] };
}

/**
 * Blocking shots ko insaan ke laayak requests mein badlo.
 *  - 1s se kam faasle wale jodo
 *  - 30s se lambe ko SRT boundary par todo
 */
function groupGaps(bad, cues, maxSec = 30, mergeGap = 1.0) {
  const sorted = bad.slice().sort((a, b) => a.start - b.start);
  const groups = [];
  for (const s of sorted) {
    const last = groups[groups.length - 1];
    if (last && s.start - last.end <= mergeGap) {
      last.end = Math.max(last.end, s.end);
      last.shots.push(s);
      for (const c of s.codes) last.codes.add(c);
      if (s.moment_id) last.moment_ids.add(s.moment_id);
      if (s.pack_id) last.pack_ids.add(s.pack_id);
    } else {
      groups.push({ start: s.start, end: s.end, shots: [s], codes: new Set(s.codes),
        moment_ids: new Set(s.moment_id ? [s.moment_id] : []), pack_ids: new Set(s.pack_id ? [s.pack_id] : []) });
    }
  }
  // lambe groups ko SRT boundary par todo — beech se kaatna narration ko cheer deta hai
  const out = [];
  for (const g of groups) {
    if (g.end - g.start <= maxSec) { out.push(g); continue; }
    let cur = { ...g, shots: [], codes: new Set(), moment_ids: new Set(), pack_ids: new Set(), start: g.start, end: g.start };
    for (const s of g.shots) {
      const wouldBe = Math.max(cur.end, s.end) - cur.start;
      const atBoundary = cues.some(c => Math.abs(c.start - s.start) < 0.35);
      if (cur.shots.length && wouldBe > maxSec && atBoundary) {
        out.push(cur);
        cur = { shots: [], codes: new Set(), moment_ids: new Set(), pack_ids: new Set(), start: s.start, end: s.end };
      }
      cur.shots.push(s); cur.end = Math.max(cur.end, s.end);
      for (const c of s.codes) cur.codes.add(c);
      if (s.moment_id) cur.moment_ids.add(s.moment_id);
      if (s.pack_id) cur.pack_ids.add(s.pack_id);
    }
    if (cur.shots.length) out.push(cur);
  }
  return out;
}

// narration ka hubahu text is range se — aur uske aage-peeche ki ek line
function narrationFor(cues, a, b) {
  const inside = cues.filter(c => c.end > a + 0.05 && c.start < b - 0.05);
  const beforeIdx = cues.findIndex(c => c.end > a + 0.05);
  const before = beforeIdx > 0 ? cues[beforeIdx - 1] : null;
  const lastIdx = inside.length ? cues.indexOf(inside[inside.length - 1]) : -1;
  const after = lastIdx >= 0 && lastIdx + 1 < cues.length ? cues[lastIdx + 1] : null;
  return {
    exact: inside.map(c => c.text).join(' ').replace(/\s+/g, ' ').trim(),
    before: before ? before.text : '',
    after: after ? after.text : '',
    cue_ids: inside.map(c => cues.indexOf(c)),
  };
}

/**
 * Poora gap plan banao.
 * @returns { requests, blocking, optional, covered_seconds, missing_seconds }
 */
function plan({ manifest, resolved, cues, packIndex, fingerprint, projectId, cfg }) {
  const resolvedById = {};
  for (const e of (resolved || [])) resolvedById[e.moment_id] = e;
  // preview timeline 0 se shuru hoti hai — POORE audio ke waqt par wapas laao
  const off = (manifest && manifest.preview_offset) || 0;
  const shots = ((manifest && manifest.shots) || []).map(s => ({
    ...s, start: +(s.start + off).toFixed(3), end: +(s.end + off).toFixed(3),
  }));

  const bad = [], optional = [];
  let okSec = 0, badSec = 0;
  for (const s of shots) {
    const c = classifyShot(s, resolvedById);
    const dur = s.end - s.start;
    if (c.level === 'BLOCKING') { bad.push({ ...s, codes: c.codes }); badSec += dur; }
    else { okSec += dur; if (c.level === 'OPTIONAL') optional.push({ ...s, codes: c.codes }); }
  }

  const maxSec = ((cfg || {}).hybrid || {}).maxRequestSeconds || 30;
  const groups = groupGaps(bad, cues || [], maxSec);
  const requests = groups.map((g, i) => {
    const momentIds = [...g.moment_ids].sort();
    const packIds = [...g.pack_ids].sort();
    const scope = (packIndex && packIndex[packIds[0]] && packIndex[packIds[0]].scope) || {};
    const nar = narrationFor(cues || [], g.start, g.end);
    const codes = [...g.codes];
    // Sthir ID: project + rounded range + moments + reason. Status/filenames
    // ISME NAHI — warna media daalte hi ID badal jayegi aur folder anaath ho jayega.
    const rid = sha8([projectId, g.start.toFixed(1), g.end.toFixed(1), momentIds.join(','), codes.sort().join(',')].join('|'));
    const num = String(i + 1).padStart(3, '0');
    const dur = +(g.end - g.start).toFixed(3);
    const firstMoment = momentIds[0] || (packIds[0] || 'GAP');
    const must = [], mustNot = [], purpose = [];
    for (const s of g.shots) {
      for (const x of (s.must_show || [])) if (!must.includes(x)) must.push(x);
      for (const x of (s.must_not_show || [])) if (!mustNot.includes(x)) mustNot.push(x);
      const e = resolvedById[s.moment_id];
      if (e && e.purpose && !purpose.includes(e.purpose)) purpose.push(e.purpose);
    }
    return {
      schema: 'manual-gap-request-v1',
      request_id: `MISSING_${num}__${rid}`,
      folder: `MISSING_${num}__${mmss(g.start)}-${mmss(g.end)}__${firstMoment}`,
      project_id: projectId,
      input_fingerprint: fingerprint,
      range: { start_sec: +g.start.toFixed(3), end_sec: +g.end.toFixed(3), duration_sec: dur },
      moment_ids: momentIds, pack_ids: packIds,
      severity: 'BLOCKING',
      reason_codes: codes,
      reason_text: codes.map(c => REASON_TEXT[c]).filter(Boolean),
      narration_exact: nar.exact, context_before: nar.before, context_after: nar.after,
      cue_ids: nar.cue_ids,
      scope: { title: scope.title || '', episode_title: scope.episode_title || '', kind: scope.kind || '' },
      purpose, must_show: must, must_not_show: mustNot,
      search_queries: keywords(nar.exact, scope),
      suggested_media: {
        // ~5s ek shot — utne hi unique assets maango, warna repeat dikhega
        minimum_unique_assets: Math.max(1, Math.ceil(dur / 6)),
        recommended_video_seconds: Math.round(dur * 0.6),
        recommended_images: Math.max(1, Math.round(dur / 8)),
      },
      sub_slots: g.shots.map(s => ({ i: s.i, start_sec: s.start, end_sec: s.end,
        moment_id: s.moment_id || null, cue: s.cue || null })),
      status: 'WAITING_FOR_MEDIA',
    };
  });

  const total = okSec + badSec;
  return {
    schema: 'gap-plan-v1', generated_at: new Date().toISOString(),
    project_id: projectId, input_fingerprint: fingerprint,
    covered_seconds: +okSec.toFixed(1), missing_seconds: +badSec.toFixed(1),
    coverage_percent: total ? Math.round(okSec / total * 1000) / 10 : 0,
    requests,
    optional: optional.map(s => ({ i: s.i, start_sec: s.start, end_sec: s.end, moment_id: s.moment_id || null,
      asset: s.asset, codes: s.codes, cue: s.cue || null })),
  };
}

// ---------- DATA folders ----------
function readableRequest(r) {
  const L = [];
  const P = s => L.push(s);
  P(r.request_id.split('__')[0].replace('_', ' '));
  P(`Video time: ${clock(r.range.start_sec)} se ${clock(r.range.end_sec)}  (${r.range.duration_sec.toFixed(1)} second)`);
  P('');
  P('Yahan narration ye keh rahi hai:');
  P(`"${r.narration_exact}"`);
  P('');
  if (r.context_before) { P('(isse thoda pehle: "' + r.context_before + '")'); }
  if (r.context_after) { P('(iske thoda baad: "' + r.context_after + '")'); }
  if (r.context_before || r.context_after) P('  ^ ye sirf samajhne ke liye hai. Media SIRF upar wali range ke liye chahiye.');
  P('');
  if (r.scope.title) P(`Kis cheez ki baat ho rahi hai: ${r.scope.title}${r.scope.episode_title ? ' — ' + r.scope.episode_title : ''}`);
  if (r.purpose.length) { P('Screen par kya hona chahiye:'); r.purpose.forEach(x => P('  - ' + x)); }
  if (r.must_show.length) { P('Ye zaroor dikhna chahiye:'); r.must_show.forEach(x => P('  - ' + x)); }
  if (r.must_not_show.length) { P('Ye NAHI dikhna chahiye:'); r.must_not_show.forEach(x => P('  - ' + x)); }
  P('');
  P('Automatic media kyun nahi mila:');
  (r.reason_text.length ? r.reason_text : ['media nahi mila']).forEach(x => P('  ' + x));
  P('');
  P('Search karne ke liye (copy karke YouTube/Google Images mein daalo):');
  r.search_queries.forEach((q, i) => P(`  ${i + 1}. ${q}`));
  P('');
  P('Kitna media chahiye:');
  P(`  kam se kam ${r.suggested_media.minimum_unique_assets} alag-alag file`);
  P(`  jaise: ~${r.suggested_media.recommended_video_seconds}s video, ya ${r.suggested_media.recommended_images} image, ya dono ka mix`);
  P('');
  P('KYA KARNA HAI:');
  P('  1. Is folder ke andar "media" folder kholo');
  P('  2. Apni images/videos usme daal do');
  P('  3. Kis order mein lagani hain, wo naam se batao: 01_pehli.jpg, 02_doosri.mp4, 03_...');
  P('  4. Phir tool mein "Missing media complete karo" chalao');
  P('');
  P('Audio kabhi nahi badlega — aapki narration jaisi hai waisi hi rahegi.');
  P('Video ka sound apne aap mute ho jayega.');
  return L.join('\n') + '\n';
}

/**
 * DATA/ folders likho. Purane folders jo ab kaam ke nahi, _ORPHANED mein jaate
 * hain — DELETE kabhi nahi, kyunki usme user ki mehnat se dhoondhi hui files hain.
 */
function writeDataFolders(dataRoot, gapPlan) {
  fs.mkdirSync(dataRoot, { recursive: true });
  const want = new Map();
  for (const r of gapPlan.requests) want.set(r.request_id, r);

  const isReqDir = n => /^MISSING_\d{3}__/.test(n);
  const existing = fs.existsSync(dataRoot) ? fs.readdirSync(dataRoot).filter(n => {
    try { return isReqDir(n) && fs.statSync(path.join(dataRoot, n)).isDirectory(); } catch { return false; }
  }) : [];

  // purane folders: request.json se unki ID padho
  const byId = {};
  for (const n of existing) {
    let rid = null;
    try { rid = JSON.parse(fs.readFileSync(path.join(dataRoot, n, 'request.json'), 'utf8')).request_id; } catch {}
    if (rid) byId[rid] = n;
  }

  const orphaned = [];
  for (const [rid, dir] of Object.entries(byId)) {
    if (want.has(rid)) continue;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(dataRoot, '_ORPHANED', stamp);
    fs.mkdirSync(dest, { recursive: true });
    fs.renameSync(path.join(dataRoot, dir), path.join(dest, dir));
    fs.writeFileSync(path.join(dest, dir, 'KYUN_HATAYA.txt'),
      'Ye request ab valid nahi hai — script, voiceover ya research pack badal gaya hai,\n' +
      'isliye is jagah ka gap ab waisa nahi raha.\n\n' +
      'Aapki daali hui files yahin surakshit hain. Agar ye media abhi bhi kaam ka hai,\n' +
      'to naye MISSING_... folder ke "media" folder mein copy kar lo.\n');
    orphaned.push(dir);
  }

  const made = [];
  for (const r of gapPlan.requests) {
    const dir = byId[r.request_id] ? path.join(dataRoot, byId[r.request_id]) : path.join(dataRoot, r.folder);
    fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
    U.writeJsonAtomic ? U.writeJsonAtomic(path.join(dir, 'request.json'), r)
      : fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify(r, null, 2));
    fs.writeFileSync(path.join(dir, 'WHAT_IS_MISSING.txt'), readableRequest(r));
    made.push(path.basename(dir));
  }

  fs.writeFileSync(path.join(dataRoot, 'READ_ME_FIRST.txt'),
    'YE FOLDER KYA HAI\n' +
    '=================\n\n' +
    'Tool ne poori video bana di, par kuch jagah aisi hain jahan use koi asli footage\n' +
    'nahi mila — aksar isliye ki wo video internet par hai hi nahi (delete/private ho\n' +
    'gaya, ya wo movie kahin publicly upload hi nahi hui).\n\n' +
    'Har aisi jagah ke liye yahan ek folder hai. Andar:\n' +
    '  WHAT_IS_MISSING.txt   -> saaf-saaf likha hai kya chahiye (yahi pehle padho)\n' +
    '  media/                -> apni images/videos ISME daalo\n' +
    '  request.json          -> tool ke liye hai, ise chhedne ki zaroorat nahi\n\n' +
    'Order set karna ho to filename ke aage number lagao: 01_, 02_, 03_\n\n' +
    'Files daalne ke baad tool mein "Missing media complete karo" chalao.\n' +
    'Purane downloads dobara nahi honge — sirf ye hisse naye banenge.\n\n' +
    `Abhi ${gapPlan.requests.length} jagah media chahiye ` +
    `(kul ${gapPlan.missing_seconds}s me se ${gapPlan.coverage_percent}% pehle se bana hua hai).\n`);

  return { made, orphaned };
}

module.exports = { plan, writeDataFolders, classifyShot, groupGaps, keywords, readableRequest, REASON_TEXT };
