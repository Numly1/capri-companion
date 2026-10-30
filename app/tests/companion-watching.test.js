'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { WatchingTracker, sanitizeWatching } = require('../src/main/companion-watching');
const movie = { service: 'Кинопоиск', title: 'Тестовый фильм', playing: true, source: 'gsmtc', url: 'PRIVATE_URL', subtitles: 'PRIVATE_SUBTITLES' };

test('watching strips all data except known foreground player metadata', () => {
  assert.deepEqual(sanitizeWatching(movie), { service: 'Кинопоиск', title: 'Тестовый фильм', playing: true, source: 'gsmtc' });
  for (const raw of [null, {}, { ...movie, service: 'unknown' }, { ...movie, title: 'Кинопоиск' }, { ...movie, title: 'https://example.invalid/private' }, { ...movie, source: 'screen' }]) assert.equal(sanitizeWatching(raw), null);
});
test('automatic comments require confirmed playback and dwell, pause resets dwell, no immediate repeats', () => {
  let at = 0;
  const tracker = new WatchingTracker({ now: () => at, random: () => 0 });
  const cfg = { watchMode: 'auto', watchIntervalMinutes: 5 };
  assert.equal(tracker.sample(movie, cfg).reaction, null);
  at = 119999; assert.equal(tracker.sample(movie, cfg).reaction, null);
  at++; const first = tracker.sample(movie, cfg).reaction; assert.match(first.line, /Тестовый фильм/);
  at += 299999; assert.equal(tracker.sample(movie, cfg).reaction, null);
  at++; const second = tracker.sample(movie, cfg).reaction; assert.notEqual(first.line, second.line);
  tracker.sample({ ...movie, playing: false }, cfg);
  at += 600000; assert.equal(tracker.sample(movie, cfg).reaction, null);
  at += 120000; assert.ok(tracker.sample(movie, cfg).reaction);
});
test('a Kinopoisk page alone does not mean playing; manual mode and disabling are explicit', () => {
  let at = 0;
  const tracker = new WatchingTracker({ now: () => at });
  const page = { ...movie, source: 'window-title', playing: null };
  tracker.sample(page, { watchMode: 'auto' }); at = 600000;
  assert.equal(tracker.sample(page, { watchMode: 'auto' }).reaction, null);
  tracker.sample(page, { watchMode: 'manual' }); at += 120000;
  assert.ok(tracker.sample(page, { watchMode: 'manual' }).reaction);
  assert.deepEqual(tracker.sample(movie, { watchMode: 'off' }).state, { enabled: false, watching: null });
});
test('watching renderer drops busy, game, sleep and stale opportunities without queuing them', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/companion-watching.js'), 'utf8');
  const { CompanionWatching } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  let count = 0;
  const watching = new CompanionWatching({ host: {}, capri: { free: true, mode: 'idle' }, panel: { visible: false, say() { count++; } }, chat: {}, guide: {}, pc: {} });
  const event = { state: { enabled: true, watching: movie }, reaction: { id: 1, line: 'Смотрим вместе', source: 'local-metadata' } };
  watching.capri.mode = 'sleep'; assert.equal(watching.onSnapshot(event), false);
  watching.capri.mode = 'idle'; assert.equal(watching.onSnapshot(event), false);
  watching.pc.game = {}; assert.equal(watching.onSnapshot({ ...event, reaction: { ...event.reaction, id: 2 } }), false);
  watching.pc.game = null; assert.equal(watching.onSnapshot({ ...event, reaction: { ...event.reaction, id: 3 } }), true);
  assert.equal(count, 1);
});
