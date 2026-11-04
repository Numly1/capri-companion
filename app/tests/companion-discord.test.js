'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once, EventEmitter } = require('node:events');
const { create, validId, parseId, clientIdFor, imageFor, activityFor, statusLine, frame } = require('../src/main/companion-discord');
const sharedApp = require('../src/main/companion-discord-app');
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

test('disabled Discord never opens a socket; a shared identity needs no personal application', async () => {
  let calls = 0, cfg = {};
  const service = create({ schedule: false, getConfig: () => cfg, connect: () => { calls++; throw new Error('unexpected'); } });
  await service.tick(); cfg = { discordPresence: false, discordClientId: 'secret-not-an-id' }; await service.tick();
  assert.equal(calls, 0); assert.equal(service.getState().state, 'off'); service.stop();
  assert.equal(clientIdFor({}), sharedApp.CLIENT_ID);
  assert.equal(clientIdFor({ discordClientId: '123456789012345678' }), '123456789012345678');
  const saved = sharedApp.CLIENT_ID;
  try {
    sharedApp.CLIENT_ID = '';
    const missing = create({ schedule: false, getConfig: () => ({ discordPresence: true }), connect: () => { throw new Error('must not connect'); } });
    await missing.tick(); assert.equal(missing.getState().state, 'needs-id'); missing.stop();
  } finally { sharedApp.CLIENT_ID = saved; }
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

test('public application links, owned image URLs and richer activity states stay bounded', () => {
  assert.equal(parseId(' https://discord.com/developers/applications/1565710348860784701/information '), '1565710348860784701');
  for (const value of ['https://evil.example/developers/applications/1565710348860784701', 'http://discord.com/developers/applications/1565710348860784701',
    'https://user:password@discord.com/developers/applications/1565710348860784701', 'gsk_not_a_public_id']) assert.equal(parseId(value), '');
  const app = { APPLICATION_NAME: 'Capri', PRESENCE_IMAGE_URL: 'https://raw.githubusercontent.com/example/capri/main/run.gif' };
  const movie = activityFor({ discordShareActivity: true }, { watching: { playing: true, title: 'Фильм' } }, app);
  assert.equal(movie.type, 3); assert.equal(movie.assets.large_image, app.PRESENCE_IMAGE_URL);
  assert.equal(activityFor({ discordShareActivity: true }, { watching: { playing: true, title: 'X' } }).state, '«X»');
  for (const [game, details] of [['Valorant', 'Играет в Valorant'], ['League of Legends', 'Играет в League of Legends'], ['Space Station 14', 'Играет в Space Station 14']])
    assert.equal(activityFor({ discordShareActivity: true }, { game }).details, details);
  assert.equal(activityFor({ discordShareActivity: true }, { drawing: { app: 'Krita' } }).details, 'Рисует в Krita');
  assert.equal(activityFor({ discordShareActivity: true }, { drawing: { app: 'private-file-name' } }).details, 'Капри рядом');
  const music = { music: { title: 'Песня', artist: 'Артист', playing: true, album: 'PRIVATE_ALBUM', cover: 'PRIVATE_COVER' } };
  assert.equal(activityFor({ discordShareActivity: true }, music).details, 'Капри рядом');
  const listening = activityFor({ discordShareActivity: true, discordShareMusic: true }, music);
  assert.equal(listening.type, 2); assert.equal(listening.state, 'Артист — Песня');
  assert.doesNotMatch(JSON.stringify(listening), /PRIVATE_/);
  assert.doesNotMatch(activityFor({ discordShareActivity: true }, { watching: { playing: true, title: '💜'.repeat(150) } }).state, /\ud800(?![\udc00-\udfff])/);
  assert.equal([...activityFor({ discordShareActivity: true }, { watching: { playing: true, title: '💜'.repeat(150) } }).state].length, 110);
  assert.equal(imageFor({ PRESENCE_IMAGE_URL: 'file:///private/file', LARGE_IMAGE_KEY: '' }), null);
  assert.equal(imageFor({ PRESENCE_IMAGE_URL: 'https://user:secret@example.com/image.gif', LARGE_IMAGE_KEY: 'owned_static' }), 'owned_static');
});

let fixtureSequence = 0;
async function rpcFixture(t, options = {}) {
  const pipe = '\\\\?\\pipe\\capri-rpc-edge-' + process.pid + '-' + Date.now() + '-' + fixtureSequence++;
  const server = net.createServer(); const clients = new Set(); const received = [];
  let at = 0, latestSocket = null, service;
  const cfg = { discordPresence: true, discordClientId: '123456789012345678', discordShareActivity: true };
  const context = { watching: { playing: true, title: 'Тестовый фильм' } };
  server.on('connection', socket => {
    latestSocket = socket; clients.add(socket); socket.on('error', () => {}); socket.on('close', () => clients.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8 && buffer.length >= 8 + buffer.readUInt32LE(4)) {
        const op = buffer.readUInt32LE(0), length = buffer.readUInt32LE(4);
        const bytes = buffer.subarray(8, 8 + length); buffer = buffer.subarray(8 + length);
        const body = op === 0 || op === 1 ? JSON.parse(bytes) : bytes;
        received.push({ op, body });
        if (op === 0) {
          if (options.onHandshake) options.onHandshake(socket);
          else socket.write(frame(1, { evt: 'READY', data: { user: { username: 'PRIVATE_USER' } } }));
        } else if (op === 1 && body.cmd === 'SET_ACTIVITY') {
          if (body.args.activity === null || !options.onActivity) socket.write(frame(1, { cmd: 'SET_ACTIVITY', nonce: body.nonce, data: {} }));
          else options.onActivity(body, socket);
        }
      }
    });
  });
  t.after(async () => { service?.stop(); for (const socket of clients) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  server.listen(pipe); await once(server, 'listening');
  let probes = 0;
  service = create({ schedule: false, now: () => at, getConfig: () => cfg, getContext: () => context,
    limits: { connect: 50, handshake: 100, ack: 100, ...options.limits },
    connect: request => { assert.match(request.path, /^\\\\\?\\pipe\\discord-ipc-\d$/); probes++; return net.createConnection(pipe); } });
  await service.tick();
  return { service, cfg, context, received, advance: value => { at += value; }, get socket() { return latestSocket; }, get probes() { return probes; } };
}

test('rejected activity is not acknowledged by stale replies or resent in a background error loop', async t => {
  let count = 0, rejectedNonce;
  const f = await rpcFixture(t, { onActivity(body, socket) {
    count++;
    if (count === 1) {
      rejectedNonce = body.nonce;
      socket.write(frame(1, { cmd: 'SET_ACTIVITY', evt: 'ERROR', nonce: body.nonce, data: { code: 4000, message: 'PRIVATE_DIAGNOSTIC' } }));
    } else socket.write(frame(1, { cmd: 'SET_ACTIVITY', nonce: body.nonce, data: {} }));
  } });
  await waitFor(() => f.service.getState().state === 'rejected');
  assert.equal(f.service.getState().error, 'invalid-activity');
  f.socket.write(frame(1, { cmd: 'SET_ACTIVITY', nonce: rejectedNonce, data: {} }));
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.service.getState().state, 'rejected');
  f.advance(60000); await f.service.tick(); assert.equal(count, 1);
  f.context.watching.title = 'Другой фильм'; await f.service.tick();
  await waitFor(() => f.service.getState().state === 'active'); assert.equal(count, 2);
  assert.doesNotMatch(JSON.stringify(f.service.getState()), /PRIVATE_DIAGNOSTIC|PRIVATE_USER|Другой фильм/);
});

test('rate limiting waits before resending, and only the current nonce can confirm an update', async t => {
  const requests = [];
  const f = await rpcFixture(t, { limits: { ack: 500 }, onActivity(body, socket) {
    requests.push(body);
    if (requests.length === 1) socket.write(frame(1, { cmd: 'SET_ACTIVITY', evt: 'ERROR', nonce: body.nonce,
      data: { code: 1000, message: 'rate limited PRIVATE_DIAGNOSTIC' } }));
  } });
  await waitFor(() => f.service.getState().state === 'rate-limited');
  f.advance(29999); await f.service.tick(); assert.equal(requests.length, 1);
  f.advance(1); await f.service.tick(); await waitFor(() => requests.length === 2);
  f.socket.write(frame(1, { cmd: 'SET_ACTIVITY', nonce: requests[0].nonce, data: {} }));
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.service.getState().state, 'connected');
  f.socket.write(frame(1, { cmd: 'SET_ACTIVITY', nonce: requests[1].nonce, data: {} }));
  await waitFor(() => f.service.getState().state === 'active');
  assert.doesNotMatch(JSON.stringify(f.service.getState()), /PRIVATE_/);
});

