'use strict';
const { SUPPORT_LINES } = require('./companion-support-lines');

const JAPANESE = Object.freeze({
  encouragement: ['急がなくていいよ。自分のペースで一歩ずつ。私はここで応援してる。', '完璧じゃなくても大丈夫。小さな一歩にも価値があるよ。'],
  creativeBlock: ['小さなラフから試してみよう。最初から完成形じゃなくていい。', 'うまくいかない部分は少し置いておこう。休んでから戻ってもいいよ。'],
  frustration: ['今は少しペースを落とそう。ひとつの失敗で全部は決まらないよ。', '難しい日はあるよ。自分を責めずに、次の小さな一歩を選ぼう。'],
  rest: ['保存できたら、少し休もう。お水と、画面から目を離す時間をどうぞ。', '休むのも自分のペースのうち。戻りたくなったら、また始めよう。'],
  celebration: ['その一歩に拍手。今日はここまで進めた自分もねぎらおう。', 'よし、小さくてもお祝いしよう。あなたのペースで進んでいいんだよ。'],
});

function create({ random = Math.random } = {}) {
  const used = new Map(), previous = new Map();
  return { line(category, language = 'ru') {
    if (!Object.hasOwn(SUPPORT_LINES, category)) return { ok: false, error: 'Выбери, какая поддержка сейчас нужна.' };
    const ja = language === 'ja' || language === 'jp';
    const key = `${ja ? 'ja' : 'ru'}:${category}`;
    const bank = (ja ? JAPANESE : SUPPORT_LINES)[category];
    if (!used.has(key)) used.set(key, new Set());
    const seen = used.get(key);
    if (bank.every(line => seen.has(line))) seen.clear();
    const pool = bank.filter(line => !seen.has(line) && line !== previous.get(key));
    const value = Math.max(0, Math.min(.999999, Number(random()) || 0));
    const line = pool[Math.floor(value * pool.length)] || bank[0];
    seen.add(line); previous.set(key, line);
    return { ok: true, line, category, face: category === 'celebration' ? 'laugh' : category === 'rest' ? 'calm' : 'smug',
      action: category === 'celebration' ? 'hop' : 'curious' };
  } };
}

module.exports = { create };
