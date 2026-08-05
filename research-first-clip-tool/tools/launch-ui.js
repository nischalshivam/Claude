#!/usr/bin/env node
'use strict';

// One-click launcher. Reuse this exact tool if it is already running. If the
// preferred port belongs to something else, choose another port automatically.
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const INSTANCE_ID = crypto.createHash('sha256').update(ROOT.toLowerCase()).digest('hex').slice(0, 20);
const FIRST_PORT = 7900;
const LAST_PORT = 7999;

function health(port, timeout = 450) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/v1/health', timeout }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function portIsOpen(port, timeout = 300) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const done = value => { if (settled) return; settled = true; socket.destroy(); resolve(value); };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(true));
    socket.once('error', e => done(e && e.code !== 'ECONNREFUSED'));
  });
}

function openUrl(url) {
  if (process.env.RFC_NO_BROWSER === '1') return;
  let cmd, args;
  if (process.platform === 'win32') { cmd = 'cmd.exe'; args = ['/d', '/s', '/c', 'start', '', url]; }
  else if (process.platform === 'darwin') { cmd = 'open'; args = [url]; }
  else { cmd = 'xdg-open'; args = [url]; }
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForServer(port, child, maxMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const h = await health(port, 700);
    if (h && h.instance_id === INSTANCE_ID && h.launch_url) return h;
    if (child.exitCode != null) return null;
    await wait(200);
  }
  return null;
}

async function main() {
  const runtime = path.join(ROOT, '.runtime');
  fs.mkdirSync(runtime, { recursive: true });
  const currentFile = path.join(runtime, 'current.json');
  let remembered = null;
  try { remembered = JSON.parse(fs.readFileSync(currentFile, 'utf8')); } catch {}
  if (remembered && remembered.instance_id === INSTANCE_ID && Number.isInteger(+remembered.port)) {
    const h = await health(+remembered.port, 700);
    if (h && h.instance_id === INSTANCE_ID && h.launch_url) {
      console.log(`Movie Editor pehle se chal raha hai (port ${remembered.port}) - wahi khol raha hoon.`);
      openUrl(h.launch_url);
      return 0;
    }
  }

  const ports = Array.from({ length: LAST_PORT - FIRST_PORT + 1 }, (_, i) => FIRST_PORT + i);
  const openFlags = await Promise.all(ports.map(port => portIsOpen(port)));
  // Runtime file missing/stale ho tab bhi an already-running same copy mil jaye.
  for (let i = 0; i < ports.length; i++) {
    if (!openFlags[i]) continue;
    const h = await health(ports[i], 500);
    if (h && h.instance_id === INSTANCE_ID && h.launch_url) {
      fs.writeFileSync(currentFile, JSON.stringify({ port: ports[i], instance_id: INSTANCE_ID, recovered_at: new Date().toISOString() }, null, 2));
      console.log(`Movie Editor pehle se chal raha hai (port ${ports[i]}) - wahi khol raha hoon.`);
      openUrl(h.launch_url);
      return 0;
    }
  }

  for (let i = 0; i < ports.length; i++) {
    const port = ports[i];
    if (openFlags[i]) continue;
    const log = fs.openSync(path.join(runtime, `server-${port}.log`), 'a');
    const child = spawn(process.execPath, [path.join(ROOT, 'server', 'app.js'), `--port=${port}`, '--no-open'], {
      cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env },
    });
    child.unref();
    fs.closeSync(log);
    const h = await waitForServer(port, child);
    if (h) {
      fs.writeFileSync(currentFile, JSON.stringify({ port, pid: child.pid, instance_id: INSTANCE_ID, started_at: new Date().toISOString() }, null, 2));
      console.log(`Movie Editor ready (port ${port}).`);
      openUrl(h.launch_url);
      return 0;
    }
  }
  console.error(`Movie Editor start nahi hua. Detail: ${path.join(runtime, 'server-7900.log')}`);
  return 1;
}

if (require.main === module) main().then(code => { process.exitCode = code; }).catch(e => {
  console.error('Launcher fail: ' + String(e && e.message || e));
  process.exitCode = 1;
});

module.exports = { health, portIsOpen, main, INSTANCE_ID };
