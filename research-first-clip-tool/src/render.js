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
    if (!r.ok || !fs.existsSync(seg)) {
      // NEVER skip time — same-duration fallback solid card (no drift, P1-8)
      U.warn(`seg ${s.i} (${s.kind}) render fail -> fallback card: ${(r.stderr || '').slice(0, 80)}`);
      const fb = renderSolid(cfg, seg, dur, '0x202020');
      if (!fb.ok || !fs.existsSync(seg)) throw new Error(`seg ${s.i} fallback card bhi fail: ${(fb.stderr || '').slice(0, 100)}`);
      failed++;
    }
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
    // VO truncate se bachne ko: video+audio dono ko MAX length tak pad karo
    // (video = last frame freeze, audio = silence). -shortest nahi.
    const adur = U.probe(audio).duration || vdur;
    const target = Math.max(vdur, adur);
    const vpad = Math.max(0, +(target - vdur).toFixed(3));
    const m = U.ffmpeg(['-i', master, '-i', audio,
      '-filter_complex', `[0:v]tpad=stop_mode=clone:stop_duration=${vpad}[v];[1:a]apad[a]`,
      '-map', '[v]', '-map', '[a]', '-t', target.toFixed(3),
      '-c:v', 'libx264', '-preset', cfg.render.preset || 'veryfast', '-crf', String(cfg.render.crf || 21),
      '-pix_fmt', 'yuv420p', '-r', String(FPS), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', finalOut]);
    if (!m.ok || !fs.existsSync(finalOut)) throw new Error('audio mux fail: ' + (m.stderr || '').slice(0, 200));
  } else if (cfg.render.allowSilent) {
    U.warn('voiceover audio nahi — allowSilent=true, silent video (test-only).');
    fs.copyFileSync(master, finalOut);
  } else {
    throw new Error('voiceover audio nahi mila. Production render ke liye audio zaroori (ya config.render.allowSilent=true test ke liye).');
  }

  const pr = U.probe(finalOut);
  U.ok(`render: final.mp4 (${n} segments${failed ? ', ' + failed + ' fallback-card' : ''}, ${pr.ok ? pr.duration.toFixed(1) + 's' : '?'}, ${W}x${H})`);
  st.meta.render = { segments: n, failed, duration: pr.ok ? +pr.duration.toFixed(1) : null, file: 'final.mp4' };
  return { file: finalOut, segments: n, duration: pr.ok ? pr.duration : null };
};
