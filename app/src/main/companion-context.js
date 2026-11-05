'use strict';

// Local metadata only. No screenshots, document text, file reads or network requests.
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { sessionId: spotifySessionId, controls: spotifyControls } = require('./companion-spotify-control');
const { DRAWING_LINES } = require('./companion-support-lines');

const POLL_MS = 10000;
const DRAW_DWELL = 45000;
const DRAW_FOCUS_GRACE = 45000;
const MUSIC_DWELL = 30000;
const GLOBAL_SPACING = 60000;
const MAX_COVER_BYTES = 24576;
const MAX_MEDIA_LINE = 131072;
const MAX_TIMELINE_MS = 7 * 24 * 60 * 60 * 1000;
const APPS = Object.freeze({
  photoshop: 'Adobe Photoshop', krita: 'Krita', clipstudiopaint: 'CLIP STUDIO PAINT',
  sai: 'PaintTool SAI', sai2: 'PaintTool SAI', mspaint: 'Paint', paintdotnet: 'Paint.NET',
  illustrator: 'Adobe Illustrator', affinityphoto: 'Affinity Photo', affinityphoto2: 'Affinity Photo',
  affinitydesigner: 'Affinity Designer', affinitydesigner2: 'Affinity Designer',
  medibangpaintpro: 'MediBang Paint', firealpaca: 'FireAlpaca', firealpaca64: 'FireAlpaca',
  blender: 'Blender', ibispaint: 'ibisPaint',
});
const APP_NAMES = new Set([...Object.values(APPS), 'Photopea', 'Figma']);
const BROWSERS = /^(chrome|msedge|firefox|brave|opera|vivaldi)$/i;
const text = (s, n = 200) => typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) : '';

function classifyDrawing(executable, title = '') {
  const exe = text(executable).split(/[\\/]/).pop().replace(/\.exe$/i, '').toLowerCase();
  if (APPS[exe]) return APPS[exe];
  // A browser title is tested locally, then discarded. Filenames and titles never leave this classifier.
  if (BROWSERS.test(exe)) {
    if (/\bPhotopea\b/i.test(title)) return 'Photopea';
    if (/\bFigma\b/i.test(title)) return 'Figma';
  }
  return null;
}

function sanitizeSnapshot(raw) {
  const app = APP_NAMES.has(raw?.drawingApp) ? raw.drawingApp : null;
  const song = raw?.music;
  const title = text(song?.title);
  const source = song?.source === 'gsmtc' || song?.source === 'window-title' ? song.source : null;
  const music = title && source ? {
    title, artist: text(song.artist), playing: typeof song.playing === 'boolean' ? song.playing : null, source,
    album: text(song.album), cover: sanitizeCover(song.cover),
    durationMs: timelineMs(song.durationMs), positionMs: timelineMs(song.positionMs),
    sessionId: source === 'gsmtc' ? spotifySessionId(song.sessionId) : null,
    controls: spotifyControls(source === 'gsmtc' && spotifySessionId(song.sessionId) ? song.controls : null),
  } : null;
  if (music && music.durationMs !== null && music.positionMs !== null && music.positionMs > music.durationMs) music.positionMs = music.durationMs;
  return { drawingApp: app, music, mediaAvailable: raw?.mediaAvailable === true };
}

function timelineMs(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TIMELINE_MS ? Math.floor(value) : null;
}

function sanitizeCover(value) {
  if (typeof value !== 'string' || value.length > MAX_COVER_BYTES * 4 / 3 + 32) return null;
  const match = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length < 12 || bytes.length > MAX_COVER_BYTES || bytes.toString('base64') !== match[2]) return null;
  const valid = match[1] === 'jpeg'
    ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
    : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return valid ? value : null;
}

function enabledIntegrations(cfg = {}) {
  const master = cfg.companionContext !== false;
  const spotify = master && cfg.spotifyReactions !== false;
  const spotifyWidget = master && cfg.spotifyWidget !== false;
  return { spotify, spotifyWidget, spotifyMetadata: spotify || spotifyWidget, krita: master && cfg.kritaReactions !== false };
}

function cooldownFor(value, legacy) {
  const minutes = Number(value ?? legacy);
  return (Number.isFinite(minutes) && minutes > 0 ? Math.min(240, Math.max(1, minutes)) : 12) * 60000;
}

