'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveDisplay, pinPatch, mayMove } = require('../src/main/companion-displays');

const primary = { id: 10, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
const left = { id: 20, bounds: { x: -2560, y: 0, width: 2560, height: 1440 } };

test('choosing a monitor also disables cursor following', () => {
  assert.deepEqual(pinPatch([primary, left], 20), { displayId: 20, follow: false });
  assert.deepEqual(pinPatch([primary], 10), { displayId: 10, follow: false });
  assert.equal(pinPatch([primary], 20), null);
  assert.equal(pinPatch([primary], '10'), null);
});

test('a pinned monitor temporarily falls back and returns without changing the saved ID', () => {
  const cfg = { displayId: 20, follow: false };
  assert.equal(resolveDisplay([primary, left], 10, cfg.displayId), left);
  assert.equal(resolveDisplay([primary], 10, cfg.displayId), primary);
  assert.equal(mayMove(cfg, [primary], 10, 10), true);
  assert.equal(resolveDisplay([primary, left], 10, cfg.displayId), left);
  assert.equal(cfg.displayId, 20);
});

test('pinning blocks queued following, wandering and drag moves to another monitor', () => {
  const cfg = { displayId: 20, follow: false };
  assert.equal(mayMove(cfg, [primary, left], 10, 10), false);
  assert.equal(mayMove(cfg, [primary, left], 10, 20), true);
  assert.equal(mayMove({ ...cfg, follow: true }, [primary, left], 10, 10), true);
  assert.equal(mayMove({ ...cfg, follow: true }, [primary, left], 10, 999), false);
});

test('unset and unavailable display IDs resolve safely, including development displays', () => {
  assert.equal(resolveDisplay([primary, left], 10, null), primary);
  assert.equal(resolveDisplay([left], 10, 999), left);
  assert.equal(resolveDisplay([], 10, 20), null);
  assert.equal(resolveDisplay([{ id: 101 }, { id: 102 }], 10, 102).id, 102);
});
