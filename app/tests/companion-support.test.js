'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ContextTracker } = require('../src/main/companion-context');
const { create } = require('../src/main/companion-support');
const { reply } = require('../src/main/offline-companion');
const { SUPPORT_LINES, DRAWING_LINES } = require('../src/main/companion-support-lines');
const drawing = { drawingApp: 'Krita' };

test('a busy renderer does not spend Krita cooldown before the first real opportunity', () => {
  let at = 0; const t = new ContextTracker({ now: () => at, random: () => 0 });
  const cfg = { kritaIntervalMinutes: 12, spotifyReactions: false };
  t.sample(drawing, cfg); at = 45000;
  assert.equal(t.sample(drawing, cfg, { drawingReady: false }).reaction, null);
  at = 50000; assert.equal(t.sample(drawing, cfg, { drawingReady: false }).reaction, null);
  at = 51000; assert.equal(t.sample(drawing, cfg, { drawingReady: true }).reaction.kind, 'drawing');
});
test('a fresh rejected drawing opportunity retries after a minute with fresh text, not after twelve minutes', () => {
  let at = 0; const t = new ContextTracker({ now: () => at, random: () => 0 });
  const cfg = { kritaIntervalMinutes: 12, spotifyReactions: false };
  t.sample(drawing, cfg); at = 45000; const first = t.sample(drawing, cfg).reaction;
  assert.equal(t.reacted(first.id + 1, false), false);
  assert.equal(t.reacted(first.id, false), true);
  assert.equal(t.reacted(first.id, false), false);
  at = 104999; assert.equal(t.sample(drawing, cfg).reaction, null);
  at = 105000; const retry = t.sample(drawing, cfg).reaction;
  assert.equal(retry.kind, 'drawing'); assert.notEqual(retry.id, first.id); assert.notEqual(retry.line, first.line);
  assert.equal(t.reacted(retry.id, true), true);
  assert.equal(t.reacted(retry.id, false), false);
  at = 165000; assert.equal(t.sample(drawing, cfg).reaction, null);
});
test('expired or malformed acknowledgements cannot roll back a delivered cooldown', () => {
  let at = 0; const t = new ContextTracker({ now: () => at });
  t.sample(drawing); at = 45000; const event = t.sample(drawing).reaction;
  assert.equal(t.reacted(String(event.id), false), false);
  assert.equal(t.reacted(event.id, 'no'), false);
  at += 30001; assert.equal(t.reacted(event.id, false), false);
  at = 110000; assert.equal(t.sample(drawing).reaction, null);
});
test('a rejected drawing never replays while another app is foreground, and a long switch starts fresh', () => {
  let at = 0; const t = new ContextTracker({ now: () => at });
  const cfg = { kritaIntervalMinutes: 1, spotifyReactions: false };
  t.sample(drawing, cfg); at = 45000; const event = t.sample(drawing, cfg).reaction;
  t.reacted(event.id, false); at = 50000; t.sample({ drawingApp: null }, cfg);
  at = 120000; assert.equal(t.sample({ drawingApp: null }, cfg).reaction, null);
  assert.equal(t.sample(drawing, cfg).reaction, null);
  at = 164999; assert.equal(t.sample(drawing, cfg).reaction, null);
  at = 165000; assert.equal(t.sample(drawing, cfg).reaction.kind, 'drawing');
});
test('disabling Krita clears a suspended session and any receipt, but leaves Spotify eligible', () => {
  let at = 0; const t = new ContextTracker({ now: () => at });
  t.sample(drawing); at = 45000; const event = t.sample(drawing).reaction;
  at = 46000; t.sample(drawing, { kritaReactions: false });
  assert.equal(t.reacted(event.id, false), false);
  at = 100000; assert.equal(t.sample(drawing, { kritaReactions: true }).reaction, null);
  at = 110000; const music = { music: { title: 'Actual track', artist: 'Artist', playing: true, source: 'gsmtc' } };
  t.sample(music); at = 140000; assert.equal(t.sample(music).reaction.kind, 'music');
});
test('Krita has no early repeat across the old eight-line boundary and chooses a bank using focus time', () => {
  let at = 0; const t = new ContextTracker({ now: () => at, random: () => 0 });
  const cfg = { kritaIntervalMinutes: 1, spotifyReactions: false }; t.sample(drawing, cfg);
  const lines = [];
  for (let i = 0; i < 16; i++) { at = 45000 + i * 60000; const event = t.sample(drawing, cfg); lines.push(event.reaction.line); t.reacted(event.reaction.id, true); }
  assert.equal(new Set(lines).size, 16);
  assert.ok(DRAWING_LINES.start.includes(lines[0]));
  assert.ok(DRAWING_LINES.steady.includes(lines[10]));
  at = 1245000; assert.ok(DRAWING_LINES.long.includes(t.sample(drawing, cfg).reaction.line));
});
test('manual support offers distinct local phrases for every topic and respects the selected answer language', () => {
  const service = create({ random: () => 0 });
  for (const category of Object.keys(SUPPORT_LINES)) {
    const answers = Array.from({ length: SUPPORT_LINES[category].length }, () => service.line(category));
    assert.ok(answers.every(result => result.ok && SUPPORT_LINES[category].includes(result.line)));
    assert.equal(new Set(answers.map(result => result.line)).size, answers.length);
    assert.match(service.line(category, 'ja').line, /[\u3040-\u30ff\u3400-\u9fff]/);
  }
  assert.equal(service.line('__proto__').ok, false);
  assert.equal(service.line('run-shell').ok, false);
});
test('offline support and creative frustration return authored replies instead of a capabilities fallback', () => {
  for (const input of ['поддержи меня', 'подбодри', 'ничего не получается', 'я проиграла', 'не получается рисовать', 'я застряла на рисунке', 'у меня получилось', 'закончила рисунок']) {
    const text = reply(input, { responseLanguage: 'ru' });
    assert.doesNotMatch(text, /пределами моих|конечный набор|включи ИИ|поздравляю с поражением/i);
    assert.ok(Object.values(SUPPORT_LINES).flat().includes(text));
  }
  assert.match(reply('поддержи меня', { responseLanguage: 'ja' }), /[\u3040-\u30ff\u3400-\u9fff]/);
});
test('renderer acknowledges only fresh drawing cards, reports skipped cards once and speaks accepted text', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/companion-context.js'), 'utf8');
  const { CompanionContext } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const feedback = [], spoken = [];
  const capri = { free: true, mode: 'idle', wake() {}, perform() {} }, panel = { visible: true, say: () => true };
  const context = new CompanionContext({ capri, panel, chat: { open: false }, guide: { running: false }, host: { contextReaction: value => feedback.push(value) } });
  context.onSay = line => spoken.push(line);
  const event = (id, kind = 'drawing') => ({ state: { enabled: true }, reaction: { id, kind, line: 'Твой темп подходит.' } });
  context.onSnapshot(event(1)); panel.visible = false; context.onSnapshot(event(1));
  context.onSnapshot(event(2)); context.onSnapshot(event(3, 'music'));
  assert.deepEqual(feedback, [{ id: 1, accepted: false }, { id: 2, accepted: true }]);
  assert.deepEqual(spoken, ['Твой темп подходит.', 'Твой темп подходит.']); context.dispose();
});

