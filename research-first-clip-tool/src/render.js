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

// solid card (fail-safe) — exact duration, taaki timeline drift na ho
function renderSolid(cfg, seg, dur, bg) {
  const W = cfg.canvas.width, H = cfg.canvas.height, FPS = cfg.canvas.fps;
  return U.ffmpeg(['-f', 'lavfi', '-i', `color=c=${bg}:s=${W}x${H}:r=${FPS}:d=${dur.toFixed(3)}`,
    '-t', dur.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(cfg.render.crf || 21),
    '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', seg]);
}

module.exports = function render(spec, cfg, st, tl) {
  const id = spec.id;
  const W = cfg.canvas.width, H = cfg.canvas.height, FPS = cfg.canvas.fps;
  const segDir = U.ensureDir(U.p(id, 'segments'));
  const font = findFont(cfg);
  const drawtextOK = hasDrawtext();
  if (!font) U.warn('koi TTF font nahi mila — text cards bina text ke (solid color) banenge. config.render.fontFile set karo.');
  else if (!drawtextOK) U.warn('is ffmpeg build mein drawtext filter nahi — text cards solid-color (text report mein hai). Windows ffmpeg mein text aayega.');

  const production = (cfg.output && cfg.output.mode) !== 'review';
  const manifest = [];
  const listLines = [];
  let n = 0, failed = 0;
  for (const s of tl.slots) {
    const seg = path.join(segDir, `seg_${String(s.i).padStart(4, '0')}.mp4`);
    const dur = Math.max(0.3, s.dur);
    let r;
    if (s.kind === 'video' && s.video && fs.existsSync(U.p(id, s.video))) {
      // M2: shot planner guarantee karta hai ki video slot clip se lamba na ho,
      // isliye ab koi infinite `tpad` clone (= 7-14s frozen frame) nahi chahiye.
      // Bas bahut chhota shortfall ho to bounded hold (<= maxFreezeSeconds).
      const clipDur = (s.clip_dur || U.probe(U.p(id, s.video)).duration) || dur;
      const maxFreeze = (cfg.shots && cfg.shots.maxFreezeSeconds != null) ? cfg.shots.maxFreezeSeconds : 0.5;
      let vf = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1`;
      const shortfall = dur - clipDur;
      if (shortfall > 0.02) vf += `,tpad=stop_mode=clone:stop_duration=${Math.min(maxFreeze, shortfall).toFixed(2)}`;
      r = U.ffmpeg(['-i', U.p(id, s.video), '-vf', vf, '-t', dur.toFixed(3),
        '-c:v', 'libx264', '-preset', cfg.render.preset || 'veryfast', '-crf', String(cfg.render.crf || 21),
        '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', seg], { timeout: 300000 });
    } else if (s.kind === 'context_video' && s.media_file && fs.existsSync(U.p(id, s.media_file))) {
      // CONTEXT VIDEO: already-downloaded approved source se chalta hua tukda
      // (exact scene ka daawa nahi — report mein CONTEXT_VIDEO). Still se behtar,
      // aur koi naya download nahi.
      r = U.ffmpeg(['-ss', String(s.media_start || 0), '-i', U.p(id, s.media_file), '-t', dur.toFixed(3), '-an',
        '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1`,
        '-c:v', 'libx264', '-preset', cfg.render.preset || 'veryfast', '-crf', String(cfg.render.crf || 21),
        '-pix_fmt', 'yuv420p', '-r', String(FPS), seg], { timeout: 300000 });
    } else if (s.kind === 'still' && s.image && fs.existsSync(U.p(id, s.image))) {
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
      r = U.ffmpeg(['-loop', '1', '-framerate', String(FPS), '-i', U.p(id, s.image), '-t', dur.toFixed(3), '-vf', vf,
        '-c:v', 'libx264', '-preset', cfg.render.preset || 'veryfast', '-crf', String(cfg.render.crf || 21),
        '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', seg], { timeout: 180000 });
      if (!r.ok) {   // zoompan fail -> simple static fit (still better than card)
        r = U.ffmpeg(['-loop', '1', '-i', U.p(id, s.image), '-t', dur.toFixed(3),
          '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(cfg.render.crf || 21), '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', seg]);
      }
    } else {
      // ---- MONTAGE: 2-3 verified frames ek shot mein (crossfade) ----
      if (s.kind === 'montage' && Array.isArray(s.images) && s.images.length >= 2) {
        const imgs = s.images.filter(f => fs.existsSync(U.p(id, f))).slice(0, 3);
        if (imgs.length >= 2) {
          const per = dur / imgs.length;
          const args = [];
          imgs.forEach(f => args.push('-loop', '1', '-framerate', String(FPS), '-t', (per + 0.6).toFixed(3), '-i', U.p(id, f)));
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
          r = U.ffmpeg(['-loop', '1', '-framerate', String(FPS), '-i', U.p(id, s.images[0]), '-t', dur.toFixed(3),
            '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},fps=${FPS},setsar=1`,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(cfg.render.crf || 21), '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', seg]);
        }
      } else if (s.kind === 'graphic' && s.image && fs.existsSync(U.p(id, s.image))) {
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
        r = U.ffmpeg(['-loop', '1', '-framerate', String(FPS), '-i', U.p(id, s.image), '-t', dur.toFixed(3),
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
    let assetUsed = s.asset || s.kind;
    if (!r || !r.ok || !fs.existsSync(seg)) {
      // RETRY: pehle usi shot ka simpler form (media rakhte hue), phir hi haar mano.
      U.warn(`seg ${s.i} (${s.kind}) render fail — retry: ${((r && r.stderr) || '').slice(0, 90)}`);
      let retried = null;
      // scope-correct backup still (timeline ne pehle hi chun rakhi hai) sabse pehle
      const anyImg = s.image || (Array.isArray(s.images) && s.images[0]) || s.fallback_image;
      if (anyImg && fs.existsSync(U.p(id, anyImg))) {
        retried = U.ffmpeg(['-loop', '1', '-framerate', String(FPS), '-i', U.p(id, anyImg), '-t', dur.toFixed(3),
          '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(cfg.render.crf || 21), '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', seg]);
        if (retried.ok) assetUsed = 'VERIFIED_SOURCE_STILL';
      } else if (s.video && fs.existsSync(U.p(id, s.video))) {
        retried = U.ffmpeg(['-i', U.p(id, s.video), '-t', dur.toFixed(3),
          '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(cfg.render.crf || 21), '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', seg]);
        if (retried.ok) assetUsed = 'EXACT_VIDEO';
      }
      if (!retried || !retried.ok || !fs.existsSync(seg)) {
        // Ab CHHUPANA nahi: production mein fail karo, review mode mein hi placeholder.
        if (production) throw new Error(`shot ${s.i} (${s.kind}, ${s.start}-${s.end}s) render nahi ho paya aur koi verified alternate nahi mila. ` +
          `Production export rok raha hoon (pehle chupchap solid card lag jata tha). Report/NEEDS_SOURCE.csv dekho.`);
        const fb = renderSolid(cfg, seg, dur, '0x202020');
        if (!fb.ok || !fs.existsSync(seg)) throw new Error(`seg ${s.i} placeholder bhi fail`);
        assetUsed = 'RENDER_FAILURE_FALLBACK';
      }
      failed++;
    }
    manifest.push({ i: s.i, start: s.start, end: s.end, dur, kind: s.kind, asset: assetUsed,
      moment_id: s.moment_id || null, pack_id: s.pack_id || null,
      source_id: s.source_id || s.image_source || null, url: s.url || null,
      image: s.image || null, images: s.images || null, image_time: s.image_time != null ? s.image_time : null,
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
  const finalOut = U.p(id, 'final.mp4');
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
    if (!offset && adurRaw && Math.abs(adurRaw - vdur) > 1.0) {
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

  fs.writeFileSync(U.p(id, 'render-manifest.json'), JSON.stringify({ total: tl.total, shots: manifest }, null, 2));
  const pr = U.probe(finalOut);
  U.ok(`render: final.mp4 (${n} segments${failed ? ', ' + failed + ' fallback-card' : ''}, ${pr.ok ? pr.duration.toFixed(1) + 's' : '?'}, ${W}x${H})`);
  st.meta.render = { segments: n, failed, duration: pr.ok ? +pr.duration.toFixed(1) : null, file: 'final.mp4' };
  return { file: finalOut, segments: n, duration: pr.ok ? pr.duration : null };
};
