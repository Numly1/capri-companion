'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/pc.js'), 'utf8')
  .replace("import { pick, fmt } from './util.js';", "const pick = values => values[0]; const fmt = value => value;");
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

async function harness(t, config = {}) {
  const { Pc } = await modulePromise;
  const pc = Object.create(Pc.prototype);
  const counts = { wake: 0, sleep: 0, stow: 0, unstow: 0, rest: 0 };
  const state = { now: 10000, visible: true };
  t.mock.method(Date, 'now', () => state.now);
  Object.assign(pc, { game: null, drives: [], plugs: 0, wantsOut: () => state.visible,
    chat: { open: false }, guide: { running: false }, panel: { visible: false },
    brain: { lang: 'ru', t: { pc: { gameBack: ['Я вернулась'] } } }, say() {}, onRest() { counts.rest++; },
  });
  pc.capri = {
    mode: 'idle', stowed: false, stowing: false, dormant: false,
    get free() { return !this.busy && !this.dragging && !this.act && !this.stowed && !this.stowing && !this.dormant; },
    wake() { counts.wake++; this.mode = 'idle'; this.dormant = false; },
    setMode(mode) { if (mode === 'sleep') counts.sleep++; this.mode = mode; },
    stow() { counts.stow++; this.stowed = true; },
    unstow() { counts.unstow++; this.stowed = false; return Promise.resolve(); },
  };
  pc.configure(config);
  const start = (name = 'Minecraft') => pc.onWindows({ game: name });
  const after = (milliseconds) => { state.now += milliseconds; pc.checkGame(); };
  return { pc, counts, state, start, after };
}

test('Minecraft stays awake and visible by default; no delayed hiding is scheduled', async t => {
  const { pc, counts, start, after } = await harness(t);
  t.mock.method(global, 'setTimeout', () => { throw new Error('Unexpected hide timer'); });
  pc.capri.mode = 'sleep'; start(); after(7000); after(1000);
  assert.equal(pc.capri.mode, 'idle'); assert.equal(counts.stow, 0); assert.equal(counts.sleep, 0);
  assert.ok(counts.wake >= 2);
});

test('game sleep waits configured dwell, stops speech once, and wakes after leaving the game', async t => {
  const { pc, counts, state, start, after } = await harness(t, { gameBehavior: 'sleep', gameDelaySeconds: 30 });
  start(); after(29999); assert.equal(counts.sleep, 0);
  after(1); assert.equal(counts.sleep, 1); assert.equal(counts.rest, 1); assert.equal(pc.capri.mode, 'sleep');
  after(90000); assert.equal(counts.sleep, 1); assert.equal(counts.wake, 0);
  pc.onWindows({ game: null }); const goneAt = state.now;
  after(7999); assert.equal(pc.capri.mode, 'sleep');
  after(1); assert.equal(state.now - goneAt, 8000); assert.equal(pc.capri.mode, 'idle'); assert.equal(counts.wake, 1);
  assert.equal(pc.game, null);
});

test('brief Alt+Tab keeps sleep ownership without repeating sleep or waking', async t => {
  const { pc, counts, start, after } = await harness(t, { gameBehavior: 'sleep', gameDelaySeconds: 5 });
  start(); after(5000); pc.capri.dormant = true;
  pc.onWindows({ game: null }); after(2000); start(); after(10000);
  assert.equal(counts.sleep, 1); assert.equal(counts.wake, 0); assert.equal(pc.game.sleeping, true);
});

test('game scope applies only to selected Minecraft or SS14', async t => {
  const { pc, counts, start, after } = await harness(t, { gameBehavior: 'sleep', gameDelaySeconds: 5, gameScope: 'ss14' });
  start('Minecraft'); after(300000); assert.equal(counts.sleep, 0);
  start('Space Station 14'); after(5000); assert.equal(counts.sleep, 1);
  pc.configure({ gameBehavior: 'sleep', gameDelaySeconds: 5, gameScope: 'minecraft' });
  assert.equal(pc.capri.mode, 'idle'); after(5000); assert.equal(counts.sleep, 1);
  start('Minecraft'); after(5000); assert.equal(counts.sleep, 2);
});