async function supportUi(extra = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/companion-support.js'), 'utf8');
  const { CompanionSupport } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const shown = [], spoken = [], resolvers = [];
  const capri = { free: true, wake() {}, perform() {}, stowed: false, stowing: false, hidden: false, busy: false, async unstow() { this.stowed = this.hidden = false; } };
  const panel = { current: null, hide() { this.current = null; }, say(value) { this.current = value; shown.push(value); return true; } };
  const host = { setConfig: async () => ({ visible: true }), supportLine: () => new Promise(resolve => resolvers.push(resolve)) };
  const controller = new CompanionSupport({ capri, panel, host, chat: { open: false, close() {} }, guide: { running: false, answer() {} },
    speech: { cancelRecording() {}, stop() {}, say(line) { spoken.push(line); } } }, extra);
  return { controller, capri, panel, host, shown, spoken, resolvers };
}
test('a late support reply cannot replace a newer reply or speak after manual hiding', async () => {
  const f = await supportUi(); const older = f.controller.show(), newer = f.controller.show('rest');
  f.resolvers[1]({ ok: true, line: 'Новая поддержка.' }); assert.equal(await newer, true);
  f.resolvers[0]({ ok: true, line: 'Старая поддержка.' }); assert.equal(await older, false);
  assert.deepEqual(f.spoken, ['Новая поддержка.']);
  const hidden = f.controller.show(); f.controller.configure({ visible: false });
  f.resolvers[2]({ ok: true, line: 'Не показывать.' }); assert.equal(await hidden, false);
  assert.equal(f.shown.length, 1);
});
test('a pending support reply preserves another card opened by the user', async () => {
  const f = await supportUi(), pending = f.controller.show();
  const current = { line: 'Другая карточка.' }; f.panel.current = current;
  f.resolvers[0]({ ok: true, line: 'Устаревший ответ.' }); assert.equal(await pending, false);
  assert.equal(f.panel.current, current); assert.equal(f.spoken.length, 0);
});
test('manual support waits for folding and unfolding to finish before preparing or speaking', async () => {
  let at = 0; const events = []; let f;
  f = await supportUi({ now: () => at, sleep: async () => { at += 40; if (f.capri.stowing) { f.capri.stowing = false; f.capri.stowed = true; events.push('fold-finished'); } } });
  f.capri.stowing = true; f.capri.hidden = true;
  f.capri.unstow = async function () { if (this.stowing) return; events.push('unfold-finished'); this.stowed = this.hidden = false; };
  f.host.supportLine = async () => { events.push('prepare'); return { ok: true, line: 'Я рядом.' }; };
  assert.equal(await f.controller.show(), true);
  assert.deepEqual(events, ['fold-finished', 'unfold-finished', 'prepare']); assert.deepEqual(f.spoken, ['Я рядом.']);
});
test('old foreground metadata and a manually hidden pet cannot receive deferred drawing praise', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/companion-context.js'), 'utf8');
  const { CompanionContext } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const feedback = [], shown = [];
  const c = new CompanionContext({ host: { contextReaction: value => feedback.push(value) }, capri: { free: true, mode: 'idle', wake() {}, perform() {} },
    panel: { visible: false, say: value => shown.push(value) }, chat: { open: false }, guide: { running: false } });
  const event = (id, updatedAt) => ({ state: { enabled: true, updatedAt }, reaction: { id, kind: 'drawing', line: 'Поддержка.' } });
  assert.equal(c.onSnapshot(event(1, Date.now() - 26000)), false);
  assert.equal(c.onSnapshot(event(2, Date.now() + 5000)), false);
  c.configure({ visible: false }); assert.equal(c.onSnapshot(event(3, Date.now())), false);
  assert.equal(shown.length, 0); assert.equal(feedback.length, 3); c.dispose();
});
