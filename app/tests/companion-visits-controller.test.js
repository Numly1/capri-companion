'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../src/main/companion-visits-controller');

function fixture() {
  let now = 1000, created = 0, stopped = 0, emit, settleJoin;
  let state = { listening: false, paired: false, inviteExpiresAt: null };
  const copied = [], states = [], calls = [];
  const controller = create({ now: () => now, clipboardWrite: code => copied.push(code), onState: value => states.push(value), createService({ onState }) {
    created++; emit = value => { state = { ...state, ...value }; onState(state); };
    return {
      getState: () => state, getOptions: () => ({ addresses: [], port: 47826 }),
      async invite(options) { calls.push(options); emit({ listening: true, paired: false, inviteExpiresAt: now + 600000 }); return { ok: true, code: 'capri1.TEST_SECRET', expiresAt: state.inviteExpiresAt }; },
      join(code, options) { calls.push([code, options]); return new Promise(resolve => { settleJoin = resolve; }); },
      async visit(pet) { calls.push(pet); return { ok: true }; },
      async returnHome() { calls.push('return'); return { ok: true }; },
      async stop() { stopped++; settleJoin?.({ ok: true }); emit({ listening: false, paired: false, inviteExpiresAt: null }); },
    };
  } });
  return { controller, copied, states, calls, emit: value => emit(value), advance: value => { now += value; }, counts: () => ({ created, stopped }) };
}
const invite = f => f.controller.action({ action: 'invite', address: '192.168.1.5', name: 'Капри' });

test('visits stay off until requested, and IPC rejects unsupported fields before creating a service', async () => {
  const f = fixture();
  assert.equal((await f.controller.action({ action: 'state' })).state.connection, 'off');
  for (const value of [null, [], { action: '__proto__' }, { action: 'invite', port: 1234 }, { action: 'join', code: 'x'.repeat(1025), name: 'Капри' }, { action: 'visit', name: 'x', mood: 'happy', facing: 1, scale: 999 }]) assert.equal((await f.controller.action(value)).ok, false);
  assert.equal(f.counts().created, 0);
});
test('only an explicit exact live invitation can be copied; snapshots contain no code', async () => {
  const f = fixture(); const issued = await invite(f);
  assert.equal(f.copied.length, 0);
  assert.equal((await f.controller.action({ action: 'copy', code: 'OTHER' })).ok, false);
  assert.equal((await f.controller.action({ action: 'copy', code: issued.code })).ok, true);
  assert.deepEqual(f.copied, [issued.code]);
  assert.doesNotMatch(JSON.stringify(f.states), /TEST_SECRET/);
  f.emit({ paired: true });
  assert.equal((await f.controller.action({ action: 'copy', code: issued.code })).ok, false);
});
test('expired and disconnected invitations cannot be copied; disconnect closes the listener', async () => {
  const f = fixture(), issued = await invite(f);
  f.advance(600001);
  assert.equal((await f.controller.action({ action: 'copy', code: issued.code })).ok, false);
  await f.controller.action({ action: 'disconnect' });
  assert.equal(f.counts().stopped, 1);
  assert.equal(f.controller.getState().connection, 'off');
  await invite(f); assert.equal(f.counts().created, 2);
});
test('disconnect cancels pending join immediately, ignores late state, and allows a fresh listener', async () => {
  const f = fixture();
  const pending = f.controller.action({ action: 'join', code: 'capri1.pending', name: 'Капри' });
  assert.equal((await invite(f)).ok, false);
  await f.controller.action({ action: 'disconnect' });
  assert.equal((await pending).ok, false);
  const count = f.states.length; f.emit({ paired: true, away: true });
  assert.equal(f.states.length, count);
  assert.equal(f.controller.getState().away, false);
  await invite(f); assert.equal(f.counts().created, 2);
});
test('return stays available during a pending connection and terminal stop rejects further requests', async () => {
  const f = fixture(); const pending = f.controller.action({ action: 'join', code: 'capri1.pending', name: 'Капри' });
  assert.equal((await f.controller.action({ action: 'return' })).ok, true);
  await f.controller.stop(); await pending;
  assert.equal((await invite(f)).ok, false);
  assert.equal(f.counts().created, 1);
});
