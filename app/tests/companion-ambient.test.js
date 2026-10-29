'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const read = name => fs.readFileSync(path.join(__dirname, '../src/renderer/js', name), 'utf8');
const panelReady = import(moduleUrl(read('panel.js').replace("import { clamp, ease, reducedMotion } from './util.js';", 'const reducedMotion = { matches: false };')));
const speechReady = import(moduleUrl(read('companion-speech.js')));
const linesUrl = moduleUrl(read('lines.js'));
const idleReady = import(moduleUrl(read('companion-idle.js').replace("'./lines.js'", `'${linesUrl}'`)));

async function panelFixture(onAmbientSay) {
  const { Panel } = await panelReady;
  const p = Object.create(Panel.prototype);
  const element = () => ({ textContent: '', hidden: false, classList: { toggle() {}, remove() {} } });
  Object.assign(p, { current: null, el: { ...element(), dataset: {} }, tickerEl: {}, quote: element(), reply: element(),
    tag: element(), state: element(), summary: element(), labels: { state: {} },
    onAmbientSay, setFace() {}, setProgress() {}, renderReport() {}, renderActions() {}, renderChat() {}, renderLog() {},
    replayEnter() {}, place() {}, decode() {},
  });
  return p;
}

test('only accepted authored idle and marked ambient lines reach speech, with no chat/context duplicates', async () => {
  const spoken = [];
  const p = await panelFixture(text => spoken.push(text));
  assert.equal(p.say({ kind: 'idle', line: 'Мы рядом, чум.', actions: [{ id: 'talk' }] }), true);
  assert.deepEqual(spoken, ['Мы рядом, чум.']);
  p.current = null;
  assert.equal(p.say({ kind: 'info', ambient: true, line: 'Спутник всё ещё там.' }), true);
  assert.equal(spoken.length, 2);
  p.current = null;
  p.say({ kind: 'chat', line: 'Ответ на вопрос.', chat: {} });
  assert.equal(p.say({ kind: 'info', ambient: true, line: 'Перебиваю!' }), false);
  assert.equal(spoken.length, 2, 'a rejected background panel stays silent');
  p.current = null;
  p.say({ kind: 'info', line: 'Название трека: …' });
  assert.equal(spoken.length, 2, 'context has its own explicit speech callback');
});

test('API setup, OCR, permission, errors and other system messages are never inferred as ambient speech', async () => {
  const { ambientText } = await panelReady;
  for (const msg of [
    { kind: 'info', line: 'Просто системное сообщение.' },
    { kind: 'info', ambient: true, guide: true, chat: { secret: true }, line: 'Вставь API ключ.' },
    { kind: 'info', ambient: true, badge: 'ЛОКАЛЬНО', line: 'Текст с экрана' },
    { kind: 'info', ambient: true, quote: 'private text', line: 'Текст из окна' },
    { kind: 'info', ambient: true, actions: [{ id: 'yes' }], line: 'Разрешишь?' },
    { kind: 'alert', ambient: true, line: 'Разрешение' },
    { kind: 'error', ambient: true, line: 'Ошибка' },
    { kind: 'idle', tag: 'private-project', line: 'Заголовок проекта' },
    { kind: 'idle', line: 'x'.repeat(501) },
  ]) assert.equal(ambientText(msg), null);
});

test('background speech respects global gap and never interrupts playback, recording or conversation', async () => {
  const { CompanionSpeech } = await speechReady;
  const spoken = [];
  const s = Object.create(CompanionSpeech.prototype);
  let now = 0;
  Object.assign(s, { cfg: { companionVoice: true, volume: 0.7 }, host: { synthesizeSpeech() {} }, chat: { open: false },
    now: () => now, sayDigital: async text => spoken.push(text),
  });
  assert.equal(s.sayAmbient('Первая реплика.'), true);
  assert.equal(s.sayAmbient('Слишком быстро.'), false);
  now = 45000;
  assert.equal(s.sayAmbient('Другая реплика.'), true);
  now += 45000;
  assert.equal(s.sayAmbient('Другая реплика.'), false, 'same ambient line never repeats immediately');
  for (const [key, value] of [['pendingSpeech', true], ['playing', true], ['processing', true], ['recorder', { state: 'recording' }]]) {
    s[key] = value; assert.equal(s.sayAmbient('Есть дела важнее.'), false); delete s[key];
  }
  s.chat.open = true; assert.equal(s.sayAmbient('Во время диалога.'), false); s.chat.open = false;
  await s.say('Обычный ответ.');
  assert.equal(s.sayAmbient('Сразу после ответа.'), false);
  now += 45000;
  for (const [key, value] of [['ambientSpeech', false], ['muted', true], ['volume', 0]]) {
    const before = s.cfg[key]; s.cfg[key] = value;
    assert.equal(s.sayAmbient('Выключено.'), false); s.cfg[key] = before;
  }
  assert.deepEqual(spoken, ['Первая реплика.', 'Другая реплика.', 'Обычный ответ.']);
});

