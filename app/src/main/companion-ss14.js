'use strict';

// Local, visible-message reactions. This is not server telemetry or knowledge of hidden roles.
// Foreground identity and physical bounds come from the existing Windows watcher; OCR is in memory.
const { inspect: inspectScreen, boundsFor } = require('./companion-screen');

const SOURCE = 'local-screen';
const SCAN_MS = 20000;
const TYPE_COOLDOWN_MS = 10 * 60000;
const RULES = [
  { kind: 'alert-delta', priority: 100, pattern: /(?:уровень угрозы(?: станции)?(?: теперь|:)?\s*(?:код\s*)?дельта|объявлен[аоы]?[^.!?\n]{0,35}(?:код|протокол)\s*дельта|механизм самоуничтожения[^.!?\n]{0,25}активирован|alert level[^.!?\n]{0,25}delta)/i },
  { kind: 'evac-docked', priority: 90, pattern: /(?:(?:эвакуационный|спасательный|аварийный) шаттл (?:пристыковался|прибыл к станции)|(?:emergency|evacuation) shuttle (?:has )?(?:docked|arrived))/i },
  { kind: 'evac-departed', priority: 85, pattern: /(?:(?:эвакуационный|спасательный|аварийный) шаттл (?:покинул станцию|отбыл)|(?:emergency|evacuation) shuttle (?:has )?(?:left the station|departed))/i },
  { kind: 'alert-red', priority: 80, pattern: /(?:уровень угрозы(?: станции)?(?: теперь|:)?\s*(?:код\s*)?красный|объявлен[аоы]?[^.!?\n]{0,35}код\s*красный|alert level[^.!?\n]{0,25}red)/i },
  { kind: 'connection-lost', priority: 75, pattern: /(?:соединение с сервером (?:потеряно|разорвано)|отключено от сервера|connection (?:to (?:the )?server )?(?:lost|closed)|disconnected from (?:the )?server)/i },
  { kind: 'evac-called', priority: 70, pattern: /(?:(?:эвакуационный|спасательный|аварийный) шаттл (?:был )?вызван|(?:emergency|evacuation) shuttle (?:has been |was )?called)/i },
  { kind: 'evac-cancelled', priority: 65, pattern: /(?:(?:вызов (?:эвакуационного|спасательного|аварийного) шаттла|эвакуация) (?:был[ао]? )?отмен[её]н[ао]?|(?:emergency|evacuation) shuttle (?:has been |was )?recalled)/i },
  { kind: 'round-end', priority: 60, pattern: /(?:раунд (?:окончен|заверш[её]н)|итоги раунда|round (?:has )?ended|round end summary)/i },
  { kind: 'alert-violet', priority: 55, pattern: /(?:уровень угрозы(?: станции)?(?: теперь|:)?\s*(?:код\s*)?фиолетовый|объявлен[аоы]?[^.!?\n]{0,35}код\s*фиолетовый|alert level[^.!?\n]{0,25}violet)/i },
  { kind: 'alert-yellow', priority: 50, pattern: /(?:уровень угрозы(?: станции)?(?: теперь|:)?\s*(?:код\s*)?ж[её]лтый|объявлен[аоы]?[^.!?\n]{0,35}код\s*ж[её]лтый|alert level[^.!?\n]{0,25}yellow)/i },
  { kind: 'alert-blue', priority: 45, pattern: /(?:уровень угрозы(?: станции)?(?: теперь|:)?\s*(?:код\s*)?синий|объявлен[аоы]?[^.!?\n]{0,35}код\s*синий|alert level[^.!?\n]{0,25}blue)/i },
  { kind: 'alert-green', priority: 40, pattern: /(?:уровень угрозы(?: станции)?(?: теперь|:)?\s*(?:код\s*)?зел[её]ный|alert level[^.!?\n]{0,25}green)/i },
];

