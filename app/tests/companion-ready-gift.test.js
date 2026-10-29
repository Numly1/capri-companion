'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeReadyGift } = require('../src/main/companion-ready-gift');

const directory = 'D:/Gift/Капри';
const marker = { format: 'capri-ready-gift', version: 1, voice: 'capri-sample' };
function filesystem(data = marker, missing = false) {
  return { statSync: () => ({ isFile: () => true, size: 100 }),
    readFileSync: () => JSON.stringify(data), existsSync: file => !missing || !file.endsWith('python.exe') };
}

test('ready package selects its included voice on first launch while preserving private settings', () => {
  const original = { voiceStyle: 'reference', apiKeys: { groq: 'enc:test-only' }, responseLanguage: 'ru', offlineChat: false, muted: true, volume: 0.3 };
  const cfg = initializeReadyGift(original, directory, filesystem());
  assert.equal(cfg.voiceStyle, 'capri-sample'); assert.equal(cfg.companionVoice, true); assert.equal(cfg.readyGiftVoiceVersion, 1);
  for (const key of ['apiKeys', 'responseLanguage', 'offlineChat', 'muted', 'volume']) assert.deepEqual(cfg[key], original[key]);
  assert.equal(original.voiceStyle, 'reference');
});

test('subsequent deliberate voice choice stays selected and ordinary EXE defaults are unchanged', () => {
  const changed = { voiceStyle: 'natural', companionVoice: false, readyGiftVoiceVersion: 1 };
  assert.equal(initializeReadyGift(changed, directory, filesystem()), changed);
  const normal = { voiceStyle: 'capri' };
  assert.equal(initializeReadyGift(normal, '', filesystem()), normal);
  assert.equal(initializeReadyGift(normal, directory, filesystem(marker, true)), normal);
});

test('marker only enables the known voice and cannot import arbitrary settings or credentials', () => {
  const cfg = { voiceStyle: 'natural', apiKeys: {} };
  const result = initializeReadyGift(cfg, directory, filesystem({ ...marker, apiKeys: { groq: 'untrusted' }, provider: 'custom', customUrl: 'https://example.invalid' }));
  assert.deepEqual(result.apiKeys, {}); assert.equal(result.provider, undefined); assert.equal(result.customUrl, undefined);
  for (const value of [{}, { ...marker, version: 2 }, { ...marker, voice: 'reference' }]) assert.equal(initializeReadyGift(cfg, directory, filesystem(value)), cfg);
  const oversized = filesystem(); oversized.statSync = () => ({ isFile: () => true, size: 2000 });
  assert.equal(initializeReadyGift(cfg, directory, oversized), cfg);
  assert.equal(initializeReadyGift(cfg, directory, { statSync: () => { throw new Error('missing'); } }), cfg);
});
