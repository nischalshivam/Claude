#!/usr/bin/env node
// BUILD_INFO.json banata hai — ZIP ko exact commit se tie karne ke liye.
// Usage: node tools/build-info.js
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const sh = c => { try { return execSync(c, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return null; } };
const hash = f => { try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex').toUpperCase(); } catch { return null; } };

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const info = {
  name: pkg.name,
  version: pkg.version,
  git_commit: sh('git rev-parse HEAD'),
  git_branch: sh('git rev-parse --abbrev-ref HEAD'),
  // BUILD_INFO.json khud ko ignore karo — warna ye hamesha "dirty" dikhata hai
  // (isse likhte hi tree dirty ho jata hai). Baaki har file ginii jaati hai.
  git_dirty: !!sh('git status --porcelain').split('\n').filter(l => l.trim() && !/BUILD_INFO\.json$/.test(l)).length,
  built_at: new Date().toISOString(),
  schema_version: 'scene-research-pack-v1',
  node: process.version,
  test_logs: {
    'RAW-TEST-LOG.txt': hash('RAW-TEST-LOG.txt'),
    'RAW-REGRESSION-LOG.txt': hash('RAW-REGRESSION-LOG.txt'),
  },
  canonical_prompt_sha256: hash('prompts/STAGE1_SOURCES_AND_BEATS_PROMPT.txt'),
  oneshot_prompt_sha256: hash('prompts/GENSPARK_M2_5_ONE_SHOT_SCENE_RESEARCH_PROMPT.txt'),
  previous_prompt_sha256: hash('prompts/GENSPARK_M1_2_ONE_SHOT_SCENE_RESEARCH_PROMPT.txt'),
};
fs.writeFileSync(path.join(ROOT, 'BUILD_INFO.json'), JSON.stringify(info, null, 2));
console.log(JSON.stringify(info, null, 2));
