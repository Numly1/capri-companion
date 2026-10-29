'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { create, findInstallation } = require('../src/main/companion-voice-runtime');

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise(setImmediate);
const workspace = path.resolve('virtual-capri-runtime');
const locations = { root: path.join(workspace, 'app'), portableDir: path.join(workspace, 'dist', 'companion'), dataDir: path.join(workspace, 'profile') };
const reference = path.join(locations.dataDir, 'voice-reference.audio');
const expected = {
  server: path.join(workspace, 'voice-backend', 'server.py'),
  runtime: path.join(workspace, '.tools', 'capri-voice'),
  python: path.join(workspace, '.tools', 'capri-voice', 'venv', 'Scripts', 'python.exe'),
};
const healthy = (extra = {}) => new Response(JSON.stringify({ model: 'chatterbox-multilingual-v3', state: 'ready', ...extra }), { headers: { 'content-type': 'application/json' } });
const unavailable = () => new Response('{}', { status: 503 });

function fixture(options = {}) {
  const files = new Set(options.files ?? [reference, expected.server, expected.python]);
  const calls = { spawn: [], fetch: [], sleep: [] }, children = [];
  const runtime = create(locations, {
    exists: file => files.has(file),
    fetch: async (url, init) => {
      calls.fetch.push({ url, init });
      return options.fetch ? options.fetch(calls.fetch.length) : unavailable();
    },
    spawn(file, args, init) {
      calls.spawn.push({ file, args, init });
      if (options.spawnError) throw new Error('cannot spawn');
      const child = new EventEmitter(); child.kills = 0;
      child.kill = () => { child.kills++; return true; };
      children.push(child);
      return child;
    },
    sleep: async ms => {
      calls.sleep.push(ms);
      return options.sleep?.(calls.sleep.length);
    },
  });
  return { runtime, files, calls, children };
}

test('installation lookup supports a sidecar and this checkout without touching unrelated paths', () => {
  const checked = [];
  const exists = file => { checked.push(file); return [expected.server, expected.python].includes(file); };
  assert.deepEqual(findInstallation(locations, exists), expected);
  assert.ok(checked.every(file => file.startsWith(workspace + path.sep)));
  const sidecar = { server: path.join(locations.portableDir, 'voice-backend', 'server.py'),
    runtime: path.join(locations.portableDir, '.tools', 'capri-voice'),
    python: path.join(locations.portableDir, '.tools', 'capri-voice', 'venv', 'Scripts', 'python.exe') };
  assert.deepEqual(findInstallation(locations, file => [sidecar.server, sidecar.python, expected.server, expected.python].includes(file)), sidecar);
  assert.equal(findInstallation({}, () => { throw new Error('no paths to inspect'); }), null);
});

test('missing reference never contacts a service, missing installation never spawns', async () => {
  const noReference = fixture({ files: [expected.server, expected.python] });
  assert.equal(await noReference.runtime.ensure(), false);
  assert.equal(noReference.calls.fetch.length, 0); assert.equal(noReference.calls.spawn.length, 0);
  const noInstallation = fixture({ files: [reference] });
  assert.equal(await noInstallation.runtime.ensure(), false);
  assert.equal(noInstallation.calls.spawn.length, 0); assert.equal(noInstallation.calls.sleep.length, 0);
});

test('reuses an existing matching local service and stop never kills an external process', async () => {
  const f = fixture({ files: [reference], fetch: () => healthy() });
  assert.equal(await f.runtime.ensure(), true);
  assert.equal(await f.runtime.ensure(), true);
  f.runtime.stop(); f.runtime.stop();
  assert.equal(f.calls.spawn.length, 0); assert.equal(f.children.length, 0);
  assert.ok(f.calls.fetch.every(call => call.url === 'http://127.0.0.1:8794/health'));
  assert.ok(f.calls.fetch.every(call => call.init.redirect === 'error' && call.init.signal instanceof AbortSignal));
  assert.ok(f.calls.fetch.every(call => !call.init.headers && !call.init.body));
});

