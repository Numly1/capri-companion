'use strict';

// Reads only new client-log records while Minecraft is foreground. No game control or cloud calls.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { execFile } = require('node:child_process');
const PLAYER = /^[A-Za-z0-9_]{1,16}$/;
const SOURCE = 'client-log';
const MAX_CHUNK = 256 * 1024;

// Command lines can contain access tokens. They stay inside this fixed local projection;
// only PID, game directory and the already-public in-game player name are emitted.
const CLIENT_SCRIPT = `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Read-Argument([string]$command,[string]$name) {
 $pattern='(?:^|\\s)'+[regex]::Escape($name)+'(?:\\s+|=)(?:"([^"]*)"|(\\S+))'
 $match=[regex]::Match($command,$pattern)
 if(-not $match.Success){return $null}
 if($match.Groups[1].Success){return $match.Groups[1].Value}
 return $match.Groups[2].Value
}
try {
 $result=@(Get-CimInstance Win32_Process -Filter "Name='javaw.exe' OR Name='java.exe'" | ForEach-Object {
  $directory=Read-Argument $_.CommandLine '--gameDir'
  $player=Read-Argument $_.CommandLine '--username'
  if($directory -and $player -match '^[A-Za-z0-9_]{1,16}$') {
   [pscustomobject]@{pid=[int]$_.ProcessId;gameDir=[IO.Path]::GetFullPath($directory);playerName=$player}
  }
 })
 ConvertTo-Json -InputObject $result -Depth 3 -Compress
} catch { [Console]::Out.WriteLine('[]') }
`;

function normalizeClients(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, 16).filter(item => Number.isSafeInteger(item?.pid) && item.pid > 0
    && typeof item.gameDir === 'string' && path.isAbsolute(item.gameDir) && item.gameDir.length < 32768
    && PLAYER.test(item.playerName)).map(item => ({ pid: item.pid, gameDir: path.resolve(item.gameDir), playerName: item.playerName }));
}

function runningClients(options = {}) {
  if ((options.platform || process.platform) !== 'win32') return Promise.resolve([]);
  const invoke = options.execFile || execFile;
  return new Promise(resolve => {
    const file = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    invoke(file, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(CLIENT_SCRIPT, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, output) => {
        if (error) return resolve([]);
        try { resolve(normalizeClients(JSON.parse(String(output).replace(/^\uFEFF/, '').trim()))); } catch { resolve([]); }
      });
  });
}

function discoverLogs(appData = process.env.APPDATA, io = fs) {
  if (!appData) return [];
  const candidates = [path.join(appData, '.minecraft', 'logs', 'latest.log')];
  const addInstances = (directory, suffix) => {
    try { for (const entry of io.readdirSync(directory, { withFileTypes: true }).slice(0, 64)) {
      if (entry.isDirectory()) candidates.push(path.join(directory, entry.name, ...suffix, 'logs', 'latest.log'));
    } } catch {}
  };
  addInstances(path.join(appData, 'ReignCraft', 'game data'), []);
  addInstances(path.join(appData, 'PrismLauncher', 'instances'), ['.minecraft']);
  addInstances(path.join(appData, 'MultiMC', 'instances'), ['.minecraft']);
  addInstances(path.join(appData, 'com.modrinth.theseus', 'profiles'), []);
  return candidates.map(file => {
    try { const stat = io.statSync(file); return stat.isFile() && stat.size > 0 ? { file, modified: stat.mtimeMs } : null; } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.modified - a.modified).map(item => item.file);
}

function logBody(line) {
  if (typeof line !== 'string' || line.length > 8192) return null;
  line = line.replace(/\r?\n$/, '');
  // Vanilla and Forge 1.20.1 formats: optional logger between thread/level and the message.
  const match = /^\[[^\]\r\n]+\]\s+\[(?:Render thread|Client thread|main)\/INFO\]\s*(?:\[[^\]\r\n]+\])?:\s*(.*)$/.exec(line);
  return match ? match[1].replace(/§[0-9A-FK-OR]/gi, '').trim() : null;
}

