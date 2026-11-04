'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { foreground, valorantEvents, valorantRegion, ValorantTracker, LolTracker, readLol, start } = require('../src/main/companion-riot');
const active = (game = 'lol') => ({ active: true, game, id: 123, bounds: { x: -1920, y: 0, width: 1920, height: 1080 } });
const event = (EventID, EventName, EventTime) => ({ EventID, EventName, EventTime, KillerName: 'PRIVATE_PLAYER', VictimName: 'PRIVATE_ENEMY' });

test('Valorant reads only bounded headline area of an exact foreground game and recognizes full headline lines', () => {
  assert.equal(foreground({ ...active(), game: 'Riot Client' }), null);
  assert.equal(foreground({ ...active(), active: false }), null);
  assert.equal(foreground({ ...active(), bounds: { x: 0, y: 0, width: 100000, height: 2000 } }), null);
  assert.deepEqual(valorantRegion(active().bounds), { x: -1652, y: 32, width: 1382, height: 540 });
  for (const [text, kind] of [['VICTORY', 'victory'], ['ПОРАЖЕНИЕ', 'defeat'], ['SPIKE PLANTED', 'spike'], ['СПАЙК УСТАНОВЛЕН', 'spike'], ['ROUND WON', 'round-win'], ['РАУНД ПРОИГРАН', 'round-loss']]) assert.deepEqual(valorantEvents(text), [kind]);
  for (const text of ['Player: VICTORY', 'я люблю победа', 'Use SPIKE PLANTED in a message', 'Riot Client', null]) assert.deepEqual(valorantEvents(text), []);
});

test('Valorant baselines visible messages, consumes cooldown misses, and never replays after alt-tab', () => {
  let at = 0; const tracker = new ValorantTracker({ now: () => at }); const cfg = { valorantReactions: true, valorantIntervalMinutes: 2 };
  assert.equal(tracker.sample('VICTORY', cfg), null, 'initial old end screen is a baseline');
  tracker.sample('', cfg); assert.equal(tracker.sample('SPIKE PLANTED', cfg).kind, 'spike');
  at = 1000; tracker.sample('', cfg); assert.equal(tracker.sample('VICTORY', cfg), null);
  at = 300000; assert.equal(tracker.sample('VICTORY', cfg), null, 'cooldown does not queue an old result');
  tracker.leave(); assert.equal(tracker.sample('DEFEAT', cfg), null, 'return to foreground baselines old screen');
  tracker.sample('', cfg); assert.equal(tracker.sample('DEFEAT', cfg).kind, 'defeat');
});

test('LoL consumes initial history and old IDs, only reacts to fresh documented global objectives', () => {
  let at = 0; const tracker = new LolTracker({ now: () => at }); const cfg = { lolReactions: true, lolIntervalMinutes: 2 };
  const events = [event(0, 'GameStart', 0), event(1, 'DragonKill', 90)];
  assert.equal(tracker.sample({ Events: events }, { gameTime: 100 }, cfg), null);
  events.push(event(2, 'BaronKill', 102));
  const first = tracker.sample({ Events: events }, { gameTime: 103 }, cfg);
  assert.equal(first.kind, 'baron'); assert.doesNotMatch(JSON.stringify(first), /PRIVATE|KillerName|VictimName|EventID/);
  assert.equal(tracker.sample({ Events: events }, { gameTime: 104 }, cfg), null);
  events.push(event(3, 'TurretKilled', 105)); assert.equal(tracker.sample({ Events: events }, { gameTime: 106 }, cfg), null);
  at = 180000; assert.equal(tracker.sample({ Events: events }, { gameTime: 107 }, cfg), null, 'suppressed event ID is consumed');
  events.push(event(4, 'DragonKill', 50), event(5, 'ChampionKill', 108));
  assert.equal(tracker.sample({ Events: events }, { gameTime: 109 }, cfg), null, 'stale objective and unidentified personal kill are ignored');
  events.push(event(6, 'InhibKilled', 110)); assert.equal(tracker.sample({ Events: events }, { gameTime: 111 }, cfg).kind, 'inhibitor');
  at += 180000;
  assert.equal(tracker.sample({ Events: [event(0, 'GameStart', 0)] }, { gameTime: 2 }, cfg), null, 'new match resets baseline');
  assert.equal(tracker.sample({ Events: [event(0, 'GameStart', 0), event(1, 'HeraldKill', 10)] }, { gameTime: 11 }, cfg).kind, 'herald');
});

