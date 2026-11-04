'use strict';

// Visible Valorant headlines and the documented, read-only LoL Game Client API.
// Names, raw API responses and recognized screen text never leave this module.
const https = require('node:https');
const { inspect: inspectScreen, boundsFor } = require('./companion-screen');
const LOL_PATHS = new Set(['/liveclientdata/eventdata', '/liveclientdata/gamestats']);
const LOL_EVENT_KINDS = Object.freeze({ BaronKill: 'baron', DragonKill: 'dragon', HeraldKill: 'herald', TurretKilled: 'turret', InhibKilled: 'inhibitor' });
const PRIORITY = { baron: 90, dragon: 80, inhibitor: 70, herald: 65, turret: 60 };
const LINES = Object.freeze({
  victory: 'Вижу надпись «Победа». Вот это финал, чум! Можно выдохнуть — я за тебя болела.',
  defeat: 'На экране поражение. Обидно, чум, но один матч не отменяет твою крутость. Передохни, я рядом.',
  'round-win': 'Вижу надпись о победе в раунде. Красиво! Держу за тебя цифровые кулачки.',
  'round-loss': 'Раунд закончился не в вашу пользу. Выдохни, чум. Я всё ещё на твоей стороне.',
  spike: 'На экране «Спайк установлен». Момент напряжённый — я тихонько поболею за тебя.',
  baron: 'В League of Legends пал Барон. Вот это поворот в матче, чум! Я рядом и болею за тебя.',
  dragon: 'В League of Legends повержен дракон. На карте снова жарко. Держу за тебя цифровые кулачки.',
  herald: 'В League of Legends повержен Герольд. У этого матча явно характер. Я всё ещё на твоей стороне.',
  turret: 'В League of Legends разрушена башня. Матч набирает обороты, чум. Ты справишься.',
  inhibitor: 'В League of Legends разрушен ингибитор. Ух, напряжённый момент. Я рядом, чум.',
});
const VALORANT_RULES = [
  ['victory', /^(?:VICTORY|ПОБЕДА)[!\s]*$/iu], ['defeat', /^(?:DEFEAT|ПОРАЖЕНИЕ)[!\s]*$/iu],
  ['round-win', /^(?:ROUND WON|РАУНД ВЫИГРАН|ПОБЕДА В РАУНДЕ)[!\s]*$/iu],
  ['round-loss', /^(?:ROUND LOST|РАУНД ПРОИГРАН|ПОРАЖЕНИЕ В РАУНДЕ)[!\s]*$/iu],
  ['spike', /^(?:SPIKE PLANTED|СПАЙК УСТАНОВЛЕН)[!\s]*$/iu],
];

function enabled(game, cfg = {}) { return cfg[game === 'valorant' ? 'valorantReactions' : 'lolReactions'] === true; }
function pauseFor(game, cfg = {}) {
  const value = Number(cfg[game === 'valorant' ? 'valorantIntervalMinutes' : 'lolIntervalMinutes']);
  return (Number.isFinite(value) ? Math.min(30, Math.max(1, value)) : 2) * 60000;
}
function reaction(game, kind, sequence) {
  return { id: `${game}:${sequence}`, game, kind, source: game === 'valorant' ? 'local-screen' : 'lol-live-client', line: LINES[kind], face: ['victory', 'round-win'].includes(kind) ? 'laugh' : 'look' };
}
function foreground(value) {
  const bounds = boundsFor(value?.bounds);
  if (value?.active !== true || !['valorant', 'lol'].includes(value.game) || !bounds || bounds.width < 640 || bounds.height < 360 || !['string', 'number'].includes(typeof value.id) || !/^[1-9][0-9]{0,19}$/.test(String(value.id))) return null;
  return { game: value.game, id: String(value.id), bounds };
}
const sameWindow = (a, b) => a && b && a.game === b.game && a.id === b.id && ['x', 'y', 'width', 'height'].every(key => a.bounds[key] === b.bounds[key]);
function valorantRegion(bounds) {
  return { x: bounds.x + Math.floor(bounds.width * 0.14), y: bounds.y + Math.floor(bounds.height * 0.03), width: Math.floor(bounds.width * 0.72), height: Math.floor(bounds.height * 0.5) };
}
function valorantEvents(text) {
  if (typeof text !== 'string') return [];
  const lines = text.slice(0, 12000).split(/\r?\n/).map(line => line.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim());
  return VALORANT_RULES.filter(([, pattern]) => lines.some(line => pattern.test(line))).map(([kind]) => kind);
}

class ValorantTracker {
  constructor({ now = Date.now } = {}) { this.now = now; this.present = new Set(); this.armed = false; this.lastAt = -Infinity; this.sequence = 0; }
  sample(text, cfg) {
    const events = valorantEvents(text), fresh = events.filter(kind => !this.present.has(kind));
    this.present = new Set(events);
    if (!this.armed) { this.armed = true; return null; }
    if (!enabled('valorant', cfg) || !fresh.length || this.now() - this.lastAt < pauseFor('valorant', cfg)) return null;
    this.lastAt = this.now(); return reaction('valorant', fresh[0], ++this.sequence);
  }
  leave() { this.present.clear(); this.armed = false; }
}

