'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/companion-acting.js'), 'utf8')
  .replace("import { reducedMotion } from './util.js';", 'const reducedMotion = { matches: false };');
const ready = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const actsReady = import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync(path.join(__dirname, '../src/renderer/js/acting.js'), 'utf8')).toString('base64')}`);

async function fixture(overrides = {}) {
  const { CompanionActing } = await ready;
  const state = { at: 0, reduced: false, intervalCleared: false, removed: 0 };
  const played = [], slices = [];
  const capri = {
    free: true, mode: 'idle', stance: 'stand', scale: 0.6,
    perform: (name) => { played.push(name); return Promise.resolve(); },
    pulse: () => played.push('glitch'), head: () => ({ x: 100, y: 100 }), towardCenter: () => 1,
    ...overrides,
  };
  const panel = { visible: false }, chat = { open: false }, guide = { running: false };
  const listeners = {};
  const host = {
    onConfig(fn) { listeners.config = fn; return () => { state.removed++; }; },
    onWindows(fn) { listeners.windows = fn; return () => { state.removed++; }; },
  };
  const acting = new CompanionActing({ capri, fx: { slices: (...args) => slices.push(args) }, panel, chat, guide, host }, {
    now: () => state.at, random: () => 0, reduced: () => state.reduced,
    setInterval: () => 123, clearInterval: (id) => { assert.equal(id, 123); state.intervalCleared = true; },
  });
  const tick = async (at) => { state.at = at; const action = acting.tick(); await Promise.resolve(); await Promise.resolve(); return action; };
  return { acting, state, capri, panel, chat, guide, listeners, played, slices, tick };
}

test('full schedule uses original acts without immediate repeats and no early glitch', async () => {
  const f = await fixture();
  const { ACTS } = await actsReady;
  assert.equal(await f.tick(4999), null);
  assert.equal(await f.tick(5000), 'curious');
  assert.equal(await f.tick(10000), 'look');
  assert.equal(await f.tick(15000), 'curious');
  assert.equal(await f.tick(19999), null);
  assert.equal(await f.tick(20000), 'glitch');
  assert.equal(f.slices.length, 1); assert.equal(f.slices[0][4].life, 120);
  for (const name of f.played.filter(x => x !== 'glitch')) assert.ok(ACTS[name], name);
  f.acting.dispose();
});

test('large acts are bounded by their own cooldown and seated poses stay seated', async () => {
  const f = await fixture();
  assert.equal(await f.tick(60000), 'spin');
  assert.ok(f.acting.next.large >= 120000);
  await f.tick(62000); await f.tick(64000);
  assert.equal(f.played.filter(x => ['spin', 'hop', 'split'].includes(x)).length, 1);
  f.capri.stance = 'sit';
  assert.equal(await f.tick(120000), 'split');
  assert.equal(f.played.filter(x => x === 'hop').length, 0);
  f.acting.dispose();
});

test('quiet, reduced motion, game and occupied states add no effects or queued burst', async () => {
  const f = await fixture();
  for (const object of [f.panel, f.chat, f.guide]) {
    const key = object === f.panel ? 'visible' : object === f.chat ? 'open' : 'running';
    object[key] = true; await f.tick(f.state.at + 200000); object[key] = false;
    assert.equal(await f.tick(f.state.at + 1), null);
  }
  f.listeners.windows({ game: 'Minecraft' }); await f.tick(f.state.at + 200000);
  f.listeners.windows({ game: null }); assert.equal(await f.tick(f.state.at + 1), null);
  f.state.reduced = true; await f.tick(f.state.at + 200000); f.state.reduced = false;
  f.acting.configure({ effectLevel: 'quiet' }); await f.tick(f.state.at + 200000);
  for (const key of ['busy', 'dragging', 'stowed', 'dormant', 'hidden']) {
    f.acting.configure({ effectLevel: 'full' }); f.capri[key] = true; await f.tick(f.state.at + 200000); f.capri[key] = false;
  }
  f.capri.mode = 'sleep'; await f.tick(f.state.at + 200000);
  assert.deepEqual(f.played, []); assert.deepEqual(f.slices, []);
  f.acting.dispose();
});

test('normal mode is quieter, pending acts never overlap, dispose removes timers/listeners', async () => {
  let release;
  const f = await fixture({ perform: () => new Promise((resolve) => { release = resolve; }) });
  f.acting.configure({ effectLevel: 'normal' });
  assert.equal(await f.tick(19999), null);
  assert.equal(await f.tick(20000), 'curious');
  assert.equal(await f.tick(100000), null);
  release(); await Promise.resolve(); await Promise.resolve();
  assert.equal(await f.tick(100001), null);
  f.acting.dispose();
  assert.equal(f.state.intervalCleared, true); assert.equal(f.state.removed, 2);
  assert.equal(await f.tick(1000000), null);
});