test('LoL rejects malformed/unbounded snapshots and baselines again after connection loss', () => {
  const tracker = new LolTracker(); const cfg = { lolReactions: true };
  for (const raw of [null, {}, { Events: Array(4097).fill(event(0, 'DragonKill', 10)) }]) assert.equal(tracker.sample(raw, { gameTime: 10 }, cfg), null);
  assert.equal(tracker.sample({ Events: [event(0, 'DragonKill', 10)] }, { gameTime: 11 }, cfg), null);
  assert.equal(tracker.sample({ Events: [event(1, 'BaronKill', 11)] }, { gameTime: Infinity }, cfg), null);
  assert.equal(tracker.sample({ Events: [event(1, 'BaronKill', 11)] }, { gameTime: 12 }, cfg), null);
});

test('LoL HTTPS is limited to fixed loopback GET endpoints with bounded data and no redirects', async () => {
  const calls = [];
  function request(options, callback) {
    calls.push(options); const req = new EventEmitter(); req.destroy = () => {}; req.end = () => setImmediate(() => { const response = new EventEmitter(); response.statusCode = 200; response.headers = {}; callback(response); response.emit('data', Buffer.from('{"Events":[]}')); response.emit('end'); }); return req;
  }
  assert.deepEqual(await readLol('/liveclientdata/eventdata', { request }), { Events: [] });
  assert.deepEqual({ host: calls[0].hostname, port: calls[0].port, method: calls[0].method, path: calls[0].path, scopedTls: calls[0].rejectUnauthorized, agent: calls[0].agent }, { host: '127.0.0.1', port: 2999, method: 'GET', path: '/liveclientdata/eventdata', scopedTls: false, agent: false });
  await assert.rejects(readLol('https://evil.example/liveclientdata/eventdata', { request }));
  await assert.rejects(readLol('/liveclientdata/activeplayer', { request })); assert.equal(calls.length, 1);
  for (const [statusCode, data] of [[302, '{}'], [200, 'x'.repeat(1024 * 1024 + 1)], [200, 'not-json']]) {
    await assert.rejects(readLol('/liveclientdata/eventdata', { request(options, callback) { const req = new EventEmitter(); req.destroy = () => {}; req.end = () => setImmediate(() => { const res = new EventEmitter(); res.statusCode = statusCode; res.headers = {}; res.resume = () => {}; callback(res); res.emit('data', Buffer.from(data)); res.emit('end'); }); return req; } }));
  }
});

test('controller only reads the selected foreground game, drops alt-tab results and broadcasts fixed phrases only', async () => {
  let fg = null, at = 0, reads = 0, scans = 0, text = '', apiEvents = [event(0, 'GameStart', 0)], gameTime = 100;
  const cfg = { lolReactions: true, valorantReactions: true }; const sent = [];
  const controller = start(value => sent.push(value), () => cfg, { schedule: false, now: () => at, getForeground: () => fg,
    inspect: async request => { scans++; assert.deepEqual(request.bounds, valorantRegion(active('valorant').bounds)); return { ok: true, text }; },
    readLol: async pathname => { reads++; return pathname.endsWith('eventdata') ? { Events: apiEvents } : { gameTime }; },
  });
  await controller.poll(); assert.equal(reads, 0); assert.equal(scans, 0);
  fg = active(); await controller.poll(); assert.equal(reads, 2); assert.equal(sent.at(-1).reaction, null);
  apiEvents.push(event(1, 'DragonKill', 100)); gameTime = 101; await controller.poll(); assert.equal(sent.at(-1).reaction.kind, 'dragon');
  fg = active('valorant'); at += 10000; await controller.poll(); assert.equal(scans, 1); assert.equal(reads, 4);
  text = 'VICTORY\nPRIVATE_CHAT'; at += 10000; await controller.poll(); assert.equal(sent.at(-1).reaction.kind, 'victory');
  assert.doesNotMatch(JSON.stringify(sent), /PRIVATE|bounds|KillerName|VictimName|123/);
  cfg.valorantReactions = false; await controller.poll(); assert.equal(scans, 2);
  controller.stop(); await controller.poll(); assert.equal(reads, 4);
  let release, delayedReads = 0;
  const response = new Promise(resolve => { release = resolve; });
  const delayed = start(() => assert.fail('alt-tab result must be dropped'), () => ({ lolReactions: true }), { schedule: false, getForeground: () => fg, readLol: () => { delayedReads++; return response; } });
  fg = active(); const pending = delayed.poll(); await delayed.poll(); assert.equal(delayedReads, 2, 'overlapping poll does not issue more requests');
  fg = null; release({}); await pending; delayed.stop();
});

