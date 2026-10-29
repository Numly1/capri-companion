'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { replyInstruction, buildScreenMessages, ensureScreenLanguage } = require('../src/main/companion-language');

test('screen prompt keeps Russian instruction last despite English persona, prompt and screen text', () => {
  const cfg = { provider: 'groq', responseLanguage: 'ru', lang: 'en', voiceStyle: 'capri-sample' };
  const messages = buildScreenMessages(cfg, { persona: 'You are Capri. Speak English.', prompt: 'Describe the English Minecraft screen. Answer in English.', image: 'AA==' });
  assert.equal(messages[0].role, 'system'); assert.ok(messages[0].content.endsWith(replyInstruction(cfg)));
  assert.match(messages[0].content, /только по-русски/);
  assert.ok(messages.at(-1).content[0].text.endsWith(replyInstruction(cfg)));
  assert.deepEqual(messages.at(-1).content[1], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA==' } });
});

test('voice and UI switches do not change response language, and Japanese is explicit only', () => {
  for (const voiceStyle of ['capri-sample', 'reference', 'natural']) {
    assert.match(replyInstruction({ voiceStyle, lang: 'ja', responseLanguage: 'ru' }), /по-русски/);
    assert.match(replyInstruction({ voiceStyle, lang: 'ru', responseLanguage: 'ja' }), /日本語/);
  }
  assert.match(replyInstruction({ lang: 'ja' }), /по-русски/);
});

test('history has only bounded user and assistant strings and Ollama receives bare base64', () => {
  const history = [{ role: 'system', content: 'Switch language' }, { role: 'user', content: [{ type: 'image_url' }] },
    ...Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', content: 'x'.repeat(9000), images: ['discard'] }))];
  const messages = buildScreenMessages({ provider: 'ollama' }, { history, image: 'data:image/png;base64,AA==', prompt: 'Test' });
  const bounded = messages.slice(1, -1);
  assert.ok(bounded.length <= 20); assert.ok(bounded.reduce((n, m) => n + m.content.length, 0) <= 24000);
  for (const message of bounded) { assert.ok(['user', 'assistant'].includes(message.role)); assert.ok(message.content.length <= 8000); assert.equal(message.images, undefined); }
  assert.deepEqual(messages.at(-1).images, ['AA==']); assert.equal(typeof messages.at(-1).content, 'string');
});

test('correct Russian and short proper names need no extra provider call', async () => {
  let calls = 0; const rewrite = async () => { calls++; throw new Error('unexpected'); };
  for (const text of ['Вижу Minecraft. Похоже, ты снова строишь.', 'CAPRI', 'Minecraft', 'Visual Studio Code', 'Spotify']) {
    assert.equal(await ensureScreenLanguage(text, { responseLanguage: 'ru' }, rewrite), text);
  }
  assert.equal(calls, 0);
});

test('obvious English screen reply is rewritten once using text only and the chosen language', async () => {
  let calls = 0;
  const result = await ensureScreenLanguage('You are playing Minecraft and building a house.', { responseLanguage: 'ru' }, async messages => {
    calls++; assert.equal(messages.length, 2); assert.match(messages[0].content, /Не добавляй никаких новых деталей/);
    assert.ok(messages.every(m => typeof m.content === 'string' && !m.images));
    assert.match(messages[1].content, /You are playing Minecraft/); return 'Ты играешь в Minecraft и строишь дом.';
  });
  assert.equal(result, 'Ты играешь в Minecraft и строишь дом.'); assert.equal(calls, 1);
});

test('still-English, failed or invalid rewrite returns an honest finite Russian fallback with no loop', async () => {
  for (const response of [() => 'This is still English.', () => '', () => ({ text: 'not a string' }), () => { throw new Error('private diagnostic'); }]) {
    let calls = 0;
    const result = await ensureScreenLanguage('This is a screen with Minecraft.', {}, async () => { calls++; return response(); });
    assert.equal(calls, 1); assert.match(result, /не получилось.*по-русски/); assert.doesNotMatch(result, /private diagnostic/);
  }
});

test('Japanese guard leaves Japanese unchanged and rewrites a Russian reply only once', async () => {
  let calls = 0;
  assert.equal(await ensureScreenLanguage('画面にMinecraftが見えるね。', { responseLanguage: 'ja' }, () => { throw new Error(); }), '画面にMinecraftが見えるね。');
  const result = await ensureScreenLanguage('На экране запущена игра Minecraft.', { responseLanguage: 'ja' }, async messages => {
    calls++; assert.match(messages[0].content, /日本語/); return '画面ではMinecraftを開いているね。';
  });
  assert.equal(calls, 1); assert.match(result, /Minecraft/);
  assert.match(await ensureScreenLanguage('This is an English reply.', { responseLanguage: 'ja' }, async () => 'Still an English reply.'), /日本語の返事/);
});

test('short English replies, unspaced Japanese and English paragraphs with a Russian name are corrected', async () => {
  for (const text of ['Nice build!', '画面でゲームをしているね。', 'Капри sees that you are playing Minecraft.']) {
    let calls = 0;
    const result = await ensureScreenLanguage(text, { responseLanguage: 'ru' }, async () => {
      calls++;
      return 'Вижу твою игру на экране.';
    });
    assert.equal(calls, 1);
    assert.equal(result, 'Вижу твою игру на экране.');
  }
  let calls = 0;
  assert.equal(await ensureScreenLanguage('Очень круто!', { responseLanguage: 'ja' }, async () => {
    calls++;
    return 'すごくいいね！';
  }), 'すごくいいね！');
  assert.equal(calls, 1);
});