function playerFromLines(lines) {
  for (const line of lines) {
    const match = /^Setting user:\s*([A-Za-z0-9_]{1,16})$/.exec(logBody(line) || '');
    if (match && PLAYER.test(match[1])) return match[1];
  }
  return null;
}

function eventsFromLines(lines, playerName) {
  const events = [];
  const own = PLAYER.test(playerName || '') ? playerName : null;
  for (const line of Array.isArray(lines) ? lines.slice(-2000) : []) {
    const body = logBody(line);
    if (!body) continue;
    if (/^Connecting to\s+\S+/i.test(body)) { events.push({ kind: 'connecting', priority: 20 }); continue; }
    if (/^(?:Client )?connected to (?:a modded |the )?server[.!]?$/i.test(body)) { events.push({ kind: 'connected', priority: 30 }); continue; }
    if (/^(?:Disconnected from (?:the )?server|Lost connection:|Connection lost:)/i.test(body)) { events.push({ kind: 'disconnected', priority: 70 }); continue; }
    const chat = /^\[CHAT\]\s*(.*)$/.exec(body)?.[1];
    if (!chat || /^[<\[]|^\*\s|^[^:]{1,40}:/.test(chat)) continue; // Player chat, ranks, whispers and RP actions.
    if (/^(?:Точка возрождения установлена|Respawn point set)[.!]?$/.test(chat)) { events.push({ kind: 'spawn-set', priority: 40 }); continue; }
    if (/^(?:Спать можно только ночью и во время грозы|You can sleep only at night or during thunderstorms)[.!]?$/.test(chat)) { events.push({ kind: 'sleep-denied', priority: 10 }); continue; }
    if (!own || !chat.startsWith(`${own} `)) continue;
    const action = chat.slice(own.length + 1);
    if (/^(?:получил достижение|достиг цели|завершил испытание) [«\[].+[»\]]$|^has (?:made the advancement|reached the goal|completed the challenge) \[.+\]$/.test(action)) {
      events.push({ kind: 'advancement', priority: 60 }); continue;
    }
    if (/^(?:умер|утонул|сгорел|взорвался|разбился вдребезги|решил поплавать в лаве|был (?:убит|застрелен|сражён|сражен|взорван|раздавлен)|погиб|испытал кинетическую энергию|задохнулся|замёрз насмерть|замерз насмерть|died|drowned|burned to death|went up in flames|hit the ground too hard|fell (?:from|off)|tried to swim in lava|was (?:slain|shot|killed|blown up|squashed)|blew up|experienced kinetic energy|froze to death)(?:[.! ]|$)/.test(action)) {
      events.push({ kind: 'death', priority: 100 }); continue;
    }
    if (/^(?:присоединился к игре|joined the game)[.!]?$/.test(action)) events.push({ kind: 'joined', priority: 30 });
  }
  // Event types only: no player names, server addresses, achievement titles or raw chat leave here.
  return events;
}

class LogTail {
  constructor(file, io = fs) {
    this.file = file; this.io = io; this.position = null; this.identity = null; this.headLength = 0; this.headHash = null;
    this.partial = ''; this.decoder = new StringDecoder('utf8'); this.discard = false; this.available = false;
  }

  readPart(fd, length, position) {
    const buffer = Buffer.alloc(length);
    const read = length ? this.io.readSync(fd, buffer, 0, length, position) : 0;
    return buffer.subarray(0, read);
  }

  read() {
    let fd;
    try {
      const stat = this.io.statSync(this.file);
      if (!stat.isFile()) return [];
      fd = this.io.openSync(this.file, 'r');
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      const head = this.readPart(fd, Math.min(this.headLength || 256, stat.size), 0);
      const hash = crypto.createHash('sha256').update(head).digest('hex');
      const replaced = this.position === null || this.identity !== identity || stat.size < this.position
        || (this.headLength > 0 && head.length === this.headLength && this.headHash !== hash);
      this.available = true;
      if (replaced || stat.size - this.position > MAX_CHUNK) {
        this.position = stat.size; this.identity = identity; this.headLength = head.length; this.headHash = hash;
        this.partial = ''; this.decoder = new StringDecoder('utf8');
        this.discard = stat.size > 0 && this.readPart(fd, 1, stat.size - 1)[0] !== 10;
        return []; // A new/rotated log is a baseline, never a backlog of historical events.
      }
      const chunk = this.readPart(fd, Math.min(MAX_CHUNK, Math.max(0, stat.size - this.position)), this.position);
      this.position += chunk.length;
      if (!this.headLength && stat.size) { this.headLength = head.length; this.headHash = hash; }
      const completed = (this.partial + this.decoder.write(chunk)).split('\n');
      this.partial = completed.pop() || '';
      if (this.partial.length > 8192) { this.partial = ''; this.discard = true; }
      if (this.discard && completed.length) { completed.shift(); this.discard = false; }
      return completed.map(line => line.replace(/\r$/, '')).filter(line => line.length <= 8192);
    } catch { this.available = false; return []; }
    finally { if (fd !== undefined) try { this.io.closeSync(fd); } catch {} }
  }
}

const LINES = Object.freeze({
  death: ['В журнале сообщение о гибели твоего персонажа. Чум, это неприятно. Выдохни — мы ещё вернёмся и продолжим.', 'По журналу персонаж погиб. Ты не обязана играть идеально. Я рядом, а следующую попытку начнём спокойнее.', 'Похоже, эта попытка закончилась гибелью персонажа. Не ругай себя. У нашей истории ещё будут хорошие главы.'],
  advancement: ['В журнале новое достижение твоего персонажа. Нова! Маленькая победа официально засчитана — ты умница.', 'Есть новое достижение! Вот за такие моменты я и люблю сидеть рядом. Мой цифровой респект.', 'По журналу ты получила достижение. У нас тут прогресс, чум. Можно на секунду собой погордиться.'],
  connecting: ['В журнале началось подключение к серверу Minecraft. Чум, желаю хорошей игры. Я тут на подстраховке.', 'Minecraft подключается к серверу. Пусть в этой истории будет побольше приятных находок и поменьше внезапностей.'],
  connected: ['В журнале подтверждение подключения к серверу. Ну что, чум, хорошей игры. Я побуду рядом.', 'Minecraft сообщает о подключении. Новая порция приключений на связи. Держу за тебя цифровые кулачки.'],
  joined: ['В журнале твой персонаж присоединился к игре. Хорошего приключения, чум. Мы на связи.', 'Персонаж вошёл в игру. Пусть эта попытка будет удачной. Я заняла свой неоновый угол и болею за тебя.'],
  disconnected: ['В журнале сообщение о потере соединения Minecraft. Спокойно, чум. Проверь подключение, а пока можно выдохнуть.', 'Minecraft сообщил об отключении от сервера. Незапланированная пауза — повод расправить плечи.'],
  'spawn-set': ['Точка возрождения установлена. Неплохая забота о будущей себе, чум.', 'Minecraft пишет, что точка возрождения установлена. Маленькая подготовка, большое спокойствие.'],
  'sleep-denied': ['Minecraft напоминает: спать сейчас нельзя. Даже кровать сегодня с характером. Я пока составлю компанию.', 'По сообщению Minecraft сейчас не время для сна. Ну что, ещё немного приключений — я рядом.'],
});

class MinecraftTracker {
  constructor({ now = Date.now, random = Math.random } = {}) { this.now = now; this.random = random; this.lastAt = -Infinity; this.kindAt = new Map(); this.previousLine = null; this.sequence = 0; }
  sample(events, cfg = {}) {
    if (cfg.minecraftReactions !== true) return null;
    const at = this.now(); const value = Number(cfg.minecraftIntervalMinutes);
    const pause = (Number.isFinite(value) && value > 0 ? Math.min(30, Math.max(1, value)) : 2) * 60000;
    const fresh = [...events].sort((a, b) => b.priority - a.priority);
    if (at - this.lastAt < pause) return null;
    const event = fresh.find(item => LINES[item.kind] && at - (this.kindAt.get(item.kind) ?? -Infinity) >= 5 * 60000);
    if (!event) return null;
    this.lastAt = at; this.kindAt.set(event.kind, at);
    const lines = LINES[event.kind]; const choice = Number(this.random());
    let index = Math.max(0, Math.min(lines.length - 1, Math.floor((Number.isFinite(choice) ? choice : 0) * lines.length)));
    if (lines[index] === this.previousLine) index = (index + 1) % lines.length;
    this.previousLine = lines[index];
    return { id: ++this.sequence, source: SOURCE, kind: event.kind, line: this.previousLine, face: event.kind === 'advancement' ? 'laugh' : 'look' };
  }
}

function start(send, cfgGetter = () => ({}), options = {}) {
  const io = options.fs || fs; const now = options.now || Date.now;
  const getForeground = options.getForeground || (() => null);
  const getClients = options.runningClients || runningClients;
  const tracker = new MinecraftTracker(options);
  let stopped = false; let pending = false; let clients = []; let checkedAt = -Infinity; let tail = null; let selected = null; let playerName = null;
  let state = { enabled: false, active: false, available: false, identified: false, source: SOURCE, updatedAt: 0 };
  const emit = reaction => { try { send({ state: { ...state }, reaction }); } catch {} };
  async function poll() {
    if (stopped || pending) return;
    const cfg = cfgGetter(); const front = getForeground(); const active = cfg.minecraftReactions === true && front?.active === true;
    state = { enabled: cfg.minecraftReactions === true, active, available: false, identified: false, source: SOURCE, updatedAt: now() };
    pending = true;
    try {
      if (!active) {
        tail = null; selected = null; playerName = null; // Resume from a fresh EOF, with no off-game reads or backlog.
        emit(null); return;
      }
      if (now() - checkedAt >= 30000) { clients = await getClients(); checkedAt = now(); }
      if (stopped) return;
      const current = clients.find(client => client.pid === front.pid) || (!front.pid && clients.length === 1 ? clients[0] : null);
      const explicit = typeof cfg.minecraftLogPath === 'string' && path.isAbsolute(cfg.minecraftLogPath) && /\.log$/i.test(cfg.minecraftLogPath) ? path.resolve(cfg.minecraftLogPath) : null;
      const file = explicit || (current ? path.join(current.gameDir, 'logs', 'latest.log') : (options.logPath || discoverLogs(options.appData, io)[0]));
      if (!file) { emit(null); return; }
      if (file !== selected || !tail) { selected = file; tail = new LogTail(file, io); playerName = null; }
      playerName = PLAYER.test(cfg.minecraftPlayerName || '') ? cfg.minecraftPlayerName : (current?.playerName || playerName);
      const records = tail.read();
      playerName = playerName || playerFromLines(records);
      const after = getForeground();
      if (stopped || cfgGetter().minecraftReactions !== true || after?.active !== true || String(after.id) !== String(front.id)) return;
      state.available = tail.available; state.identified = Boolean(playerName);
      const reaction = tracker.sample(eventsFromLines(records, playerName), cfgGetter());
      emit(reaction);
    } catch { if (!stopped) emit(null); }
    finally { pending = false; }
  }
  const timer = options.schedule === false ? null : setInterval(() => { poll().catch(() => {}); }, 2000);
  if (options.schedule !== false) poll().catch(() => {});
  return { poll, getState: () => ({ ...state }), stop() { stopped = true; if (timer) clearInterval(timer); } };
}

module.exports = { runningClients, normalizeClients, discoverLogs, logBody, playerFromLines, eventsFromLines, LogTail, MinecraftTracker, start };
