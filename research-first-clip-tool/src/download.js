// ============================================================
//  Stage 4 — DOWNLOAD (sirf zaroori range) + ALTERNATE fallback + resume-safe.
//   - raw_file (relative) + raw_offset resolved.json mein PERSIST hote hain,
//     taaki alag process se cut resume ho (P0-2 fix).
//   - url range cache MS-exact key + manifest + probe-before-reuse (P1-6 fix).
//   - candidate order: download 403/unavailable -> agla candidate.
//  NOTE: sandbox mein YouTube proxy-blocked; url path Windows par. local_file yahan bhi.
// ============================================================
const fs = require('fs');
const path = require('path');
const U = require('./util.js');

// entry.raw_file/raw_kind se absolute path banao (resume par reconstruct)
function resolveRaw(id, e) {
  if (!e.raw_file) return null;
  if (e.raw_kind === 'local') return path.isAbsolute(e.raw_file) ? e.raw_file : path.join(U.ROOT, e.raw_file);
  return U.p(id, e.raw_file);   // 'job' relative (cache/_raw/...)
}

// MS-exact, collision-proof cache key (10.1-20.1 vs 10.9-20.9 => alag files)
function rangeKey(sourceId, segStart, segEnd, minH) {
  return `${sourceId}__${Math.round(segStart * 1000)}_${Math.round(segEnd * 1000)}__h${minH}.mp4`;
}

// ---------------- PER-SOURCE BANK (M2-B) ----------------
// Ek source ko BAAR-BAAR range-download karne ke bajaye EK BAAR poora (<=720p)
// laakar local se saare moments cut karo. Nicole run: 53 downloads -> ~13.
// Sirf chhoti/reused sources ke liye; lambi source ke liye range download hi.
function bankPath(id, sourceId) { return U.p(id, 'cache', '_bank', `${sourceId}.mp4`); }

// Per-source CIRCUIT BREAKER: ek hi source ko baar-baar timeout hone dena ek
// job mein ghante kha jata hai. Do baar fail hui to us source ko us run mein
// chhod dete hain (wajah ke saath).
const _srcFails = {};
const MAX_SRC_FAILS = 2;
// M4.1: kuch nakaamiyan "shayad agli baar chal jaye" wali nahi hoti — wo source
// ka hi kharab hona batati hain (koi video stream hi nahi, format support nahi,
// video hata diya gaya). Asli run mein P02_S02 ne aisi hi ek galti par DO baar
// ~165-165 second khaye — yaani 5.5 minute, do baar wahi jawab paane ke liye.
// Aisa source pehli baar mein hi is run ke liye band ho jata hai.
const _srcDead = {};
const FATAL_RE = /zero video streams|no usable video stream|unsupported|video unavailable|private video|removed by the uploader|is not available/i;
function isFatalSourceError(err) { return FATAL_RE.test(String(err || '')); }
function markSourceDead(sid, why) { if (sid && !_srcDead[sid]) _srcDead[sid] = String(why || '').slice(0, 120); }
function sourceDeadReason(sid) { return _srcDead[sid] || null; }

