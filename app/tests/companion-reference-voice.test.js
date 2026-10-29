'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { referenceVoice } = require('../src/main/companion-speech');
const wav = () => { const bytes = Buffer.alloc(48); bytes.write('RIFF'); bytes.write('WAVE', 8); return bytes; };

test('reference synthesis uses only fixed loopback, voice and text, with no cloud keys', async () => {
  let call;
  const result = await referenceVoice('Ну что, продолжаем?', async (url, options) => {
    call = { url, options };
    return new Response(wav(), { headers: { 'content-type': 'audio/wav' } });
  });
  assert.equal(result.ok, true); assert.equal(result.engine, 'reference');
  assert.equal(call.url, 'http://127.0.0.1:8794/tts');
  assert.deepEqual(JSON.parse(call.options.body), { text: 'Ну что, продолжаем?', voice: 'capri' });
  assert.deepEqual(call.options.headers, { 'content-type': 'application/json' });
  assert.equal(call.options.redirect, 'error');
  assert.equal(Buffer.from(result.audio, 'base64').toString('ascii', 8, 12), 'WAVE');
});

test('unavailable, busy, wrong MIME and malformed WAV never reach the audio renderer', async () => {
  for (const response of [
    new Response('{}', { status: 503 }), new Response('{}', { status: 409 }),
    new Response(wav(), { headers: { 'content-type': 'text/plain' } }),
    new Response('invalid audio', { headers: { 'content-type': 'audio/wav' } }),
    new Response(wav(), { headers: { 'content-type': 'audio/wav', 'content-length': String(9 * 1024 * 1024) } }),
  ]) {
    const result = await referenceVoice('Привет', async () => response);
    assert.equal(result.ok, false); assert.equal(result.audio, undefined);
  }
  const result = await referenceVoice('Привет', async () => { throw new Error('private diagnostic'); });
  assert.equal(result.ok, false); assert.doesNotMatch(result.error, /private diagnostic/);
});

test('oversized streaming local audio is stopped even without Content-Length', async () => {
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); controller.close(); } });
  const result = await referenceVoice('Привет', async () => new Response(stream, { headers: { 'content-type': 'audio/wav' } }));
  assert.equal(result.ok, false); assert.equal(result.audio, undefined);
});
