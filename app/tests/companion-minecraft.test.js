'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { eventsFromLines, playerFromLines, LogTail, MinecraftTracker, start, normalizeClients, runningClients } = require('../src/main/companion-minecraft');
const record = text => `[01:02:03] [Render thread/INFO] [minecraft/ChatComponent]: ${text}\n`;
function temporary() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-minecraft-test-'));
  const file = path.join(directory, 'latest.log');
  fs.writeFileSync(file, '');
  return { file, cleanup() { fs.unlinkSync(file); fs.rmdirSync(directory); } };
}

test('own Java/Forge events are distinct from other players, quoted chat and unrelated loggers', () => {
  const input = [record('[CHAT] Alice_Secret получил достижение [Secret title]'), record('[CHAT] Alice_Secret был убит зомби'),
    record('[CHAT] OtherPlayer был убит зомби'), record('[CHAT] <OtherPlayer> Alice_Secret умер'),
    record('[CHAT] [VIP] OtherPlayer: Alice_Secret умер'), record('[CHAT] Точка возрождения установлена'),
    '[01:02:03] [Server thread/INFO]: [CHAT] Alice_Secret умер', record('Connecting to example.invalid, 25565')];
  const events = eventsFromLines(input, 'Alice_Secret');
  assert.deepEqual(events.map(event => event.kind), ['advancement', 'death', 'spawn-set', 'connecting']);
  assert.doesNotMatch(JSON.stringify(events), /Alice_Secret|OtherPlayer|Secret title|example\.invalid/);
  assert.deepEqual(eventsFromLines([record('[CHAT] Alice_Secret умер')], null), []);
  assert.equal(playerFromLines([record('[CHAT] <OtherPlayer> Setting user: Fake')]), null);
  assert.equal(playerFromLines(['[01:02:03] [Render thread/INFO]: Setting user: OwnPlayer']), 'OwnPlayer');
});

test('log tail starts at EOF, reconstructs split UTF-8 and never replays history', () => {
  const t = temporary();
  try {
    fs.writeFileSync(t.file, record('[CHAT] Alice_Secret умер'));
    const tail = new LogTail(t.file);
    assert.deepEqual(tail.read(), []);
    const next = Buffer.from(record('[CHAT] Alice_Secret сгорел'));
    const cut = next.findIndex(byte => byte > 127) + 1;
    fs.appendFileSync(t.file, next.subarray(0, cut)); assert.deepEqual(tail.read(), []);
    fs.appendFileSync(t.file, next.subarray(cut));
    assert.deepEqual(eventsFromLines(tail.read(), 'Alice_Secret').map(event => event.kind), ['death']);
    assert.deepEqual(tail.read(), []);
  } finally { t.cleanup(); }
});

test('truncation and replacement establish a new baseline rather than celebrating stale events', () => {
  const t = temporary();
  try {
    fs.writeFileSync(t.file, 'old log header\n'); const tail = new LogTail(t.file); tail.read();
    fs.writeFileSync(t.file, record('[CHAT] Alice_Secret умер').repeat(4));
    assert.deepEqual(tail.read(), []);
    fs.appendFileSync(t.file, record('[CHAT] Alice_Secret получил достижение [New]'));
    assert.equal(eventsFromLines(tail.read(), 'Alice_Secret')[0].kind, 'advancement');
    fs.writeFileSync(t.file, ''); assert.deepEqual(tail.read(), []);
    fs.appendFileSync(t.file, record('[CHAT] Respawn point set'));
    assert.equal(eventsFromLines(tail.read(), 'Alice_Secret')[0].kind, 'spawn-set');
  } finally { t.cleanup(); }
});

test('unfinished baseline and oversized catch-up are discarded with bounded reads', () => {
  const t = temporary();
  try {
    fs.writeFileSync(t.file, 'unfinished old record'); const tail = new LogTail(t.file); tail.read();
    fs.appendFileSync(t.file, ' rest\n' + record('[CHAT] Respawn point set'));
    assert.equal(tail.read().length, 1);
    fs.appendFileSync(t.file, 'x'.repeat(300000) + '\n' + record('[CHAT] Alice_Secret умер'));
    assert.deepEqual(tail.read(), []);
    fs.appendFileSync(t.file, record('[CHAT] Respawn point set'));
    assert.equal(tail.read().length, 1);
  } finally { t.cleanup(); }
});