function acquireFullSource(id, cfg, cand, meta, spec) {
  const bank = bankPath(id, cand.source_id);
  const man = bank + '.json';
  U.ensureDir(path.dirname(bank));
  if (fs.existsSync(bank) && fs.existsSync(man)) {
    const pr = U.probe(bank);
    if (pr.ok) return { ok: true, file: bank, duration: pr.duration, width: pr.width, height: pr.height, via: 'bank-cache' };
    try { fs.rmSync(bank, { force: true }); fs.rmSync(man, { force: true }); } catch {}
  }
  if ((_srcFails[cand.source_id] || 0) >= MAX_SRC_FAILS) {
    return { ok: false, error: `${cand.source_id} is run mein ${MAX_SRC_FAILS} baar fail ho chuka — dobara koshish nahi (circuit breaker)` };
  }
  // AUTHORITATIVE METADATA YAHIN LOAD KARO.
  // Pehle duration caller ke `meta` par nirbhar thi. Per-moment recovery calls
  // mein wo aksar undefined hoti thi -> dur0 = 0 -> `0 > cap` false -> ek 67-min
  // source bhi poori download ho sakti thi. Ab source_id se khud nikalte hain,
  // aur duration pata hi na chale to full download se INKAAR karte hain.
  if ((!meta || !meta.duration) && spec && spec.pack) {
    try {
      const SRC = require('./sources.js');
      const sObj = SRC.indexSources(spec.pack)[cand.source_id];
      if (sObj) meta = SRC.getMeta(id, sObj, cfg);
    } catch (e) { /* neeche unknown-duration rule chalega */ }
  }
  // HARD CAP: fallback/variety ke liye ek 67-minute compilation poori download
  // karna ghanton ka kaam hai. Cap sirf planAcquisition mein tha, par lazy aur
  // context-variety paths seedha yahan aate the — isliye cap ab YAHIN hai.
  const acq = cfg.acquire || {};
  // Do alag cap:
  //  - normal cap (900s): sirf variety/fallback ke liye laayi jaane wali sources
  //  - hard cap (2400s): jab source SACH mein kai moments ko chahiye. Ek 22-min
  //    episode jo 16 beats serve karta hai use poora laana hi sasta hai —
  //    range-per-moment usse kai guna mehnga aur kam bharosemand hai.
  const capSec = cand.manyUses ? (acq.fullDownloadHardMaxSeconds || 2400) : (acq.fullDownloadMaxSeconds || 900);
  const dur0 = (meta && meta.duration) || 0;
  // local_file ki duration probe se pakki hoti hai; URL par duration na pata ho
  // to poori download karna andhera mein teer hai — 3-ghante ki source bhi ho
  // sakti hai. Inkaar karo.
  if (!cand.local_file && !cand.allowLong && dur0 <= 0) {
    return { ok: false, error: `${cand.source_id} ki duration pata nahi chali — poori download nahi karunga (kitni badi hai ye maloom nahi).` };
  }
  if (!cand.allowLong && dur0 > capSec) {
    return { ok: false, tooLong: true,
      error: `source ${Math.round(dur0)}s lamba hai (cap ${capSec}s${cand.manyUses ? ', multi-use' : ''}) — poori download nahi karunga. Range/hint se kaam chalega.` };
  }
  const maxH = acq.maxHeight || 720;
  // VIDEO-ONLY: final video mein source audio hamesha mute hota hai (sirf
  // voiceover chalta hai), isliye audio stream laana bandwidth/time ki barbaadi
  // hai. Muxed-only sources ke liye fallback chain phir bhi rakhi hai.
  const fmt = `bv*[height<=${maxH}][ext=mp4]/bv*[height<=${maxH}]/b[height<=${maxH}][ext=mp4]/b[height<=${maxH}]/b`;
  const r = U.ytdlp(['-f', fmt, '--merge-output-format', 'mp4', ...U.ytRuntimeArgs(cfg),
    '-o', bank, '--no-playlist', '--no-warnings', cand.url],
    { timeout: (cfg.acquire && cfg.acquire.timeoutMs) || 900000 });
  const cleanPartials = () => {
    try {
      const dir = path.dirname(bank), base = path.basename(bank);
      for (const f of fs.readdirSync(dir)) if (f.startsWith(base) && f !== base + '.json') { try { fs.rmSync(path.join(dir, f), { force: true }); } catch {} }
    } catch {}
  };
  if (!r.ok || !fs.existsSync(bank)) {
    cleanPartials();                                  // .part/.ytdl temp files bhi
    _srcFails[cand.source_id] = (_srcFails[cand.source_id] || 0) + 1;
    return { ok: false, error: (r.stderr || 'full-source download fail').replace(/\s+/g, ' ').slice(0, 180) };
  }
  const pr = U.probe(bank);
  if (!pr.ok) { cleanPartials(); _srcFails[cand.source_id] = (_srcFails[cand.source_id] || 0) + 1; return { ok: false, error: `full source invalid: ${pr.error}` }; }
  fs.writeFileSync(man, JSON.stringify({ url: cand.url, source_id: cand.source_id, maxH, duration: pr.duration, width: pr.width, height: pr.height, at: Date.now() }));
  return { ok: true, file: bank, duration: pr.duration, width: pr.width, height: pr.height, via: 'yt-dlp-full' };
}

