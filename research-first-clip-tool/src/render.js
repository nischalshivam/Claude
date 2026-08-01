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

const CARD_BG = { text: '0x1a1a1a', graphic: '0x102a43', needs_source: '0x4a1010' };

module.exports = function render(spec, cfg, st, tl) {
  const id = spec.id;
  const W = cfg.canvas.width, H = cfg.canvas.height, FPS = cfg.canvas.fps;
  const segDir = U.ensureDir(U.p(id, 'segments'));
  const font = findFont(cfg);
  const drawtextOK = hasDrawtext();
  if (!font) U.warn('koi TTF font nahi mila — text cards bina text ke (solid color) banenge. config.render.fontFile set karo.');
  else if (!drawtextOK) U.warn('is ffmpeg build mein drawtext filter nahi — text cards solid-color (text report mein hai). Windows ffmpeg mein text aayega.');

  const listLines = [];
  let n = 0;
  for (const s of tl.slots) {
    const seg = path.join(segDir, `seg_${String(s.i).padStart(4, '0')}.mp4`);
    const dur = Math.max(0.3, s.dur);
    let r;
    if (s.kind === 'video' && s.video && fs.existsSync(U.p(id, s.video))) {
      const vf = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1,tpad=stop=-1:stop_mode=clone`;
      r = U.ffmpeg(['-i', U.p(id, s.video), '-vf', vf, '-t', dur.toFixed(3),
        '-c:v', 'libx264', '-preset', cfg.render.preset || 'veryfast', '-crf', String(cfg.render.crf || 21),
        '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', seg], { timeout: 300000 });
    } else {
      // card
      const kind = s.kind === 'video' ? 'needs_source' : s.kind;   // clip missing -> needs_source card
      const bg = CARD_BG[kind] || CARD_BG.text;
      const label = s.label === 'NEEDS SOURCE' ? 'NEEDS SOURCE' : (s.label === 'fallback' ? '' : '');
      const body = (label ? label + '\n\n' : '') + wrap(s.text || s.cue || '');
      const vf = ['-f', 'lavfi', '-i', `color=c=${bg}:s=${W}x${H}:r=${FPS}:d=${dur.toFixed(3)}`];
      let filter = null;
      if (font && drawtextOK) {
        const txtFile = path.join(segDir, `txt_${s.i}.txt`);
        fs.writeFileSync(txtFile, body);
        filter = `drawtext=fontfile='${escFont(font)}':textfile='${escFont(txtFile)}':fontcolor=white:fontsize=44:line_spacing=14:x=(w-text_w)/2:y=(h-text_h)/2`;
      }
      const args = [...vf];
      if (filter) args.push('-vf', filter);
      args.push('-t', dur.toFixed(3), '-c:v', 'libx264', '-preset', cfg.render.preset || 'veryfast',
        '-crf', String(cfg.render.crf || 21), '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', seg);
      r = U.ffmpeg(args, { timeout: 120000 });
    }
    if (!r.ok || !fs.existsSync(seg)) { U.warn(`seg ${s.i} (${s.kind}) render fail: ${(r.stderr || '').slice(0, 100)}`); continue; }
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
  if (audio && fs.existsSync(audio)) {
    const m = U.ffmpeg(['-i', master, '-i', audio, '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', finalOut]);
    if (!m.ok || !fs.existsSync(finalOut)) throw new Error('audio mux fail: ' + (m.stderr || '').slice(0, 150));
  } else {
    U.warn('voiceover audio nahi mila — video bina audio ke.');
    fs.copyFileSync(master, finalOut);
  }

  const pr = U.probe(finalOut);
  U.ok(`render: final.mp4 (${n} segments, ${pr.ok ? pr.duration.toFixed(1) + 's' : '?'}, ${W}x${H})`);
  st.meta.render = { segments: n, duration: pr.ok ? +pr.duration.toFixed(1) : null, file: 'final.mp4' };
  return { file: finalOut, segments: n };
};
