'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { create, listAddresses, allowedAddress, validPet, parseInvitation, createCodec, frame } = require('../src/main/companion-visits');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, ms = 1500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (predicate()) return; await wait(5); }
  throw new Error('Local visits fixture timed out');
}
const pet = { name: 'Капри', mood: 'happy', facing: 1, scale: 0.6 };
function service(t, options = {}) {
  const states = [];
  const { timings = {}, ...rest } = options;
  const instance = create({ interfaces: () => ({}), getConfig: () => ({ visitsName: 'Local Capri' }),
    onState: state => states.push(state), timings: { handshake: 350, handoff: 200, heartbeat: 40, lease: 500, ...timings }, ...rest });
  t.after(() => instance.stop());
  return { instance, states };
}
async function pair(t, options = {}) {
  const host = service(t, options.host), client = service(t, options.client);
  const invitation = await host.instance.invite({ address: '127.0.0.1', port: 0, name: 'Host' });
  assert.equal(invitation.ok, true);
  assert.equal((await client.instance.join(invitation.code, { name: 'Client' })).ok, true);
  assert.equal(host.instance.getState().paired, true); assert.equal(client.instance.getState().paired, true);
  return { host, client, invitation };
}

test('only private LAN, known Radmin and loopback interfaces can be selected', async t => {
  const options = listAddresses({ Ethernet: [{ family: 'IPv4', address: '192.168.1.12' }, { family: 'IPv4', address: '8.8.8.8' }],
    'Radmin VPN': [{ family: 'IPv4', address: '26.12.34.56' }], UnknownPublic: [{ family: 'IPv4', address: '26.1.1.1' }] });
  assert.equal(options[0].address, '26.12.34.56'); assert.equal(options[0].kind, 'radmin');
  assert.deepEqual(options.map(item => item.address), ['26.12.34.56', '192.168.1.12', '127.0.0.1']);
  for (const address of ['0.0.0.0', '8.8.8.8', '1.1.1.1', 'example.com', '::1', '172.32.0.1']) assert.equal(allowedAddress(address), false);
  const local = service(t).instance;
  assert.equal(local.getState().listening, false);
  assert.equal((await local.listen({ address: '0.0.0.0' })).code, 'unsafe-address');
  assert.equal((await local.listen({ address: '10.99.99.99' })).code, 'unsafe-address');
  assert.equal(local.getState().listening, false);
});

test('invitations are high entropy, expire, reject public/DNS endpoints and never enter status snapshots', async t => {
  const host = service(t).instance;
  const invitation = await host.invite({ address: '127.0.0.1', port: 0 });
  const parsed = parseInvitation(invitation.code);
  assert.equal(parsed.ok, true); assert.equal(parsed.key.length, 43); assert.equal(Buffer.from(parsed.key, 'base64url').length, 32);
  assert.ok(invitation.code.length <= 1024);
  assert.doesNotMatch(JSON.stringify(host.getState()), new RegExp(parsed.key));
  assert.equal(parseInvitation(invitation.code, parsed.expiresAt).code, 'expired-invite');
  for (const host of ['8.8.8.8', 'example.com', '0.0.0.0']) {
    const value = { ...parsed }; delete value.ok; value.host = host;
    assert.equal(parseInvitation('capri1.' + Buffer.from(JSON.stringify(value)).toString('base64url')).ok, false);
  }
  const rotated = await host.invite({ address: '127.0.0.1', port: 0 });
  assert.notEqual(rotated.code, invitation.code);
});

test('AES-GCM uses fresh directional session keys and rejects alteration, replay and reflection', () => {
  const key = crypto.randomBytes(32), c = crypto.randomBytes(32), s = crypto.randomBytes(32);
  const client = createCodec(key, c, s, 'client'), server = createCodec(key, c, s, 'server');
  const message = client.seal({ type: 'hello', name: 'Client' });
  assert.doesNotMatch(JSON.stringify(message), /Client|hello/);
  assert.deepEqual(server.open(message), { type: 'hello', name: 'Client' });
  assert.throws(() => server.open(message));
  assert.throws(() => client.open(message));
  const otherSession = createCodec(key, c, crypto.randomBytes(32), 'server');
  assert.throws(() => otherSession.open(message));
  const next = client.seal({ type: 'heartbeat', awayVisitId: null, guestVisitId: null });
  assert.throws(() => server.open({ ...next, tag: crypto.randomBytes(16).toString('base64url') }));
  assert.deepEqual(server.open(next), { type: 'heartbeat', awayVisitId: null, guestVisitId: null });
  client.destroy(); assert.throws(() => client.seal({ type: 'bye' }));
});

