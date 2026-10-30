'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once, EventEmitter } = require('node:events');
const { create, validId, activityFor, frame } = require('../src/main/companion-discord');
const waitFor = async predicate => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Discord fixture timed out');
};

test('Discord presence only includes the explicitly enabled bounded activity', () => {
  const context = { game: 'Minecraft', watching: { playing: true, title: 'PRIVATE_TITLE' }, pet: { mode: 'sleep' }, apiKeys: { secret: 'PRIVATE_KEY' } };
  assert.doesNotMatch(JSON.stringify(activityFor({}, context)), /Minecraft|PRIVATE_/);
  assert.equal(activityFor({ discordShareActivity: true }, context).details, 'Играет в Minecraft');
  assert.equal(activityFor({ discordShareActivity: true }, { game: 'C:\\Users\\secret\\UnknownGame' }).details, 'Играет');
  const viewing = activityFor({ discordShareActivity: true }, { watching: { playing: true, title: 'a'.repeat(1000) } });
  assert.equal(viewing.state.length, 110);
  assert.equal(validId('123456789012345678'), true);
  for (const id of ['', 'gsk_test', '123', 123456789012345678n]) assert.equal(validId(id), false);
});

test('real Windows IPC handshakes, fragmented READY, ping, activity ACK and clear without any account token', async t => {
  const pipe = '\\\\?\\pipe\\capri-rpc-test-' + process.pid + '-' + Date.now();
  const server = net.createServer();
  const clients = new Set(); const received = [];
  t.after(() => { for (const socket of clients) socket.destroy(); server.close(); });
  server.on('connection', socket => {
    clients.add(socket); socket.on('close', () => clients.delete(socket)); socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8 && buffer.length >= 8 + buffer.readUInt32LE(4)) {
        const op = buffer.readUInt32LE(0), length = buffer.readUInt32LE(4);
        const bytes = buffer.subarray(8, 8 + length); buffer = buffer.subarray(8 + length);
        received.push({ op, body: op === 4 ? bytes.toString() : JSON.parse(bytes) });
        if (op === 0) {
          const ready = frame(1, { evt: 'READY', data: { user: { username: 'NOT_RETAINED' } } });
          socket.write(ready.subarray(0, 5)); setTimeout(() => socket.write(Buffer.concat([ready.subarray(5), frame(3, Buffer.from('ping'))])), 10);
        } else if (op === 1) socket.write(frame(1, { cmd: 'SET_ACTIVITY', nonce: JSON.parse(bytes).nonce, data: {} }));
      }
    });
  });
  server.listen(pipe); await once(server, 'listening');
  let at = 0; let cfg = { discordPresence: true, discordClientId: '123456789012345678', discordShareActivity: true };
  let probes = 0;
  const service = create({ schedule: false, now: () => at, getConfig: () => cfg,
    getContext: () => ({ watching: { title: 'Тестовый фильм', playing: true } }),
    connect: options => { assert.match(options.path, /^\\\\\?\\pipe\\discord-ipc-\d$/); probes++; return net.createConnection(pipe); } });
  t.after(() => service.stop());
  await service.tick(); await waitFor(() => service.getState().state === 'active' && received.some(value => value.op === 4));
  assert.deepEqual(received[0].body, { v: 1, client_id: cfg.discordClientId });
  assert.equal(received.find(value => value.body.cmd === 'SET_ACTIVITY').body.args.activity.state, 'Тестовый фильм');
  assert.equal(received.find(value => value.op === 4).body, 'ping');
  await service.tick(); assert.equal(received.filter(value => value.body.cmd === 'SET_ACTIVITY').length, 1);
  at += 15000; cfg = { ...cfg, discordShareActivity: false }; await service.tick();
  await waitFor(() => received.filter(value => value.body.cmd === 'SET_ACTIVITY').length === 2);
  assert.doesNotMatch(JSON.stringify(received.at(-1)), /Тестовый фильм/);
  cfg = { ...cfg, discordPresence: false }; await service.tick();
  await waitFor(() => received.some(value => value.body.args?.activity === null));
  assert.equal(service.getState().state, 'off'); assert.equal(probes, 1);
  assert.doesNotMatch(JSON.stringify(service.getState()), /NOT_RETAINED|Тестовый фильм/);
  assert.equal(received.some(value => /AUTH|SUBSCRIBE/.test(value.body.cmd || '')), false);
});

test('disabled or unconfigured Discord never opens a socket', async () => {
  let calls = 0, cfg = {};
  const service = create({ schedule: false, getConfig: () => cfg, connect: () => { calls++; throw new Error('unexpected'); } });
  await service.tick(); cfg = { discordPresence: true, discordClientId: 'secret-not-an-id' }; await service.tick();
  assert.equal(calls, 0); assert.equal(service.getState().state, 'needs-id'); service.stop();
});

test('disabling while a local pipe connection is pending keeps status off and discards the socket', async () => {
  let cfg = { discordPresence: true, discordClientId: '123456789012345678' };
  const socket = new EventEmitter();
  let destroyed = false, writes = 0;
  socket.destroy = () => { destroyed = true; };
  socket.write = () => { writes++; };
  const service = create({ schedule: false, getConfig: () => cfg, connect: () => socket });
  const pending = service.tick();
  cfg = { ...cfg, discordPresence: false };
  await service.tick();
  assert.equal(service.getState().state, 'off');
  socket.emit('connect'); await pending;
  assert.equal(service.getState().state, 'off');
  assert.equal(service.getState().enabled, false);
  assert.equal(destroyed, true); assert.equal(writes, 0);
  service.stop();
});
