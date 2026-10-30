'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeGameSettings } = require('../src/main/companion-game-settings');

test('legacy game hiding is preserved without turning sleep on for existing users', () => {
  assert.equal(normalizeGameSettings({ hideInGames: true }).gameBehavior, 'hide');
  assert.equal(normalizeGameSettings({ hideInGames: false }).gameBehavior, 'stay');
  assert.deepEqual(normalizeGameSettings({}), { gameBehavior: 'stay', gameDelaySeconds: 30, gameScope: 'all', hideInGames: false });
  assert.equal(normalizeGameSettings({ hideInGames: true, gameBehavior: 'sleep' }).hideInGames, false);
});

test('invalid game settings have bounded safe defaults and known scopes only', () => {
  assert.deepEqual(normalizeGameSettings({ gameBehavior: 'shutdown', gameDelaySeconds: Infinity, gameScope: '*' }), normalizeGameSettings());
  assert.equal(normalizeGameSettings({ gameDelaySeconds: -100 }).gameDelaySeconds, 5);
  assert.equal(normalizeGameSettings({ gameDelaySeconds: 1e9 }).gameDelaySeconds, 300);
  assert.equal(normalizeGameSettings({ gameDelaySeconds: '15' }).gameDelaySeconds, 30);
  assert.equal(normalizeGameSettings({ gameDelaySeconds: 59.7, gameScope: 'minecraft' }).gameDelaySeconds, 60);
  assert.equal(normalizeGameSettings({ gameScope: 'ss14' }).gameScope, 'ss14');
});

test('config migrates a saved legacy preference and keeps keys and voice through edits and restart', () => {
  let disk = JSON.stringify({ hideInGames: true, apiKeys: { groq: 'enc:test-only' }, voiceStyle: 'capri-sample', muted: true });
  const configSource = fs.readFileSync(path.join(__dirname, '../src/main/config.js'), 'utf8');
  const open = () => {
    const module = { exports: {} };
    vm.runInNewContext(configSource, { module, console, require: name => {
      if (name === 'node:fs') return { readFileSync: () => disk, mkdirSync() {}, writeFileSync: (_file, data) => { disk = data; } };
      if (name === 'electron') return { app: { getPath: () => '/test-profile' } };
      if (name === './companion-ready-gift') return { initializeReadyGift: cfg => cfg };
      return require(name.startsWith('./') ? path.join(__dirname, '../src/main', name) : name);
    } });
    return module.exports;
  };
  const cfg = open();
  assert.equal(cfg.load().gameBehavior, 'hide');
  cfg.save({ gameBehavior: 'sleep', gameDelaySeconds: 60, gameScope: 'minecraft' });
  const next = open().load();
  assert.equal(next.gameBehavior, 'sleep'); assert.equal(next.gameDelaySeconds, 60); assert.equal(next.gameScope, 'minecraft');
  assert.equal(next.voiceStyle, 'capri-sample'); assert.equal(next.muted, true); assert.equal(next.apiKeys.groq, 'enc:test-only');
  cfg.save({ hideInGames: false }); assert.equal(open().load().gameBehavior, 'stay');
});
