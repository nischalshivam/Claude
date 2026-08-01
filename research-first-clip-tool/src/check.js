// ============================================================
//  Stage 0 — SETUP CHECK
//  node / ffmpeg / ffprobe / yt-dlp maujood hain? Milestone 1 ke liye
//  Gemini/API key ki zaroorat NAHI. ffprobe optional (ffmpeg fallback hai).
// ============================================================
const U = require('./util.js');

// har result mein stable KEY (bin path naam pe nirbhar nahi — custom RFC_YTDLP/
// config.tools path ke sath bhi preflight reliably kaam kare)
function checkOne(bin, versionArgs, { required = true, optionalNote = '', key = '' } = {}) {
  const r = U.run(bin, versionArgs, { timeout: 20000 });
  const line = (r.stdout || r.stderr || '').split('\n')[0].trim();
  return { key, bin, ok: r.ok, version: r.ok ? line.slice(0, 80) : '', required, optionalNote, error: r.ok ? '' : (r.stderr || 'not found').slice(0, 120) };
}

module.exports = function check() {
  U.step('0. setup check');
  const results = [];

  // node
  results.push({ key: 'node', bin: 'node', ok: true, version: process.version, required: true });

  // ffmpeg (zaroori)
  results.push(checkOne(U.tool('ffmpeg'), ['-version'], { required: true, key: 'ffmpeg' }));

  // ffprobe (optional — ffmpeg -i se metadata nikal lete hain)
  const fp = checkOne(U.tool('ffprobe'), ['-version'], { required: false, optionalNote: 'optional (ffmpeg fallback hai)', key: 'ffprobe' });
  results.push(fp);

  // drawtext filter (text cards ke liye) — kuch static builds mein missing
  const filters = U.run(U.tool('ffmpeg'), ['-hide_banner', '-filters']);
  const drawtext = !!(filters.ok && /\bdrawtext\b/.test(filters.stdout || ''));
  results.push({ key: 'drawtext', bin: 'ffmpeg:drawtext', ok: drawtext, version: drawtext ? 'available' : '', required: false, optionalNote: drawtext ? 'text cards on' : 'missing -> text cards solid-color (full ffmpeg build lo)' });

  // yt-dlp (zaroori download ke liye; local_file sources ke liye optional)
  const ytdlp = checkOne(U.tool('yt-dlp'), ['--version'], { required: true, key: 'ytdlp' });
  results.push(ytdlp);

  // yt-dlp ko ab YouTube ke liye ek JS RUNTIME chahiye (nsig/PO-token challenge —
  // EJS). Deno recommended (koi bhi version); Node-based EJS ke liye Node 22+.
  // Ref: https://github.com/yt-dlp/yt-dlp/wiki/EJS  &  .../Po-Token-Guide
  let jsFound = null;
  const deno = U.run('deno', ['--version'], { timeout: 15000 });
  if (deno.ok) {
    const m = String(deno.stdout).match(/deno\s+(\d+)\.(\d+)\.(\d+)/i);
    if (m && (+m[1] > 2 || (+m[1] === 2 && +m[2] >= 3))) jsFound = { name: 'deno', ver: (deno.stdout || '').split('\n')[0].trim() };
    else results.push({ key: 'jsruntime', bin: 'js-runtime', ok: false, required: false, optionalNote: `deno ${(m ? m[0] : '?')} EJS ke liye purana (2.3+ chahiye)`, error: 'deno <2.3' });
  }
  if (!jsFound) { const bun = U.run('bun', ['--version'], { timeout: 15000 }); if (bun.ok) jsFound = { name: 'bun', ver: (bun.stdout || '').trim() }; }
  if (!jsFound) {
    const node = U.run('node', ['--version'], { timeout: 15000 });
    if (node.ok) {
      const major = parseInt(String(node.stdout).replace(/^v/, '').split('.')[0], 10) || 0;
      if (major >= 22) jsFound = { name: 'node', ver: node.stdout.trim() };
      else results.push({ key: 'jsruntime', bin: 'js-runtime', ok: false, required: false, optionalNote: `node ${node.stdout.trim()} EJS ke liye purana (Node 22+ ya Deno chahiye)`, error: 'node <22' });
    }
  }
  if (jsFound) results.push({ key: 'jsruntime', bin: `js-runtime(${jsFound.name})`, ok: true, version: jsFound.ver.slice(0, 40), required: false, optionalNote: 'yt-dlp YouTube EJS' });
  else if (!results.some(r => r.key === 'jsruntime')) results.push({ key: 'jsruntime', bin: 'js-runtime', ok: false, required: false, optionalNote: 'Deno (recommended) ya Node 22+ install karo', error: 'koi EJS-capable JS runtime nahi' });

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
