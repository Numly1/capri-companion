'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { bundledVoice, installReference } = require('../src/main/companion-voice-clips');
const { create, findInstallation } = require('../src/main/companion-voice-runtime');
const { synthesize, referenceVoice, setReferenceStarter } = require('../src/main/companion-speech');
const assets = path.resolve(__dirname, '../assets/companion-voice');
const approvedText = 'Мы рядом. Продолжай, художница.';

test('the bundled preview is byte-identical to the user-approved audio and plays without a runtime', async () => {
  const result = bundledVoice(approvedText);
  const audio = Buffer.from(result.audio, 'base64');
  assert.equal(crypto.createHash('sha256').update(audio).digest('hex'), 'ede1da1036178897aa4ba94d7a7e6502e2d241f133dbae0e1e0f1120f34eaee2');
  assert.equal(result.prepared, true); assert.equal(result.engine, 'reference');
  assert.deepEqual(Buffer.from(result.audio, 'base64'), audio);
  setReferenceStarter(() => { throw new Error('prepared audio must not start Python'); });
  if (process.platform === 'win32') assert.deepEqual(Buffer.from((await synthesize({ text: approvedText }, { companionVoice: true, responseLanguage: 'ru', voiceStyle: 'capri-sample' })).audio, 'base64'), audio);
  setReferenceStarter(null);
  assert.equal(bundledVoice('A new uncached answer'), null);
});

test('all four short roaming phrases are available as valid local WAVs', () => {
  for (const line of ['Мы рядом, чум.', 'Сигнал стабильный. Продолжаем.', 'Небольшой перерыв не помешает.', 'Этот глич был намеренным.']) {
    const result = bundledVoice(line);
    assert.equal(result.ok, true); assert.equal(result.prepared, true);
    const audio = Buffer.from(result.audio, 'base64'); assert.equal(audio.toString('ascii', 8, 12), 'WAVE');
  }
});

test('the approved reference is installed once without replacing an existing user file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-reference-test-'));
  const destination = path.join(directory, 'capri-approved-reference.audio');
  try {
    assert.equal(installReference(directory), true);
    assert.deepEqual(fs.readFileSync(destination), fs.readFileSync(path.join(assets, 'reference.wav')));
    fs.writeFileSync(destination, 'custom reference');
    assert.equal(installReference(directory), true); assert.equal(fs.readFileSync(destination, 'utf8'), 'custom reference');
  } finally { fs.unlinkSync(destination); fs.rmdirSync(directory); }
});

test('a modified manifest cannot read a file outside its asset directory or a prototype property', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-clip-test-'));
  const manifest = path.join(directory, 'manifest.json');
  try {
    fs.writeFileSync(manifest, JSON.stringify({ model: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base', language: 'ru', clips: { test: '../private.wav' } }));
    assert.equal(bundledVoice('test', directory), null); assert.equal(bundledVoice('toString', directory), null);
  } finally { fs.unlinkSync(manifest); fs.rmdirSync(directory); }
});

test('the approved engine uses its own port and never sends a cloud key', async () => {
  const wav = Buffer.alloc(48); wav.write('RIFF'); wav.write('WAVE', 8);
  const result = await referenceVoice('Тест новой реплики', async (url, request) => {
    assert.equal(url, 'http://127.0.0.1:8795/tts');
    assert.deepEqual(request.headers, { 'content-type': 'application/json' });
    assert.equal(JSON.parse(request.body).voice, 'capri');
    return new Response(wav, { headers: { 'content-type': 'audio/wav' } });
  }, 'capri-sample');
  assert.equal(result.ok, true);
});

test('Qwen runtime selection isolates installation, health and reference from the old engine', async () => {
  const base = path.resolve('virtual-approved-voice');
  const dataDir = path.join(base, 'data');
  const server = path.join(base, 'voice-backend-qwen', 'server.py');
  const runtimeDir = path.join(base, '.tools/capri-qwen-voice');
  const python = path.join(runtimeDir, 'venv/Scripts/python.exe');
  const reference = path.join(dataDir, 'capri-approved-reference.audio');
  const files = new Set([server, python, reference]);
  assert.deepEqual(findInstallation({ root: path.join(base, 'app'), profile: 'capri-sample' }, file => files.has(file)), { server, runtime: runtimeDir, python });
  let checks = 0, spawned = 0, killed = 0;
  const voice = create({ root: path.join(base, 'app'), dataDir, profile: 'capri-sample' }, {
    exists: file => files.has(file), sleep: async () => {},
    fetch: async url => { assert.equal(url, 'http://127.0.0.1:8795/health'); return new Response(JSON.stringify({ model: ++checks === 1 ? 'chatterbox-multilingual-v3' : 'qwen3-tts-1.7b-capri', state: 'cached' })); },
    spawn(file, args) { spawned++; assert.equal(file, python); assert.ok(args.includes(reference)); assert.ok(args.includes('--offline')); const child = new EventEmitter(); child.kill = () => { killed++; }; return child; },
  });
  assert.equal(await voice.ensure(), true); assert.equal(spawned, 1); voice.stop(); assert.equal(killed, 1);
});

test('Windows shutdown terminates only the owned venv process tree', { skip: process.platform !== 'win32' }, async () => {
  let checks = 0, termination;
  const child = new EventEmitter(); child.pid = 123456; child.kill = () => { throw new Error('venv wrapper alone must not be killed'); };
  const voice = create({ root: path.resolve('app'), dataDir: path.resolve('profile'), profile: 'capri-sample' }, {
    exists: () => true, sleep: async () => {}, spawn: () => child,
    fetch: async () => new Response(JSON.stringify({ model: ++checks === 1 ? 'other' : 'qwen3-tts-1.7b-capri', state: 'cached' })),
    execFile(file, args, options, callback) { termination = { file, args, options }; callback(null); },
  });
  assert.equal(await voice.ensure(), true); voice.stop();
  assert.match(termination.file, /taskkill\.exe$/i);
  assert.deepEqual(termination.args, ['/PID', '123456', '/T', '/F']); assert.equal(termination.options.windowsHide, true);
});