test('actual TCP pairing, acknowledged handoff, return and one-use invitation preserve home ownership', async t => {
  const { host, client, invitation } = await pair(t);
  assert.equal(client.instance.getState().away, false);
  assert.equal(host.instance.getState().guest, null);
  assert.equal((await client.instance.visit(pet)).ok, true);
  assert.equal(client.instance.getState().away, true);
  assert.deepEqual(Object.fromEntries(Object.entries(host.instance.getState().guest).filter(([key]) => key !== 'visitId')), pet);
  assert.equal((await client.instance.visit(pet)).code, 'already-away');
  assert.equal((await client.instance.returnHome()).ok, true);
  await until(() => host.instance.getState().guest === null);
  assert.equal(client.instance.getState().away, false);
  await client.instance.disconnect(); await until(() => !host.instance.getState().paired);
  assert.equal(host.instance.getState().listening, true);
  const again = await client.instance.join(invitation.code);
  assert.equal(again.ok, false);
  assert.equal(client.instance.getState().away, false);
});

test('the receiver can send a guest home, and disconnect restores both desktops', async t => {
  const { host, client } = await pair(t);
  await client.instance.visit(pet);
  await host.instance.returnHome();
  await until(() => !client.instance.getState().away);
  assert.equal(host.instance.getState().guest, null);
  await client.instance.visit(pet);
  await host.instance.disconnect();
  await until(() => !client.instance.getState().paired);
  assert.equal(client.instance.getState().away, false); assert.equal(host.instance.getState().guest, null);
  assert.equal(host.instance.getState().away, false); assert.equal(client.instance.getState().guest, null);
});

test('no invalid or additional pet fields can cross the network', async t => {
  const { host, client } = await pair(t);
  for (const invalid of [
    { ...pet, name: 'x'.repeat(25) }, { ...pet, mood: 'run_command' }, { ...pet, facing: 0 },
    { ...pet, scale: 3 }, { ...pet, scale: NaN }, { ...pet, apiKey: 'must never be sent' }, { ...pet, file: 'private-file' },
  ]) {
    assert.equal(validPet(invalid), false); assert.equal((await client.instance.visit(invalid)).code, 'invalid-pet');
    assert.equal(host.instance.getState().guest, null); assert.equal(client.instance.getState().away, false);
  }
});

test('stopping closes the listener and returns the visiting pet without persistence', async t => {
  const { host, client } = await pair(t);
  await client.instance.visit(pet);
  const port = Number(host.instance.getState().endpoint.split(':')[1]);
  await host.instance.stop(); await until(() => !client.instance.getState().paired);
  assert.equal(client.instance.getState().away, false); assert.equal(host.instance.getState().guest, null);
  const socket = net.createConnection({ host: '127.0.0.1', port });
  const [error] = await once(socket, 'error'); assert.equal(error.code, 'ECONNREFUSED'); socket.destroy();
});