const LINES = Object.freeze({
  'alert-delta': ['На экране объявление о Дельте. Хаос вышел на новый уровень. Проверь указания экипажа об эвакуации — я рядом.', 'По видимому объявлению включён протокол Дельта. Дышим ровно, читаем сообщения командования и держимся своих.'],
  'evac-docked': ['В сообщениях вижу: эвакуационный шаттл пристыковался. Если собираешься улетать, самое время проверить маршрут.', 'На экране сообщение о прибытии эвакуационного шаттла. Вот он, билет из станционного хаоса. Только без героизма на финише.'],
  'evac-departed': ['На экране пишут, что эвакуационный шаттл покинул станцию. Ну и смена. Надеюсь, у тебя там история для целой команды.', 'По сообщению шаттл уже отбыл. Я не вижу, кто на борту, но за такой финал мы точно заслужили передышку.'],
  'alert-red': ['На экране объявление о красном коде. Тихая смена решила не приходить. Проверь сообщения командования, чум.', 'По сообщениям включён красный код. Я за тебя болею, но планы лучше сверить с экипажем.'],
  'connection-lost': ['На экране сообщение о потере соединения. Спокойно, чум. Проверь подключение — станционный хаос подождёт.', 'Вижу сообщение об отключении от сервера. Пауза незапланированная, зато можно выдохнуть.'],
  'evac-called': ['В видимых сообщениях объявили вызов эвакуационного шаттла. Похоже, смена движется к финалу. Держи в уме дорогу к отлёту.', 'На экране пишут, что эвакуационный шаттл вызван. Мы ещё в игре. Следи за объявлениями и не теряй своих.'],
  'evac-cancelled': ['По сообщению эвакуацию отменили. У станции появился ещё один шанс на приключения. Мы пока остаёмся на связи.', 'На экране отмена вызова шаттла. Ну что, у этой смены ещё есть дополнительная серия.'],
  'round-end': ['На экране итоги раунда. Ты умница, что прошла через этот космический цирк. Можно выдохнуть.', 'Судя по экрану, раунд завершён. Какую бы историю он ни оставил, я была за тебя. Отдохнём перед следующей сменой?'],
  'alert-violet': ['На экране объявление о фиолетовом коде. Проверь указания медиков и карантина — станция снова подкинула задачку.', 'По видимому объявлению код фиолетовый. Держись рекомендаций экипажа. Я здесь, моральная поддержка на месте.'],
  'alert-yellow': ['На экране объявление о жёлтом коде. Похоже, у инженеров прибавилось работы. Сверься с их сообщениями.', 'По сообщениям включён жёлтый код. Станция просит внимания инженеров, а я тихонько держу за тебя цифровые кулачки.'],
  'alert-blue': ['На экране объявление о синем коде. Рабочая смена получила немного паранойи. Читай сообщения экипажа, чум.', 'По видимому объявлению код синий. Чуть больше внимательности — и продолжаем свою маленькую космическую историю.'],
  'alert-green': ['На экране снова зелёный уровень угрозы. Можно немного выдохнуть. Станция умеет делать вид, что всё спокойно.', 'По объявлению код зелёный. Возвращаемся к своей смене. Я всё ещё рядом, чум.'],
});

