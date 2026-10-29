'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawn, execFile } = require('node:child_process');
const PROFILES = {
  reference: { directory: 'voice-backend', runtime: 'capri-voice', port: 8794, model: 'chatterbox-multilingual-v3', reference: 'voice-reference.audio' },
  'capri-sample': { directory: 'voice-backend-qwen', runtime: 'capri-qwen-voice', port: 8795, model: 'qwen3-tts-1.7b-capri', reference: 'capri-approved-reference.audio' },
};

function findInstallation({ root, portableDir, profile = 'reference' }, exists = fs.existsSync) {
  const engine = PROFILES[profile];
  if (!engine) return null;
  const bases = [portableDir, root && path.resolve(root, '..'), portableDir && path.resolve(portableDir, '..', '..')].filter(Boolean);
  for (const base of [...new Set(bases)]) {
    const server = path.join(base, engine.directory, 'server.py');
    const runtime = path.join(base, '.tools', engine.runtime);
    const python = path.join(runtime, 'venv', 'Scripts', 'python.exe');
    if (exists(server) && exists(python)) return { server, runtime, python };
  }
  return null;
}

// Optional and already-installed only. No installer, downloads, PATH changes or game processes.
function create({ root, portableDir, dataDir, profile = 'reference' }, options = {}) {
  const engine = PROFILES[profile];
  if (!engine) return { ensure: async () => false, stop() {} };
  const exists = options.exists || fs.existsSync;
  const run = options.spawn || spawn;
  const request = options.fetch || fetch;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let child = null, pending = null, epoch = 0;
  async function ready() {
    try {
      const response = await request(`http://127.0.0.1:${engine.port}/health`, { signal: AbortSignal.timeout(1200), redirect: 'error' });
      if (!response.ok || Number(response.headers.get('content-length')) > 8192) return false;
      const info = await response.json();
      return info.model === engine.model && info.state !== 'error';
    } catch { return false; }
  }
  async function ensure() {
    if (!exists(path.join(dataDir, engine.reference))) return false;
    if (pending) return pending;
    const generation = epoch;
    const job = (async () => {
      if (await ready()) return generation === epoch;
      const install = findInstallation({ root, portableDir, profile }, exists);
      if (!install || generation !== epoch) return false;
      if (!child) {
        try {
          const processRef = run(install.python, [install.server, '--runtime', install.runtime,
            '--reference', path.join(dataDir, engine.reference), '--device', 'cpu', '--threads', '2', '--offline'],
          { cwd: path.dirname(install.server), windowsHide: true, stdio: 'ignore' });
          child = processRef;
          const gone = () => { if (child === processRef) child = null; };
          processRef.once('error', gone); processRef.once('exit', gone);
        } catch { return false; }
      }
      for (let i = 0; i < 20 && generation === epoch; i++) {
        await sleep(250);
        if (await ready()) return generation === epoch;
        if (!child) return false;
      }
      return false;
    })();
    pending = job;
    try { return await job; } finally { if (pending === job) pending = null; }
  }
  function stop() {
    epoch++; const owned = child; child = null; pending = null;
    if (!owned) return;
    // Windows venv Python may redirect to a child interpreter. Stop only our owned tree.
    if (process.platform === 'win32' && Number.isSafeInteger(owned.pid) && owned.pid > 0) {
      const terminate = options.execFile || execFile;
      terminate(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(owned.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else owned.kill();
  }
  return { ensure, stop };
}

module.exports = { create, findInstallation, PROFILES };