async function proxy(t, targetPort, transform) {
  const connections = new Set(), wire = [];
  const server = net.createServer(client => {
    const target = net.createConnection({ host: '127.0.0.1', port: targetPort });
    connections.add(client); connections.add(target);
    for (const socket of [client, target]) {
      socket.on('error', () => { client.destroy(); target.destroy(); });
      socket.on('close', () => { connections.delete(socket); client.destroy(); target.destroy(); });
    }
    const relay = (from, to, direction) => {
      let buffer = Buffer.alloc(0);
      from.on('data', chunk => {
        wire.push(Buffer.from(chunk)); buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE(0) + 4) {
          const length = buffer.readUInt32BE(0), packet = buffer.subarray(0, length + 4); buffer = buffer.subarray(length + 4);
          const value = JSON.parse(packet.subarray(4).toString('utf8'));
          const result = transform(value, direction, packet);
          for (const bytes of result === undefined ? [packet] : result || []) to.write(bytes);
        }
      });
    };
    relay(client, target, 'client'); relay(target, client, 'server');
  });
  server.listen({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  t.after(async () => { for (const socket of connections) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { port: server.address().port, wire };
}
async function pairWithProxy(t, transform, timings = {}) {
  const host = service(t, { timings }), invitation = await host.instance.invite({ address: '127.0.0.1', port: 0 });
  const bridge = await proxy(t, parseInvitation(invitation.code).port, transform);
  const client = service(t, { timings, connect: () => net.createConnection({ host: '127.0.0.1', port: bridge.port }) });
  assert.equal((await client.instance.join(invitation.code)).ok, true);
  return { host, client, bridge };
}

test('lost offer ACK keeps the local pet home and never exposes a reserved guest', async t => {
  const f = await pairWithProxy(t, (value, direction) => direction === 'server' && value.type === 'sealed' && value.seq >= 2 ? [] : undefined,
    { handoff: 80, heartbeat: 1000, lease: 4000 });
  const result = await f.client.instance.visit(pet);
  assert.equal(result.code, 'handoff-timeout');
  assert.equal(f.client.instance.getState().away, false); assert.equal(f.host.instance.getState().guest, null);
  assert.equal(f.client.states.some(state => state.away), false);
});

test('lost commit ACK rolls ownership back and removes the remote guest', async t => {
  const f = await pairWithProxy(t, (value, direction) => direction === 'server' && value.type === 'sealed' && value.seq >= 3 ? [] : undefined,
    { handoff: 100, heartbeat: 1000, lease: 4000 });
  const result = await f.client.instance.visit(pet);
  assert.equal(result.code, 'handoff-timeout');
  await until(() => f.host.instance.getState().guest === null);
  assert.equal(f.client.instance.getState().away, false);
  assert.equal(f.client.states.some(state => state.away), true, 'source leaves only after the first authenticated acceptance');
});

test('replayed encrypted visit on actual TCP is rejected and both pets remain home', async t => {
  let replayed = false;
  const f = await pairWithProxy(t, (value, direction, packet) => {
    if (!replayed && direction === 'client' && value.type === 'sealed' && value.seq === 2) { replayed = true; return [packet, packet]; }
  });
  assert.equal((await f.client.instance.visit({ ...pet, name: 'SECRET_PET_NAME' })).ok, false);
  await until(() => !f.host.instance.getState().paired && !f.client.instance.getState().paired);
  assert.equal(replayed, true); assert.equal(f.host.instance.getState().guest, null); assert.equal(f.client.instance.getState().away, false);
  assert.doesNotMatch(Buffer.concat(f.bridge.wire).toString('utf8'), /SECRET_PET_NAME/);
});

test('heartbeat lease expiration restores home even while TCP remains half-alive', async t => {
  let paused = false;
  const f = await pairWithProxy(t, () => paused ? [] : undefined, { handoff: 150, heartbeat: 20, lease: 120 });
  assert.equal((await f.client.instance.visit(pet)).ok, true); paused = true;
  await until(() => !f.client.instance.getState().paired && !f.host.instance.getState().paired);
  assert.equal(f.client.instance.getState().away, false); assert.equal(f.host.instance.getState().guest, null);
});

async function rawPeer(t, options = {}) {
  const host = service(t, options), invitation = await host.instance.invite({ address: '127.0.0.1', port: 0 });
  const decoded = parseInvitation(invitation.code), socket = net.createConnection({ host: '127.0.0.1', port: decoded.port });
  t.after(() => socket.destroy()); socket.on('error', () => {});
  let buffer = Buffer.alloc(0); const packets = [];
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE(0) + 4) {
      const length = buffer.readUInt32BE(0); packets.push(JSON.parse(buffer.subarray(4, length + 4).toString('utf8'))); buffer = buffer.subarray(length + 4);
    }
  });
  await once(socket, 'connect');
  const nonce = crypto.randomBytes(32);
  socket.write(frame({ type: 'hello', v: 1, id: decoded.id, nonce: nonce.toString('base64url') }));
  await until(() => packets.length > 0);
  const challenge = packets.shift(), codec = createCodec(Buffer.from(decoded.key, 'base64url'), nonce, Buffer.from(challenge.nonce, 'base64url'), 'client');
  socket.write(frame(codec.seal({ type: 'hello', name: 'Raw test peer' })));
  await until(() => packets.length > 0); assert.equal(codec.open(packets.shift()).type, 'paired');
  return { host, socket, codec };
}

