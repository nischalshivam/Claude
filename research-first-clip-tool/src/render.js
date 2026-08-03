// ============================================================
//  Stage 8 — RENDER.
//  Har slot ko exact slot.dur par canvas (WxH,FPS) segment banao:
//    video       -> clip; chhota ho to aakhri frame freeze karke fill
//    text/graphic-> colored card + drawtext (narration/fallback text)
//    needs_source-> "NEEDS SOURCE" card (saaf dikhe kahan fix karna hai)
//  Sab segments concat -> master voiceover mux (source audio muted, VO
//  continuous, video length = audio length via -shortest).
// ============================================================
const fs = require('fs');
const path = require('path');
const U = require('./util.js');

const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
  'C:\\Windows\\Fonts\\arial.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
];
function findFont(cfg) {
  const c = cfg.render && cfg.render.fontFile;
  if (c && fs.existsSync(c)) return c;
  for (const f of FONT_CANDIDATES) if (fs.existsSync(f)) return f;
  return null;
}
// kuch (static) ffmpeg builds mein drawtext compiled nahi hota — ek baar check.
let _drawtext = null;
function hasDrawtext() {
  if (_drawtext !== null) return _drawtext;
  const r = U.run(U.tool('ffmpeg'), ['-hide_banner', '-filters']);
  _drawtext = !!(r.ok && /\bdrawtext\b/.test(r.stdout || ''));
  return _drawtext;
}
function wrap(text, width = 42) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ');
  const lines = []; let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) { if (line) lines.push(line); line = w; }
    else line = (line ? line + ' ' : '') + w;
  }
  if (line) lines.push(line);
  return lines.slice(0, 12).join('\n');
}
// ffmpeg drawtext fontfile path (Windows backslash + colon escape)
const escFont = p => p.replace(/\\/g, '/').replace(/:/g, '\\:');

const CARD_BG = { text: '0x1a1a1a', graphic: '0x102a43', needs_source: '0x4a1010', needs_review: '0x3a2b08' };

// Slot ka asset path job-relative bhi ho sakta hai (clips/, cache/) aur
// ROOT-relative ya absolute bhi (local_file wale sources). Ek hi jagah resolve
// karo, warna ek valid local source "missing" lagta hai aur shot chupchap card
// ban jata hai. Milta nahi to null — caller ko pata chalna chahiye.
function resolveAsset(id, p) {
  if (!p) return null;
  const tries = path.isAbsolute(p) ? [p] : [U.p(id, p), path.join(U.ROOT, p), path.resolve(p)];
  for (const t of tries) { try { if (fs.existsSync(t) && fs.statSync(t).size > 0) return t; } catch {} }
  return null;
}

// solid card (fail-safe) — exact duration, taaki timeline drift na ho
function renderSolid(cfg, seg, dur, bg) {
  const W = cfg.canvas.width, H = cfg.canvas.height, FPS = cfg.canvas.fps;
  return U.ffmpeg(['-f', 'lavfi', '-i', `color=c=${bg}:s=${W}x${H}:r=${FPS}:d=${dur.toFixed(3)}`,
    '-t', dur.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(cfg.render.crf || 21),
    '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', seg]);
}

// DRAFT ka numbered placeholder. Ye dekhne wale ko turant batata hai:
// kaunsa gap hai (MISSING 003), video mein kahan hai, aur kya bola ja raha hai.
// Laal rang jaan-boojh kar — ye kabhi final video jaisa nahi dikhna chahiye.
function renderPlaceholder(cfg, seg, dur, tag, s, font, drawtextOK, W, H, FPS) {
  const at = t => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  const lines = [tag, `${at(s.start)} - ${at(s.end)}  (${dur.toFixed(1)}s)`,
    s.moment_id ? `beat: ${s.moment_id}` : '', '',
    String(s.cue || '').replace(/\s+/g, ' ').slice(0, 160), '',
    'is jagah ke liye media DATA folder mein daalo'].filter(x => x !== null);
  const args = ['-f', 'lavfi', '-i', `color=c=0x3B1113:s=${W}x${H}:r=${FPS}:d=${dur.toFixed(3)}`];
  if (font && drawtextOK) {
    const txtFile = seg + '.txt';
    fs.writeFileSync(txtFile, lines.join('\n'));
    args.push('-vf', `drawtext=fontfile='${escFont(font)}':textfile='${escFont(txtFile)}':fontcolor=0xFFC9C9:fontsize=40:line_spacing=16:x=(w-text_w)/2:y=(h-text_h)/2`);
  }
  args.push('-t', dur.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(cfg.render.crf || 21),
    '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', seg);
  return U.ffmpeg(args, { timeout: 120000 });
}