class LolTracker {
  constructor({ now = Date.now } = {}) { this.now = now; this.armed = false; this.lastTime = null; this.maxId = -1; this.lastAt = -Infinity; this.sequence = 0; }
  sample(raw, stats, cfg) {
    const gameTime = stats?.gameTime;
    if (!Number.isFinite(gameTime) || gameTime < 0 || gameTime > 86400 || !Array.isArray(raw?.Events) || raw.Events.length > 4096) { this.leave(); return null; }
    // Keep only fixed event IDs, names and times; player identity fields are discarded.
    const events = raw.Events.filter(event => Number.isSafeInteger(event?.EventID) && event.EventID >= 0 && event.EventID <= 10000000 && typeof event.EventName === 'string' && Number.isFinite(event.EventTime) && event.EventTime >= 0 && event.EventTime <= gameTime + 2);
    const maximum = events.reduce((max, event) => Math.max(max, event.EventID), -1);
    const reset = !this.armed || gameTime < this.lastTime - 15 || maximum < this.maxId;
    const fresh = events.filter(event => event.EventID > this.maxId && gameTime - event.EventTime <= 15 && Object.hasOwn(LOL_EVENT_KINDS, event.EventName));
    this.maxId = maximum; this.lastTime = gameTime; this.armed = true;
    if (reset || !enabled('lol', cfg) || this.now() - this.lastAt < pauseFor('lol', cfg)) return null;
    const candidate = fresh.sort((a, b) => PRIORITY[LOL_EVENT_KINDS[b.EventName]] - PRIORITY[LOL_EVENT_KINDS[a.EventName]])[0];
    if (!candidate) return null;
    this.lastAt = this.now(); return reaction('lol', LOL_EVENT_KINDS[candidate.EventName], ++this.sequence);
  }
  leave() { this.armed = false; this.lastTime = null; this.maxId = -1; }
}

// A self-signed certificate is accepted only on these two fixed loopback GETs.
// No proxy, authentication, redirects, arbitrary URL or global TLS change is used.
function readLol(pathname, options = {}) {
  if (!LOL_PATHS.has(pathname)) return Promise.reject(new Error('unsupported endpoint'));
  const request = options.request || https.request;
  return new Promise((resolve, reject) => {
    let settled = false, deadline;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(deadline); error ? reject(error) : resolve(value); };
    const req = request({ protocol: 'https:', hostname: '127.0.0.1', port: 2999, path: pathname, method: 'GET', rejectUnauthorized: false, agent: false, timeout: 2500, headers: { Accept: 'application/json' } }, response => {
      if (response.statusCode !== 200 || Number(response.headers?.['content-length']) > 1024 * 1024) { response.resume?.(); finish(new Error('unavailable')); return; }
      let size = 0; const chunks = [];
      response.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) { req.destroy(); finish(new Error('oversized response')); } else chunks.push(chunk); });
      response.on('error', () => finish(new Error('unavailable')));
      response.on('end', () => { try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(new Error('invalid response')); } });
    });
    deadline = setTimeout(() => { req.destroy(); finish(new Error('timeout')); }, 3000);
    req.on('error', () => finish(new Error('unavailable')));
    req.on('timeout', () => { req.destroy(); finish(new Error('timeout')); });
    req.end();
  });
}

function start(send, cfgGetter = () => ({}), options = {}) {
  const now = options.now || Date.now, inspect = options.inspect || inspectScreen, read = options.readLol || readLol;
  const trackers = { valorant: new ValorantTracker(options), lol: new LolTracker(options) };
  const getForeground = options.getForeground || (() => null);
  let pending = false, stopped = false, current = null, valorantAt = -Infinity;
  let state = { enabled: false, active: false, available: false, game: null, source: null, updatedAt: 0 };
  const emit = value => { try { send({ state: { ...state }, reaction: value }); } catch {} };
  async function poll() {
    if (stopped || pending) return;
    const cfg = cfgGetter(), before = foreground(getForeground());
    const active = Boolean(before && enabled(before.game, cfg));
    state = { enabled: active, active, available: false, game: active ? before.game : null, source: active ? (before.game === 'valorant' ? 'local-screen' : 'lol-live-client') : null, updatedAt: now() };
    if (!active) { trackers.valorant.leave(); trackers.lol.leave(); current = null; emit(null); return; }
    if (!sameWindow(current, before)) { trackers[before.game].leave(); current = before; valorantAt = -Infinity; }
    if (before.game === 'valorant' && options.canInspect && !options.canInspect()) { trackers.valorant.leave(); return; }
    if (before.game === 'valorant' && now() - valorantAt < 10000) return;
    pending = true;
    try {
      let value = null;
      if (before.game === 'valorant') {
        valorantAt = now();
        const result = await inspect({ bounds: valorantRegion(before.bounds) });
        if (stopped || !enabled(before.game, cfgGetter()) || !sameWindow(before, foreground(getForeground()))) { trackers.valorant.leave(); return; }
        state.available = result?.ok === true;
        if (result?.ok) value = trackers.valorant.sample(result.text, cfgGetter()); else trackers.valorant.leave();
      } else {
        const results = await Promise.all([read('/liveclientdata/eventdata'), read('/liveclientdata/gamestats')]);
        if (stopped || !enabled(before.game, cfgGetter()) || !sameWindow(before, foreground(getForeground()))) { trackers.lol.leave(); return; }
        state.available = true;
        value = trackers.lol.sample(results[0], results[1], cfgGetter());
      }
      emit(options.canReact && !options.canReact() ? null : value);
    } catch { trackers[before.game].leave(); if (!stopped) emit(null); }
    finally { pending = false; }
  }
  const timer = options.schedule === false ? null : setInterval(() => poll().catch(() => {}), 5000);
  timer?.unref?.();
  if (options.schedule !== false) poll().catch(() => {});
  return { poll, getState: () => ({ ...state }), stop() { stopped = true; if (timer) clearInterval(timer); trackers.valorant.leave(); trackers.lol.leave(); } };
}

module.exports = { start, foreground, sameWindow, valorantRegion, valorantEvents, ValorantTracker, LolTracker, readLol, pauseFor };
