'use strict';

// Explicit one-peer desktop-pet visits over a selected LAN/Radmin IPv4 interface.
// All secrets are memory-only; no remote files, commands, chat, screenshots or API keys.
const net = require('node:net');
const os = require('node:os');
const crypto = require('node:crypto');

const PORT = 47826;
const MAX_FRAME = 16384;
const INVITE_TTL = 10 * 60000;
const MOODS = new Set(['idle', 'happy', 'curious', 'sleep']);
const MESSAGES = Object.freeze({
  stopped: 'Визиты выключены. Открой их заново через меню Капри.',
  'unsafe-address': 'Выбери адрес локальной сети или адаптера Radmin VPN.',
  'cannot-listen': 'Не получилось открыть этот адрес и порт. Проверь, что адрес принадлежит этому компьютеру и порт свободен.',
  'invalid-invite': 'Не получилось прочитать приглашение. Скопируй его целиком.',
  'expired-invite': 'Это приглашение уже истекло. Попроси новое.',
  'invite-unavailable': 'Приглашение уже использовано или отменено. Попроси новое.',
  'already-paired': 'Капри уже соединена с другом. Сначала отключи текущее соединение.',
  'self-invite': 'Это приглашение с этого же компьютера. Отправь его другу.',
  'not-paired': 'Сначала соедини Капри с другом по приглашению.',
  'already-away': 'Капри уже в гостях или собирается в путь.',
  busy: 'На другом рабочем столе уже есть гость. Попробуй чуть позже.',
  'invalid-pet': 'Параметры гостя не подходят. Попробуй отправить Капри ещё раз.',
  'connection-failed': 'Не получилось соединиться. Проверь Radmin VPN, адрес друга и разрешение Капри в брандмауэре Windows.',
  'connection-lost': 'Связь пропала. Капри вернулась домой.',
  'handshake-failed': 'Приглашение не подошло или соединение не подтвердилось. Попроси новое приглашение.',
  'handoff-timeout': 'Визит не подтвердился вовремя. Капри осталась дома.',
  protocol: 'Соединение закрыто: получены неподдерживаемые данные. Капри дома.',
});
const fail = code => ({ ok: false, code, error: MESSAGES[code] || MESSAGES.protocol });
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));
const token = (value, bytes) => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)
  && Buffer.from(value, 'base64url').length === bytes && Buffer.from(value, 'base64url').toString('base64url') === value;
