'use strict';

// Discord's native local IPC only. No account token, OAuth, messages or voice access.
// Protocol: https://docs.discord.com/developers/topics/rpc
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const sharedApp = require('./companion-discord-app');
const validId = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
const bounded = value => typeof value === 'string' ? [...value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()].slice(0, 110).join('') : '';
function parseId(value) {
  if (typeof value !== 'string' || value.length > 512) return '';
  const text = value.trim();
  if (validId(text)) return text;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || !['discord.com', 'discordapp.com'].includes(url.hostname) || url.username || url.password) return '';
    return /^\/developers\/applications\/(\d{17,20})(?:\/[^?#]*)?$/.exec(url.pathname)?.[1] || '';
  } catch { return ''; }
}
const clientIdFor = cfg => parseId(cfg?.discordClientId) || (validId(sharedApp.CLIENT_ID) ? sharedApp.CLIENT_ID : '');
function imageFor(app = sharedApp) {
  try {
    const url = new URL(app.PRESENCE_IMAGE_URL);
    if (url.protocol === 'https:' && !url.username && !url.password && url.href.length <= 512) return url.href;
  } catch { }
  return typeof app.LARGE_IMAGE_KEY === 'string' && /^[a-z0-9_-]{1,64}$/i.test(app.LARGE_IMAGE_KEY) ? app.LARGE_IMAGE_KEY : null;
}
function frame(op, value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(8); header.writeUInt32LE(op, 0); header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}
function activityFor(cfg, context = {}, app = sharedApp) {
  const mode = context.pet?.mode;
  let type = 0, details = 'Капри рядом', state = mode === 'sleep' ? 'Отдыхает' : context.pet?.chat ? 'Общается' : 'Гуляет по рабочему столу';
  if (cfg.discordShareActivity === true) {
    if (context.game) {
      details = /minecraft/i.test(context.game) ? 'Играет в Minecraft'
        : /space station 14|ss14/i.test(context.game) ? 'Играет в Space Station 14'
          : /valorant/i.test(context.game) ? 'Играет в Valorant'
            : /league of legends|^lol$/i.test(context.game) ? 'Играет в League of Legends' : 'Играет';
      state = mode === 'sleep' ? 'Капри спит рядом' : 'Капри составляет компанию';
    } else if (context.watching?.playing === true) {
      type = 3;
      details = 'Смотрит Кинопоиск';
      const title = bounded(context.watching.title);
      state = title ? ([...title].length < 2 ? `«${title}»` : title) : 'Капри смотрит вместе';
    } else if (['Krita', 'Adobe Photoshop', 'CLIP STUDIO PAINT', 'Blender', 'Photopea', 'Figma'].includes(context.drawing?.app)) {
      details = `Рисует в ${context.drawing.app}`;
      state = mode === 'sleep' ? 'Капри спит рядом' : 'Капри поддерживает художницу';
    } else if (cfg.discordShareMusic === true && context.music?.playing === true && bounded(context.music.title)) {
      type = 2;
      details = 'Слушает Spotify';
      state = bounded([context.music.artist, context.music.title].filter(Boolean).join(' — '));
      if ([...state].length < 2) state = `«${state}»`;
    }
  }
  const activity = { type, details, state, instance: false };
  const image = imageFor(app);
  if (image) activity.assets = { large_image: image, large_text: bounded(app.APPLICATION_NAME) || 'Capri Companion' };
  return activity;
}

function statusLine(status = {}) {
  if (status.error === 'invalid-id') return 'Discord не принял Application ID. Проверь номер приложения или выбери общее приложение Capri Companion.';
  if (status.error === 'permissions') return 'Discord отклонил доступ к активности. Проверь настройки отображения активности в настольном Discord и повтори подключение.';
  if (status.error === 'invalid-activity') return 'Discord отклонил содержимое статуса. Повтори подключение; если ошибка остаётся, выключи передачу игры и просмотра.';
  const descriptions = {
    off: 'Статус Discord выключен. Его можно включить одной кнопкой: общее приложение Капри уже настроено.',
    'needs-id': 'Для этой сборки не задано общее приложение. Укажи публичный Application ID в настройках Discord.',
    connecting: 'Подключаюсь к настольному Discord. Обычно это занимает несколько секунд.',
    'not-running': status.error === 'ack-timeout' ? 'Discord подключился, но не подтвердил статус. Попробую переподключиться; можно повторить сейчас.'
      : 'Настольный Discord пока недоступен. Открой его и нажми «Повторить». В браузерной версии эта функция не работает.',
    connected: 'Связь с Discord установлена. Ожидаю подтверждение статуса; обновления отправляются с паузой.',
    active: 'Discord подтвердил статус Капри. Если его не видно в профиле, включи отображение активности в настройках Discord.',
    rejected: 'Discord отклонил статус. Повтори подключение или проверь Application ID своего приложения.',
    'rate-limited': `Discord попросил подождать. Следующая попытка примерно через ${Math.max(1, status.retryInSeconds || 30)} секунд.`,
  };
  return descriptions[status.state] || 'Подключение Discord пока не готово.';
}

