'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/pc.js'), 'utf8')
  .replace("import { pick, fmt } from './util.js';", "const pick = values => values[0]; const fmt = value => value;");
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
async function harness() {
  const { Pc } = await modulePromise; const pc = Object.create(Pc.prototype);
  const counts = { wake: 0, stow: 0, unstow: 0 };
  pc.enabled = true; pc.hideInGames = false; pc.wantsOut = () => true;
  pc.game = { name: 'Minecraft', since: Date.now() - 7000, gone: 0, said: false, put: false };
  pc.capri = { mode: 'sleep', stowed: false, wake() { counts.wake++; this.mode = 'idle'; }, stow() { counts.stow++; this.stowed = true; }, unstow() { counts.unstow++; this.stowed = false; return Promise.resolve(); } };
  pc.brain = { lang: 'ru', t: { pc: { game: ['Прячусь'], gameBack: ['Я вернулась'] } } }; pc.say = () => {};
  return { pc, counts };
}

test('Minecraft remains visible and keeps the companion awake by default', async t => {
  const { pc, counts } = await harness(); let timers = 0;
  t.mock.method(global, 'setTimeout', () => { timers++; return 1; });
  pc.checkGame(); pc.checkGame();
  assert.equal(pc.capri.mode, 'idle'); assert.equal(counts.stow, 0); assert.equal(timers, 0); assert.ok(counts.wake >= 2);
});

test('hiding requires explicit preference and cancelling it prevents a pending stow', async t => {
  const { pc, counts } = await harness(); let hide;
  t.mock.method(global, 'setTimeout', callback => { hide = callback; return 1; });
  pc.hideInGames = true; pc.checkGame(); assert.equal(typeof hide, 'function');
  pc.hideInGames = false; hide(); assert.equal(counts.stow, 0);
  pc.hideInGames = true; hide(); assert.equal(counts.stow, 1); assert.equal(pc.game.put, true);
});

test('automatic hiding is undone, while manually hidden companion stays hidden', async () => {
  const { pc, counts } = await harness(); pc.game.said = true; pc.game.put = true; pc.capri.stowed = true;
  pc.checkGame(); assert.equal(counts.unstow, 1);
  pc.capri.stowed = true; pc.game.put = false; pc.checkGame(); assert.equal(counts.unstow, 1);
  pc.game.put = true; pc.wantsOut = () => false; pc.checkGame(); assert.equal(counts.unstow, 1);
});
