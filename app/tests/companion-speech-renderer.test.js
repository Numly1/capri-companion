'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/companion-speech.js'), 'utf8');
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

async function harness({ permission, transcript } = {}) {
  const { CompanionSpeech } = await modulePromise;
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const oldWindow = globalThis.window; const oldRecorder = globalThis.MediaRecorder;
  let stopped = 0; let calls = 0;
  const stream = { getTracks: () => [{ stop() { stopped++; } }] };
  class Recorder {
    static instances = [];
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; Recorder.instances.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.finished = Promise.resolve(this.onstop?.()); }
    chunk() { this.ondataavailable({ data: new Blob([new Uint8Array([1, 2, 3])]) }); }
  }
  globalThis.window = { MediaRecorder: Recorder };
  globalThis.MediaRecorder = Recorder;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    getUserMedia: () => permission ? permission.promise : Promise.resolve(stream),
  } } });
  const voice = Object.create(CompanionSpeech.prototype);
  Object.assign(voice, {
    cfg: { offlineChat: false, provider: 'groq', voiceLanguage: 'ru' },
    host: { async transcribeSpeech() { calls++; return transcript ? transcript.promise : { ok: true, text: 'hello' }; } },
    chat: { open: true }, generation: 0, speechTurn: 0,
    panel: { visible: true, current: { chat: {} }, chatForm: { hidden: false },
      chatInput: { disabled: false, type: 'text', value: '', focus() {} } },
    button: { disabled: false, textContent: '' },
    note() {}, stop() {},
  });
  return { voice, Recorder, stream, get stopped() { return stopped; }, get calls() { return calls; },
    restore() {
      voice.cancelRecording(); globalThis.window = oldWindow; globalThis.MediaRecorder = oldRecorder;
      if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator;
    } };
}

test('permission resolving after cancellation cannot start microphone capture', async () => {
  const permission = deferred(); const h = await harness({ permission });
  try {
    const pending = h.voice.record(); h.voice.cancelRecording(); permission.resolve(h.stream); await pending;
    assert.equal(h.Recorder.instances.length, 0); assert.equal(h.stopped, 1); assert.equal(h.calls, 0);
  } finally { h.restore(); }
});

test('late transcripts never populate password, hidden, closed or replaced chat forms', async () => {
  const mutations = [
    (voice) => { voice.panel.chatInput.type = 'password'; },
    (voice) => { voice.panel.chatForm.hidden = true; },
    (voice) => { voice.chat.open = false; },
    (voice) => { voice.panel.current = { chat: { secret: true } }; },
  ];
  for (const mutate of mutations) {
    const transcript = deferred(); const h = await harness({ transcript });
    try {
      await h.voice.record(); const recorder = h.Recorder.instances[0]; recorder.chunk(); h.voice.finish();
      await new Promise(setImmediate); assert.equal(h.calls, 1);
      h.voice.panel.chatInput.value = 'existing input'; mutate(h.voice);
      transcript.resolve({ ok: true, text: 'late transcript' }); await recorder.finished;
      assert.equal(h.voice.panel.chatInput.value, 'existing input');
    } finally { h.restore(); }
  }
});

test('old transcription completion cannot enable controls belonging to a new recording permission request', async () => {
  const transcript = deferred(); const h = await harness({ transcript });
  try {
    await h.voice.record(); const old = h.Recorder.instances[0]; old.chunk(); h.voice.finish();
    await new Promise(setImmediate); h.voice.cancelRecording();
    const permission = deferred();
    navigator.mediaDevices.getUserMedia = () => permission.promise;
    const next = h.voice.record(); assert.equal(h.voice.button.disabled, true);
    transcript.resolve({ ok: true, text: 'stale' }); await old.finished;
    assert.equal(h.voice.button.disabled, true); assert.equal(h.voice.processing, true);
    h.voice.cancelRecording(); permission.resolve(h.stream); await next;
    assert.equal(h.voice.panel.chatInput.value, '');
  } finally { h.restore(); }
});
