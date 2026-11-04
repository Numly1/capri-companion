'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/companion-music-dance.js'), 'utf8');
const exported = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
async function harness(reduced = false) {
  const { CompanionMusicDance } = await exported; const played = [];
  const capri = { free: true, mode: 'idle', stance: 'stand', perform: async name => { played.push(name); } };
  const dance = new CompanionMusicDance({ capri, panel: {}, chat: {}, guide: {}, pc: {}, speech: {} }, { reduced: () => reduced });
  return { dance, capri, played };
}
test('manual dance is short, reduced motion and seated poses remain appropriate', async () => {
  const { dance, capri, played } = await harness();
  assert.equal(await dance.start(), true); assert.deepEqual(played, ['hop', 'spin', 'hop']); assert.equal(dance.running, false);
  played.length = 0; capri.stance = 'sit'; await dance.start(); assert.deepEqual(played, ['curious', 'look', 'curious']);
  const quiet = await harness(true); await quiet.dance.start(); assert.deepEqual(quiet.played, ['look']);
});
test('busy, game, speech and sleep requests are skipped instead of queued', async () => {
  const { dance, capri, played } = await harness();
  for (const target of [dance.chat, dance.guide, dance.panel, dance.speech, dance.pc]) {
    const key = target === dance.chat ? 'open' : target === dance.guide ? 'running' : target === dance.panel ? 'visible' : target === dance.speech ? 'pendingSpeech' : 'game';
    target[key] = true; assert.equal(await dance.start(), false); target[key] = false;
  }
  capri.mode = 'sleep'; assert.equal(await dance.start(), false); assert.deepEqual(played, []);
});
test('a new conversation ends the remaining dance without overriding another act', async () => {
  const { dance, capri, played } = await harness();
  let release; capri.perform = name => { played.push(name); capri.act = {}; return new Promise(resolve => release = resolve); };
  const pending = dance.start(); assert.equal(await dance.start(), false);
  dance.chat.open = true; release(); await pending; assert.deepEqual(played, ['hop']);
  let cancelled = 0; dance.ownedAct = {}; capri.act = {}; capri.endAct = () => cancelled++;
  dance.stop(); assert.equal(cancelled, 0);
});
