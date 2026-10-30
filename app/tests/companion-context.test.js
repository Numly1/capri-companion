'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ContextTracker, classifyDrawing, sanitizeSnapshot, conversationContext, sanitizeCover, enabledIntegrations, MAX_COVER_BYTES } = require('../src/main/companion-context');

test('drawing classification is a narrow allowlist and never outputs document titles', () => {
  assert.equal(classifyDrawing('C:\\Apps\\Krita.exe', 'private-art.kra — Krita'), 'Krita');
  assert.equal(classifyDrawing('chrome.exe', 'private-file.psd — Photopea'), 'Photopea');
  assert.equal(classifyDrawing('notepad.exe', 'Krita secret drawing'), null);
  assert.equal(classifyDrawing('unknown.exe', 'private report'), null);
  const safe = sanitizeSnapshot({ drawingApp: 'Krita', title: 'secret.kra', executable: 'secret.exe', music: null });
  assert.deepEqual(safe, { drawingApp: 'Krita', music: null, mediaAvailable: false });
});

test('drawing waits 90 seconds, praises during a long session with its own cooldown and no immediate repeat', () => {
  let at = 0;
  const tracker = new ContextTracker({ now: () => at, random: () => 0 });
  const sample = () => tracker.sample({ drawingApp: 'Krita' });
  assert.equal(sample().reaction, null);
  at = 89999; assert.equal(sample().reaction, null);
  at = 90000;
  const first = sample().reaction;
  assert.equal(first.kind, 'drawing');
  assert.match(first.line, /Круто|умница|верю|твор/i);
  at = 809999; assert.equal(sample().reaction, null);
  at = 810000;
  const second = sample().reaction;
  assert.equal(second.kind, 'drawing');
  assert.notEqual(second.line, first.line);
  // An overdue poll produces one opportunity, never a catch-up burst.
  at = 10000000; assert.equal(sample().reaction.kind, 'drawing');
  assert.equal(sample().reaction, null);
  tracker.sample({ drawingApp: null });
  at += 1; assert.equal(sample().reaction, null);
  at += 90000; assert.equal(sample().reaction, null);
  at += 630000; assert.equal(sample().reaction.kind, 'drawing');
});

test('Krita praise uses its configured interval and disabling it requires a fresh drawing dwell', () => {
  let at = 0;
  const tracker = new ContextTracker({ now: () => at, random: () => 0 });
  const cfg = { kritaIntervalMinutes: 5, spotifyReactions: false };
  const sample = (config = cfg) => tracker.sample({ drawingApp: 'Krita' }, config);
  sample();
  at = 90000; assert.equal(sample().reaction.kind, 'drawing');
  at = 389999; assert.equal(sample().reaction, null);
  at = 390000; assert.equal(sample().reaction.kind, 'drawing');
  at = 800000;
  const disabled = sample({ ...cfg, kritaReactions: false });
  assert.equal(disabled.reaction, null); assert.equal(disabled.state.drawing, null);
  at = 900000; assert.equal(sample().reaction, null);
  at = 989999; assert.equal(sample().reaction, null);
  at = 990000; assert.equal(sample().reaction.kind, 'drawing');
});

test('short switches reset drawing dwell and no content-specific art praise is fabricated', () => {
  let at = 0;
  const t = new ContextTracker({ now: () => at, random: () => 0 });
  t.sample({ drawingApp: 'Krita' });
  at = 80000; t.sample({ drawingApp: null });
  at = 85000; t.sample({ drawingApp: 'Krita' });
  at = 100000; assert.equal(t.sample({ drawingApp: 'Krita' }).reaction, null);
  at = 175000;
  const line = t.sample({ drawingApp: 'Krita' }).reaction.line;
  assert.match(line, /Krita/);
  assert.doesNotMatch(line, /вижу|цвета|композици|красиво нарисова/i);
});

test('Spotify waits 30 seconds of confirmed playback; paused and fallback remain quiet', () => {
  let at = 0;
  const t = new ContextTracker({ now: () => at, random: () => 0 });
  const song = (playing = true, source = 'gsmtc') => ({ music: { title: 'Actual song', artist: 'Actual artist', playing, source } });
  t.sample(song(false));
  at = 100000; assert.equal(t.sample(song(false)).reaction, null);
  at = 110000; assert.equal(t.sample(song()).reaction, null);
  at = 139999; assert.equal(t.sample(song()).reaction, null);
  at = 140000; const event = t.sample(song());
  assert.equal(event.reaction.kind, 'music');
  assert.match(event.reaction.line, /Actual artist — Actual song/);
  at = 9000000; assert.equal(t.sample(song()).reaction, null);
  const fallback = new ContextTracker({ now: () => at });
  fallback.sample(song(null, 'window-title'));
  at += 9000000; assert.equal(fallback.sample(song(null, 'window-title')).reaction, null);
});

