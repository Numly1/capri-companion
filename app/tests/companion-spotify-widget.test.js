'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/companion-spotify-widget.js'), 'utf8');
const ready = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const COVER = 'data:image/png;base64,iVBORw0KGgo=';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.style = {}; this.events = {}; this.hidden = false; }
  appendChild(el) { this.children.push(el); el.parent = this; return el; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
  remove() { this.removed = true; }
  getBoundingClientRect() { return { left: 40, top: 50, right: 284, bottom: 138 }; }
}

async function fixture() {
  const { CompanionSpotifyWidget } = await ready;
  const listeners = {}, saved = [], state = { now: 100000, removed: 0, cleared: false };
  const doc = { createElement: tag => new Element(tag), head: new Element('head'), body: new Element('body') };
  const capri = { scale: 0.6, view: { floor: 700 }, head: () => ({ x: 350, y: 400 }) };
  const panel = { visible: false }, chat = { open: false };
  const host = {
    onConfig: fn => { listeners.config = fn; return () => state.removed++; },
    onCompanionContext: fn => { listeners.context = fn; return () => state.removed++; },
    setConfig: async cfg => saved.push(cfg),
  };
  const widget = new CompanionSpotifyWidget({ capri, host, panel, chat }, {
    document: doc, window: { innerWidth: 1000, innerHeight: 750 }, now: () => state.now,
    setInterval: fn => { listeners.tick = fn; return 123; }, clearInterval: id => { assert.equal(id, 123); state.cleared = true; },
  });
  const snapshot = overrides => listeners.context({ state: { available: true, updatedAt: state.now,
    music: { title: 'A real track', artist: 'The artist', album: 'The album', playing: true, source: 'gsmtc', cover: COVER,
      durationMs: 200000, positionMs: 50000, ...overrides } } });
  return { widget, listeners, saved, state, doc, capri, panel, chat, snapshot };
}

test('Spotify covers accept bounded local image data only, never remote URLs or SVG markup', async () => {
  const { spotifyCover } = await ready;
  assert.equal(spotifyCover(COVER), COVER);
  for (const value of ['https://example.com/cover.jpg', 'file:///secret', 'data:image/svg+xml;base64,PHN2Zz4=',
    'data:image/png;base64,AAA\" onerror=alert(1)', `data:image/png;base64,${'A'.repeat(40000)}`, {}, null]) {
    assert.equal(spotifyCover(value), null);
  }
});

test('progress follows real playback, freezes on pause, clamps at duration and bounds stale extrapolation', async () => {
  const { spotifyProgress } = await ready;
  const song = { durationMs: 200000, positionMs: 50000, playing: true };
  assert.equal(spotifyProgress(song, 100000, 105000).position, 55000);
  assert.equal(spotifyProgress({ ...song, playing: false }, 100000, 105000).position, 50000);
  assert.equal(spotifyProgress(song, 100000, 9999999).position, 65000);
  assert.equal(spotifyProgress({ ...song, positionMs: 199000 }, 100000, 105000).fraction, 1);
  assert.equal(spotifyProgress({ ...song, durationMs: null }, 100000), null);
  assert.equal(spotifyProgress({ ...song, positionMs: -1 }, 100000), null);
});

test('card moves beside Capri and stays within the visible desktop including taskbar floor', async () => {
  const { spotifyPlacement } = await ready;
  for (const head of [{ x: 0, y: 0 }, { x: 998, y: 698 }, { x: 500, y: 350 }]) {
    const at = spotifyPlacement(head, { w: 1000, h: 700 });
    assert.ok(at.x >= 10 && at.x + 244 <= 990);
    assert.ok(at.y >= 10 && at.y + 88 <= 690);
  }
  assert.ok(spotifyPlacement({ x: 998, y: 300 }, { w: 1000, h: 700 }).x < 998 - 244);
});

test('real metadata is rendered as literal text and local cover, with a separately switchable card', async () => {
  const f = await fixture();
  assert.equal(f.widget.el.hidden, true);
  f.snapshot({ title: '<img src=x onerror=alert(1)>', artist: 'Artist\nName' });
  assert.equal(f.widget.el.hidden, false);
  assert.equal(f.widget.title.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(f.widget.artist.textContent, 'Artist Name');
  assert.equal(f.widget.image.getAttribute('src'), COVER);
  assert.equal(f.widget.heading.textContent, 'SPOTIFY / ИГРАЕТ');
  assert.equal(f.widget.track.getAttribute('aria-valuenow'), '25');
  f.listeners.config({ spotifyReactions: false, spotifyWidget: true });
  assert.equal(f.widget.el.hidden, false, 'muting reactions does not hide the card');
  f.listeners.config({ spotifyWidget: false }); assert.equal(f.widget.el.hidden, true);
  f.listeners.config({ spotifyWidget: true }); assert.equal(f.widget.el.hidden, false);
  f.snapshot({ cover: 'https://example.com/art.jpg', playing: false });
  assert.equal(f.widget.image.hidden, true); assert.equal(f.widget.image.getAttribute('src'), null);
  assert.equal(f.widget.heading.textContent, 'SPOTIFY / ПАУЗА');
  f.listeners.context({ state: { available: true, music: null } });
  assert.equal(f.widget.el.hidden, true, 'no fake music when Spotify session ends');
  f.widget.dispose();
});

test('card avoids conversation and hidden pet, participates in hit testing, and close persists only its own toggle', async () => {
  const f = await fixture(); f.snapshot();
  assert.equal(f.widget.containsPoint(50, 60), true);
  assert.equal(f.widget.containsPoint(500, 600), false);
  for (const [object, name] of [[f.panel, 'visible'], [f.chat, 'open'], [f.capri, 'hidden'], [f.capri, 'stowed'], [f.capri, 'dormant'], [f.capri, 'dragging']]) {
    object[name] = true; f.listeners.tick();
    assert.equal(f.widget.el.hidden, true); assert.equal(f.widget.containsPoint(50, 60), false);
    object[name] = false; f.listeners.tick(); assert.equal(f.widget.el.hidden, false);
  }
  f.capri.mode = 'sleep'; f.listeners.tick();
  assert.equal(f.widget.el.hidden, true, 'sleep hides the card before the mask-only doze starts');
  assert.equal(f.widget.containsPoint(50, 60), false);
  f.capri.mode = 'idle'; f.listeners.tick(); assert.equal(f.widget.el.hidden, false);
  let stopped = false;
  const close = f.widget.el.children.find(el => el.tag === 'button');
  close.events.click[0]({ stopPropagation: () => { stopped = true; } });
  assert.equal(stopped, true); assert.equal(f.widget.el.hidden, true);
  assert.deepEqual(f.saved, [{ spotifyWidget: false }]);
  f.widget.dispose();
  assert.equal(f.state.removed, 2); assert.equal(f.state.cleared, true);
  assert.equal(f.widget.el.removed, true); assert.equal(f.widget.style.removed, true);
});

test('card stylesheet obeys existing CSP by using a local stylesheet link', async () => {
  const f = await fixture();
  assert.equal(f.widget.style.tag, 'link');
  assert.equal(f.widget.style.rel, 'stylesheet');
  assert.equal(f.widget.style.href, 'styles/companion-spotify-widget.css');
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/styles/companion-spotify-widget.css'), 'utf8');
  assert.ok(css.includes('.companion-spotify-widget'));
  assert.doesNotMatch(css, /url\(/);
  f.widget.dispose();
});
