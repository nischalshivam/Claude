// ============================================================
//  state.js — checkpoint / resume. Har job ka state.json:
//    { done: { stageKey: {at, seconds} }, meta: {...} }
//  Beech mein ruke to jo stage ho chuka wo skip, wahin se aage.
// ============================================================
const fs = require('fs');
const U = require('./util.js');

function file(id) { return U.p(id, 'state.json'); }

function load(id) {
  const f = file(id);
  if (fs.existsSync(f)) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* corrupt -> fresh */ }
  }
  return { done: {}, meta: {} };
}

function save(id, st) {
  U.ensureDir(U.jobDir(id));
  fs.writeFileSync(file(id), JSON.stringify(st, null, 2));
}

const isDone = (st, key) => !!(st.done && st.done[key]);

function markDone(st, key, extra = {}) {
  st.done = st.done || {};
  st.done[key] = { at: new Date().toISOString(), ...extra };
}

module.exports = { load, save, isDone, markDone, file };