test('changing behavior releases only automatic sleep and starts a fresh delay', async t => {
  const { pc, counts, start, after } = await harness(t, { gameBehavior: 'sleep', gameDelaySeconds: 5 });
  start(); after(5000); assert.equal(pc.game.sleeping, true);
  pc.configure({ gameBehavior: 'stay' }); assert.equal(counts.wake, 1); assert.equal(pc.capri.mode, 'idle');
  pc.configure({ gameBehavior: 'sleep', gameDelaySeconds: 30 }); after(29999); assert.equal(counts.sleep, 1);
  after(1); assert.equal(counts.sleep, 2);
});

test('manually asleep or hidden characters are not claimed or restored by automatic sleep', async t => {
  const f = await harness(t, { gameBehavior: 'sleep', gameDelaySeconds: 5 });
  f.pc.capri.mode = 'sleep'; f.start(); f.after(5000);
  assert.equal(f.counts.sleep, 0); assert.equal(f.pc.game.sleeping, false);
  f.pc.onWindows({ game: null }); f.after(8000); assert.equal(f.counts.wake, 0);
  f.pc.capri.stowed = true; f.start(); f.after(5000); f.pc.onWindows({ game: null }); f.after(8000);
  assert.equal(f.counts.unstow, 0); assert.equal(f.counts.wake, 0);
});

test('manual hiding during automatic sleep remains hidden after game or preference changes', async t => {
  const { pc, counts, state, start, after } = await harness(t, { gameBehavior: 'sleep', gameDelaySeconds: 5 });
  start(); after(5000); state.visible = false; pc.capri.stowed = true;
  pc.configure({ gameBehavior: 'stay' }); pc.onWindows({ game: null }); after(8000);
  assert.equal(counts.wake, 0); assert.equal(counts.unstow, 0); assert.equal(pc.capri.stowed, true);
});

test('clicking or an external wake grants a minute before sleeping again', async t => {
  const { pc, counts, start, after } = await harness(t, { gameBehavior: 'sleep', gameDelaySeconds: 5 });
  start(); after(5000); pc.interact(); assert.equal(counts.wake, 1);
  after(59999); assert.equal(counts.sleep, 1); after(1); assert.equal(counts.sleep, 2);
  pc.capri.wake(); after(1000); assert.equal(pc.game.sleeping, false);
  after(59999); assert.equal(counts.sleep, 2); after(1); assert.equal(counts.sleep, 3);
});

test('conversation, guide, panel, work, drag and animation defer game sleep', async t => {
  const { pc, counts, start, after } = await harness(t, { gameBehavior: 'sleep', gameDelaySeconds: 5 });
  start(); after(4999);
  const cases = [[pc.chat, 'open', true], [pc.guide, 'running', true], [pc.panel, 'visible', true],
    [pc.capri, 'mode', 'work'], [pc.capri, 'dragging', true], [pc.capri, 'busy', true], [pc.capri, 'act', {}]];
  for (const [object, key, value] of cases) {
    const previous = object[key]; object[key] = value; after(1000); assert.equal(counts.sleep, 0); object[key] = previous;
  }
  after(1000); assert.equal(counts.sleep, 1);
});

test('game behavior still works when unrelated CPU and device reactions are disabled', async t => {
  const { pc, counts, start, after } = await harness(t, { pcReact: false, gameBehavior: 'sleep', gameDelaySeconds: 5 });
  start(); after(5000); assert.equal(counts.sleep, 1); assert.equal(pc.enabled, false);
});

test('legacy hide preference uses configured delay and automatic hiding can be cancelled mid-fold', async t => {
  const { pc, counts, start, after } = await harness(t, { hideInGames: true, gameDelaySeconds: 5 });
  pc.capri.stow = () => { counts.stow++; pc.capri.stowing = true; };
  pc.capri.unstow = () => { counts.unstow++; pc.capri.unstowAfter = pc.capri.stowing; return Promise.resolve(); };
  start(); after(4999); assert.equal(counts.stow, 0); after(1); assert.equal(counts.stow, 1);
  after(1000); assert.equal(pc.game.put, true, 'a fold in progress is still owned');
  pc.configure({ gameBehavior: 'stay' }); assert.equal(counts.unstow, 1); assert.equal(pc.capri.unstowAfter, true);
});

test('switching games restores previous automatic state without bypassing the next dwell', async t => {
  const { pc, counts, start, after } = await harness(t, { gameBehavior: 'hide', gameDelaySeconds: 5 });
  start(); after(5000); assert.equal(counts.stow, 1);
  start('Space Station 14'); assert.equal(counts.unstow, 1); after(4999); assert.equal(counts.stow, 1);
  after(1); assert.equal(counts.stow, 2);
});
