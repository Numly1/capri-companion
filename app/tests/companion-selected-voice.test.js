'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { referenceVoice, synthesize, setReferenceStarter, capriSpokenText } = require('../src/main/companion-speech');
const selected = { voiceStyle: 'capri-sample', companionVoice: true, responseLanguage: 'ru' };
const wav = () => { const bytes = Buffer.alloc(48); bytes.write('RIFF'); bytes.write('WAVE', 8); return bytes; };

test('long replies use one bounded first sentence or word excerpt in the selected timbre', () => {
  assert.deepEqual(capriSpokenText('Привет, чум.'), { text: 'Привет, чум.', excerpt: false });
  assert.deepEqual(capriSpokenText(`Первая короткая фраза! ${'Дальше очень длинный ответ. '.repeat(25)}`), { text: 'Первая короткая фраза!', excerpt: true });
  const spaced = capriSpokenText('Очень длинная непрерывная мысль '.repeat(30));
  assert.equal(spaced.excerpt, true); assert.ok(spaced.text.length <= 160); assert.ok(spaced.text.endsWith('…'));
  assert.ok(capriSpokenText('Я'.repeat(900)).text.length <= 160);
});

test('busy and connection failures preserve a useful reason without private diagnostics', async () => {
  const busy = await referenceVoice('Привет', async () => new Response('{}', { status: 409 }), 'capri-sample');
  assert.equal(busy.code, 'voice_busy'); assert.match(busy.error, /занят/);
  const offline = await referenceVoice('Привет', async () => { throw new Error('private error'); }, 'capri-sample');
  assert.equal(offline.code, 'voice_offline'); assert.doesNotMatch(offline.error, /private error|установлен/);
});

test('a missing selected module or unsupported language never invokes a Windows substitute', { skip: process.platform !== 'win32' }, async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error('no request should happen'); };
  setReferenceStarter(async () => false);
  try {
    const unavailable = await synthesize({ text: 'Эта фраза не входит в готовые записи.' }, selected);
    assert.equal(unavailable.ok, false); assert.equal(unavailable.keepSelectedVoice, true);
    assert.equal(unavailable.code, 'voice_module'); assert.equal(unavailable.audio, undefined);
    const japanese = await synthesize({ text: 'こんにちは' }, { ...selected, responseLanguage: 'ja' });
    assert.equal(japanese.code, 'voice_language'); assert.equal(japanese.keepSelectedVoice, true);
    assert.equal(calls, 0);
  } finally { setReferenceStarter(null); global.fetch = originalFetch; }
});

test('long selected-voice replies go to Qwen as an explicit excerpt and busy stays selected', { skip: process.platform !== 'win32' }, async () => {
  const originalFetch = global.fetch;
  let spoken, requests = 0;
  setReferenceStarter(async profile => { assert.equal(profile, 'capri-sample'); return true; });
  global.fetch = async (url, request) => { requests++; assert.equal(url, 'http://127.0.0.1:8795/tts'); spoken = JSON.parse(request.body).text; return new Response(wav(), { headers: { 'content-type': 'audio/wav' } }); };
  try {
    const result = await synthesize({ text: `Я рядом, художница. ${'Полный текст ответа остаётся доступен. '.repeat(25)}` }, selected);
    assert.equal(result.ok, true); assert.equal(result.engine, 'reference'); assert.equal(result.excerpt, true);
    assert.equal(spoken, 'Я рядом, художница.'); assert.equal(result.spokenText, spoken);
    assert.match(result.voiceNote, /начало/); assert.equal(requests, 1);
    global.fetch = async () => new Response('{}', { status: 409 });
    const busy = await synthesize({ text: 'Новая фраза' }, selected);
    assert.equal(busy.ok, false); assert.equal(busy.code, 'voice_busy'); assert.equal(busy.keepSelectedVoice, true);
  } finally { setReferenceStarter(null); global.fetch = originalFetch; }
});

test('renderer reports a selected voice failure and never speaks it in a different Windows voice', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/companion-speech.js'), 'utf8');
  const { CompanionSpeech } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const voice = Object.create(CompanionSpeech.prototype);
  let native = 0, note;
  Object.assign(voice, { cfg: selected, speechTurn: 0, stop() { this.speechTurn++; }, note(value) { note = value; },
    sayNative() { native++; }, host: { synthesizeSpeech: async () => ({ ok: false, code: 'voice_busy', keepSelectedVoice: true, error: 'Модуль занят.' }) } });
  await voice.sayDigital('Новая фраза');
  assert.equal(native, 0); assert.equal(note, 'Модуль занят.'); assert.equal(voice.pendingSpeech, false);
  voice.voiceButton = {}; voice.stop = () => {};
  voice.configure({ voiceStyle: 'capri-sample', offlineChat: false });
  assert.match(voice.voiceButton.title, /Капри/);
});

test('everyday voice button skips old experiments even when an old imported reference exists', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/companion-speech.js'), 'utf8');
  const { nextVoiceStyle } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const cfg = { capriVoiceAvailable: true, hasVoiceReference: true, voiceStyle: 'natural' };
  const visited = [];
  for (let i = 0; i < 8; i++) { cfg.voiceStyle = nextVoiceStyle(cfg); visited.push(cfg.voiceStyle); }
  assert.deepEqual(visited, ['capri-sample', 'capri', 'bright', 'natural', 'capri-sample', 'capri', 'bright', 'natural']);
  assert.equal(nextVoiceStyle({ ...cfg, voiceStyle: 'reference' }), 'capri-sample');
  assert.equal(nextVoiceStyle({ capriVoiceAvailable: false, hasVoiceReference: true, voiceStyle: 'natural' }), 'capri');
});