// kaunse sources ko poora laana hai? (chhote + reuse hone wale)
function planAcquisition(cfg, resolved, metaOf) {
  const acq = cfg.acquire || {};
  const maxFullSec = acq.fullDownloadMaxSeconds || 900;      // <=15 min sources
  const minUses = acq.fullDownloadMinUses || 2;
  const uses = {};
  for (const e of resolved) {
    if (e.kind !== 'video') continue;
    for (const c of candList(e)) if (c.url) uses[c.source_id] = (uses[c.source_id] || 0) + 1;
  }
  const hardMax = acq.fullDownloadHardMaxSeconds || 2400;
  const plan = {};
  for (const sid of Object.keys(uses)) {
    const meta = metaOf(sid);
    const dur = meta && meta.duration || 0;
    if (dur <= 0) { plan[sid] = false; continue; }
    // chhoti source: hamesha poori
    if (dur <= (acq.alwaysFullUnderSeconds || 420)) { plan[sid] = true; continue; }
    // kai moments use kar rahe hain: hard cap tak poori laana sasta hai
    if (uses[sid] >= minUses && dur <= hardMax) { plan[sid] = true; continue; }
    plan[sid] = dur <= maxFullSec && uses[sid] >= minUses;
  }
  return { plan, uses };
}

// ek candidate materialize karo (download/local). {ok, raw_file, raw_offset, raw_kind, via, error}
function downloadCandidate(id, cfg, cand, opts = {}) {
  if (cand.local_file) {
    const abs = path.isAbsolute(cand.local_file) ? cand.local_file : path.join(U.ROOT, cand.local_file);
    if (!fs.existsSync(abs)) return { ok: false, error: `local_file missing: ${cand.local_file}` };
    const pr = U.probe(abs);
    if (!pr.ok) return { ok: false, error: `local_file unreadable: ${pr.error}` };
    return { ok: true, raw_file: cand.local_file, raw_offset: 0, raw_kind: 'local', src_w: pr.width, src_h: pr.height, via: 'local' };
  }
  if (!cand.url) return { ok: false, error: 'na url na local_file' };

  // --- BANK FIRST: poori source pehle se aayi hui hai to usi se cut hoga (koi download nahi)
  const bank = bankPath(id, cand.source_id);
  if (opts.useBank !== false) {
    let pr = fs.existsSync(bank) ? U.probe(bank) : { ok: false };
    if (!pr.ok && opts.acquireBank) {
      const got = acquireFullSource(id, cfg, cand, opts.meta, opts.spec);
      if (got.ok) pr = { ok: true, width: got.width, height: got.height, duration: got.duration };
      else if (opts.bankOnly) return { ok: false, error: got.error };
    }
    if (pr.ok) {
      if (cand.cut && cand.cut.start >= pr.duration) return { ok: false, error: `requested start ${cand.cut.start}s beyond source ${Math.round(pr.duration)}s` };
      return { ok: true, raw_file: path.relative(U.jobDir(id), bank), raw_offset: 0, raw_kind: 'job', src_w: pr.width, src_h: pr.height, via: 'source-bank' };
    }
  }

  const clip = cfg.clip, guard = clip.downloadGuardSeconds || 3, minH = cfg.qa.minHeight || 480;
  const segStart = Math.max(0, cand.cut.start - guard);
  const segEnd = cand.cut.end + guard;
  const rawDir = U.ensureDir(U.p(id, 'cache', '_raw'));
  const rawFile = path.join(rawDir, rangeKey(cand.source_id, segStart, segEnd, minH));
  const manFile = rawFile + '.json';
  const relRaw = path.relative(U.jobDir(id), rawFile);

  // reuse only if cached file probes ok AND manifest matches request
  if (fs.existsSync(rawFile) && fs.existsSync(manFile)) {
    try {
      const man = JSON.parse(fs.readFileSync(manFile, 'utf8'));
      const pr = U.probe(rawFile);
      if (pr.ok && Math.abs(man.segStart - segStart) < 0.005 && Math.abs(man.segEnd - segEnd) < 0.005 && man.url === cand.url) {
        return { ok: true, raw_file: relRaw, raw_offset: segStart, raw_kind: 'job', src_w: pr.width, src_h: pr.height, via: 'cache' };
      }
    } catch {}
  }

  // cacheOnly: sirf pata karna tha ki cache hai ya nahi (network bilkul nahi)
  if (opts.cacheOnly) return { ok: false, error: 'not cached', cacheMiss: true };

  // stale/mismatch cache file hata do warna yt-dlp "already downloaded" bol ke purane bytes rakh sakta hai
  try { if (fs.existsSync(rawFile)) fs.rmSync(rawFile, { force: true }); if (fs.existsSync(manFile)) fs.rmSync(manFile, { force: true }); } catch {}
  const fmt = `bv*[height>=${minH}][ext=mp4]/bv*[ext=mp4]/bv*/b[height>=${minH}]/b`;
  // `--force-keyframes-at-cuts` HATA diya gaya hai. Wo yt-dlp ko cut points par
  // keyframe banane ke liye poori stream RE-ENCODE karwata hai — 22-minute
  // YouTube episode par ye 300s timeout mein khatam hi nahi hota. Asli preview
  // mein 5/6 moments isi wajah se ETIMEDOUT hue the.
  // Iski zaroorat bhi nahi thi: frame-accuracy cut.js deta hai, jo range ke
  // andar `-ss/-t` ke saath dobara encode karta hai. Range ko bas thoda pad
  // chahiye (wo pehle se hai), keyframe-perfect hona zaroori nahi.
  const args = ['-f', fmt, '--download-sections', `*${segStart.toFixed(3)}-${segEnd.toFixed(3)}`,
    '--merge-output-format', 'mp4', ...U.ytRuntimeArgs(cfg),
    '-o', rawFile, '--no-playlist', '--no-warnings', cand.url];
  const r = U.ytdlp(args, { timeout: (cfg.download && cfg.download.timeoutMs) || 300000 });
  if (!r.ok || !fs.existsSync(rawFile)) {
    const err = (r.stderr || 'download fail').replace(/\s+/g, ' ').slice(0, 200);
    const flag = /403|forbidden|sign in|po.?token|not available|unavailable|requested format/i.test(err) ? '[403/unavailable] ' : '';
    try { if (fs.existsSync(rawFile)) fs.rmSync(rawFile, { force: true }); } catch {}
    // RANGE FAIL -> POORI SOURCE SE RECOVERY.
    // Asli run: usi source ka range 2x300s par ETIMEDOUT hua, jabki poora
    // episode 11.8s mein aa gaya. Range fail hone par source ko haar maan kar
    // chhodna bewakoofi hai — ek baar poora laakar dekh lo (cap ke andar).
    if (opts.noFullRecovery !== true) {
      U.log(`     range fail — poori source se recovery try kar raha hoon (${cand.source_id})`);
      const rec = acquireFullSource(id, cfg, { ...cand, manyUses: true }, opts.meta, opts.spec);
      if (rec.ok) {
        if (cand.cut && cand.cut.start >= rec.duration) return { ok: false, error: `requested start ${cand.cut.start}s beyond source ${Math.round(rec.duration)}s` };
        return { ok: true, raw_file: path.relative(U.jobDir(id), bank), raw_offset: 0, raw_kind: 'job',
                 src_w: rec.width, src_h: rec.height, via: 'full-source-recovery' };
      }
      return { ok: false, error: `${flag}${err} | full-source recovery bhi fail: ${String(rec.error).slice(0, 90)}` };
    }
    return { ok: false, error: flag + err };
  }
  // STRICT: empty/streamless/short download ko kabhi READY mat bolo (M1.3 ka 262-byte bug)
  const pr = U.probe(rawFile);
  if (!pr.ok) {
    try { fs.rmSync(rawFile, { force: true }); if (fs.existsSync(manFile)) fs.rmSync(manFile, { force: true }); } catch {}
    return { ok: false, error: `invalid media: ${pr.error} (quarantined, retry/alternate)`, invalidMedia: true };
  }
  // requested range actually mila? (guard ke saath segment length ~ expected)
  const wantLen = Math.max(0.5, (cand.cut ? cand.cut.dur || (cand.cut.end - cand.cut.start) : 1));
  if (pr.duration + 0.75 < wantLen) {
    try { fs.rmSync(rawFile, { force: true }); } catch {}
    return { ok: false, error: `range short: got ${pr.duration.toFixed(2)}s, need ${wantLen.toFixed(2)}s`, invalidMedia: true };
  }
  fs.writeFileSync(manFile, JSON.stringify({ segStart, segEnd, url: cand.url, minH, at: Date.now(), duration: pr.duration, w: pr.width, h: pr.height }));
  return { ok: true, raw_file: relRaw, raw_offset: segStart, raw_kind: 'job', src_w: pr.width, src_h: pr.height, via: 'yt-dlp' };
}