function reactionFor(kind, state, lang, pick = Math.random, previousLine = null, usedLines = null) {
  const ja = lang === 'ja' || lang === 'jp';
  let lines;
  if (kind === 'drawing') {
    const app = state.drawing.app;
    lines = ja ? [
      `${app}を開いてるね。アイデアの時間？ 私はネオンの隅で応援してる。`,
      `${app}、出番だね。細部で迷ったら、少し離れて全体を見るのもあり。`,
      `${app}が前にいる。ひらめいたもの、自由に試してみよう。`,
    ] : DRAWING_LINES[drawingStage(state.drawing.activeSeconds)];
  } else {
    const music = state.music;
    const track = music.artist ? `${music.artist} — ${music.title}` : music.title;
    lines = ja ? [
      `Spotifyで「${track}」が流れてる。よし、机にサウンドトラックが付いた。`,
      `今の曲は「${track}」だね。私はここで、こっそりリズムに乗ってる。`,
      `「${track}」、受信。音楽があると、いつもの作業も少し違って見えるね。`,
    ] : [
      `В Spotify играет «${track}». Всё, у нашего рабочего стола появился саундтрек.`,
      `Сейчас «${track}». Я тут тихонько качаюсь в такт — своим цифровым способом.`,
      `Приняла «${track}». С музыкой даже обычный день немного похож на сцену из фильма.`,
    ];
  }
  if (usedLines && lines.every(line => usedLines.has(line))) usedLines.clear();
  const remaining = lines.filter(line => line !== previousLine && !usedLines?.has(line));
  if (remaining.length) lines = remaining;
  const value = Number(pick());
  let index = Math.max(0, Math.min(lines.length - 1, Math.floor((Number.isFinite(value) ? value : 0) * lines.length)));
  if (lines[index] === previousLine) index = (index + 1) % lines.length;
  usedLines?.add(lines[index]);
  return { kind, line: lines[index], face: kind === 'drawing' ? 'smug' : 'laugh', action: kind === 'drawing' ? 'curious' : 'hop' };
}

const drawingStage = seconds => Number(seconds) >= 1200 ? 'long' : Number(seconds) >= 300 ? 'steady' : 'start';

class ContextTracker {
  constructor({ now = Date.now, random = Math.random } = {}) {
    this.now = now;
    this.random = random;
    this.drawing = null;
    this.pausedDrawing = null;
    this.drawingLines = new Map();
    this.pendingDrawing = null;
    this.retryDrawingAt = -Infinity;
    this.song = null;
    this.seenSongs = new Set();
    this.lastReactionAt = -Infinity;
    this.lastKindAt = { drawing: -Infinity, music: -Infinity };
    this.lastLines = { drawing: null, music: null };
    this.sequence = 0;
  }

