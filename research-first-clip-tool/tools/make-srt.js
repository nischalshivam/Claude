#!/usr/bin/env node
// ============================================================
//  MAKE-SRT (M5.0-A.2) — voiceover ke liye ESTIMATED .srt banao.
//
//  Kyun ye bana:
//  Pipeline ko narration ki timing (voiceover.srt) chahiye — wahi "kab kya"
//  ka source of truth hai. Ab tak user ko wo alag se deni padti thi. Ye tool
//  clean script + audio ki lambai se ek anumaan-timing SRT bana deta hai.
//
//  IMAANDAR baat: ye ASLI transcription nahi hai (uske liye offline Whisper
//  jaisa model chahiye jo is tool ke "zero-install, offline" waade ko tod de).
//  Ye har line ko uske shabdon/aksharon ke hisaab se audio par faila deta hai.
//  Timing ±kuch second aage-peeche ho sakti hai — draft ke liye kaafi, aur
//  editor mein fine-tune ho jati hai. Agar aapke paas ASLI srt hai (TTS ya
//  Whisper se), wo hamesha behtar hai — use daal do, tool usi ko lega.
//
//  Chalao:
//    node tools/make-srt.js --audio=input/voiceover.mp3 --script=input/script.txt --out=input/voiceover.srt
//    node tools/make-srt.js --audio=input/voiceover.wav --pack=input/scene-research.json --out=input/voiceover.srt
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const U = require(path.join(__dirname, '..', 'src', 'util.js'));

const arg = (n, d = null) => { const a = process.argv.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=').replace(/^["']|["']$/g, '') : d; };

function srtTime(s) {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = Math.floor(s % 60), ms = Math.round((s % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

// script text ko cue-layak lines mein todo: pehle newline, phir . ! ? par
function splitLines(text) {
  const out = [];
  for (const para of String(text).split(/\r?\n+/)) {
    const t = para.trim();
    if (!t) continue;
    // lambe paragraph ko sentence par todo
    const parts = t.split(/(?<=[.!?।])\s+/).map(s => s.trim()).filter(Boolean);
    for (const p of parts) {
      // bahut lambi line ko ~14 shabd ke tukdon mein
      const words = p.split(/\s+/);
      if (words.length <= 16) { out.push(p); continue; }
      for (let i = 0; i < words.length; i += 14) out.push(words.slice(i, i + 14).join(' '));
    }
  }
  return out;
}

// pack se cues (agar clean script na ho): moments ke script_cue_exact, order mein
function cuesFromPack(packFile) {
  const v = JSON.parse(fs.readFileSync(packFile, 'utf8'));
  const lines = [];
  for (const pk of (v.packs || [])) for (const m of (pk.moments || [])) {
    const c = String(m.script_cue_exact || '').trim();
    if (c) lines.push(c);
  }
  return lines;
}

function build({ audioFile, scriptFile, packFile, wpm }) {
  let dur = 0;
  if (audioFile && fs.existsSync(audioFile)) {
    const p = U.probe(audioFile, { strict: false });
    if (p && p.duration > 0) dur = p.duration;
  }
  let lines = [];
  if (scriptFile && fs.existsSync(scriptFile)) lines = splitLines(fs.readFileSync(scriptFile, 'utf8'));
  else if (packFile && fs.existsSync(packFile)) lines = cuesFromPack(packFile);
  if (!lines.length) throw new Error('script/pack se koi line nahi mili — clean script ya pack do');

  // har line ka "weight" = shabd (min 1). Bina audio ke WPM se total anumaan.
  const words = lines.map(l => Math.max(1, l.split(/\s+/).filter(Boolean).length));
  const totalWords = words.reduce((a, b) => a + b, 0);
  const speakRate = (wpm || 150) / 60;                 // words per second
  const total = dur > 0 ? dur : totalWords / speakRate;

  const cues = [];
  let t = 0;
  for (let i = 0; i < lines.length; i++) {
    const share = words[i] / totalWords;
    const len = +(share * total).toFixed(3);
    const start = +t.toFixed(3);
    let end = +(t + len).toFixed(3);
    if (i === lines.length - 1) end = +total.toFixed(3);   // aakhri cue theek total par
    cues.push({ start, end: Math.max(end, start + 0.4), text: lines[i] });
    t = end;
  }
  return { cues, total, estimated: true, hadAudio: dur > 0 };
}

function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n') + '\n';
}

function main() {
  const audioFile = arg('audio');
  const scriptFile = arg('script');
  const packFile = arg('pack');
  const out = arg('out', path.join(U.ROOT, 'input', 'voiceover.srt'));
  const wpm = Number(arg('wpm', '150'));
  if (!scriptFile && !packFile) { console.error('  --script=<file.txt> ya --pack=<pack.json> chahiye'); process.exit(2); }

  const r = build({ audioFile, scriptFile, packFile, wpm });
  const tmp = out + '.tmp';
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(tmp, toSrt(r.cues));
  fs.renameSync(tmp, out);

  console.log('='.repeat(60));
  console.log('  ESTIMATED SRT ban gaya');
  console.log('='.repeat(60));
  console.log(`  file        : ${path.relative(U.ROOT, out)}`);
  console.log(`  lines/cues  : ${r.cues.length}`);
  console.log(`  lambai      : ${r.total.toFixed(1)}s ${r.hadAudio ? '(audio se)' : '(WPM anumaan — audio nahi mila)'}`);
  console.log('');
  console.log('  DHYAN: ye anumaan-timing hai (asli transcription nahi). Draft ke');
  console.log('  liye kaafi hai; editor mein fine-tune ho jayegi. Aapke paas asli');
  console.log('  .srt (TTS/Whisper se) ho to wahi behtar — use daal do.');
  console.log('='.repeat(60));
  return 0;
}

if (require.main === module) { try { process.exit(main()); } catch (e) { console.error('fatal: ' + (e && e.message)); process.exit(1); } }
module.exports = { build, toSrt, splitLines, srtTime };