async function idleFixture() {
  const { CompanionIdle } = await idleReady;
  const state = { now: 0, removed: 0, cleared: false }, shown = [], listeners = {};
  const capri = { free: true, mode: 'idle', stance: 'stand' };
  const panel = { visible: false, say(msg) { shown.push(msg); return true; } }, chat = { open: false }, guide = { running: false };
  const host = { onConfig(fn) { listeners.config = fn; return () => state.removed++; }, onWindows(fn) { listeners.windows = fn; return () => state.removed++; } };
  const idle = new CompanionIdle({ capri, panel, brain: {}, chat, guide, host }, {
    now: () => state.now, random: () => 0, setInterval: () => 77,
    clearInterval: id => { assert.equal(id, 77); state.cleared = true; },
  });
  const tick = now => { state.now = now; return idle.tick(); };
  return { idle, state, shown, listeners, capri, panel, chat, guide, tick };
}

test('idle chatter starts after a minute, alternates short opening lines and obeys its configured interval', async () => {
  const f = await idleFixture();
  assert.equal(f.tick(59999), false);
  assert.equal(f.tick(60000), true);
  assert.equal(f.tick(359999), false);
  assert.equal(f.tick(360000), true);
  assert.notEqual(f.shown[0].line, f.shown[1].line);
  assert.equal(f.shown.every(msg => msg.ambient && msg.kind === 'idle'), true);
  assert.equal(f.shown[0].line, 'Мы рядом, чум.');
  f.idle.configure({ ambientIntervalMinutes: 3 });
  assert.equal(f.tick(539999), false);
  assert.equal(f.tick(540000), true);
  assert.equal(f.tick(720000), true);
  assert.deepEqual(f.shown.slice(0, 4).map(msg => msg.line), [
    'Мы рядом, чум.', 'Сигнал стабильный. Продолжаем.',
    'Небольшой перерыв не помешает.', 'Этот глич был намеренным.',
  ], 'the first four successful idle lines use each cached short phrase once');
  assert.equal(f.tick(900000), true);
  assert.equal(f.shown[4].line, 'Нашла себе уголок. Теперь это командный пункт.');
  assert.equal(new Set(f.shown.map(msg => msg.line)).size, 5);
  f.idle.dispose();
  assert.equal(f.state.removed, 2); assert.equal(f.state.cleared, true);
});

test('busy, game, sleep, disabled and occupied opportunities disappear without delayed bursts', async () => {
  const f = await idleFixture();
  for (const [object, key, value] of [
    [f.panel, 'visible', true], [f.chat, 'open', true], [f.guide, 'running', true],
    [f.capri, 'busy', true], [f.capri, 'dragging', true], [f.capri, 'dormant', true],
    [f.capri, 'stowed', true], [f.capri, 'hidden', true], [f.capri, 'mode', 'sleep'],
  ]) {
    const before = object[key]; object[key] = value;
    assert.equal(f.tick(f.state.now + 400000), false); object[key] = before;
    assert.equal(f.tick(f.state.now + 1), false);
  }
  f.listeners.windows({ game: 'Minecraft' }); assert.equal(f.tick(f.state.now + 400000), false);
  f.listeners.windows({ game: null }); assert.equal(f.tick(f.state.now + 1), false);
  f.idle.configure({ ambientSpeech: false }); assert.equal(f.tick(f.state.now + 400000), false);
  f.idle.configure({ ambientSpeech: true }); assert.equal(f.tick(f.state.now + 1), false);
  assert.deepEqual(f.shown, []);
  f.idle.dispose();
  assert.equal(f.tick(f.state.now + 400000), false);
});