  sample(raw, cfg = {}, { drawingReady = true } = {}) {
    const at = this.now();
    const enabled = enabledIntegrations(cfg);
    if (!enabled.spotifyMetadata && !enabled.krita) {
      this.drawing = null;
      this.pausedDrawing = null;
      this.pendingDrawing = null;
      this.song = null;
      return { state: { enabled: false, spotifyEnabled: false, spotifyWidgetEnabled: false, kritaEnabled: false, available: false, drawing: null, music: null, updatedAt: at }, reaction: null };
    }
    const snapshot = sanitizeSnapshot(raw);
    if (!enabled.krita) {
      snapshot.drawingApp = null;
      this.drawing = null; this.pausedDrawing = null; this.pendingDrawing = null;
    }
    if (!enabled.spotifyMetadata) snapshot.music = null;
    if (snapshot.drawingApp !== this.drawing?.app) {
      if (this.drawing?.app === 'Krita') this.pausedDrawing = { ...this.drawing, pausedAt: at };
      const resume = snapshot.drawingApp === 'Krita' && this.pausedDrawing && at >= this.pausedDrawing.pausedAt
        && at - this.pausedDrawing.pausedAt <= DRAW_FOCUS_GRACE;
      this.drawing = snapshot.drawingApp ? { app: snapshot.drawingApp,
        since: resume ? this.pausedDrawing.since + at - this.pausedDrawing.pausedAt : at } : null;
      if (snapshot.drawingApp === 'Krita') this.pausedDrawing = null;
    }
    if (this.pausedDrawing && at - this.pausedDrawing.pausedAt > DRAW_FOCUS_GRACE) this.pausedDrawing = null;
    const music = snapshot.music;
    const key = music ? `${music.artist.toLowerCase()}\u0000${music.title.toLowerCase()}` : null;
    // Display metadata alone must never build a delayed reaction opportunity.
    if (!enabled.spotify) this.song = null;
    else if (key !== this.song?.key) this.song = key ? { key, since: at, playing: music.playing === true } : null;
    if (this.song) {
      if (music.playing !== true) this.song.since = null;
      else if (!this.song.playing || this.song.since === null) this.song.since = at;
      this.song.playing = music.playing === true;
    }
    const state = {
      enabled: true, spotifyEnabled: enabled.spotify, spotifyWidgetEnabled: enabled.spotifyWidget, kritaEnabled: enabled.krita,
      available: true, mediaAvailable: enabled.spotifyMetadata && snapshot.mediaAvailable,
      drawing: this.drawing ? { app: this.drawing.app, activeSeconds: Math.max(0, Math.floor((at - this.drawing.since) / 1000)) } : null,
      music, updatedAt: at,
    };
    const kritaCooldown = cooldownFor(cfg.kritaIntervalMinutes, cfg.companionIntervalMinutes);
    const spotifyCooldown = cooldownFor(cfg.spotifyIntervalMinutes, cfg.companionIntervalMinutes);
    let kind = null;
    if (at - this.lastReactionAt >= GLOBAL_SPACING) {
      if (drawingReady && at >= this.retryDrawingAt && this.drawing?.app === 'Krita' && at - this.drawing.since >= DRAW_DWELL && at - this.lastKindAt.drawing >= kritaCooldown) kind = 'drawing';
      else if (this.song?.playing && this.song.since !== null && at - this.song.since >= MUSIC_DWELL && !this.seenSongs.has(key) && at - this.lastKindAt.music >= spotifyCooldown) kind = 'music';
    }
    let reaction = null;
    if (kind) {
      const previousDrawingAt = this.lastKindAt.drawing;
      this.lastReactionAt = at;
      this.lastKindAt[kind] = at;
      if (kind === 'music') this.seenSongs.add(key);
      const language = cfg.responseLanguage || cfg.lang;
      const bankKey = `${language === 'ja' || language === 'jp' ? 'ja' : 'ru'}:${drawingStage(state.drawing?.activeSeconds)}`;
      if (kind === 'drawing' && !this.drawingLines.has(bankKey)) this.drawingLines.set(bankKey, new Set());
      reaction = { ...reactionFor(kind, state, language, this.random, this.lastLines[kind], kind === 'drawing' ? this.drawingLines.get(bankKey) : null), id: ++this.sequence };
      if (kind === 'drawing') this.pendingDrawing = { id: reaction.id, issuedAt: at, previousDrawingAt };
      this.lastLines[kind] = reaction.line;
    }
    return { state, reaction };
  }

  reacted(id, accepted) {
    const pending = this.pendingDrawing;
    const at = this.now();
    if (!Number.isSafeInteger(id) || typeof accepted !== 'boolean' || pending?.id !== id) return false;
    this.pendingDrawing = null;
    if (at < pending.issuedAt || at - pending.issuedAt > 30000) return false;
    if (!accepted && this.lastKindAt.drawing === pending.issuedAt) {
      this.lastKindAt.drawing = pending.previousDrawingAt;
      this.retryDrawingAt = at + GLOBAL_SPACING;
    }
    return true;
  }
}

let latest = { enabled: false, available: false, drawing: null, music: null, updatedAt: 0 };
let running = null;
let activeConfig = () => ({});

function getContext() {
  const flags = enabledIntegrations(activeConfig());
  return { ...latest, enabled: flags.spotifyMetadata || flags.krita, spotifyEnabled: flags.spotify, spotifyWidgetEnabled: flags.spotifyWidget, kritaEnabled: flags.krita,
    drawing: flags.krita && latest.drawing ? { ...latest.drawing } : null,
    music: flags.spotifyMetadata && latest.music ? { ...latest.music } : null,
    mediaAvailable: flags.spotifyMetadata && latest.mediaAvailable === true };
}

// Images and high-frequency progress remain local UI data, never conversation input.
function conversationContext(state) {
  const music = state?.music;
  return { ...state, music: music ? { title: text(music.title), artist: text(music.artist), album: text(music.album),
    playing: music.playing === true ? true : music.playing === false ? false : null, source: music.source } : null };
}
function getConversationContext() { return conversationContext(getContext()); }