module.exports = function render(spec, cfg, st, tl) {
  const id = spec.id;
  const W = cfg.canvas.width, H = cfg.canvas.height, FPS = cfg.canvas.fps;
  const segDir = U.ensureDir(U.p(id, 'segments'));
  const font = findFont(cfg);
  const drawtextOK = hasDrawtext();
  if (!font) U.warn('koi TTF font nahi mila — text cards bina text ke (solid color) banenge. config.render.fontFile set karo.');
  else if (!drawtextOK) U.warn('is ffmpeg build mein drawtext filter nahi — text cards solid-color (text report mein hai). Windows ffmpeg mein text aayega.');

  // DRAFT vs PRODUCTION (M4).
  //  production : ek bhi missing asset par export rukta hai. Final video mein
  //               kabhi placeholder nahi aa sakta — ye rule waisa ka waisa hai.
  //  draft      : poori timeline banti hai, aur jahan media nahi hai wahan ek
  //               SAAF-SAAF numbered "MISSING NNN" placeholder lagta hai.
  //  Kyun: asli run mein mid/weak preview download, cut aur QA sab paar kar gaye,
  //  phir ek missing graphic par poora render ruk gaya — yaani jis cheez ko dekhne
  //  ke liye preview chalaya tha, wahi kabhi dikhi hi nahi. Diagnostic preview ka
  //  kaam kami DIKHANA hai, uspar rukna nahi.
  const mode = (cfg.output && cfg.output.mode) || 'production';
  const production = mode !== 'review' && mode !== 'draft';
  let missingNo = 0;
  const missingSlots = [];
  const manifest = [];
  const listLines = [];
  let n = 0, failed = 0;
  for (const s of tl.slots) {
    const seg = path.join(segDir, `seg_${String(s.i).padStart(4, '0')}.mp4`);
    const dur = Math.max(0.3, s.dur);
    let r;
    // ---- P0: har planned asset PEHLE ek absolute path par resolve hota hai ----
    // Pehle har branch ki condition mein fs.existsSync tha. File na mile to
    // execution agli branch mein chala jata tha aur aakhir mein generic TEXT CARD
    // ban jata tha — par manifest wahi purana label (EXACT_VIDEO/CONTEXT_VIDEO)
    // rakhta tha. Yaani screen par card, report mein "media-backed". Ab kind par
    // switch hota hai; media na mile to verified-fallback state machine chalti
    // hai, doosra semantic renderer kabhi nahi.
    const videoAbs = resolveAsset(id, s.video);
    const mediaAbs = resolveAsset(id, s.media_file);
    const imageAbs = resolveAsset(id, s.image);
    const imagesAbs = (Array.isArray(s.images) ? s.images : []).map(f => resolveAsset(id, f)).filter(Boolean);
    let missingReason = null;
    const PLANNED_MEDIA = { video: 'video', context_video: 'media_file', still: 'image', montage: 'images', graphic: 'image' };
    if (PLANNED_MEDIA[s.kind]) {
      const have = s.kind === 'video' ? videoAbs : s.kind === 'context_video' ? mediaAbs
        : s.kind === 'montage' ? (imagesAbs.length >= 2 ? imagesAbs : null) : imageAbs;
      if (!have) missingReason = `planned ${s.kind} asset (${PLANNED_MEDIA[s.kind]}) nahi mila: ${s.video || s.media_file || s.image || (s.images || []).join(',') || '(none)'}`;
    }
    if (missingReason) {
      r = null;                                  // fallback state machine neeche chalegi
    } else if (s.kind === 'video') {
      // M2: shot planner guarantee karta hai ki video slot clip se lamba na ho,
      // isliye ab koi infinite `tpad` clone (= 7-14s frozen frame) nahi chahiye.
      // Bas bahut chhota shortfall ho to bounded hold (<= maxFreezeSeconds).
      const clipDur = (s.clip_dur || U.probe(videoAbs).duration) || dur;
      const maxFreeze = (cfg.shots && cfg.shots.maxFreezeSeconds != null) ? cfg.shots.maxFreezeSeconds : 0.5;
      let vf = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1`;
      const shortfall = dur - clipDur;
      if (shortfall > 0.02) vf += `,tpad=stop_mode=clone:stop_duration=${Math.min(maxFreeze, shortfall).toFixed(2)}`;
      r = U.ffmpeg(['-i', videoAbs, '-vf', vf, '-t', dur.toFixed(3),
        '-c:v', 'libx264', '-preset', cfg.render.preset || 'veryfast', '-crf', String(cfg.render.crf || 21),
        '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', seg], { timeout: 300000 });
    } else if (s.kind === 'context_video') {
      // CONTEXT VIDEO: already-downloaded approved source se chalta hua tukda
      // (exact scene ka daawa nahi — report mein CONTEXT_VIDEO). Still se behtar,
      // aur koi naya download nahi.
      r = U.ffmpeg(['-ss', String(s.media_start || 0), '-i', mediaAbs, '-t', dur.toFixed(3), '-an',
        '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1`,
        '-c:v', 'libx264', '-preset', cfg.render.preset || 'veryfast', '-crf', String(cfg.render.crf || 21),
        '-pix_fmt', 'yuv420p', '-r', String(FPS), seg], { timeout: 300000 });
    } else if (s.kind === 'still') {
      // STILL: Ken Burns (slow zoom/pan) + blurred background fill — dead card nahi
      // Ken Burns = fixed-size crop jo upscaled image par PAN karta hai.
      // (zoompan bahut mehnga tha: ~12s/still; ye ~3s/still deta hai aur dims
      //  hamesha even/valid rehte hain.) Har still ka rukh alag — variety.
      const z = Math.max(0.06, cfg.render.kenBurnsZoom || 0.1);
      const SW = Math.round(W * (1 + z) / 2) * 2, SH = Math.round(H * (1 + z) / 2) * 2;
      const dx = SW - W, dy = SH - H;
      const D = dur.toFixed(3);
      const moves = [
        `x='${dx}*(t/${D})':y='${dy}/2'`,                    // left -> right
        `x='${dx}*(1-t/${D})':y='${dy}/2'`,                  // right -> left
        `x='${dx}/2':y='${dy}*(t/${D})'`,                    // top -> bottom
        `x='${dx}/2':y='${dy}*(1-t/${D})'`,                  // bottom -> top
      ];
      const mv = moves[s.i % moves.length];
      const vf = `scale=${SW}:${SH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}:${mv},fps=${FPS},setsar=1`;
      r = U.ffmpeg(['-loop', '1', '-framerate', String(FPS), '-i', imageAbs, '-t', dur.toFixed(3), '-vf', vf,
        '-c:v', 'libx264', '-preset', cfg.render.preset || 'veryfast', '-crf', String(cfg.render.crf || 21),
        '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', seg], { timeout: 180000 });
      if (!r.ok) {   // zoompan fail -> simple static fit (still better than card)
        r = U.ffmpeg(['-loop', '1', '-i', imageAbs, '-t', dur.toFixed(3),
          '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(cfg.render.crf || 21), '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', seg]);
      }
    } else {
      // ---- MONTAGE: 2-3 verified frames ek shot mein (crossfade) ----
      if (s.kind === 'montage') {
        const imgs = imagesAbs.slice(0, 3);
        if (imgs.length >= 2) {
          const per = dur / imgs.length;
          const args = [];
          imgs.forEach(f => args.push('-loop', '1', '-framerate', String(FPS), '-t', (per + 0.6).toFixed(3), '-i', f));
          const parts = imgs.map((_, k) => `[${k}:v]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},fps=${FPS},setsar=1[v${k}]`);
          let chain = parts.join(';') + ';';
          if (imgs.length === 2) chain += `[v0][v1]xfade=transition=fade:duration=0.5:offset=${(per - 0.25).toFixed(3)}[vo]`;
          else chain += `[v0][v1]xfade=transition=fade:duration=0.4:offset=${(per - 0.2).toFixed(3)}[a01];[a01][v2]xfade=transition=fade:duration=0.4:offset=${(per * 2 - 0.4).toFixed(3)}[vo]`;
          args.push('-filter_complex', chain, '-map', '[vo]', '-t', dur.toFixed(3),
            '-c:v', 'libx264', '-preset', cfg.render.preset || 'veryfast', '-crf', String(cfg.render.crf || 21),
            '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', seg);
          r = U.ffmpeg(args, { timeout: 180000 });
        }
        if (!r || !r.ok) {   // montage fail -> pehli image ka simple still (still real media)
          r = U.ffmpeg(['-loop', '1', '-framerate', String(FPS), '-i', imgs[0] || imagesAbs[0], '-t', dur.toFixed(3),
            '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},fps=${FPS},setsar=1`,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(cfg.render.crf || 21), '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', seg]);
        }
      } else if (s.kind === 'graphic') {
        // ---- MEDIA-BACKED GRAPHIC: asli frame + dim + accent + text ----
        const filters = [
          `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos`, `crop=${W}:${H}`,
          `eq=brightness=-0.18:saturation=0.75`,                      // dim taaki text padha jaye
          `drawbox=x=0:y=0:w=${W}:h=${H}:color=0x0a0d18@0.45:t=fill`,
          `drawbox=x=140:y=(ih-380)/2:w=8:h=380:color=0x4f8cff@0.95:t=fill`,
        ];
        if (font && drawtextOK) {
          const txtFile = path.join(segDir, `txt_${s.i}.txt`);
          fs.writeFileSync(txtFile, wrap(s.text || s.cue || '', 32));
          filters.push(`drawtext=fontfile='${escFont(font)}':textfile='${escFont(txtFile)}':fontcolor=0xffffff:fontsize=56:line_spacing=22:shadowcolor=0x000000@0.8:shadowx=2:shadowy=2:x=190:y=(h-text_h)/2`);
        }
        filters.push(`fps=${FPS}`, 'setsar=1');
        r = U.ffmpeg(['-loop', '1', '-framerate', String(FPS), '-i', imageAbs, '-t', dur.toFixed(3),
          '-vf', filters.join(','), '-c:v', 'libx264', '-preset', cfg.render.preset || 'veryfast',
          '-crf', String(cfg.render.crf || 21), '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', seg], { timeout: 180000 });
      } else {
      // ---- GRAPHIC / CARD ----
      const isDiag = ['needs_source', 'needs_review'].includes(s.kind);
      const label = (s.label === 'NEEDS SOURCE' || s.label === 'NEEDS REVIEW') ? s.label : '';
      const body = wrap(s.text || s.cue || '', 34);
      if (!isDiag) {
        // DESIGNED editorial graphic: dark gradient + accent bar + big type
        // (M1.3 ka flat blue paragraph card nahi)
        const grad = `gradients=s=${W}x${H}:c0=0x141a2e:c1=0x0a0d18:x0=0:y0=0:x1=${W}:y1=${H}:n=2:d=${dur.toFixed(3)}:r=${FPS}`;
        const args = ['-f', 'lavfi', '-i', grad];
        const filters = [`drawbox=x=140:y=(ih-360)/2:w=8:h=360:color=0x4f8cff@0.95:t=fill`];
        if (font && drawtextOK) {
          const txtFile = path.join(segDir, `txt_${s.i}.txt`);
          fs.writeFileSync(txtFile, body);
          filters.push(`drawtext=fontfile='${escFont(font)}':textfile='${escFont(txtFile)}':fontcolor=0xf2f5ff:fontsize=54:line_spacing=20:x=190:y=(h-text_h)/2`);
        }
        args.push('-vf', filters.join(','), '-t', dur.toFixed(3), '-c:v', 'libx264', '-preset', cfg.render.preset || 'veryfast',
          '-crf', String(cfg.render.crf || 21), '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', seg);
        r = U.ffmpeg(args, { timeout: 120000 });
        if (!r.ok) {   // gradients filter na ho to solid par wahi layout
          const a2 = ['-f', 'lavfi', '-i', `color=c=0x141a2e:s=${W}x${H}:r=${FPS}:d=${dur.toFixed(3)}`, '-vf', filters.join(','),
            '-t', dur.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(cfg.render.crf || 21), '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', seg];
          r = U.ffmpeg(a2, { timeout: 120000 });
        }
      } else {
        // review/debug mode ka diagnostic card (production mein aata hi nahi)
        const bg = CARD_BG[s.kind] || CARD_BG.text;
        const txt = (label ? label + '\n\n' : '') + body;
        const args = ['-f', 'lavfi', '-i', `color=c=${bg}:s=${W}x${H}:r=${FPS}:d=${dur.toFixed(3)}`];
        if (font && drawtextOK) {
          const txtFile = path.join(segDir, `txt_${s.i}.txt`);
          fs.writeFileSync(txtFile, txt);
          args.push('-vf', `drawtext=fontfile='${escFont(font)}':textfile='${escFont(txtFile)}':fontcolor=white:fontsize=44:line_spacing=14:x=(w-text_w)/2:y=(h-text_h)/2`);
        }
        args.push('-t', dur.toFixed(3), '-c:v', 'libx264', '-preset', cfg.render.preset || 'veryfast',
          '-crf', String(cfg.render.crf || 21), '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', seg);
        r = U.ffmpeg(args, { timeout: 120000 });
      }
      }
    }
    // ---- label WAHI jo sach mein bana ----
    // Planned label sirf tab chalta hai jab us kind ka planned media sach mein
    // render hua. Generic text graphic sirf usi slot par jo GENERIC plan hua tha.
    const PLANNED_ASSET = { video: 'EXACT_VIDEO', context_video: 'CONTEXT_VIDEO', still: 'VERIFIED_SOURCE_STILL',
      montage: 'MONTAGE', graphic: 'TEMPLATE_GRAPHIC_MEDIA' };
    // USER KA MEDIA ALAG GINA JATA HAI. Ye kabhi "automatically researched exact
    // clip" nahi bolna chahiye — wo jhooth report ko meaningless bana deta hai
    // aur automation ki asli kaamyabi bhi chhupa deta hai.
    const USER_ASSET = { video: 'USER_VIDEO', context_video: 'USER_VIDEO', still: 'USER_IMAGE', montage: 'USER_MONTAGE' };
    let assetUsed = s.manual ? (USER_ASSET[s.kind] || 'USER_IMAGE')
      : (PLANNED_MEDIA[s.kind] ? PLANNED_ASSET[s.kind]
        : (['needs_source', 'needs_review'].includes(s.kind) ? 'DIAGNOSTIC_CARD' : 'GENERIC_TEXT_GRAPHIC'));
    let assetNote = null;
    if (missingReason || !r || !r.ok || !fs.existsSync(seg)) {
      // VERIFIED FALLBACK STATE MACHINE — kabhi chupchap doosre renderer mein nahi.
      const why = missingReason || `ffmpeg fail: ${((r && r.stderr) || '').slice(0, 90)}`;
      U.warn(`seg ${s.i} (${s.kind}) — ${why}`);
      let retried = null;
      const stillFrom = imageAbs || imagesAbs[0] || resolveAsset(id, s.fallback_image);
      if (stillFrom) {
        retried = U.ffmpeg(['-loop', '1', '-framerate', String(FPS), '-i', stillFrom, '-t', dur.toFixed(3),
          '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(cfg.render.crf || 21), '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', seg]);
        if (retried.ok) { assetUsed = 'VERIFIED_SOURCE_STILL'; assetNote = `fallback still (${why})`; }
      }
      if ((!retried || !retried.ok) && videoAbs) {
        retried = U.ffmpeg(['-i', videoAbs, '-t', dur.toFixed(3),
          '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(cfg.render.crf || 21), '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', seg]);
        if (retried.ok) { assetUsed = 'EXACT_VIDEO'; assetNote = `fallback exact clip (${why})`; }
      }
      if ((!retried || !retried.ok) && mediaAbs) {
        retried = U.ffmpeg(['-ss', String(s.media_start || 0), '-i', mediaAbs, '-t', dur.toFixed(3), '-an',
          '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(cfg.render.crf || 21), '-pix_fmt', 'yuv420p', '-r', String(FPS), seg]);
        if (retried.ok) { assetUsed = 'CONTEXT_VIDEO'; assetNote = `fallback context (${why})`; }
      }
      if (!retried || !retried.ok || !fs.existsSync(seg)) {
        // Production mein CHHUPANA nahi — export rok do.
        if (production) throw new Error(`shot ${s.i} (${s.kind}, ${s.start}-${s.end}s): ${why}. Koi verified alternate bhi nahi mila. ` +
          `Production export rok raha hoon (pehle ye chupchap text card ban jata tha aur report media-backed bolti thi). NEEDS_SOURCE.csv dekho.`);
        // DRAFT: rukna nahi — ek saaf-saaf gina hua placeholder lagao aur aage badho.
        // Ye placeholder chhupata nahi, chillata hai: number, waqt, aur narration.
        missingNo++;
        const tag = `MISSING ${String(missingNo).padStart(3, '0')}`;
        const fb = renderPlaceholder(cfg, seg, dur, tag, s, font, drawtextOK, W, H, FPS);
        if (!fb.ok || !fs.existsSync(seg)) throw new Error(`seg ${s.i} placeholder bhi fail`);
        assetUsed = 'MISSING_PLACEHOLDER'; assetNote = why;
        missingSlots.push({ tag, i: s.i, start: s.start, end: s.end, moment_id: s.moment_id || null,
          pack_id: s.pack_id || null, cue: s.cue || null, why });
      }
      failed++;
    }
    manifest.push({ i: s.i, start: s.start, end: s.end, dur, kind: s.kind, asset: assetUsed, asset_note: assetNote,
      moment_id: s.moment_id || null, pack_id: s.pack_id || null,
      source_id: s.source_id || s.image_source || null, url: s.url || null,
      planned_source_id: s.planned_source_id || null, actual_source_id: s.actual_source_id || s.image_source || s.source_id || null,
      scope_relation: s.scope_relation || null, criticality: s.criticality || 'NORMAL',
      image: s.image || null, images: s.images || null, image_time: s.image_time != null ? s.image_time : null,
      // hint provenance: kya maanga gaya, kya mila, kitna farq (audit ke liye)
      hint_time: s.hint_time != null ? s.hint_time : null, hint_delta: s.hint_delta != null ? s.hint_delta : null,
      hint_times: s.hint_times || null, hint_deltas: s.hint_deltas || null,
      must_show: s.must_show || [], must_not_show: s.must_not_show || [], cue: s.cue || null,
      video: s.video || null, media_file: s.media_file || null, media_start: s.media_start != null ? s.media_start : null,
      why: s.why || s.reason || null, template: s.template || null, reused: !!s.reused });
    listLines.push(`file '${seg.replace(/'/g, "'\\''")}'`);
    n++;
  }
  if (!n) throw new Error('koi segment render nahi hua');

  // concat
  const listFile = U.p(id, 'segments', 'list.txt');
  fs.writeFileSync(listFile, listLines.join('\n'));
  const master = U.p(id, 'video_master.mp4');
  let c = U.ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', master]);
  if (!c.ok || !fs.existsSync(master)) {
    // fallback: re-encode concat
    c = U.ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c:v', 'libx264', '-preset', 'veryfast',
      '-crf', String(cfg.render.crf || 21), '-pix_fmt', 'yuv420p', '-r', String(FPS), master]);
    if (!c.ok) throw new Error('concat fail: ' + (c.stderr || '').slice(0, 150));
  }

  // master voiceover mux
  //  DRAFT ka output ka naam ALAG hai. draft.mp4 mein placeholder ho sakte hain;
  //  final.mp4 ka matlab hi ye hai ki usme koi khaali jagah nahi bachi.
  //  Dono ko ek hi naam dena sabse aasan tareeka hota adhoori video ko final
  //  samajh lene ka — isliye naam alag hai.
  const outName = mode === 'draft' ? 'draft.mp4' : 'final.mp4';
  const finalOut = U.p(id, outName);
  const audio = spec.audio;
  const vdur = U.probe(master).duration || tl.total;
  if (audio && fs.existsSync(audio)) {
    // ---- TIMELINE hi authoritative hai (M2.1 fix) ----
    // Purana bug: target = max(video, POORA audio). Preview mein video 122s tha
    // aur audio 837s, isliye aakhri frame ~714 SECOND tak clone ho gaya.
    // Ab: length = video/timeline. Audio ko preview offset se seek karke usi
    // length tak trim karte hain (chhota pade to silence se pad — video kabhi
    // freeze nahi hoga).
    const offset = spec.previewOffset || 0;
    const adurRaw = U.probe(audio).duration || 0;
    const audioAvail = Math.max(0, adurRaw - offset);
    const target = +vdur.toFixed(3);
    // PREVIEW mein audio poori hoti hai par timeline sirf window jitni — ye
    // normal hai, galti nahi. Isliye preview par ye ek saaf INFO line hai;
    // sirf FULL run mein hi ye asli mismatch ka ishara hai.
    if (spec.isPreview) {
      U.log(`   preview: ${vdur.toFixed(1)}s window (${offset.toFixed(1)}s se) — voiceover ${adurRaw.toFixed(1)}s ka hai, usme se utna hi hissa liya gaya.`);
    } else if (!offset && adurRaw && Math.abs(adurRaw - vdur) > 1.0) {
      U.warn(`audio ${adurRaw.toFixed(1)}s vs timeline ${vdur.toFixed(1)}s — ${Math.abs(adurRaw - vdur).toFixed(1)}s ka farak. ` +
        `(SRT aur voiceover mismatch ho sakta hai; video timeline ke hisaab se banega.)`);
    }
    if (audioAvail + 0.05 < target) U.warn(`audio sirf ${audioAvail.toFixed(1)}s hai par timeline ${target.toFixed(1)}s — aakhir mein silence padega.`);
    const aoff = offset ? ['-ss', String(offset)] : [];
    const m = U.ffmpeg(['-i', master, ...aoff, '-i', audio,
      '-filter_complex', `[1:a]apad[a]`,
      '-map', '0:v:0', '-map', '[a]', '-t', target.toFixed(3),
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', finalOut]);
    if (!m.ok || !fs.existsSync(finalOut)) throw new Error('audio mux fail: ' + (m.stderr || '').slice(0, 200));
  } else if (cfg.render.allowSilent) {
    U.warn('voiceover audio nahi — allowSilent=true, silent video (test-only).');
    fs.copyFileSync(master, finalOut);
  } else {
    throw new Error('voiceover audio nahi mila. Production render ke liye audio zaroori (ya config.render.allowSilent=true test ke liye).');
  }

  fs.writeFileSync(U.p(id, 'render-manifest.json'), JSON.stringify({
    total: tl.total, mode, is_draft: mode === 'draft',
    // preview mein timeline 0 se shuru hoti hai; gap planner ko ASLI audio ka
    // waqt chahiye, isliye offset yahin likh dete hain.
    preview_offset: spec.previewOffset || 0,
    missing_placeholders: missingSlots,
    shots: manifest,
  }, null, 2));
  const pr = U.probe(finalOut);
  U.ok(`render: ${outName} (${n} segments${missingNo ? ', ' + missingNo + ' MISSING placeholder' : ''}${failed && !missingNo ? ', ' + failed + ' fallback' : ''}, ${pr.ok ? pr.duration.toFixed(1) + 's' : '?'}, ${W}x${H})`);
  if (missingNo) {
    U.log(`   ${missingNo} jagah placeholder laga hai — ye draft hai, final nahi.`);
    U.log('   Har placeholder par uska number likha hai (MISSING 001, 002 ...) aur wahi');
    U.log('   number DATA folder mein bhi milega.');
  }
  st.meta.render = { segments: n, failed, missing: missingNo, duration: pr.ok ? +pr.duration.toFixed(1) : null, file: outName };
  return { file: finalOut, segments: n, duration: pr.ok ? pr.duration : null };
};