test('Spotify and Krita have independent cooldowns and a previously announced song never repeats', () => {
  let at = 0;
  const t = new ContextTracker({ now: () => at, random: () => 0 });
  const cfg = { spotifyIntervalMinutes: 12, kritaIntervalMinutes: 12 };
  const song = (title) => ({ music: { title, artist: 'Artist', playing: true, source: 'gsmtc' } });
  t.sample({ ...song('One'), drawingApp: 'Krita' }, cfg);
  at = 30000; assert.equal(t.sample({ ...song('One'), drawingApp: 'Krita' }, cfg).reaction.kind, 'music');
  // Krita does not wait for Spotify's twelve-minute cooldown: only sixty-second anti-overlap applies.
  at = 90000; assert.equal(t.sample({ ...song('One'), drawingApp: 'Krita' }, cfg).reaction.kind, 'drawing');
  at = 100000; t.sample({ ...song('Two'), drawingApp: 'Krita' }, cfg);
  at = 130000; assert.equal(t.sample({ ...song('Two'), drawingApp: 'Krita' }, cfg).reaction, null);
  at = 750000; assert.equal(t.sample({ ...song('Two'), drawingApp: 'Krita' }, cfg).reaction.kind, 'music');
  at = 760000; t.sample(song('Three'), cfg);
  at = 770000; t.sample({ ...song('Three'), drawingApp: 'Krita' }, cfg);
  at = 860000; assert.equal(t.sample({ ...song('Three'), drawingApp: 'Krita' }, cfg).reaction.kind, 'drawing');
  at = 2200000; t.sample(song('One'), cfg);
  at += 60000; assert.equal(t.sample(song('One'), cfg).reaction, null);
});

test('sixty seconds of global spacing prevents simultaneous reactions without merging per-kind cooldowns', () => {
  let at = 0;
  const t = new ContextTracker({ now: () => at, random: () => 0 });
  const raw = { drawingApp: 'Krita', music: { title: 'One', artist: 'Artist', playing: true, source: 'gsmtc' } };
  t.sample(raw);
  at = 90000; assert.equal(t.sample(raw).reaction.kind, 'drawing');
  at = 100000; assert.equal(t.sample(raw).reaction, null);
  at = 149999; assert.equal(t.sample(raw).reaction, null);
  at = 150000; assert.equal(t.sample(raw).reaction.kind, 'music');
});

test('each integration can be disabled separately and its metadata is omitted', () => {
  let at = 0;
  const raw = { drawingApp: 'Krita', mediaAvailable: true, music: { title: 'One', artist: 'Artist', playing: true, source: 'gsmtc' } };
  const drawing = new ContextTracker({ now: () => at });
  let event = drawing.sample(raw, { spotifyReactions: false, spotifyWidget: false });
  assert.equal(event.state.music, null);
  assert.equal(event.state.mediaAvailable, false);
  assert.equal(event.state.drawing.app, 'Krita');
  at = 90000; assert.equal(drawing.sample(raw, { spotifyReactions: false, spotifyWidget: false }).reaction.kind, 'drawing');
  at = 0;
  const music = new ContextTracker({ now: () => at });
  event = music.sample(raw, { kritaReactions: false });
  assert.equal(event.state.drawing, null);
  assert.equal(event.state.music.title, 'One');
  at = 30000; assert.equal(music.sample(raw, { kritaReactions: false }).reaction.kind, 'music');
  event = music.sample(raw, { spotifyReactions: false, spotifyWidget: false, kritaReactions: false });
  assert.equal(event.state.enabled, false);
  assert.equal(event.state.drawing, null);
  assert.equal(event.state.music, null);
});

test('Spotify card stays available independently of reactions and never accumulates a delayed reaction', () => {
  let at = 0;
  const tracker = new ContextTracker({ now: () => at });
  const raw = { mediaAvailable: true, music: { title: 'Actual track', artist: 'Artist', album: 'Album', playing: true, source: 'gsmtc' } };
  const cfg = { spotifyWidget: true, spotifyReactions: false, kritaReactions: false };
  const first = tracker.sample(raw, cfg);
  assert.equal(first.state.enabled, true);
  assert.equal(first.state.spotifyEnabled, false);
  assert.equal(first.state.spotifyWidgetEnabled, true);
  assert.equal(first.state.music.title, 'Actual track');
  assert.equal(first.state.mediaAvailable, true);
  at = 3600000;
  assert.equal(tracker.sample(raw, cfg).reaction, null);
  assert.equal(tracker.sample(raw, { ...cfg, spotifyReactions: true }).reaction, null);
  at += 30000;
  assert.equal(tracker.sample(raw, { ...cfg, spotifyReactions: true }).reaction.kind, 'music');
  const disabled = tracker.sample(raw, { ...cfg, companionContext: false });
  assert.equal(disabled.state.music, null);
  assert.equal(disabled.state.spotifyWidgetEnabled, false);
  assert.equal(disabled.state.enabled, false);
  assert.equal(enabledIntegrations({ spotifyReactions: false }).spotifyMetadata, true);
});

