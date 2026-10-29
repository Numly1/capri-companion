'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');

test('portable uses a unique launch directory with this installed builder', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.build.portable.unpackDirName, true,
    'builder26.18.0 implementation needs true, despite contradictory schema description');
  const builder = fs.readFileSync(path.join(appRoot, 'node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js'), 'utf8');
  const branch = builder.match(/if \(typeof unpackDirName === "string" \|\| !unpackDirName\) \{\s*defines\.UNPACK_DIR_NAME = [^;]+;\s*\}/)?.[0];
  assert.ok(branch, 'review builder directory selection if its implementation changes');
  const resolveDir = new Function('unpackDirName', `const defines={}; const builder_util_1={generateKsuid:()=> 'fixed-build-directory'}; ${branch} return defines.UNPACK_DIR_NAME;`);
  assert.equal(resolveDir(pkg.build.portable.unpackDirName), undefined,
    'no UNPACK_DIR_NAME must be defined, so NSIS uses its unique PLUGINSDIR/app');
  assert.equal(resolveDir(undefined), 'fixed-build-directory');
  assert.equal(resolveDir(false), 'fixed-build-directory');
  const template = fs.readFileSync(path.join(appRoot, 'node_modules/app-builder-lib/templates/nsis/portable.nsi'), 'utf8');
  assert.match(template, /StrCpy \$INSTDIR "\$PLUGINSDIR\\app"/);
});

test('embedded voice source equals the canonical script', () => {
  const embedded = require('../src/main/companion-voice-script');
  const source = typeof embedded === 'string' ? embedded : embedded.script;
  assert.equal(typeof source, 'string');
  const canonical = fs.readFileSync(path.join(appRoot, 'src/main/companion-voice.ps1'), 'utf8');
  const normalized = x => x.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  assert.equal(normalized(source), normalized(canonical));
});

test('speech launches fixed encoded script and sends user text only on stdin', () => {
  const source = fs.readFileSync(path.join(appRoot, 'src/main/companion-speech.js'), 'utf8');
  const synth = source.slice(source.indexOf('function synthesize'));
  assert.match(source, /require\(['"]\.\/companion-voice-script['"]\)/);
  assert.match(synth, /-EncodedCommand/);
  assert.match(source, /utf16le/);
  assert.doesNotMatch(synth, /['"]-File['"]/);
  assert.match(synth, /child\.stdin\.end\(JSON\.stringify\(/);
  assert.doesNotMatch(synth, /execFile\([^\n]+text/);
});