test('cooldowns consume suppressed opportunities without queueing and preserve event priority', () => {
  let at = 0; const tracker = new MinecraftTracker({ now: () => at, random: () => 0 });
  const cfg = { minecraftReactions: true, minecraftIntervalMinutes: 2 };
  const death = { kind: 'death', priority: 100 }, advancement = { kind: 'advancement', priority: 60 };
  assert.equal(tracker.sample([advancement, death], cfg).kind, 'death');
  assert.equal(tracker.sample([advancement], cfg), null);
  at = 121000; assert.equal(tracker.sample([], cfg), null);
  assert.equal(tracker.sample([advancement], cfg).kind, 'advancement');
  at = 242000; assert.equal(tracker.sample([death], cfg), null);
  at = 250000; assert.equal(tracker.sample([death], cfg), null);
  at = 301000; assert.equal(tracker.sample([death], cfg).kind, 'death');
  assert.equal(tracker.sample([death], { minecraftReactions: false }), null);
});

test('controller consumes only future foreground records and never broadcasts raw chat or identity', async () => {
  const t = temporary(); const events = []; let active = true;
  const service = start(event => events.push(event), () => ({ minecraftReactions: true, minecraftLogPath: t.file }), {
    schedule: false, getForeground: () => ({ active, id: 9, pid: 7 }),
    runningClients: async () => [{ pid: 7, gameDir: path.dirname(t.file), playerName: 'Alice_Secret' }],
  });
  try {
    await service.poll();
    fs.appendFileSync(t.file, record('[CHAT] Alice_Secret получил достижение [Private name]'));
    await service.poll();
    assert.equal(events.at(-1).reaction.kind, 'advancement');
    assert.equal(events.at(-1).state.identified, true);
    assert.doesNotMatch(JSON.stringify(events), /Alice_Secret|Private name|latest\.log/);
    active = false; fs.appendFileSync(t.file, record('[CHAT] Alice_Secret умер')); await service.poll();
    active = true; await service.poll();
    assert.equal(events.at(-1).reaction, null);
    assert.equal(events.filter(event => event.reaction).length, 1);
  } finally { service.stop(); t.cleanup(); }
});

test('client projection strips unknown fields and the fixed helper cannot forward credentials', async () => {
  const directory = path.resolve(os.tmpdir()); let calls = 0;
  assert.deepEqual(normalizeClients([{ pid: 42, gameDir: directory, playerName: 'Alice_Secret', accessToken: 'discard' }]),
    [{ pid: 42, gameDir: directory, playerName: 'Alice_Secret' }]);
  const clients = await runningClients({ platform: 'win32', execFile(file, args, options, callback) {
    calls++; assert.match(file, /powershell\.exe$/); assert.ok(args.includes('-EncodedCommand'));
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.doesNotMatch(script, /Write-(?:Host|Output).*CommandLine|ConvertTo-Json.*CommandLine/);
    assert.equal(options.windowsHide, true);
    queueMicrotask(() => callback(null, JSON.stringify([{ pid: 42, gameDir: directory, playerName: 'Alice_Secret', extra: 'discard' }])));
  } });
  assert.equal(calls, 1); assert.deepEqual(clients, [{ pid: 42, gameDir: directory, playerName: 'Alice_Secret' }]);
});

test('renderer reacts once and drops busy, hidden and conversation opportunities without a replay', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/companion-minecraft.js'), 'utf8');
  const { CompanionMinecraft } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  let spoken = 0, shown = 0;
  const panel = { visible: false, say() { shown++; return true; } }, chat = { open: false }, capri = {};
  const integration = new CompanionMinecraft({ host: {}, panel, chat, capri, guide: {} });
  integration.configure({ minecraftReactions: true }); integration.onSay = () => spoken++;
  const event = id => ({ state: { enabled: true, active: true }, reaction: { id, source: 'client-log', line: 'Есть достижение!', kind: 'advancement' } });
  assert.equal(integration.onSnapshot(event(1)), true); assert.equal(integration.onSnapshot(event(1)), false);
  chat.open = true; assert.equal(integration.onSnapshot(event(2)), false);
  chat.open = false; assert.equal(integration.onSnapshot(event(2)), false);
  capri.stowed = true; assert.equal(integration.onSnapshot(event(3)), false);
  assert.equal(shown, 1); assert.equal(spoken, 1);
});
