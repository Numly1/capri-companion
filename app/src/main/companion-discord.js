'use strict';

// Discord's native local IPC only. No account token, OAuth, messages or voice access.
// Protocol: https://docs.discord.com/developers/topics/rpc
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const validId = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
const bounded = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 110) : '';
function frame(op, value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(8); header.writeUInt32LE(op, 0); header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}
function activityFor(cfg, context = {}) {
  const mode = context.pet?.mode;
  let details = 'Капри рядом', state = mode === 'sleep' ? 'Отдыхает' : context.pet?.chat ? 'Общается' : 'Гуляет по рабочему столу';
  if (cfg.discordShareActivity === true) {
    if (context.game) {
      details = /minecraft/i.test(context.game) ? 'Играет в Minecraft'
        : /space station 14|ss14/i.test(context.game) ? 'Играет в Space Station 14' : 'Играет';
      state = mode === 'sleep' ? 'Капри спит рядом' : 'Капри составляет компанию';
    } else if (context.watching?.playing === true) {
      details = 'Смотрит Кинопоиск';
      state = bounded(context.watching.title) || 'Капри смотрит вместе';
    }
  }
  return { details, state, instance: false };
}

function create({ getConfig, getContext = () => ({}), connect = net.createConnection, schedule = true, now = Date.now, pid = process.pid }) {
  let socket = null, ready = false, connecting = false, stopped = false, activeId = '';
  let last = '', lastSentAt = -Infinity, retryAt = 0, state = 'off', attempt = 0;
  let pendingNonce = null, handshakeTimer = null, timer = null;
  function write(op, data) { try { if (socket && !socket.destroyed) socket.write(frame(op, data)); } catch { socket?.destroy(); } }
  function disconnect(clear = false) {
    const old = socket; socket = null; ready = false; last = ''; pendingNonce = null; clearTimeout(handshakeTimer);
    if (old) {
      if (clear && !old.destroyed) {
        try { old.end(frame(1, { cmd: 'SET_ACTIVITY', args: { pid, activity: null }, nonce: randomUUID() })); } catch { old.destroy(); }
        const cleanup = setTimeout(() => old.destroy(), 300); cleanup.unref?.();
      } else old.destroy();
    }
  }
  function sendActivity() {
    const cfg = getConfig();
    if (!ready || !socket || !cfg.discordPresence || cfg.discordClientId !== activeId) return;
    const activity = activityFor(cfg, getContext());
    const key = JSON.stringify(activity);
    if (key === last || now() - lastSentAt < 15000) return;
    last = key; lastSentAt = now(); pendingNonce = randomUUID();
    write(1, { cmd: 'SET_ACTIVITY', args: { pid, activity }, nonce: pendingNonce });
  }
  async function tick() {
    const cfg = getConfig();
    if (stopped) return;
    if (cfg.discordPresence !== true || !validId(cfg.discordClientId)) {
      disconnect(true); activeId = ''; state = cfg.discordPresence ? 'needs-id' : 'off'; return;
    }
    if (cfg.discordClientId !== activeId) { disconnect(true); activeId = cfg.discordClientId; retryAt = 0; lastSentAt = -Infinity; }
    if (ready) { sendActivity(); return; }
    if (connecting || socket || now() < retryAt) return;
    connecting = true; state = 'connecting';
    const generation = ++attempt;
    for (let index = 0; index < 10 && !stopped && generation === attempt; index++) {
      const connected = await new Promise(resolve => {
        let candidate, settled = false;
        const finish = ok => { if (settled) return; settled = true; clearTimeout(timeout); if (!ok) candidate?.destroy(); resolve(ok ? candidate : null); };
        const timeout = setTimeout(() => finish(false), 800); timeout.unref?.();
        try {
          candidate = connect({ path: '\\\\?\\pipe\\discord-ipc-' + index });
          candidate.once('connect', () => finish(true));
          candidate.on('error', () => finish(false));
        } catch { finish(false); }
      });
      const current = getConfig();
      if (stopped || generation !== attempt || current.discordPresence !== true || current.discordClientId !== activeId) { connected?.destroy(); break; }
      if (!connected) continue;
      socket = connected; let buffer = Buffer.alloc(0);
      const fail = () => {
        if (socket !== connected) return;
        disconnect(); retryAt = now() + 30000; state = 'not-running';
      };
      connected.on('error', fail); connected.on('close', fail);
      connected.on('data', chunk => {
        if (socket !== connected) return;
        if (buffer.length + chunk.length > 65544) { fail(); return; }
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 8) {
          const op = buffer.readUInt32LE(0), length = buffer.readUInt32LE(4);
          if (length > 65536 || op > 4) { fail(); return; }
          if (buffer.length < 8 + length) return;
          const body = buffer.subarray(8, 8 + length); buffer = buffer.subarray(8 + length);
          if (op === 3) { write(4, body); continue; }
          if (op === 2) { fail(); return; }
          if (op !== 1) continue;
          let data; try { data = JSON.parse(body.toString('utf8')); } catch { fail(); return; }
          if (data.evt === 'READY') { ready = true; clearTimeout(handshakeTimer); state = 'connected'; sendActivity(); }
          else if (data.evt === 'ERROR') { state = 'rejected'; last = ''; }
          else if (data.cmd === 'SET_ACTIVITY' && data.nonce === pendingNonce) state = 'active';
          // READY user details and arbitrary event text are deliberately discarded.
        }
      });
      handshakeTimer = setTimeout(() => { if (!ready) fail(); }, 5000); handshakeTimer.unref?.();
      write(0, { v: 1, client_id: activeId });
      break;
    }
    connecting = false;
    if (!socket && !stopped) {
      const current = getConfig();
      if (current.discordPresence !== true || !validId(current.discordClientId)) state = current.discordPresence ? 'needs-id' : 'off';
      else { state = 'not-running'; retryAt = now() + 30000; }
    }
  }
  if (schedule) { timer = setInterval(() => tick().catch(() => {}), 15000); timer.unref?.(); tick().catch(() => {}); }
  return {
    tick, getState: () => ({ state, configured: validId(getConfig().discordClientId), enabled: getConfig().discordPresence === true }),
    stop() { stopped = true; attempt++; clearInterval(timer); disconnect(true); state = 'off'; },
  };
}
module.exports = { create, validId, activityFor, frame };