test('owned runtime uses fixed CPU/offline arguments and only its own child is stopped', async () => {
  const f = fixture({ fetch: attempt => attempt === 1 ? unavailable() : healthy() });
  assert.equal(await f.runtime.ensure(), true);
  assert.equal(f.calls.spawn.length, 1);
  assert.deepEqual(f.calls.spawn[0], { file: expected.python,
    args: [expected.server, '--runtime', expected.runtime, '--reference', reference, '--device', 'cpu', '--threads', '2', '--offline'],
    init: { cwd: path.dirname(expected.server), windowsHide: true, stdio: 'ignore' },
  });
  assert.deepEqual(f.calls.sleep, [250]);
  f.runtime.stop(); f.runtime.stop();
  assert.equal(f.children[0].kills, 1);
});

test('concurrent ensure calls share one startup and one owned process', async () => {
  const firstHealth = deferred();
  const f = fixture({ fetch: attempt => attempt === 1 ? firstHealth.promise : healthy() });
  const first = f.runtime.ensure(), second = f.runtime.ensure(), third = f.runtime.ensure();
  assert.equal(f.calls.fetch.length, 1);
  firstHealth.resolve(unavailable());
  assert.deepEqual(await Promise.all([first, second, third]), [true, true, true]);
  assert.equal(f.calls.spawn.length, 1); assert.equal(f.calls.fetch.length, 2);
  f.runtime.stop();
});

test('stop during the initial health request cancels startup even if readiness arrives late', async () => {
  for (const lateResponse of [healthy(), unavailable()]) {
    const health = deferred();
    const f = fixture({ fetch: () => health.promise });
    const pending = f.runtime.ensure();
    f.runtime.stop(); health.resolve(lateResponse);
    assert.equal(await pending, false);
    assert.equal(f.calls.spawn.length, 0);
  }
});

test('a cancelled startup cannot leak a later child or clear a newer coalesced startup', async () => {
  const firstWait = deferred(), secondWait = deferred();
  const f = fixture({ fetch: attempt => attempt >= 4 ? healthy() : unavailable(),
    sleep: attempt => attempt === 1 ? firstWait.promise : secondWait.promise });
  const first = f.runtime.ensure(); await flush();
  assert.equal(f.children.length, 1);
  f.runtime.stop();
  assert.equal(f.children[0].kills, 1);
  const second = f.runtime.ensure(); await flush();
  assert.equal(f.children.length, 2);
  firstWait.resolve(); assert.equal(await first, false);
  const fetchesBeforeThird = f.calls.fetch.length;
  const third = f.runtime.ensure();
  assert.equal(f.calls.fetch.length, fetchesBeforeThird, 'old finally must not clear the new pending job');
  secondWait.resolve();
  assert.deepEqual(await Promise.all([second, third]), [true, true]);
  assert.equal(f.children.length, 2); assert.equal(f.children[1].kills, 0);
  f.runtime.stop(); assert.equal(f.children[1].kills, 1);
});

test('spawn failures and early child exit are handled, and a later attempt can restart', async () => {
  const failed = fixture({ spawnError: true });
  assert.equal(await failed.runtime.ensure(), false);
  for (const event of ['exit', 'error']) {
    const wait = deferred(); const f = fixture({ sleep: () => wait.promise });
    const first = f.runtime.ensure(); await flush();
    f.children[0].emit(event, event === 'error' ? new Error('test failure') : 1);
    wait.resolve(); assert.equal(await first, false);
    assert.equal(f.children[0].kills, 0, 'already exited children are not killed');
    const next = f.runtime.ensure(); await flush();
    assert.equal(f.children.length, 2);
    f.runtime.stop(); assert.equal(await next, false);
    assert.equal(f.children[1].kills, 1);
  }
});
