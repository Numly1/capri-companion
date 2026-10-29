'use strict';

const fs = require('node:fs');
const path = require('node:path');
const REVISION = 'fd4b254389122332181a7c3db7f27e918eec64e3';

// The ready-to-run package may enable its bundled voice once. It never supplies
// credentials or replaces an existing profile with a copied configuration.
function initializeReadyGift(cfg, directory = process.env.PORTABLE_EXECUTABLE_DIR, io = fs) {
  if (!directory || cfg.readyGiftVoiceVersion === 1) return cfg;
  try {
    const marker = path.join(directory, 'capri-ready.json');
    const stat = io.statSync(marker);
    if (!stat.isFile() || stat.size > 1024) return cfg;
    const data = JSON.parse(io.readFileSync(marker, 'utf8'));
    if (data.format !== 'capri-ready-gift' || data.version !== 1 || data.voice !== 'capri-sample') return cfg;
    const runtime = path.join(directory, '.tools', 'capri-qwen-voice');
    const model = path.join(runtime, 'hf-cache', 'hub', 'models--Qwen--Qwen3-TTS-12Hz-1.7B-Base', 'snapshots', REVISION);
    const required = [path.join(directory, 'voice-backend-qwen', 'server.py'),
      path.join(runtime, 'venv', 'Scripts', 'python.exe'), path.join(model, 'config.json'), path.join(model, 'model.safetensors')];
    if (required.some(file => !io.existsSync(file))) return cfg;
    return { ...cfg, voiceStyle: 'capri-sample', companionVoice: true, readyGiftVoiceVersion: 1 };
  } catch { return cfg; }
}

module.exports = { initializeReadyGift, REVISION };
