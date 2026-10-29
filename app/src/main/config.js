'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { initializeReadyGift } = require('./companion-ready-gift');

const DEFAULTS = {
  scale: 0.6,        // sprite scale, 0.6 ≈ 250px tall
  muted: false,
  volume: 0.7,
  lang: 'ru',        // companion starts in Russian; all original languages remain available
  offlineChat: true, // finite local conversations by default; AI only after explicit setup
  companionContext: true,
  companionIntervalMinutes: 12,
  spotifyReactions: true,
  spotifyWidget: true,
  kritaReactions: true,
  spotifyIntervalMinutes: 12,
  kritaIntervalMinutes: 12,
  companionVoice: true,
  digitalVoice: true,
  voiceLanguage: 'ru',
  responseLanguage: 'ru',
  voiceStyle: 'capri',
  hasVoiceReference: false,
  ambientSpeech: true,
  ambientIntervalMinutes: 5,
  ss14Reactions: true,
  ss14IntervalMinutes: 3,
  ss14Server: 'Arcane Nirvana',
  minecraftReactions: true,
  minecraftIntervalMinutes: 2,
  minecraftLogPath: '',
  effectLevel: 'full',
  companionWelcomed: false,
  displayId: null,   // null = primary display
  wander: true,      // random teleports when idle
  possess: true,     // now and then she dives into the window she sits on and takes it over
  visible: true,
  welcomed: true,    // companion has its own non-technical welcome
  assistant: 'auto', // the coding assistant she watches: 'claude' or 'codex' ('auto': whichever has her hooks)
  linked: false,     // a Claude Code event has reached her at least once
  chatModel: null,   // the model she talks with (null: the provider's first one)
  visionModel: null,
  provider: 'groq', // optional free-tier service; no requests until offlineChat is turned off
  apiKeys: {},       // { openai: 'sk-...' }, else the provider's env variable
  customUrl: '',     // the 'custom' provider: any OpenAI-compatible base URL (http://host:port/v1)
  claudeCwd: null,   // the folder Claude Code works in (null: your home folder)
  userName: '',      // what she calls you
  persona: '',       // how you want her, in your words (her chat)
  myLines: [],       // lines of yours she says now and then, with hers
  memories: [],      // things you asked her to remember (her chat)
  claudeMode: 'default', // Claude Code's permission mode in her chat: 'default' only reads, 'acceptEdits' edits without asking
  claude: false,     // this personal companion starts without coding-assistant hooks
  rest: 'corner',    // where she rests when nothing's going on: 'corner', or 'taskbar' (sitting on it)
  motion: 'auto',    // her animations: 'auto' (like Windows' animation effects), 'full' or 'reduced'
  motionAsked: false, // she asked once, Windows' animations being off, whether to move anyway
  render: 'auto',   // how her window is drawn: 'auto', 'gl' (OpenGL) or 'software' (no graphics card), for PCs that show it black
  follow: true,      // with several screens, she follows the pointer to the one you're on
  jealous: true,     // she gets jealous when she sees you on another AI (bond.js)
  reminders: [],     // the reminders she keeps: [{ id, at, text, made }] (reminders.js)
  bond: null,        // how close she is to you: { xp, first, last, days, streak, caps } (bond.js)
  pcReact: true,     // she reacts to your PC: the processor at full tilt, the battery, the network, a USB stick, a game (pc.js)
  hideInGames: false,
  watchScreen: false, // she looks at your screen now and then and says something about it (look.js)
  lookAsked: false,  // she told you what looking means (where the picture goes) and you said yes
};

let cache = null;

function file() {
  return path.join(app.getPath('userData'), 'config.json');
}

function load(fresh = false) {
  if (cache && !fresh) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  const ready = initializeReadyGift(cache);
  if (ready !== cache) {
    cache = ready;
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
    } catch { /* A read-only profile can still use the bundled voice for this run. */ }
  }
  return cache;
}

function save(patch) {
  cache = { ...load(), ...patch };
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error('[capri] could not save config:', err.message);
  }
  return cache;
}

module.exports = { load, save, file, DEFAULTS };
