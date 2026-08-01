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
  const ytdlp = checkOne(U.tool('yt-dlp'), ['--version'], { required: true });
  results.push(ytdlp);

  // yt-dlp ko ab YouTube ke liye ek JS RUNTIME chahiye (nsig/PO-token challenge
  // solve karne ko — EJS). Deno recommended; Bun/Node bhi chal sakte hain.
  // Ref: https://github.com/yt-dlp/yt-dlp/wiki/EJS  &  .../Po-Token-Guide
  const js = ['deno', 'bun', 'node'].map(b => ({ b, r: U.run(b, ['--version'], { timeout: 15000 }) })).find(x => x.r.ok);
  if (js) results.push({ bin: `js-runtime(${js.b})`, ok: true, version: (js.r.stdout || '').split('\n')[0].trim().slice(0, 40), required: false, optionalNote: 'yt-dlp YouTube ke liye' });
  else results.push({ bin: 'js-runtime', ok: false, required: false, optionalNote: 'Deno/Bun/Node install karo (yt-dlp YouTube EJS)', error: 'koi JS runtime nahi' });

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
  if (!results.some(r => r.bin.startsWith('js-runtime') && r.ok)) {
    U.log('\n   [note] yt-dlp ko YouTube ke liye ek JS runtime chahiye (nsig/PO-token).');
    U.log('          Deno install karo (recommended): https://github.com/yt-dlp/yt-dlp/wiki/EJS');
    U.log('          Bina iske kuch YouTube sources/subtitles 403 de sakte hain -> tool alternate try karega.');
  }
  return { ok: !hardFail, results };
};
