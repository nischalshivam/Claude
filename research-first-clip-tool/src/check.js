// ============================================================
//  Stage 0 — SETUP CHECK
//  node / ffmpeg / ffprobe / yt-dlp maujood hain? Milestone 1 ke liye
//  Gemini/API key ki zaroorat NAHI. ffprobe optional (ffmpeg fallback hai).
// ============================================================
const U = require('./util.js');

function checkOne(bin, versionArgs, { required = true, optionalNote = '' } = {}) {
  const r = U.run(bin, versionArgs, { timeout: 20000 });
  const line = (r.stdout || r.stderr || '').split('\n')[0].trim();
  return { bin, ok: r.ok, version: r.ok ? line.slice(0, 80) : '', required, optionalNote, error: r.ok ? '' : (r.stderr || 'not found').slice(0, 120) };
}

module.exports = function check() {
  U.step('0. setup check');
  const results = [];

  // node
  results.push({ bin: 'node', ok: true, version: process.version, required: true });

  // ffmpeg (zaroori)
  results.push(checkOne(U.tool('ffmpeg'), ['-version'], { required: true }));

  // ffprobe (optional — ffmpeg -i se metadata nikal lete hain)
  const fp = checkOne(U.tool('ffprobe'), ['-version'], { required: false, optionalNote: 'optional (ffmpeg fallback hai)' });
  results.push(fp);

  // yt-dlp (zaroori download ke liye; local_file sources ke liye optional)
  results.push(checkOne(U.tool('yt-dlp'), ['--version'], { required: true }));

  // report
  let hardFail = false;
  for (const r of results) {
    if (r.ok) U.ok(`${r.bin.padEnd(8)} ${r.version}${r.optionalNote ? '  (' + r.optionalNote + ')' : ''}`);
    else if (r.required) { U.bad(`${r.bin.padEnd(8)} nahi mila — ${r.error}`); hardFail = true; }
    else U.warn(`${r.bin.padEnd(8)} nahi mila — ${r.optionalNote || 'optional'}`);
  }

  if (hardFail) {
    U.log('\n   Zaroori tool missing. Windows par install karo:');
    U.log('     ffmpeg : https://www.gyan.dev/ffmpeg/builds/  (PATH mein daalo ya config.json > tools)');
    U.log('     yt-dlp : https://github.com/yt-dlp/yt-dlp/releases  (yt-dlp.exe PATH mein)');
  }
  return { ok: !hardFail, results };
};