test('authenticated unknown fields and commands are rejected, never executed or interpreted as UI actions', async t => {
  for (const message of [
    { type: 'visit', requestId: crypto.randomBytes(16).toString('base64url'), visitId: crypto.randomBytes(16).toString('base64url'), pet: { ...pet, command: 'calc.exe' } },
    { type: 'execute', command: 'calc.exe' }, { type: 'chat', text: 'must not reach cloud' }, { type: 'heartbeat', awayVisitId: null, guestVisitId: null, key: 'no keys accepted' },
  ]) {
    const f = await rawPeer(t);
    f.socket.write(frame(f.codec.seal(message)));
    await until(() => !f.host.instance.getState().paired);
    assert.equal(f.host.instance.getState().guest, null); assert.equal(f.host.instance.getState().errorCode, 'protocol');
  }
});

test('oversized frames and packet floods are bounded on actual local TCP', async t => {
  const host = service(t).instance, invitation = await host.invite({ address: '127.0.0.1', port: 0 });
  const socket = net.createConnection({ host: '127.0.0.1', port: parseInvitation(invitation.code).port });
  socket.on('error', () => {}); await once(socket, 'connect');
  const closed = new Promise(resolve => socket.once('close', resolve));
  const header = Buffer.alloc(4); header.writeUInt32BE(16385); socket.write(header); await closed;
  assert.equal(host.getState().paired, false);
  const raw = await rawPeer(t, { timings: { maxPackets: 5 } });
  raw.socket.write(Buffer.concat(Array.from({ length: 8 }, () => frame(raw.codec.seal({ type: 'heartbeat', awayVisitId: null, guestVisitId: null })))));
  await until(() => !raw.host.instance.getState().paired);
  assert.equal(raw.host.instance.getState().errorCode, 'protocol');
});

test('stop during a pending listen or join cannot leave a later socket/listener alive', async t => {
  const local = service(t).instance;
  const pendingListen = local.listen({ address: '127.0.0.1', port: 0 });
  await local.stop(); assert.equal((await pendingListen).ok, false); assert.equal(local.getState().listening, false);
  const host = service(t).instance, invitation = await host.invite({ address: '127.0.0.1', port: 0 });
  const bridge = await proxy(t, parseInvitation(invitation.code).port, () => []);
  const client = service(t, { connect: () => net.createConnection({ host: '127.0.0.1', port: bridge.port }) }).instance;
  const joining = client.join(invitation.code); await client.stop();
  assert.equal((await joining).ok, false); assert.equal(client.getState().paired, false);
  assert.equal(client.getState().away, false); assert.equal(client.getState().connection, 'off');
});

async function halfHandshake(t, invitation) {
  const decoded = parseInvitation(invitation.code), socket = net.createConnection({ host: decoded.host, port: decoded.port });
  t.after(() => socket.destroy()); socket.on('error', () => {});
  let buffer = Buffer.alloc(0); const packets = [];
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE(0) + 4) {
      const length = buffer.readUInt32BE(0); packets.push(JSON.parse(buffer.subarray(4, length + 4))); buffer = buffer.subarray(length + 4);
    }
  });
  await once(socket, 'connect');
  const nonce = crypto.randomBytes(32);
  socket.write(frame({ type: 'hello', v: 1, id: decoded.id, nonce: nonce.toString('base64url') }));
  await until(() => packets.length > 0);
  const challenge = packets.shift(), codec = createCodec(Buffer.from(decoded.key, 'base64url'), nonce, Buffer.from(challenge.nonce, 'base64url'), 'client');
  return { socket, codec, authenticate() { socket.write(frame(codec.seal({ type: 'hello', name: 'Delayed peer' }))); } };
}