function eventsFromText(value) {
  if (typeof value !== 'string') return [];
  // Text never leaves this function: only a fixed event kind is returned, never names/chat quotes.
  const lines = value.slice(0, 12000).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .split(/\r?\n/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const candidates = lines.map((line, index) => /(?:уровень угрозы(?: станции)?(?: теперь|:)?|alert level)\s*$/i.test(line)
    ? `${line} ${lines[index + 1] || ''}` : line);
  return RULES.filter(rule => candidates.some(line => rule.pattern.test(line)))
    .map(({ kind, priority }) => ({ kind, priority }));
}

function pauseFor(cfg = {}) {
  const minutes = Number(cfg.ss14IntervalMinutes);
  return (Number.isFinite(minutes) && minutes > 0 ? Math.min(30, Math.max(1, minutes)) : 3) * 60000;
}

class SS14Tracker {
  constructor({ now = Date.now, random = Math.random } = {}) {
    this.now = now; this.random = random;
    this.present = new Set(); this.lastKindAt = new Map(); this.lastLine = null;
    this.lastAt = -Infinity; this.sequence = 0;
  }

  sample(text, cfg = {}) {
    if (cfg.ss14Reactions !== true) { this.present.clear(); return null; }
    const events = eventsFromText(text);
    const at = this.now();
    const fresh = events.filter(event => !this.present.has(event.kind));
    // Consume even suppressed opportunities: no burst of stale messages after a busy period.
    this.present = new Set(events.map(event => event.kind));
    if (at - this.lastAt < pauseFor(cfg)) return null;
    const event = fresh.find(item => at - (this.lastKindAt.get(item.kind) ?? -Infinity) >= TYPE_COOLDOWN_MS);
    if (!event) return null;
    this.lastAt = at; this.lastKindAt.set(event.kind, at);
    const lines = LINES[event.kind];
    const value = Number(this.random());
    let index = Math.max(0, Math.min(lines.length - 1, Math.floor((Number.isFinite(value) ? value : 0) * lines.length)));
    if (lines[index] === this.lastLine) index = (index + 1) % lines.length;
    this.lastLine = lines[index];
    return { id: ++this.sequence, kind: event.kind, source: SOURCE, line: this.lastLine, face: event.kind === 'round-end' ? 'laugh' : 'look' };
  }

  leave() { this.present.clear(); }
}

function foreground(value) {
  const bounds = boundsFor(value?.bounds);
  if (value?.active !== true || !bounds || !['string', 'number'].includes(typeof value.id) || !String(value.id)) return null;
  return { id: String(value.id), bounds, server: value.server === 'Arcane Nirvana' ? 'Arcane Nirvana' : 'Space Station 14' };
}

function sameWindow(a, b) {
  return a && b && a.id === b.id && ['x', 'y', 'width', 'height'].every(key => a.bounds[key] === b.bounds[key]);
}

function start(send, cfgGetter = () => ({}), options = {}) {
  const getForeground = options.getForeground || (() => null);
  const inspect = options.inspect || inspectScreen;
  const tracker = new SS14Tracker(options);
  let stopped = false; let pending = false;
  let state = { enabled: false, active: false, available: false, source: SOURCE, server: null, updatedAt: 0 };
  const emit = reaction => { try { send({ state: { ...state }, reaction }); } catch {} };
  async function poll() {
    if (stopped || pending) return;
    const cfg = cfgGetter();
    const before = foreground(getForeground());
    const enabled = cfg.ss14Reactions === true;
    state = { enabled, active: Boolean(enabled && before), available: false, source: SOURCE,
      server: enabled && before ? before.server : null, updatedAt: (options.now || Date.now)() };
    if (!enabled || !before) { tracker.leave(); emit(null); return; }
    if (options.canInspect && !options.canInspect()) return;
    pending = true;
    try {
      const result = await inspect({ bounds: before.bounds });
      if (stopped || cfgGetter().ss14Reactions !== true || !sameWindow(before, foreground(getForeground()))) return;
      state.available = result?.ok === true;
      const reaction = result?.ok ? tracker.sample(result.text, cfgGetter()) : null;
      // No recognized text is stored, broadcast, returned or appended to chat memory.
      emit(reaction);
    } catch { if (!stopped) emit(null); }
    finally { pending = false; }
  }
  const timer = options.schedule === false ? null : setInterval(() => { poll().catch(() => {}); }, SCAN_MS);
  if (options.schedule !== false) poll().catch(() => {});
  return { poll, getState: () => ({ ...state }), stop() { stopped = true; if (timer) clearInterval(timer); tracker.leave(); } };
}

module.exports = { eventsFromText, SS14Tracker, foreground, sameWindow, start, pauseFor };