const nameFor = value => typeof value === 'string' ? [...value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().normalize('NFC')].slice(0, 24).join('') : '';
function allowedAddress(address) {
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 127 || a === 10 || a === 26 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
function listAddresses(interfaces = os.networkInterfaces()) {
  const found = [];
  for (const [label, entries] of Object.entries(interfaces || {})) for (const entry of entries || []) {
    if (!(entry.family === 'IPv4' || entry.family === 4) || entry.internal || !allowedAddress(entry.address)) continue;
    const radmin = entry.address.startsWith('26.') && /radmin|famatech/i.test(label);
    if (entry.address.startsWith('26.') && !radmin) continue;
    if (!found.some(item => item.address === entry.address)) found.push({ address: entry.address, label: `${radmin ? 'Radmin VPN' : label} · ${entry.address}`, kind: radmin ? 'radmin' : 'lan' });
  }
  found.sort((a, b) => (a.kind === 'radmin' ? 0 : 1) - (b.kind === 'radmin' ? 0 : 1));
  found.push({ address: '127.0.0.1', label: 'Этот компьютер · проверка', kind: 'loopback' });
  return found;
}
function validPet(value) {
  return exact(value, ['name', 'mood', 'facing', 'scale']) && value.name === nameFor(value.name) && Boolean(value.name)
    && MOODS.has(value.mood) && (value.facing === -1 || value.facing === 1)
    && typeof value.scale === 'number' && Number.isFinite(value.scale) && value.scale >= 0.4 && value.scale <= 0.8;
}
function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_FRAME) throw new Error('frame_size');
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
function createCodec(key, clientNonce, serverNonce, role) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || !Buffer.isBuffer(clientNonce) || clientNonce.length !== 32
      || !Buffer.isBuffer(serverNonce) || serverNonce.length !== 32 || !['client', 'server'].includes(role)) throw new Error('key_material');
  const salt = Buffer.concat([clientNonce, serverNonce]);
  const directions = role === 'client' ? ['client-to-server', 'server-to-client'] : ['server-to-client', 'client-to-server'];
  const keys = directions.map(direction => Buffer.from(crypto.hkdfSync('sha256', key, salt, Buffer.from(`capri-visits-v1/${direction}`), 32)));
  let tx = 0, rx = 0, closed = false;
  const iv = sequence => { const bytes = Buffer.alloc(12); bytes.writeBigUInt64BE(BigInt(sequence), 4); return bytes; };
  const aad = (direction, sequence) => Buffer.from(`capri-visits-v1/${direction}/${sequence}`);
  return {
    seal(value) {
      if (closed || tx >= Number.MAX_SAFE_INTEGER) throw new Error('closed');
      const sequence = ++tx, body = Buffer.from(JSON.stringify(value));
      if (body.length > 8192) throw new Error('payload_size');
      const cipher = crypto.createCipheriv('aes-256-gcm', keys[0], iv(sequence), { authTagLength: 16 });
      cipher.setAAD(aad(directions[0], sequence));
      const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
      return { type: 'sealed', v: 1, seq: sequence, ciphertext: encrypted.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
    },
    open(value) {
      if (closed || !exact(value, ['type', 'v', 'seq', 'ciphertext', 'tag']) || value.type !== 'sealed' || value.v !== 1
          || !Number.isSafeInteger(value.seq) || value.seq !== rx + 1 || !token(value.tag, 16)
          || typeof value.ciphertext !== 'string' || value.ciphertext.length > 11000 || !/^[A-Za-z0-9_-]+$/.test(value.ciphertext)) throw new Error('packet');
      const ciphertext = Buffer.from(value.ciphertext, 'base64url');
      if (ciphertext.toString('base64url') !== value.ciphertext) throw new Error('encoding');
      const decipher = crypto.createDecipheriv('aes-256-gcm', keys[1], iv(value.seq), { authTagLength: 16 });
      decipher.setAAD(aad(directions[1], value.seq)); decipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
      const body = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const result = JSON.parse(body.toString('utf8')); rx = value.seq; return result;
    },
    destroy() { closed = true; keys.forEach(key => key.fill(0)); },
  };
}
function parseInvitation(code, at = Date.now()) {
  if (typeof code !== 'string' || code.length > 1024 || !/^capri1\.[A-Za-z0-9_-]+$/.test(code.trim())) return fail('invalid-invite');
  try {
    const encoded = code.trim().slice(7), bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded || bytes.length > 700) return fail('invalid-invite');
    const invite = JSON.parse(bytes.toString('utf8'));
    if (!exact(invite, ['v', 'host', 'port', 'id', 'key', 'expiresAt', 'name']) || invite.v !== 1 || !allowedAddress(invite.host)
        || !Number.isInteger(invite.port) || invite.port < 1024 || invite.port > 65535 || !token(invite.id, 16) || !token(invite.key, 32)
        || !Number.isSafeInteger(invite.expiresAt) || invite.expiresAt > at + INVITE_TTL + 30000
        || !invite.name || invite.name !== nameFor(invite.name)) return fail('invalid-invite');
    if (invite.expiresAt <= at) return fail('expired-invite');
    return { ok: true, ...invite };
  } catch { return fail('invalid-invite'); }
}

