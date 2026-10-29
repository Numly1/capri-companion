'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { transcribe } = require('../src/main/companion-speech');
const payload = { audio: [26, 69, 223, 163], mime: 'audio/webm;codecs=opus', language: 'ru' };
const cfg = { offlineChat: false, provider: 'groq', apiKeys: { groq: 'encrypted' } };
const keys = () => ({ groq: 'test-secret' });
const forbidden = () => { throw new Error('unexpected network or key access'); };

test('offline mode rejects without decrypting keys or reaching a provider', async () => {
  for (const offlineChat of [true, undefined]) {
    const result = await transcribe(payload, { ...cfg, offlineChat }, forbidden, forbidden);
    assert.equal(result.ok, false); assert.match(result.error, /обычном режиме/);
  }
});

test('invalid or oversized audio never reaches a provider', async () => {
  for (const audio of [null, {}, 'bytes', [], [256], [-1], [0.5], [NaN], [,], new Array(8 * 1024 * 1024 + 1)]) {
    assert.equal((await transcribe({ ...payload, audio }, cfg, forbidden, forbidden)).ok, false);
  }
});

test('unsupported mime and language are rejected before network', async () => {
  assert.equal((await transcribe({ ...payload, mime: 'text/html' }, cfg, forbidden, forbidden)).ok, false);
  assert.equal((await transcribe({ ...payload, language: 'en' }, cfg, forbidden, forbidden)).ok, false);
});

test('OpenRouter and text-only providers are explicitly unsupported for STT', async () => {
  const result = await transcribe(payload, { ...cfg, provider: 'openrouter' }, forbidden, forbidden);
  assert.equal(result.ok, false); assert.match(result.error, /не поддерживает/);
});

test('Groq request uses documented endpoint, multipart, model and manual redirect rejection', async () => {
  let calls = 0;
  const result = await transcribe({ ...payload, language: 'ja' }, cfg, keys, async (url, request) => {
    calls++;
    assert.equal(url, 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.equal(request.headers.authorization, 'Bearer test-secret');
    assert.equal(request.redirect, 'error'); assert.ok(request.signal instanceof AbortSignal);
    assert.equal(request.body.get('model'), 'whisper-large-v3-turbo');
    assert.equal(request.body.get('language'), 'ja');
    assert.equal(request.body.get('file').type, 'audio/webm');
    assert.equal(request.body.get('file').size, payload.audio.length);
    return Response.json({ text: '  こんにちは  ' });
  });
  assert.equal(calls, 1); assert.deepEqual(result, { ok: true, text: 'こんにちは' });
});

test('OpenAI uses current gpt-transcribe and no legacy language field', async () => {
  const result = await transcribe(payload, { ...cfg, provider: 'openai' }, () => ({ openai: 'test-key' }), async (url, req) => {
    assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(req.body.get('model'), 'gpt-transcribe'); assert.equal(req.body.has('language'), false);
    return Response.json({ text: 'Привет' });
  });
  assert.equal(result.ok, true);
});

test('custom endpoint rejects remote HTTP, credentials, query and fragments', async () => {
  for (const customUrl of ['http://example.com/v1', 'https://a:b@example.com', 'https://example.com?key=1', 'https://example.com#x', 'file:///C:/secret', 'http://localhost.evil/v1']) {
    assert.equal((await transcribe(payload, { ...cfg, provider: 'custom', customUrl }, forbidden, forbidden)).ok, false);
  }
});

test('loopback custom server receives only its own key, never another provider key', async () => {
  const result = await transcribe(payload, { ...cfg, provider: 'custom', customUrl: 'http://127.0.0.1:1234/v1/' }, keys, async (url, req) => {
    assert.equal(url, 'http://127.0.0.1:1234/v1/audio/transcriptions');
    assert.equal(req.headers.authorization, undefined); assert.equal(req.body.get('model'), 'whisper-1');
    return Response.json({ text: 'Привет' });
  });
  assert.equal(result.ok, true);
});

test('missing and malformed cloud keys never reach fetch', async () => {
  for (const key of ['', 'contains whitespace', 'line\nbreak', 'x'.repeat(20001)])
    assert.equal((await transcribe(payload, cfg, () => ({ groq: key }), forbidden)).ok, false);
});

test('provider error bodies and transport errors are not exposed to the renderer', async () => {
  const provider = await transcribe(payload, cfg, keys, async () => new Response('test-secret private provider dump', { status: 401 }));
  const transport = await transcribe(payload, cfg, keys, async () => { throw new Error('test-secret private transport dump'); });
  for (const result of [provider, transport]) {
    assert.equal(result.ok, false); assert.doesNotMatch(result.error, /test-secret|private/);
  }
});

test('oversized declared and streaming responses are bounded', async () => {
  const declared = await transcribe(payload, cfg, keys, async () => new Response('{}', { headers: { 'content-length': String(1024 * 1024) } }));
  const streamed = await transcribe(payload, cfg, keys, async () => new Response('x'.repeat(256 * 1024 + 1)));
  assert.equal(declared.ok, false); assert.equal(streamed.ok, false);
});

test('empty, malformed, missing and excessively long transcripts fail safely', async () => {
  for (const body of ['invalid-json', '{}', '{"text":""}', JSON.stringify({ text: 'a'.repeat(8001) })])
    assert.equal((await transcribe(payload, cfg, keys, async () => new Response(body))).ok, false);
});