// entry ko candidate se promote (chosen fields set)
function promote(e, cand, ci, res) {
  Object.assign(e, {
    source_id: cand.source_id, source_kind: cand.source_kind, url: cand.url || null, local_file: cand.local_file || null,
    locator_type: cand.locator_type, decision: cand.decision, score: cand.score, recall: cand.recall,
    reason: (ci > 0 ? `[alternate #${ci + 1}] ` : '') + cand.reason, matched: cand.matched || null, cut: cand.cut,
    candidate_index: ci, raw_file: res.raw_file, raw_offset: res.raw_offset, raw_kind: res.raw_kind,
    src_w: res.src_w || null, src_h: res.src_h || null,
  });
}

const candList = e => (e.candidates && e.candidates.length ? e.candidates
  : [{ source_id: e.source_id, url: e.url, local_file: e.local_file, cut: e.cut, locator_type: e.locator_type, decision: e.decision, score: e.score, recall: e.recall, reason: e.reason, matched: e.matched, source_kind: e.source_kind }]);

module.exports = function download(spec, cfg, st, resolved) {
  const id = spec.id;
  let ok = 0, fail = 0, local = 0, switched = 0, reused = 0;

  const todo = resolved.filter(e => e.kind === 'video' && (e.status === 'RESOLVED' || e.status === 'NEEDS_REVIEW'));
  const secs = t0 => ((Date.now() - t0) / 1000).toFixed(1);

  // ---- Stage 4a: SOURCE BANK — har unique source EK BAAR (<=720p) ----
  const SRC = require('./sources.js');
  const sources = SRC.indexSources(spec.pack);
  const metaOf = sid => { const s = sources[sid]; return s ? SRC.getMeta(id, s, cfg) : null; };
  const { plan, uses } = planAcquisition(cfg, resolved, metaOf);
  // ---- LAZY: pehle dekho kaunse moments ke paas PEHLE SE valid cached range hai
  //      (M1.3 ka cache bhi isi mein aa jata hai). Jitne already cached hain,
  //      unke liye full source download karne ki zaroorat NAHI. ----
  const missingBySource = {};
  for (const e of todo) {
    for (const c of candList(e)) {
      if (!c.url) continue;
      const probeOnly = downloadCandidate(id, cfg, c, { useBank: true, acquireBank: false, cacheOnly: true });
      if (!probeOnly.ok) missingBySource[c.source_id] = (missingBySource[c.source_id] || 0) + 1;
      break;   // sirf primary candidate dekho
    }
  }
  const minMissing = (cfg.acquire && cfg.acquire.lazyMinMissing) || 2;
  // ASLI RUN SE SEEKHA: lambi source par RANGE download bharosemand nahi hai.
  // 1351s ke episode ka poora download 11.8s mein ho gaya, jabki usi source ka
  // ek range download 300s par do baar ETIMEDOUT hua. Isliye lazy-skip sirf
  // CHHOTI sources par lagta hai — lambi source ek moment ke liye bhi poori
  // laana sasta aur zyada reliable hai.
  const rangeUnsafeSec = (cfg.acquire && cfg.acquire.rangeUnsafeAboveSeconds) || 600;
  const longSource = sid => { const m = metaOf(sid); return !!(m && m.duration && m.duration > rangeUnsafeSec); };
  const wanted = Object.keys(plan).filter(sid => plan[sid]
    && ((missingBySource[sid] || 0) >= minMissing || ((missingBySource[sid] || 0) >= 1 && longSource(sid))));
  const skipped = Object.keys(plan).filter(sid => plan[sid] && !wanted.includes(sid));
  // ---- ACQUISITION PLAN LOG (network se pehle) ----
  U.log(`   acquisition plan: ${Object.keys(uses).length} unique URL source(s) | cache se mil rahe: ${Object.keys(uses).length - Object.keys(missingBySource).length} | naye full downloads: ${wanted.length}`);
  if (skipped.length) U.log(`   skip full-download (cache kaafi hai): ${skipped.join(', ')}`);
  const bankState = {};
  if (wanted.length) {
    U.log(`   source bank: ${wanted.length} unique source(s) ek-ek baar poore aayenge (<=${(cfg.acquire && cfg.acquire.maxHeight) || 720}p), phir sab clips local se katenge.`);
    let bi = 0;
    for (const sid of wanted) {
      bi++;
      const anyCand = todo.flatMap(e => candList(e)).find(c => c.source_id === sid && c.url);
      if (!anyCand) continue;
      anyCand.manyUses = (uses[sid] || 0) >= ((cfg.acquire && cfg.acquire.fullDownloadMinUses) || 2) || longSource(sid);
      const meta = metaOf(sid);
      const t0 = Date.now();
      U.log(`   [source ${bi}/${wanted.length}] ${sid} (${Math.round((meta && meta.duration) || 0)}s, ${uses[sid]} moments) downloading...`);
      const got = acquireFullSource(id, cfg, anyCand, meta, spec);
      bankState[sid] = got.ok;
      U.log(got.ok ? `   [source ${bi}/${wanted.length}] ${sid} OK via ${got.via} in ${secs(t0)}s — is source ke ${uses[sid]} clips ab bina download ke katenge`
                   : `   [source ${bi}/${wanted.length}] ${sid} FAILED in ${secs(t0)}s — ${String(got.error).slice(0, 100)} (per-moment range par gir jayenge)`);
    }
  }

  // ---- Stage 4b: CONTEXT VARIETY ----
  // Agar bahut se beats ke paas exact clip nahi hai, to unhe context video/stills
  // se bharna padta hai. Ek hi source se bharenge to wahi episode baar-baar
  // dikhega. Isliye USI SCOPE ke kuch aur approved sources bhi laate hain
  // (ek source ~10-20s mein aa jata hai) — sirf variety ke liye.
  // BUG THA: `!e.clip` yahan hamesha true hota hai kyunki cut abhi CHALA HI NAHI
  // hai (clips agle stage mein bante hain). Isliye har fresh project mein ye
  // block trigger ho jata tha aur bina zaroorat ke poore episodes download hote
  // the. Ab sirf wo beats ginte hain jinke paas koi viable video candidate hai
  // hi nahi — yaani jinhe sach mein context/fallback chahiye hoga.
  const noClipCount = resolved.filter(e => e.kind !== 'video' || e.status === 'NEEDS_SOURCE'
    || !(e.candidates && e.candidates.length)).length;
  const maxCtx = (cfg.acquire && cfg.acquire.maxContextSources) || 4;
  if (noClipCount >= ((cfg.acquire && cfg.acquire.contextVarietyMinBeats) || 3)) {
    // kaunse sources allowed scope mein hain aur abhi tak nahi aaye?
    const allowedAll = new Set();
    for (const e of resolved) for (const sid of (e.allowed_source_ids || [])) allowedAll.add(sid);
    const have = new Set(Object.keys(bankState).filter(k => bankState[k]));
    for (const e of todo) if (e.raw_file) have.add(e.source_id);
    const extra = [...allowedAll].filter(sid => !have.has(sid) && sources[sid] && sources[sid].url).slice(0, Math.max(0, maxCtx - have.size));
    if (extra.length) {
      U.log(`   context variety: ${noClipCount} beats ke paas exact clip nahi — ${extra.length} aur same-scope source la raha hoon (taaki ek hi episode baar-baar na dikhe)`);
      for (const sid of extra) {
        const meta2 = metaOf(sid);
        const t0 = Date.now();
        const got = acquireFullSource(id, cfg, { source_id: sid, url: sources[sid].url }, meta2, spec);
        bankState[sid] = got.ok;
        U.log(`   [variety] ${sid} ${got.ok ? 'OK via ' + got.via : 'FAILED — ' + String(got.error).slice(0, 70)} in ${secs(t0)}s`);
      }
    }
  }

  U.log(`   ${todo.length} video moments — ab cut ke liye media taiyaar ho raha hai.`);
  U.log(`   note: ek yt-dlp attempt zyada se zyada ${Math.round((cfg.download && cfg.download.timeoutMs || 300000) / 1000)}s tak chup reh sakta hai — ye normal hai, hang nahi.`);

  let n = 0;
  for (const e of todo) {
    n++;
    const label = `[download ${n}/${todo.length}] ${e.moment_id} | source ${e.source_id || '-'}`;

    // resume: pehle se valid raw hai to skip
    const t0 = Date.now();
    const existing = resolveRaw(id, e);
    if (existing && fs.existsSync(existing) && U.probe(existing).ok) {
      e.download = { ok: true, via: 'resume-cache' }; ok++; reused++;
      U.log(`${label} | RESUME-CACHE (pehle se maujood, dobara download nahi) ${secs(t0)}s`);
      continue;
    }

    const cands = candList(e);
    U.log(`${label} | starting (${cands.length} candidate${cands.length > 1 ? 's' : ''})`);
    const dlAttempts = [];
    let done = false;
    for (let ci = 0; ci < cands.length; ci++) {
      const t1 = Date.now();
      const dead = sourceDeadReason(cands[ci].source_id);
      if (dead) {
        // is source ko is run mein pehle hi kharab paya ja chuka hai — dobara
        // 3 minute uspar kharch karna bekaar hai.
        U.log(`     skip ${cands[ci].source_id} — is run mein pehle hi fail ho chuka (${dead})`);
        dlAttempts.push({ candidate: ci, source_id: cands[ci].source_id, error: `skipped: ${dead}` });
        continue;
      }
      U.log(`     attempt ${ci + 1}/${cands.length} ${cands[ci].source_id}${cands[ci].url ? ' (yt-dlp range)' : ' (local file)'} ...`);
      const res = downloadCandidate(id, cfg, cands[ci], { spec });
      if (res.ok) {
        if (ci > 0) switched++;
        promote(e, cands[ci], ci, res);
        e.download = { ok: true, via: res.via, candidate: ci, attempts: dlAttempts };
        if (res.via === 'local') local++;
        const tag = res.via === 'cache' ? 'RANGE-CACHE (pehle se download, reuse)' : (ci > 0 ? `ALTERNATE ok via ${res.via}` : `READY via ${res.via}`);
        U.log(`     ${tag} in ${secs(t1)}s`);
        ok++; done = true; break;
      }
      dlAttempts.push({ candidate: ci, source_id: cands[ci].source_id, error: res.error });
      U.log(`     FAILED in ${secs(t1)}s — ${String(res.error).slice(0, 110)}`);
      if (isFatalSourceError(res.error)) {
        markSourceDead(cands[ci].source_id, res.error);
        U.log(`     -> ${cands[ci].source_id} is run ke liye band (ye source ki hi kharabi hai, timestamp ki nahi)`);
      }
      const more = cands.slice(ci + 1).some(c => !sourceDeadReason(c.source_id));
      if (more) U.log(`     -> agla alternate candidate try kar rahe hain`);
    }
    if (!done) {
      e.status = 'NEEDS_SOURCE';
      e.reason = `all ${cands.length} candidate(s) failed: ` + dlAttempts.map(a => `${a.source_id}:${a.error}`).join(' | ');
      e.download = { ok: false, attempts: dlAttempts };
      fail++;
      U.log(`${label} | NEEDS_SOURCE (saare candidates fail — random footage NAHI lagayi jayegi)`);
    }
  }

  U.ok(`download: ${ok} ready (${local} local, ${switched} via alternate, ${reused} resume-cache), ${fail} failed -> NEEDS_SOURCE`);
  st.meta.download = { ok, local, switched, reused, fail };
  return resolved;
};

module.exports.downloadCandidate = downloadCandidate;
module.exports.resolveRaw = resolveRaw;
module.exports.promote = promote;
module.exports.candList = candList;
module.exports.rangeKey = rangeKey;
module.exports.bankPath = bankPath;
module.exports.acquireFullSource = acquireFullSource;
module.exports.planAcquisition = planAcquisition;
module.exports.isFatalSourceError = isFatalSourceError;
module.exports.sourceDeadReason = sourceDeadReason;