test('missing ACK times out and reconnects with the same payload instead of losing it forever', async t => {
  let requests = 0;
  const f = await rpcFixture(t, { limits: { ack: 40 }, onActivity(body, socket) {
    if (++requests > 1) socket.write(frame(1, { cmd: 'SET_ACTIVITY', nonce: body.nonce, data: {} }));
  } });
  await waitFor(() => f.service.getState().error === 'ack-timeout');
  assert.equal(f.service.getState().state, 'not-running');
  const probes = f.probes; await f.service.tick(); assert.equal(f.probes, probes);
  f.advance(15000); await f.service.tick();
  await waitFor(() => f.service.getState().state === 'active');
  assert.equal(requests, 2); assert.equal(f.probes, 2);
});

test('invalid application close blocks automatic attempts until an explicit retry', async t => {
  const f = await rpcFixture(t, { onHandshake(socket) { socket.write(frame(2, { code: 4000, message: 'PRIVATE_DETAIL' })); } });
  await waitFor(() => f.service.getState().state === 'rejected');
  assert.equal(f.service.getState().error, 'invalid-id');
  f.advance(600000); await f.service.tick(); assert.equal(f.probes, 1);
  await f.service.retry(); await waitFor(() => f.probes === 2 && f.service.getState().state === 'rejected');
  assert.doesNotMatch(JSON.stringify(f.service.getState()), /PRIVATE_DETAIL/);
  assert.match(statusLine(f.service.getState()), /Application ID/);
});

test('silent handshakes and malformed IPC frames disconnect cleanly with bounded errors', async t => {
  const silent = await rpcFixture(t, { limits: { handshake: 30 }, onHandshake() {} });
  await waitFor(() => silent.service.getState().error === 'handshake-timeout');
  for (const badFrame of [frame(5, {}), frame(1, Buffer.from('{')), (() => { const header = Buffer.alloc(8); header.writeUInt32LE(1, 0); header.writeUInt32LE(65537, 4); return header; })()]) {
    const f = await rpcFixture(t, { onHandshake(socket) { socket.write(badFrame); } });
    await waitFor(() => f.service.getState().error === 'protocol');
    assert.equal(f.service.getState().state, 'not-running');
  }
});