test('an expired or rotated invitation cannot authenticate after an earlier valid challenge', async t => {
  const rotating = service(t).instance, original = await rotating.invite({ address: '127.0.0.1', port: 0 });
  const oldPeer = await halfHandshake(t, original);
  const current = await rotating.invite({ address: '127.0.0.1', port: 0 });
  oldPeer.authenticate(); await until(() => oldPeer.socket.destroyed);
  assert.equal(rotating.getState().paired, false);
  const legit = service(t).instance; assert.equal((await legit.join(current.code)).ok, true);
  const expiring = service(t, { timings: { invite: 70, handshake: 500 } }).instance;
  const shortInvite = await expiring.invite({ address: '127.0.0.1', port: 0 }), delayed = await halfHandshake(t, shortInvite);
  await wait(90); delayed.authenticate(); await until(() => delayed.socket.destroyed);
  assert.equal(expiring.getState().paired, false); assert.equal(expiring.getState().inviteExpiresAt, null);
});

test('a second pre-challenged connection cannot reuse the invitation after the first peer disconnects', async t => {
  const host = service(t).instance, invitation = await host.invite({ address: '127.0.0.1', port: 0 });
  const first = await halfHandshake(t, invitation), second = await halfHandshake(t, invitation);
  first.authenticate(); await until(() => host.getState().paired);
  first.socket.destroy(); await until(() => !host.getState().paired);
  second.authenticate(); await until(() => second.socket.destroyed);
  assert.equal(host.getState().paired, false); assert.equal(host.getState().guest, null);
});

test('Radmin 26/8 invitations require a local Radmin interface before any outbound connection attempt', async t => {
  const base = await service(t).instance.invite({ address: '127.0.0.1', port: 0 }), value = { ...parseInvitation(base.code) };
  delete value.ok; value.host = '26.12.34.56';
  const code = 'capri1.' + Buffer.from(JSON.stringify(value)).toString('base64url');
  let attempts = 0;
  const noRadmin = service(t, { connect: () => { attempts++; throw new Error('must not connect'); } }).instance;
  assert.equal((await noRadmin.join(code)).code, 'unsafe-address'); assert.equal(attempts, 0);
  const withRadmin = service(t, { interfaces: () => ({ 'Radmin VPN': [{ family: 'IPv4', address: '26.10.20.30' }] }),
    connect: () => { attempts++; throw new Error('mock connection failure, no actual external I/O'); } }).instance;
  assert.equal((await withRadmin.join(code)).code, 'connection-failed'); assert.equal(attempts, 1);
});

test('an unpaired listener can move to another selected port without leaking the old listener', async t => {
  const host = service(t).instance, old = await host.invite({ address: '127.0.0.1', port: 0 });
  const oldPort = parseInvitation(old.code).port;
  const reserved = net.createServer(); reserved.listen({ host: '127.0.0.1', port: 0 }); await once(reserved, 'listening');
  const newPort = reserved.address().port; await new Promise(resolve => reserved.close(resolve));
  const invitation = await host.invite({ address: '127.0.0.1', port: newPort });
  assert.equal(invitation.ok, true); assert.equal(parseInvitation(invitation.code).port, newPort);
  const socket = net.createConnection({ host: '127.0.0.1', port: oldPort });
  const [error] = await once(socket, 'error'); assert.equal(error.code, 'ECONNREFUSED'); socket.destroy();
  const client = service(t).instance; assert.equal((await client.join(invitation.code)).ok, true);
});

test('state callbacks may cancel join/invite synchronously without later network I/O or revoked invitation output', async t => {
  const host = service(t).instance, invitation = await host.invite({ address: '127.0.0.1', port: 0 });
  for (const action of ['stop', 'disconnect']) {
    let client, attempts = 0;
    client = create({ interfaces: () => ({}), onState: state => { if (state.connection === 'connecting') client[action](); },
      connect: () => { attempts++; throw new Error('must not connect after cancellation'); } });
    t.after(() => client.stop());
    assert.equal((await client.join(invitation.code)).ok, false);
    assert.equal(attempts, 0); assert.equal(client.getState().connection, 'off');
  }
  let cancelling;
  cancelling = create({ interfaces: () => ({}), onState: state => { if (state.inviteExpiresAt) cancelling.disconnect(); } });
  t.after(() => cancelling.stop());
  const result = await cancelling.invite({ address: '127.0.0.1', port: 0 });
  assert.equal(result.ok, false); assert.equal(result.code, 'stopped');
  assert.equal(cancelling.getState().inviteExpiresAt, null);
});
