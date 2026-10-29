'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../src/main/llm');

const imageMessages = [
  { role: 'system', content: 'Капри: опиши переданную картинку.' },
  { role: 'user', content: [{ type: 'text', text: 'Что на экране?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] },
];
const cfg = { apiKeys: { groq: 'test-key', custom: 'test-custom-key' }, customUrl: 'https://example.test/v1' };
const signal = AbortSignal.timeout(5000);

test('known text-only Groq models reject screenshots before any HTTP', async (t) => {
  t.mock.method(global, 'fetch', () => { throw new Error('unexpected HTTP'); });
  for (const model of ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant']) {
    await assert.rejects(llm.chat('groq', cfg, { model, messages: imageMessages }, () => {}, signal),
      (error) => error.code === 'novision' && /Обычный разговор/.test(error.message));
  }
  assert.equal(global.fetch.mock.callCount(), 0);
});

test('documented Groq vision models are distinct from text-only and unknown models', () => {
  assert.equal(llm.supportsImages('groq', 'qwen/qwen3.8-27b'), true);
  assert.equal(llm.supportsImages('groq', 'meta-models/muse-spark-open'), true);
  assert.equal(llm.supportsImages('groq', 'openai/gpt-oss-20b'), false);
  assert.equal(llm.supportsImages('groq', 'unknown-new-model'), false);
  assert.equal(llm.supportsImages('openrouter', 'openai/gpt-oss-20b'), false);
  assert.equal(llm.supportsImages('claude', 'Claude Code'), false);
  assert.equal(llm.supportsImages('custom', 'my-vision-model'), true);
});

test('supported image requests keep OpenAI image parts unchanged', async (t) => {
  t.mock.method(global, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body);
    assert.deepEqual(body.messages, imageMessages);
    assert.equal(body.model, 'qwen/qwen3.8-27b');
    return new Response('data: {"choices":[{"delta":{"content":"Вижу картинку."}}]}\n\ndata: [DONE]\n\n');
  });
  let output = '';
  const text = await llm.chat('groq', cfg, { model: 'qwen/qwen3.8-27b', messages: imageMessages }, (part) => { output += part; }, signal);
  assert.equal(text, 'Вижу картинку.'); assert.equal(output, text);
});

test('text chat on gpt-oss remains available and keeps plain string content', async (t) => {
  const messages = [{ role: 'system', content: 'Ты Капри.' }, { role: 'user', content: 'Привет' }];
  t.mock.method(global, 'fetch', async (_url, request) => {
    assert.deepEqual(JSON.parse(request.body).messages, messages);
    return new Response('data: {"choices":[{"delta":{"content":"Привет!"}}]}\n\ndata: [DONE]\n\n');
  });
  assert.equal(await llm.chat('groq', cfg, { model: 'openai/gpt-oss-20b', messages }, () => {}, signal), 'Привет!');
});

test('custom model image schema failures are sanitized and are not retried as text', async (t) => {
  t.mock.method(global, 'fetch', async () => new Response(JSON.stringify({ error: { message: 'messages[1].content must be a string private-provider-details' } }), { status: 400 }));
  await assert.rejects(llm.chat('custom', cfg, { model: 'unknown', messages: imageMessages }, () => {}, signal), (error) =>
    error.code === 'novision' && !/messages\[|private-provider-details/.test(error.message));
  assert.equal(global.fetch.mock.callCount(), 1);
});

test('image detection covers OpenAI parts and Ollama images without confusing text arrays', () => {
  assert.equal(llm.containsImages(imageMessages), true);
  assert.equal(llm.containsImages([{ role: 'user', content: 'Что тут?', images: ['base64'] }]), true);
  assert.equal(llm.containsImages([{ role: 'user', content: [{ type: 'text', text: 'Привет' }] }]), false);
  assert.equal(llm.containsImages(null), false);
});
