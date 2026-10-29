'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const llm = require('../src/main/llm');
const { chooseVisionModel } = require('../src/main/companion-model-choice');

test('Forbidden is distinguished from a rejected API key and service bodies cannot echo the key', async t => {
  const key = 'dummy-private-test-key';
  for (const body of ['Forbidden', JSON.stringify({ error: { message: `Forbidden ${key}` } })]) {
    t.mock.method(global, 'fetch', async () => new Response(body, { status: 403 }));
    await assert.rejects(llm.models('groq', { apiKeys: { groq: key } }), error => {
      assert.equal(error.status, 403); assert.equal(error.code, 'forbidden');
      assert.match(error.message, /отказал в доступе/); assert.doesNotMatch(error.message, new RegExp(key)); return true;
    });
    t.mock.restoreAll();
  }
  t.mock.method(global, 'fetch', async () => new Response('{}', { status: 401 }));
  await assert.rejects(llm.models('groq', { apiKeys: { groq: key } }), error => error.code === 'auth' && error.status === 401);
});

test('network failure is a connection problem, not a key rejection or raw transport diagnostic', async t => {
  t.mock.method(global, 'fetch', async () => { throw new Error('private transport diagnostic'); });
  await assert.rejects(llm.models('groq', { apiKeys: { groq: 'dummy' } }), error => {
    assert.equal(error.code, 'connection'); assert.doesNotMatch(error.message, /private transport/); return true;
  });
});

test('vision auto-selection is independent of a text-only conversation model', () => {
  const names = Object.freeze(['openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'meta-models/muse-spark-open']);
  assert.equal(chooseVisionModel('groq', names, null, names[0]), names[1]);
  assert.equal(chooseVisionModel('groq', names, names[2], names[0]), names[2]);
  assert.equal(chooseVisionModel('groq', names, 'missing', names[1]), names[1]);
  assert.equal(chooseVisionModel('groq', [names[0]], null, names[0]), null);
  assert.equal(chooseVisionModel('groq', null, null, null), null);
});

test('setup routes service access failure to diagnostics rather than requesting the same key again', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/setup.js'), 'utf8')
    .replace("import { fmt } from './util.js';", 'const fmt = (value) => value;');
  const { Setup } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const setup = Object.create(Setup.prototype); let prompts = 0, diagnosed = 0;
  setup.brain = { t: { setup: {} } }; setup.working = () => {};
  setup.guide = { async askText() { prompts++; return { text: 'dummy-key' }; } };
  setup.host = { async useProvider() { return { ok: false, code: 'forbidden', error: 'Forbidden' }; } };
  setup.connectionIssue = async (provider, key, result) => { diagnosed++; assert.equal(provider, 'groq'); assert.equal(key, 'dummy-key'); assert.equal(result.code, 'forbidden'); return false; };
  await setup.paste('groq'); assert.equal(prompts, 1); assert.equal(diagnosed, 1);
});
