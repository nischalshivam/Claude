// ============================================================
//  Stage 5 — CUT (frame-accurate). Har RESOLVED video ka final clip banao:
//   - precise -ss/-t (re-encode, stream-copy nahi — exact cut ke liye)
//   - source audio MUTE (-an); master voiceover render mein alag chalega
//   - canvas par scale+crop (bina stretch), fps set
//   - video max 6s (locate.js pehle hi shape kar chuka; yahan hard cap)
//  Output: clips/clip_<moment_id>.mp4
// ============================================================
const fs = require('fs');
const path = require('path');
const U = require('./util.js');

module.exports = function cut(spec, cfg, st, resolved) {
  const id = spec.id;
  const dir = U.ensureDir(U.p(id, 'clips'));
  const W = cfg.canvas.width, H = cfg.canvas.height, FPS = cfg.canvas.fps;
  const maxDur = cfg.clip.videoMaxSeconds || 6;

  let ok = 0, fail = 0;
  for (const e of resolved) {
    if (e.kind !== 'video' || e.status !== 'RESOLVED' || !e._rawFile) continue;
    const outRel = `clips/clip_${e.moment_id}.mp4`;
    const out = U.p(id, outRel);
    if (fs.existsSync(out)) { e.clip = outRel; ok++; continue; }

    const ss = Math.max(0, e.cut.start - (e._rawOffset || 0));
    const dur = Math.min(maxDur, e.cut.dur || (e.cut.end - e.cut.start));
    const vf = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1`;
    const r = U.ffmpeg(['-ss', ss.toFixed(3), '-i', e._rawFile, '-t', dur.toFixed(3), '-an',
      '-vf', vf, '-c:v', 'libx264', '-preset', cfg.render.preset || 'veryfast', '-crf', String(cfg.render.crf || 21),
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { timeout: 300000 });
    if (!r.ok || !fs.existsSync(out)) {
      e.clip = null; e.status = 'NEEDS_SOURCE'; e.reason = `cut failed: ${(r.stderr || '').slice(0, 120)}`;
      fail++; continue;
    }
    e.clip = outRel; e.cut.dur = dur; ok++;
  }

  U.ok(`cut: ${ok} clips (<=${maxDur}s, muted), ${fail} failed`);
  st.meta.cut = { ok, fail };
  return resolved;
};
