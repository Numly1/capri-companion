'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reply } = require('../src/main/offline-companion');

test('RU and JP finite greetings personalize without immediate repetition', () => {
  for (const lang of ['ru', 'ja']) {
    const cfg = { lang, userName: 'Маша' };
    let previous;
    for (let i = 0; i < 20; i++) {
      const answer = reply('привет', cfg);
      assert.match(answer, /Маша/);
      assert.notEqual(answer, previous);
      if (lang === 'ja') assert.match(answer, /[\u3040-\u30ff]/);
      previous = answer;
    }
  }
});

test('name and identity use configuration without mutating it', () => {
  const cfg = Object.freeze({ lang: 'ru', userName: 'Оля' });
  assert.match(reply('как меня зовут?', cfg), /Оля/);
  assert.match(reply('как тебя зовут?', cfg), /Капри/);
  assert.match(reply('меня зовут Ира', cfg), /настройках/);
  assert.equal(cfg.userName, 'Оля');
});

test('changing voice never changes the answer language', () => {
  for (const voiceStyle of ['capri', 'bright', 'natural']) {
    assert.doesNotMatch(reply('привет', { voiceStyle, voiceLanguage: 'ja', responseLanguage: 'ru' }), /[\u3040-\u30ff]/);
  }
  assert.match(reply('привет', { voiceStyle: 'natural', responseLanguage: 'ja' }), /[\u3040-\u30ff]/);
});

test('at least 30 practical intents yield supported local replies rather than generic fallback', () => {
  const examples = ['что умеешь', 'ты ии', 'кто ты', 'помолчи', 'тревожно', 'грустно', 'устала', 'злюсь', 'одиноко', 'скучно', 'шутку', 'расскажи историю', 'ты милая', 'похвали', 'обними', 'спасибо', 'прости', 'не могу начать', 'концентрация', 'перерыв', 'хочу воды', 'хочу поесть', 'чай', 'хочу спать', 'погода', 'новости', 'таймер', 'что нарисовать', 'что послушать', 'любимый цвет', 'день рождения', 'я закончила', 'ошиблась', 'компьютер завис', 'ты видишь экран', 'как дела', 'спокойной ночи', 'пока', 'привет'];
  assert.ok(examples.length >= 30);
  for (const text of examples) {
    const answer = reply(text, { lang: 'ru' });
    assert.equal(typeof answer, 'string', text);
    assert.ok(answer.length > 10 && answer.length < 700, text);
    assert.doesNotMatch(answer, /за пределами моих готовых|изображать всезнающую/, text);
  }
});

test('unknown input candidly describes finite offline replies and does not invent an answer', () => {
  const first = reply('Докажи гипотезу Римана', { lang: 'ru' });
  const second = reply('Докажи гипотезу Римана', { lang: 'ru' });
  assert.notEqual(first, second);
  assert.match(first, /готовых реплик|конечный набор/);
  assert.match(reply('xyzzy', { lang: 'ja' }), /決まった|台詞リスト/);
  assert.match(reply('приветливый браузерный движок', { lang: 'ru' }), /готовых реплик|конечный набор/);
});

test('metadata replies disclose only provided track/activity and do not hallucinate artwork', () => {
  const ctx = Object.freeze({ activity: 'drawing', track: Object.freeze({ title: 'Test Song', artist: 'Test Artist' }) });
  assert.match(reply('что сейчас играет?', {}, ctx), /Test Song.*Test Artist/);
  assert.match(reply('что я рисую?', {}, ctx), /Сам рисунок не вижу/);
  assert.match(reply('что я делаю?', {}, ctx), /рисование/);
  assert.match(reply('что я слушаю?', {}), /не передали/);
  assert.match(reply('что я рисую?', {}), /не передали/);
  assert.match(reply('что я делаю?', {}, { activity: '__proto__' }), /не передали/);
  assert.doesNotMatch(reply('что сейчас играет?', {}, { track: { artist: 'Only Artist' } }), /Only Artist/);
  const actual = { enabled: true, available: true, drawing: { app: 'Krita', activeSeconds: 30 }, music: { title: 'Actual Song', artist: 'Actual Artist', playing: true } };
  assert.match(reply('что я слушаю?', {}, actual), /Actual Song.*Actual Artist/);
  assert.match(reply('что я рисую?', {}, actual), /Сам рисунок не вижу/);
  assert.match(reply('что я делаю?', {}, actual), /рисование/);
  assert.match(reply('что я слушаю?', {}, { ...actual, enabled: false }), /не передали/);
  assert.match(reply('что я рисую?', {}, { ...actual, available: false }), /не передали/);
  assert.match(reply('что я слушаю?', {}, { ...actual, music: { ...actual.music, playing: false } }), /остановлено/);
});

test('Japanese output accepts both Japanese and Russian inputs', () => {
  const cfg = { lang: 'ja-JP', userName: 'ミカ' };
  assert.match(reply('ありがとう', cfg), /[\u3040-\u30ff]/);
  assert.match(reply('что я слушаю', cfg, { track: { title: '曲名' } }), /曲名/);
  assert.match(reply('что я рисую', cfg, { activity: 'drawing' }), /見えてない/);
  assert.match(reply('悲しい', cfg), /[\u3040-\u30ff]/);
  assert.match(reply('привет', { lang: 'ru', responseLanguage: 'ja' }), /[\u3040-\u30ff]/);
  assert.doesNotMatch(reply('привет', { lang: 'ja', responseLanguage: 'ru' }), /[\u3040-\u30ff]/);
});

test('negative outcome is not mistaken for success', () => {
  for (const input of ['не получилось', 'не готово', 'не успела', 'не закончила']) {
    assert.doesNotMatch(reply(input), /комбо засчитано|Вот это ход/);
    assert.match(reply(input), /сбой|Неудачная попытка/);
  }
});

test('time and date use local Intl formatting and explicitly refer to this PC', () => {
  const now = new Date(2026, 9, 28, 14, 35);
  const time = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(now);
  assert.ok(reply('который час?', { lang: 'ru' }, { now }).includes(time));
  const date = reply('какая дата?', { lang: 'ru' }, { now });
  assert.match(date, /28.*2026/);
  assert.match(date, /этого компьютера/);
  assert.match(reply('何時？', { lang: 'ja' }, { now }), /14:35/);
});

test('bounded malformed inputs, names and context are safe', () => {
  assert.equal(typeof reply(null, null, null), 'string');
  assert.match(reply('x'.repeat(8001), {}), /8000/);
  assert.equal(typeof reply('который час', {}, { now: new Date('invalid') }), 'string');
  const answer = reply('как меня зовут', { userName: 'x'.repeat(10000) });
  assert.ok(answer.length < 250);
  assert.doesNotMatch(reply('что я слушаю', {}, { track: { title: 'one\n\x00two' } }), /[\x00\n]/);
});

test('responder never imports effects-capable modules or issues search actions', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/main/offline-companion'), 'utf8');
  assert.doesNotMatch(source, /\brequire\s*\(|\bfetch\s*\(|\bimport\s*\(/);
  const answer = reply('найди рецепты моти', {});
  assert.equal(typeof answer, 'string');
  assert.doesNotMatch(answer, /уже открыл|открыла браузер|нашла рецепт/);
});