function create({ getConfig = () => ({}), onState = () => {}, interfaces = os.networkInterfaces, now = Date.now,
  connect = options => net.createConnection(options), serverFactory = listener => net.createServer(listener), timings = {} } = {}) {
  const timing = { handshake: 5000, handoff: 5000, heartbeat: 3000, lease: 12000, invite: INVITE_TTL, rateWindow: 10000, maxPackets: 40, ...timings };
  let server = null, listenPending = null, endpoint = null, listenerAddress = null, stopped = false, epoch = 0;
  let invitation = null, inviteTimer = null, paired = null, outgoing = null, incoming = null;
  let awayId = null, awayLease = 0, guest = null, guestLease = 0, selfName = '';
  let errorCode = null, lastSnapshot = '', connecting = false;
  const sockets = new Set();
  const label = () => selfName || nameFor(getConfig().visitsName) || 'Капри';
  const getOptions = () => ({ addresses: listAddresses(interfaces()), port: PORT });
  function getState() {
    return { listening: Boolean(server?.listening), endpoint, paired: Boolean(paired?.authenticated), peerName: paired?.peerName || null,
      connection: paired?.authenticated ? 'paired' : connecting ? 'connecting' : errorCode ? 'error' : server?.listening ? 'listening' : 'off',
      away: Boolean(awayId), guest: guest ? { ...guest } : null, error: errorCode ? MESSAGES[errorCode] || MESSAGES.protocol : null,
      errorCode, inviteExpiresAt: invitation?.expiresAt || null, selfName: label() };
  }
  function emit() {
    const state = getState(), key = JSON.stringify(state);
    if (key === lastSnapshot) return;
    lastSnapshot = key; try { onState(state); } catch { }
  }
  function revokeInvite() { clearTimeout(inviteTimer); invitation?.key.fill(0); invitation = null; }
  function resultError(code) { errorCode = code; emit(); return fail(code); }
  function settleOutgoing(result) {
    const pending = outgoing; outgoing = null;
    if (pending) { clearTimeout(pending.timer); pending.resolve(result); }
  }
  function clearIncoming() { clearTimeout(incoming?.timer); incoming = null; }
  function send(session, message) {
    if (!session || session.closed || !session.codec || session.socket.destroyed) return false;
    try { session.socket.write(frame(session.codec.seal(message))); return true; }
    catch { closeSession(session, 'connection-lost'); return false; }
  }
  function closeSession(session, reason = null) {
    if (!session || session.closed) return;
    session.closed = true; clearTimeout(session.handshakeTimer); clearInterval(session.heartbeatTimer);
    session.sharedKey?.fill(0); session.codec?.destroy();
    if (paired === session) {
      paired = null; awayId = null; awayLease = 0; guest = null; guestLease = 0; clearIncoming(); settleOutgoing(fail(reason || 'connection-lost'));
      errorCode = reason; emit();
    }
    if (session.joinResolve) { const resolve = session.joinResolve; session.joinResolve = null; connecting = false; errorCode = reason || 'connection-failed'; resolve(fail(errorCode)); emit(); }
    sockets.delete(session);
    try { session.socket.destroy(); } catch { }
  }
  function pairedSession(session, peerName) {
    if (paired && paired !== session) return false;
    paired = session; session.authenticated = true; session.peerName = peerName; session.lastSeen = now();
    clearTimeout(session.handshakeTimer); errorCode = null; connecting = false;
    session.heartbeatTimer = setInterval(() => {
      if (session.closed || paired !== session) return;
      const at = now();
      if (at - session.lastSeen >= timing.lease || (awayId && at >= awayLease) || (guest && at >= guestLease)) {
        closeSession(session, 'connection-lost'); return;
      }
      send(session, { type: 'heartbeat', awayVisitId: awayId, guestVisitId: guest?.visitId || null });
    }, timing.heartbeat); session.heartbeatTimer.unref?.(); emit(); return true;
  }
  const validId = value => token(value, 16);
  function handleMessage(session, message) {
    if (!plain(message) || typeof message.type !== 'string') return closeSession(session, 'protocol');
    if (!session.authenticated) {
      if (session.role === 'server' && exact(message, ['type', 'name']) && message.type === 'hello' && message.name === nameFor(message.name) && message.name) {
        if (!invitation || invitation.id !== session.inviteId || invitation.expiresAt <= now()) return closeSession(session, 'invite-unavailable');
        if (!pairedSession(session, message.name)) return closeSession(session, 'already-paired');
        revokeInvite(); send(session, { type: 'paired', name: label(), sessionId: crypto.randomBytes(16).toString('base64url') }); emit(); return;
      }
      if (session.role === 'client' && exact(message, ['type', 'name', 'sessionId']) && message.type === 'paired'
          && message.name === nameFor(message.name) && message.name && validId(message.sessionId)) {
        if (!pairedSession(session, message.name)) return closeSession(session, 'already-paired');
        if (session.joinResolve) { const resolve = session.joinResolve; session.joinResolve = null; resolve({ ok: true }); } return;
      }
      return closeSession(session, 'handshake-failed');
    }
    session.lastSeen = now();
    if (message.type === 'heartbeat' && exact(message, ['type', 'awayVisitId', 'guestVisitId'])
        && (message.awayVisitId === null || validId(message.awayVisitId)) && (message.guestVisitId === null || validId(message.guestVisitId))) {
      if (guest && message.awayVisitId === guest.visitId) guestLease = now() + timing.lease;
      if (awayId && message.guestVisitId === awayId) awayLease = now() + timing.lease;
      return;
    }
    if (message.type === 'visit' && exact(message, ['type', 'requestId', 'visitId', 'pet']) && validId(message.requestId) && validId(message.visitId) && validPet(message.pet)) {
      if (guest || incoming) { send(session, { type: 'visit-ack', requestId: message.requestId, visitId: message.visitId, accepted: false, reason: 'busy' }); return; }
      incoming = { requestId: message.requestId, visitId: message.visitId, pet: { ...message.pet }, timer: null };
      incoming.timer = setTimeout(() => { if (incoming?.visitId === message.visitId) clearIncoming(); }, timing.handoff); incoming.timer.unref?.();
      send(session, { type: 'visit-ack', requestId: message.requestId, visitId: message.visitId, accepted: true, reason: null }); return;
    }
    if (message.type === 'visit-ack' && exact(message, ['type', 'requestId', 'visitId', 'accepted', 'reason']) && validId(message.requestId) && validId(message.visitId)
        && typeof message.accepted === 'boolean' && (message.reason === null || message.reason === 'busy')) {
      if (!outgoing || outgoing.requestId !== message.requestId || outgoing.visitId !== message.visitId || outgoing.phase !== 'offer') return;
      if (!message.accepted) { settleOutgoing(fail('busy')); errorCode = 'busy'; emit(); return; }
      const pending = outgoing;
      pending.phase = 'commit'; awayId = pending.visitId; awayLease = now() + timing.lease; errorCode = null; emit();
      if (outgoing === pending && paired === session) send(session, { type: 'visit-commit', requestId: pending.requestId, visitId: pending.visitId }); return;
    }
    if (message.type === 'visit-commit' && exact(message, ['type', 'requestId', 'visitId']) && validId(message.requestId) && validId(message.visitId)) {
      if (incoming?.requestId === message.requestId && incoming.visitId === message.visitId) {
        guest = { ...incoming.pet, visitId: incoming.visitId }; guestLease = now() + timing.lease; clearIncoming(); emit();
        send(session, { type: 'visit-commit-ack', requestId: message.requestId, visitId: message.visitId });
      } else if (guest?.visitId === message.visitId) send(session, { type: 'visit-commit-ack', requestId: message.requestId, visitId: message.visitId });
      return;
    }
    if (message.type === 'visit-commit-ack' && exact(message, ['type', 'requestId', 'visitId']) && validId(message.requestId) && validId(message.visitId)) {
      if (outgoing?.phase === 'commit' && outgoing.requestId === message.requestId && outgoing.visitId === message.visitId) settleOutgoing({ ok: true });
      return;
    }
    if (message.type === 'return' && exact(message, ['type', 'visitId']) && validId(message.visitId)) {
      if (guest?.visitId === message.visitId) { guest = null; guestLease = 0; emit(); }
      if (incoming?.visitId === message.visitId) clearIncoming();
      return;
    }
    if (message.type === 'recall' && exact(message, ['type', 'visitId']) && validId(message.visitId)) {
      if (awayId === message.visitId || outgoing?.visitId === message.visitId) {
        awayId = null; awayLease = 0; settleOutgoing(fail('handoff-timeout')); emit();
      }
      return;
    }
    if (message.type === 'bye' && exact(message, ['type'])) { closeSession(session); return; }
    closeSession(session, 'protocol');
  }
  function attach(socket, role, invite = null, joinResolve = null) {
    const session = { socket, role, authenticated: false, closed: false, codec: null, sharedKey: invite ? Buffer.from(invite.key, 'base64url') : null,
      clientNonce: role === 'client' ? crypto.randomBytes(32) : null, joinResolve, buffer: Buffer.alloc(0), packets: 0, windowAt: now(), inviteId: invite?.id || null };
    sockets.add(session);
    const reject = code => {
      try { socket.write(frame({ type: 'refused', code })); } catch { }
      closeSession(session, code);
    };
    session.handshakeTimer = setTimeout(() => closeSession(session, 'handshake-failed'), timing.handshake); session.handshakeTimer.unref?.();
    socket.setNoDelay?.(true);
    socket.on('error', () => closeSession(session, session.authenticated ? 'connection-lost' : 'connection-failed'));
    socket.on('close', () => closeSession(session, session.authenticated ? 'connection-lost' : 'connection-failed'));
    socket.on('data', chunk => {
      if (session.closed) return;
      if (session.buffer.length + chunk.length > MAX_FRAME * 4 + 16) return closeSession(session, 'protocol');
      session.buffer = Buffer.concat([session.buffer, chunk]);
      while (!session.closed && session.buffer.length >= 4) {
        const length = session.buffer.readUInt32BE(0);
        if (length < 2 || length > MAX_FRAME) return closeSession(session, 'protocol');
        if (session.buffer.length < length + 4) break;
        const packet = session.buffer.subarray(4, length + 4); session.buffer = session.buffer.subarray(length + 4);
        if (now() - session.windowAt >= timing.rateWindow) { session.windowAt = now(); session.packets = 0; }
        if (++session.packets > timing.maxPackets) return closeSession(session, 'protocol');
        let value; try { value = JSON.parse(packet.toString('utf8')); } catch { return closeSession(session, 'protocol'); }
        if (!session.codec) {
          if (role === 'server') {
            if (paired || connecting) return reject('already-paired');
            if (!exact(value, ['type', 'v', 'id', 'nonce']) || value.type !== 'hello' || value.v !== 1 || !token(value.nonce, 32)) return reject('handshake-failed');
            if (!invitation || invitation.id !== value.id || invitation.expiresAt <= now()) return reject('invite-unavailable');
            const clientNonce = Buffer.from(value.nonce, 'base64url'), serverNonce = crypto.randomBytes(32);
            session.inviteId = invitation.id;
            session.codec = createCodec(invitation.key, clientNonce, serverNonce, 'server');
            try { socket.write(frame({ type: 'challenge', v: 1, id: invitation.id, nonce: serverNonce.toString('base64url') })); }
            catch { return closeSession(session, 'connection-failed'); }
          } else {
            if (exact(value, ['type', 'code']) && value.type === 'refused' && ['already-paired', 'invite-unavailable', 'handshake-failed'].includes(value.code)) return closeSession(session, value.code);
            if (!exact(value, ['type', 'v', 'id', 'nonce']) || value.type !== 'challenge' || value.v !== 1 || value.id !== session.inviteId || !token(value.nonce, 32)) return closeSession(session, 'handshake-failed');
            session.codec = createCodec(session.sharedKey, session.clientNonce, Buffer.from(value.nonce, 'base64url'), 'client'); session.sharedKey.fill(0);
            send(session, { type: 'hello', name: label() });
          }
          continue;
        }
        try { handleMessage(session, session.codec.open(value)); } catch { return closeSession(session, 'protocol'); }
      }
    });
    if (role === 'client') socket.once('connect', () => {
      if (session.closed || stopped) return closeSession(session, 'stopped');
      try { socket.write(frame({ type: 'hello', v: 1, id: invite.id, nonce: session.clientNonce.toString('base64url') })); }
      catch { closeSession(session, 'connection-failed'); }
    });
    return session;
  }
  async function listen(options = {}) {
    if (stopped) return fail('stopped');
    if (typeof options === 'string') options = { address: options };
    if (listenPending) return listenPending;
    const addresses = getOptions().addresses, address = options.address || getConfig().visitsAddress || addresses[0]?.address || '127.0.0.1';
    const port = options.port ?? PORT;
    if (!addresses.some(item => item.address === address) || !Number.isInteger(port) || port < 0 || port > 65535 || (port !== 0 && port < 1024)) return resultError('unsafe-address');
    if (server?.listening && listenerAddress === address && (port === 0 || port === server.address().port)) return { ok: true, ...getState() };
    if ((paired || connecting) && server?.listening) return resultError('already-paired');
    const generation = epoch;
    const job = (async () => {
      if (server) {
        const old = server; server = null; endpoint = null; listenerAddress = null; revokeInvite();
        for (const session of [...sockets]) if (!session.authenticated) closeSession(session);
        await new Promise(resolve => { try { old.close(() => resolve()); } catch { resolve(); } });
        if (stopped || generation !== epoch) return fail('stopped');
      }
      return new Promise(resolve => {
      const candidate = serverFactory(socket => {
        if (stopped || !allowedAddress(socket.remoteAddress) || sockets.size >= 4) return socket.destroy();
        attach(socket, 'server');
      });
      server = candidate;
      candidate.on('error', () => {
        if (server === candidate) { server = null; endpoint = null; listenerAddress = null; errorCode = 'cannot-listen'; emit(); }
        resolve(fail('cannot-listen'));
      });
      candidate.once('close', () => resolve(fail(stopped ? 'stopped' : 'cannot-listen')));
      candidate.once('listening', () => {
        if (stopped || generation !== epoch) { try { candidate.close(); } catch { } resolve(fail('stopped')); return; }
        listenerAddress = address; endpoint = `${address}:${candidate.address().port}`; errorCode = null; emit();
        resolve(stopped || generation !== epoch ? fail('stopped') : { ok: true, ...getState() });
      });
      try { candidate.listen({ host: address, port, exclusive: true }); } catch { server = null; resolve(resultError('cannot-listen')); }
      });
    })();
    listenPending = job;
    try { return await job; } finally { if (listenPending === job) listenPending = null; }
  }
  async function invite(options = {}) {
    if (stopped) return fail('stopped');
    if (paired || connecting) return resultError('already-paired');
    const generation = epoch;
    if (options.name !== undefined) selfName = nameFor(options.name) || 'Капри';
    const started = await listen(options);
    if (!started.ok) return started;
    if (stopped || generation !== epoch || !server?.listening) return fail('stopped');
    revokeInvite();
    invitation = { v: 1, host: listenerAddress, port: server.address().port, id: crypto.randomBytes(16).toString('base64url'),
      key: crypto.randomBytes(32), expiresAt: now() + Math.min(INVITE_TTL, timing.invite), name: label() };
    const code = 'capri1.' + Buffer.from(JSON.stringify({ ...invitation, key: invitation.key.toString('base64url') })).toString('base64url');
    inviteTimer = setTimeout(() => { revokeInvite(); emit(); }, Math.min(INVITE_TTL, timing.invite)); inviteTimer.unref?.();
    const id = invitation.id, expiresAt = invitation.expiresAt;
    errorCode = null; emit();
    return stopped || generation !== epoch || invitation?.id !== id ? fail('stopped') : { ok: true, code, expiresAt, endpoint };
  }
  async function join(code, options = {}) {
    if (stopped) return fail('stopped');
    if (paired || connecting) return resultError('already-paired');
    const parsed = parseInvitation(code, now());
    if (!parsed.ok) return resultError(parsed.code);
    if (parsed.host.startsWith('26.') && !getOptions().addresses.some(item => item.kind === 'radmin')) return resultError('unsafe-address');
    if (parsed.id === invitation?.id) return resultError('self-invite');
    if (options.name !== undefined) selfName = nameFor(options.name) || 'Капри';
    revokeInvite();
    for (const session of [...sockets]) if (!session.authenticated) closeSession(session);
    const generation = epoch;
    connecting = true; errorCode = null; emit();
    if (stopped || generation !== epoch) return fail('stopped');
    return new Promise(resolve => {
      try { attach(connect({ host: parsed.host, port: parsed.port }), 'client', parsed, resolve); }
      catch { connecting = false; resolve(resultError('connection-failed')); }
    });
  }
  async function visit(pet = { name: 'Капри', mood: 'happy', facing: 1, scale: 0.6 }) {
    if (!paired?.authenticated) return resultError('not-paired');
    if (awayId || outgoing) return resultError('already-away');
    if (!validPet(pet)) return resultError('invalid-pet');
    return new Promise(resolve => {
      const requestId = crypto.randomBytes(16).toString('base64url'), visitId = crypto.randomBytes(16).toString('base64url');
      outgoing = { requestId, visitId, phase: 'offer', resolve, timer: null };
      outgoing.timer = setTimeout(() => {
        if (outgoing?.visitId !== visitId) return;
        send(paired, { type: 'return', visitId }); awayId = null; awayLease = 0; settleOutgoing(fail('handoff-timeout')); errorCode = 'handoff-timeout'; emit();
      }, timing.handoff); outgoing.timer.unref?.();
      send(paired, { type: 'visit', requestId, visitId, pet: { ...pet } });
    });
  }
  async function returnHome() {
    if (outgoing || awayId) {
      const visitId = awayId || outgoing.visitId;
      send(paired, { type: 'return', visitId }); awayId = null; awayLease = 0; settleOutgoing(fail('handoff-timeout'));
    }
    if (guest) { send(paired, { type: 'recall', visitId: guest.visitId }); guest = null; guestLease = 0; }
    if (incoming) send(paired, { type: 'recall', visitId: incoming.visitId });
    clearIncoming(); errorCode = null; emit(); return { ok: true };
  }
  async function disconnect() {
    epoch++; revokeInvite(); errorCode = null;
    for (const session of [...sockets]) { if (session.authenticated) send(session, { type: 'bye' }); closeSession(session); }
    connecting = false; awayId = null; guest = null; clearIncoming(); settleOutgoing(fail('connection-lost')); errorCode = null; emit(); return { ok: true };
  }
  async function stop() {
    stopped = true; await disconnect();
    const old = server; server = null; endpoint = null; listenerAddress = null; emit();
    if (old) await new Promise(resolve => { try { old.close(() => resolve()); } catch { resolve(); } });
  }
  return { listen, invite, join, visit, returnHome, disconnect, stop, getState, getOptions };
}

module.exports = { create, listAddresses, allowedAddress, validPet, parseInvitation, createCodec, frame, PORT };
