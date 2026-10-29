'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inspect, inspectFixture, boundsFor, normalize } = require('../src/main/companion-screen');

function transport(result, error = null) {
  const calls = [];
  const execFile = (file, args, options, done) => {
    const call = { file, args, options }; calls.push(call);
    return { stdin: { on() {}, end(payload) { call.payload = JSON.parse(payload); queueMicrotask(() => done(error, result)); } } };
  };
  return { calls, options: { platform: 'win32', execFile } };
}

test('capture bounds are finite physical pixel rectangles with bounded allocation', async () => {
  assert.deepEqual(boundsFor({ x: -1920, y: 0, width: 1920, height: 1080, secret: 'discard' }), { x: -1920, y: 0, width: 1920, height: 1080 });
  for (const bounds of [null, {}, { x: 0, y: 0, width: Infinity, height: 10 }, { x: 0, y: 0, width: 0, height: 1 },
    { x: 0.1, y: 0, width: 10, height: 10 }, { x: -40000, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 8192, height: 8192 }]) {
    const t = transport('{}');
    assert.equal((await inspect({ bounds }, t.options)).code, 'invalid_bounds');
    assert.equal(t.calls.length, 0);
  }
});

test('only fixed embedded script is executed and coordinates cross stdin, never shell text', async () => {
  const t = transport(JSON.stringify({ ok: true, text: 'Visible local text', app: 'krita', language: 'ru' }));
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
  const result = await inspect({ bounds, fixture: true, command: 'ignored', key: 'never-forward' }, t.options);
  assert.equal(result.ok, true); assert.equal(result.local, true); assert.equal(result.appName, 'Krita');
  assert.equal(t.calls.length, 1);
  const call = t.calls[0];
  assert.match(call.file, /powershell\.exe$/i);
  assert.ok(call.args.includes('-EncodedCommand'));
  assert.equal(Buffer.from(call.args.at(-1), 'base64').toString('utf16le'), require('../src/main/companion-screen-script'));
  assert.deepEqual(call.payload, { bounds, excludePid: process.pid });
  assert.equal(call.options.windowsHide, true); assert.equal(call.options.timeout, 20000);
  assert.ok(call.options.maxBuffer <= 131072);
});

test('OCR output is factual, bounded and never claims to understand artwork', () => {
  const result = normalize({ ok: true, text: '\u0000' + 'line\n'.repeat(2000), app: 'private-project.exe', language: 'ru' });
  assert.equal(result.ok, true); assert.equal(result.appName, null); assert.equal(result.text.length, 3000);
  assert.doesNotMatch(result.line, /private-project/); assert.doesNotMatch(result.text, /\u0000/);
  assert.ok(result.line.length < 1000);
  assert.match(result.line, /возможны ошибки/); assert.match(result.line, /Смысл рисунка без ИИ я не определяю/);
  const empty = normalize({ ok: true, text: ' ', app: 'spotify', language: 'invalid\r\n' });
  assert.equal(empty.language, null); assert.equal(empty.appName, 'Spotify');
  assert.match(empty.line, /читаемый текст не найден/);
});

test('timeouts, malformed and excessive helper replies expose no raw exceptions', async () => {
  for (const [output, error] of [['private diagnostic', null], ['x'.repeat(64001), null], ['{}', new Error('secret path API key')]]) {
    const t = transport(output, error);
    const result = await inspect({ bounds: { x: 0, y: 0, width: 10, height: 10 } }, t.options);
    assert.equal(result.ok, false); assert.equal(result.local, true); assert.equal(result.code, 'capture_failed');
    assert.doesNotMatch(result.error, /private|secret|API|diagnostic/);
  }
  const t = transport(JSON.stringify({ ok: false, code: 'ocr_unavailable' }));
  assert.equal((await inspect({ bounds: { x: 0, y: 0, width: 10, height: 10 } }, t.options)).code, 'ocr_unavailable');
});

test('unsupported platforms do not start a helper', async () => {
  const t = transport('{}');
  const result = await inspect({ bounds: { x: 0, y: 0, width: 10, height: 10 } }, { ...t.options, platform: 'linux' });
  assert.equal(result.code, 'unsupported'); assert.equal(t.calls.length, 0);
});

test('embedded script matches canonical source and does not persist screenshots or access network', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/companion-screen.ps1'), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  assert.equal(require('../src/main/companion-screen-script'), source);
  assert.match(source, /MemoryStream/); assert.match(source, /CopyFromScreen/); assert.match(source, /RecognizeAsync/);
  assert.doesNotMatch(source, /(?:WriteAll|Out-File|Set-Content|Invoke-WebRequest|Invoke-RestMethod|https?:\/\/|StorageFile)/);
});

test('real Windows OCR recognizes a generated in-memory fixture without capturing user content', { skip: process.platform !== 'win32', timeout: 25000 }, async () => {
  const result = await inspectFixture();
  if (result.code === 'ocr_unavailable') return; // This component is optional on the recipient's PC.
  assert.equal(result.ok, true, result.error);
  assert.match(result.text, /CAPR[1I]\s+LOCAL\s+[0O]CR/i);
  assert.equal(result.local, true);
});