function stop() { running?.stop(); running = null; activeConfig = () => ({ companionContext: false }); }

function start(send, cfgGetter = () => ({}), options = {}) {
  stop();
  const tracker = new ContextTracker();
  const script = path.join(__dirname, 'companion-media.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  let child = null, lines = null, stopped = false, failures = 0, restartAt = 0, collectingWatching = false;
  const intentionalStops = new WeakSet();
  const config = () => { try { return cfgGetter() || {}; } catch { return { companionContext: false }; } };
  activeConfig = config;
  const publish = (event) => { latest = event.state; try { send(event); } catch {} };
  const needsWatching = cfg => ['auto', 'manual'].includes(cfg.watchMode) || (cfg.discordPresence === true && cfg.discordShareActivity === true);
  function supervise() {
    const cfg = config();
    const flags = enabledIntegrations(cfg);
    if (stopped) return;
    const watching = needsWatching(cfg);
    if ((!flags.spotifyMetadata && !flags.krita && !watching) || process.platform !== 'win32') {
      if (child) { intentionalStops.add(child); child.kill(); }
      child = null; lines?.close(); lines = null;
      failures = 0; restartAt = 0;
      const state = tracker.sample(null, { companionContext: false }).state;
      state.enabled = flags.spotifyMetadata || flags.krita;
      state.spotifyEnabled = flags.spotify;
      state.spotifyWidgetEnabled = flags.spotifyWidget;
      state.kritaEnabled = flags.krita;
      if (latest.enabled !== state.enabled || latest.available !== false || latest.music || latest.drawing) publish({ state, reaction: null });
      return;
    }
    // Strip an integration immediately on a menu change rather than waiting for the next helper poll.
    if ((!flags.spotifyMetadata && latest.music) || (!flags.krita && latest.drawing) ||
        latest.spotifyEnabled !== flags.spotify || latest.spotifyWidgetEnabled !== flags.spotifyWidget || latest.kritaEnabled !== flags.krita) {
      publish({ state: getContext(), reaction: null });
    }
    if (child && collectingWatching !== watching) {
      intentionalStops.add(child); child.kill(); child = null; lines?.close(); lines = null;
    }
    if (child || failures >= 3 || Date.now() < restartAt) return;
    collectingWatching = watching;
    const processRef = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ParentPid', String(process.pid), ...(watching ? ['-WatchMedia'] : [])], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = processRef;
    lines = readline.createInterface({ input: processRef.stdout });
    lines.on('line', (line) => {
      const flags = enabledIntegrations(config());
      if (line.length > MAX_MEDIA_LINE || stopped || (!flags.spotifyMetadata && !flags.krita && !needsWatching(config()))) return;
      let raw;
      try { raw = JSON.parse(line.replace(/^\uFEFF/, '')); } catch { return; }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      if (options.onSnapshot) { try { options.onSnapshot(raw); } catch {} }
      let drawingReady = true;
      try { if (options.canReact) drawingReady = options.canReact() === true; } catch { drawingReady = false; }
      publish(tracker.sample(raw, config(), { drawingReady }));
    });
    // Helper diagnostics can contain OS data. Consume them, never forward/log them.
    processRef.stderr.on('data', () => {});
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (child === processRef) { child = null; lines?.close(); lines = null; }
      if (!stopped && !intentionalStops.has(processRef)) {
        failures++; restartAt = Date.now() + 3000;
        publish({ state: { ...getContext(), available: false }, reaction: null });
      }
    };
    processRef.on('error', finish);
    processRef.on('exit', finish);
  }
  const timer = setInterval(supervise, 2000);
  timer.unref?.();
  running = {
    stop() { stopped = true; clearInterval(timer); lines?.close(); child?.kill(); child = null; lines = null; activeConfig = () => ({ companionContext: false }); latest = { enabled: false, available: false, drawing: null, music: null, updatedAt: Date.now() }; },
    getContext,
    reacted: (id, accepted) => tracker.reacted(id, accepted),
  };
  supervise();
  return running;
}

module.exports = { start, stop, getContext, getConversationContext, conversationContext, ContextTracker, classifyDrawing, sanitizeSnapshot, sanitizeCover, enabledIntegrations, POLL_MS, DRAW_DWELL, DRAW_FOCUS_GRACE, MUSIC_DWELL, GLOBAL_SPACING, MAX_COVER_BYTES, MAX_MEDIA_LINE };