test('Spotify artwork permits bounded local JPEG/PNG only and timeline is finite and clamped', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const cover = `data:image/png;base64,${png.toString('base64')}`;
  assert.equal(sanitizeCover(cover), cover);
  for (const invalid of ['https://example.com/cover.jpg', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/jpeg;base64,' + png.toString('base64'), cover + '\n', `data:image/png;base64,${Buffer.alloc(MAX_COVER_BYTES + 1).toString('base64')}`]) {
    assert.equal(sanitizeCover(invalid), null);
  }
  const raw = { music: { title: 'Track', artist: 'Artist', album: 'Album\u0000name', source: 'gsmtc', cover, durationMs: 250000, positionMs: 999999 } };
  const music = sanitizeSnapshot(raw).music;
  assert.equal(music.cover, cover);
  assert.equal(music.album, 'Album name');
  assert.equal(music.durationMs, 250000);
  assert.equal(music.positionMs, 250000);
  raw.music.durationMs = Infinity; raw.music.positionMs = -1;
  assert.equal(sanitizeSnapshot(raw).music.durationMs, null);
  assert.equal(sanitizeSnapshot(raw).music.positionMs, null);
});

test('conversation context excludes artwork and timeline while preserving real track identity', () => {
  const state = { enabled: true, drawing: { app: 'Krita' }, music: { title: 'Track', artist: 'Artist', album: 'Album', source: 'gsmtc', playing: false, cover: 'PRIVATE COVER', durationMs: 123, positionMs: 10 }, updatedAt: 1000 };
  const safe = conversationContext(state);
  assert.deepEqual(safe.music, { title: 'Track', artist: 'Artist', album: 'Album', source: 'gsmtc', playing: false });
  assert.equal(safe.drawing.app, 'Krita');
  assert.equal('cover' in safe.music, false);
  assert.equal('positionMs' in safe.music, false);
  assert.equal('durationMs' in safe.music, false);
  assert.equal(state.music.cover, 'PRIVATE COVER');
});

test('only Krita produces drawing reactions even when other drawing app metadata is available', () => {
  let at = 0;
  const t = new ContextTracker({ now: () => at });
  t.sample({ drawingApp: 'Adobe Photoshop' });
  at = 10000000;
  const event = t.sample({ drawingApp: 'Adobe Photoshop' });
  assert.equal(event.state.drawing.app, 'Adobe Photoshop');
  assert.equal(event.reaction, null);
});

test('disabled context strips metadata, re-enabling requires a fresh dwell; Japanese is supported', () => {
  let at = 0;
  const t = new ContextTracker({ now: () => at, random: () => 0 });
  const drawing = { drawingApp: 'Krita' };
  t.sample(drawing);
  at = 100000; const disabled = t.sample(drawing, { companionContext: false });
  assert.equal(disabled.reaction, null);
  assert.equal(disabled.state.drawing, null);
  assert.equal(disabled.state.music, null);
  at += 1; assert.equal(t.sample(drawing, { lang: 'ja' }).reaction, null);
  at += 90000; assert.match(t.sample(drawing, { lang: 'ja' }).reaction.line, /アイデア/);
});

test('renderer skips busy/visible/chat/guide opportunities with no deferred replay', async () => {
  const file = path.join(__dirname, '../src/renderer/js/companion-context.js');
  const { CompanionContext } = await import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync(file, 'utf8')).toString('base64')}`);
  const said = [], acted = [];
  const capri = { free: true, mode: 'idle', wake() {}, perform(action) { acted.push(action); } };
  const panel = { visible: false, say(event) { said.push(event); return true; } };
  const chat = { open: false }, guide = { running: false };
  const context = new CompanionContext({ capri, panel, chat, guide, host: {}, brain: {} });
  const spoken = [];
  context.onSay = (line) => spoken.push(line);
  const event = (id, kind = 'drawing') => ({ state: { enabled: true }, reaction: { id, kind, line: 'Only actual metadata', face: 'smug', action: 'curious' } });
  panel.visible = true; assert.equal(context.onSnapshot(event(1)), false);
  panel.visible = false; assert.equal(context.onSnapshot(event(1)), false);
  chat.open = true; assert.equal(context.onSnapshot(event(2)), false);
  chat.open = false; guide.running = true; assert.equal(context.onSnapshot(event(3)), false);
  guide.running = false; capri.free = false; assert.equal(context.onSnapshot(event(4)), false);
  capri.free = true; capri.mode = 'sleep'; assert.equal(context.onSnapshot(event('sleep')), false);
  capri.mode = 'idle'; assert.equal(context.onSnapshot(event('sleep')), false, 'sleep-time reactions are discarded');
  capri.free = true; assert.equal(context.onSnapshot(event(5)), true);
  assert.equal(said.length, 1); assert.deepEqual(acted, ['curious']);
  assert.deepEqual(spoken, ['Only actual metadata']);
  context.configure({ spotifyReactions: false, kritaReactions: true });
  assert.equal(context.onSnapshot(event(6, 'music')), false);
  assert.equal(context.onSnapshot(event(7, 'drawing')), true);
  context.configure({ spotifyReactions: true, kritaReactions: false });
  assert.equal(context.onSnapshot(event(8, 'drawing')), false);
  assert.equal(context.onSnapshot(event(9, 'music')), true);
  assert.equal(said.length, 3);
  context.dispose();
});
