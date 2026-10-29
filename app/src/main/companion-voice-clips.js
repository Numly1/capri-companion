'use strict';
const fs = require('node:fs');
const path = require('node:path');
const DIRECTORY = path.resolve(__dirname, '../../assets/companion-voice');

function bundledVoice(text, directory = DIRECTORY) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    if (manifest.model !== 'Qwen/Qwen3-TTS-12Hz-1.7B-Base' || manifest.language !== 'ru' || !Object.hasOwn(manifest.clips || {}, text)) return null;
    const file = manifest.clips[text];
    if (typeof file !== 'string' || path.basename(file) !== file || !/^[a-z0-9-]+\.wav$/i.test(file)) return null;
    const audio = fs.readFileSync(path.join(directory, file));
    if (audio.length < 44 || audio.length > 1024 * 1024 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') return null;
    return { ok: true, audio: audio.toString('base64'), synthetic: true, engine: 'reference', prepared: true };
  } catch { return null; }
}

function installReference(dataDir, directory = DIRECTORY) {
  try {
    const destination = path.join(dataDir, 'capri-approved-reference.audio');
    if (fs.existsSync(destination)) return true;
    const source = path.join(directory, 'reference.wav');
    if (!fs.existsSync(source)) return false;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(destination, fs.readFileSync(source), { flag: 'wx' });
    return true;
  } catch { return false; }
}

module.exports = { bundledVoice, installReference };