function create({ getConfig, getContext = () => ({}), connect = net.createConnection, schedule = true, now = Date.now, pid = process.pid, limits = {} }) {
  const timing = { connect: 800, handshake: 5000, ack: 8000, update: 15000, ...limits };
  let socket = null, ready = false, connecting = false, stopped = false, activeId = '', epoch = 0;
  let acknowledged = '', rejected = '', lastSentAt = -Infinity, retryAt = 0, failures = 0, blockedId = '';
  let state = 'off', error = null, errorCode = null, acknowledgedAt = null;
  let pending = null, handshakeTimer = null, timer = null, cancelProbe = null;
  let sessionKey = '', sessionStartedAt = Math.floor(now() / 1000);
  const destroy = target => { try { target?.destroy(); } catch { } };
  function clearPending() { clearTimeout(pending?.timer); pending = null; }
  function disconnect(clear = false) {
    epoch++; connecting = false; cancelProbe?.(); cancelProbe = null;
    const old = socket; socket = null; ready = false; acknowledged = ''; clearPending(); clearTimeout(handshakeTimer);
    if (!old) return;
    if (clear && !old.destroyed) {
      try { old.end(frame(1, { cmd: 'SET_ACTIVITY', args: { pid, activity: null }, nonce: randomUUID() })); }
      catch { destroy(old); }
      const cleanup = setTimeout(() => destroy(old), 300); cleanup.unref?.();
    } else destroy(old);
  }
  function failure(reason, nextState = 'not-running', code = null, minimum = 0) {
    disconnect(); failures++;
    retryAt = now() + Math.max(minimum, Math.min(120000, 5000 * 2 ** Math.min(5, failures - 1)));
    state = nextState; error = reason; errorCode = Number.isInteger(code) ? code : null;
  }
  function write(op, data) {
    try { if (!socket || socket.destroyed) return false; socket.write(frame(op, data)); return true; }
    catch { failure('connection'); return false; }
  }
  function sendActivity() {
    const cfg = getConfig();
    if (!ready || !socket || cfg.discordPresence !== true || clientIdFor(cfg) !== activeId || pending || now() < retryAt) return;
    const activity = activityFor(cfg, getContext());
    const key = JSON.stringify(activity);
    if (key === acknowledged || key === rejected || now() - lastSentAt < timing.update) return;
    if (key !== sessionKey) { sessionKey = key; sessionStartedAt = Math.floor(now() / 1000); }
    if (cfg.discordElapsed !== false) activity.timestamps = { start: sessionStartedAt };
    const nonce = randomUUID();
    pending = { nonce, key, timer: null }; lastSentAt = now(); state = 'connected';
    if (!write(1, { cmd: 'SET_ACTIVITY', args: { pid, activity }, nonce })) return;
    if (pending?.nonce === nonce) {
      pending.timer = setTimeout(() => { if (pending?.nonce === nonce) failure('ack-timeout'); }, timing.ack);
      pending.timer.unref?.();
    }
  }
  function reject(data, close = false) {
    const code = Number.isInteger(data?.code) ? data.code : null;
    const rateLimited = close ? code === 4002 : code === 429 || /rate.?limit|too many requests/i.test(String(data?.message || ''));
    const invalidId = close ? code === 4000 : code === 4007;
    if (invalidId) {
      blockedId = activeId; failure('invalid-id', 'rejected', code); return;
    }
    if (close) { failure(rateLimited ? 'rate-limited' : 'closed', rateLimited ? 'rate-limited' : 'not-running', code, rateLimited ? 30000 : 0); return; }
    const failedKey = pending?.key; clearPending();
    error = rateLimited ? 'rate-limited' : code === 4006 ? 'permissions' : code === 4000 ? 'invalid-activity' : 'rejected';
    errorCode = code; state = rateLimited ? 'rate-limited' : 'rejected';
    if (rateLimited) retryAt = now() + 30000;
    else rejected = failedKey || ''; // A rejected payload is retried only after a change or explicit retry.
  }
  async function tick() {
    const cfg = getConfig(), id = clientIdFor(cfg);
    if (stopped) return;
    if (cfg.discordPresence !== true || !id) {
      disconnect(true); activeId = ''; error = null; errorCode = null;
      state = cfg.discordPresence === true ? 'needs-id' : 'off'; return;
    }
    if (id !== activeId) {
      disconnect(true); activeId = id; retryAt = 0; failures = 0; blockedId = ''; rejected = '';
      lastSentAt = -Infinity; error = null; errorCode = null; acknowledgedAt = null;
    }
    if (blockedId === id) return;
    if (ready) { sendActivity(); return; }
    if (connecting || socket || now() < retryAt) return;
    connecting = true; state = 'connecting';
    const generation = ++epoch;
    for (let index = 0; index < 10 && !stopped && generation === epoch; index++) {
      const connected = await new Promise(resolve => {
        let candidate, settled = false;
        const finish = ok => {
          if (settled) return; settled = true; clearTimeout(timeout);
          if (cancelProbe === cancel) cancelProbe = null;
          if (!ok) destroy(candidate); resolve(ok ? candidate : null);
        };
        const cancel = () => finish(false);
        const timeout = setTimeout(cancel, timing.connect); timeout.unref?.(); cancelProbe = cancel;
        try {
          candidate = connect({ path: '\\\\?\\pipe\\discord-ipc-' + index });
          candidate.once('connect', () => finish(true)); candidate.on('error', cancel); candidate.once('close', cancel);
        } catch { finish(false); }
      });
      const current = getConfig();
      if (stopped || generation !== epoch || current.discordPresence !== true || clientIdFor(current) !== activeId) { destroy(connected); return; }
      if (!connected) continue;
      socket = connected; let buffer = Buffer.alloc(0);
      const fail = () => { if (socket === connected) failure('connection'); };
      connected.on('error', fail); connected.on('close', fail);
      connected.on('data', chunk => {
        if (socket !== connected || generation !== epoch) return;
        if (buffer.length + chunk.length > 65544) { failure('protocol'); return; }
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 8) {
          if (socket !== connected || generation !== epoch) return;
          const op = buffer.readUInt32LE(0), length = buffer.readUInt32LE(4);
          if (length > 65536 || op > 4) { failure('protocol'); return; }
          if (buffer.length < 8 + length) return;
          const body = buffer.subarray(8, 8 + length); buffer = buffer.subarray(8 + length);
          if (op === 3) { write(4, body); continue; }
          if (op !== 1 && op !== 2) continue;
          let data; try { data = JSON.parse(body.toString('utf8')); } catch { failure('protocol'); return; }
          if (op === 2) { reject(data, true); return; }
          if (data.evt === 'READY' && !ready) {
            ready = true; clearTimeout(handshakeTimer); state = 'connected'; error = null; errorCode = null; sendActivity();
          } else if (data.evt === 'ERROR' && (!ready || (pending && data.nonce === pending.nonce))) {
            reject(data.data);
          } else if (data.cmd === 'SET_ACTIVITY' && pending && data.nonce === pending.nonce && !data.evt) {
            acknowledged = pending.key; clearPending(); acknowledgedAt = now(); failures = 0;
            state = 'active'; error = null; errorCode = null;
          }
          // User/account details and arbitrary event/error text are never retained.
        }
      });
      handshakeTimer = setTimeout(() => { if (socket === connected && !ready) failure('handshake-timeout'); }, timing.handshake);
      handshakeTimer.unref?.(); write(0, { v: 1, client_id: activeId });
      connecting = false; return;
    }
    if (generation === epoch && !stopped) { connecting = false; failure('unreachable'); }
  }
  function getState() {
    const cfg = getConfig();
    return { state, configured: Boolean(clientIdFor(cfg)), shared: validId(sharedApp.CLIENT_ID) && !parseId(cfg.discordClientId),
      enabled: cfg.discordPresence === true, applicationId: clientIdFor(cfg), acknowledgedAt,
      error, errorCode, retryInSeconds: blockedId ? null : Math.max(0, Math.ceil((retryAt - now()) / 1000)) };
  }
  async function retry() {
    if (stopped) return;
    blockedId = ''; rejected = ''; failures = 0; retryAt = 0;
    if (ready) acknowledged = '';
    await tick();
  }
  async function check({ force = false, timeoutMs = 1800 } = {}) {
    const job = force ? retry() : tick(); job.catch(() => {});
    const deadline = Date.now() + Math.min(5000, Math.max(0, timeoutMs));
    do {
      if (['off', 'needs-id', 'active', 'rejected', 'rate-limited', 'not-running'].includes(state)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (!stopped && Date.now() < deadline);
    return getState();
  }
  if (schedule) { timer = setInterval(() => tick().catch(() => {}), 5000); timer.unref?.(); tick().catch(() => {}); }
  return { tick, retry, check, getState,
    stop() { stopped = true; clearInterval(timer); disconnect(true); state = 'off'; },
  };
}
module.exports = { create, validId, parseId, clientIdFor, imageFor, activityFor, statusLine, frame };