test('renderer consumes busy events without deferred speech and only displays trusted local source for its game', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/companion-riot.js'), 'utf8');
  const { CompanionRiot } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  let listener; const said = [], spoken = []; const capri = { mode: 'idle', busy: true };
  const renderer = new CompanionRiot({ host: { onRiot: fn => { listener = fn; } }, capri, panel: { say: data => said.push(data) } });
  renderer.configure({ lolReactions: true, valorantReactions: true }); renderer.onSay = text => spoken.push(text);
  const value = { state: { enabled: true, active: true, game: 'lol' }, reaction: { id: 'lol:1', game: 'lol', source: 'lol-live-client', line: 'На карте пал дракон.' } };
  listener(value); capri.busy = false; listener(value); assert.equal(said.length, 0);
  listener({ ...value, reaction: { ...value.reaction, id: 'lol:2' } }); assert.equal(said.length, 1); assert.equal(spoken.length, 1);
  listener({ ...value, reaction: { ...value.reaction, id: 'lol:3', source: 'cloud' } }); assert.equal(said.length, 1);
  capri.mode = 'sleep'; listener({ ...value, reaction: { ...value.reaction, id: 'lol:4' } }); assert.equal(said.length, 1);
});

test('sleep-suppressed LoL opportunities are consumed and do not replay when reactions become visible', async () => {
  let canReact = true, time = 0, events = [event(0, 'GameStart', 0)], gameTime = 100;
  const sent = [];
  const controller = start(value => sent.push(value), () => ({ lolReactions: true }), { schedule: false, now: () => time, getForeground: () => active(), canReact: () => canReact,
    readLol: async pathname => pathname.endsWith('eventdata') ? { Events: events } : { gameTime },
  });
  await controller.poll(); canReact = false;
  events.push(event(1, 'DragonKill', 101)); gameTime = 102; await controller.poll(); assert.equal(sent.at(-1).reaction, null);
  canReact = true; time = 200000; await controller.poll(); assert.equal(sent.at(-1).reaction, null);
  events.push(event(2, 'BaronKill', 103)); gameTime = 104; await controller.poll(); assert.equal(sent.at(-1).reaction.kind, 'baron');
  controller.stop();
});

test('native watcher classifies exact Riot client executables without starting a watcher or reading the screen', { skip: process.platform !== 'win32' }, () => {
  const file = path.join(__dirname, '../src/main/windows.ps1').replaceAll("'", "''");
  const ps = `$ErrorActionPreference='Stop';$s=[IO.File]::ReadAllText('${file}');Invoke-Expression $s.Substring(0,$s.IndexOf('[CapriWindows]::Init()'));@{valorant=[CapriWindows]::RiotKind('VALORANT-Win64-Shipping');lol=[CapriWindows]::RiotKind('League of Legends');launcher=[CapriWindows]::RiotKind('RiotClientServices');browser=[CapriWindows]::RiotKind('chrome');lookalike=[CapriWindows]::RiotKind('fake-valorant-win64-shipping')} | ConvertTo-Json -Compress`;
  const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { valorant: 'valorant', lol: 'lol', launcher: '', browser: '', lookalike: '' });
});

test('watcher exposes process liveness and invalidates foreground metadata on helper exit while preserving geometry', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/windows.js'), 'utf8');
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const lines = new EventEmitter(), updates = [];
  const module = { exports: {} };
  vm.runInNewContext(source, { require(name) {
    if (name === 'node:child_process') return { spawn: () => child };
    if (name === 'node:readline') return { createInterface: () => lines };
    if (name === 'electron') return { screen: { screenToDipRect: (window, rect) => rect } };
    return require(name);
  }, module, exports: module.exports, __dirname: path.join(__dirname, '../src/main'), process: { platform: 'win32', pid: 1 }, console: { error() {} }, setTimeout: () => 1 });
  const handle = Buffer.alloc(8); handle.writeBigUInt64LE(1n);
  const watcher = module.exports.startWindowWatch({ overlay: { getNativeWindowHandle: () => handle, getBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }), isDestroyed: () => false }, onUpdate: value => updates.push(value) });
  assert.equal(watcher.isRunning(), true);
  lines.emit('line', JSON.stringify({ fg: 123, game: 'Valorant', riot: active('valorant'), wins: [{ id: 5, x: 10, y: 20, w: 640, h: 360 }], usb: [] }));
  assert.equal(updates.at(-1).game, 'Valorant'); assert.equal(updates.at(-1).riot.game, 'valorant');
  const wins = updates.at(-1).wins;
  child.emit('exit', 1);
  assert.equal(watcher.isRunning(), false); assert.equal(updates.at(-1).game, null); assert.equal(updates.at(-1).riot, null);
  assert.deepEqual(updates.at(-1).wins, wins); assert.equal(updates.at(-1).fg, null);
  watcher.stop();
});
