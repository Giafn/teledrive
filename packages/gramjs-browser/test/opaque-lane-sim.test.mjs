import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_FRAME_BYTES, MAX_TRACE_ENTRIES, OpaqueLaneSim } from './support/opaque-lane-sim.mjs';

const open = (times = Array.from({ length: 300 }, (_, i) => i)) => {
  let i = 0; const sim = new OpaqueLaneSim({ nowMs: () => times[i++] ?? times.at(-1) });
  sim.prepare(); sim.activate(); return sim;
};
const frozenTree = value => { assert.ok(Object.isFrozen(value)); if (value && typeof value === 'object') Object.values(value).forEach(frozenTree); };
const late = sim => { const before = JSON.stringify(sim.trace()); for (const name of ['prepare', 'activate', 'offer', 'feed', 'tick']) assert.throws(() => sim[name](name === 'offer' || name === 'feed' ? Uint8Array.of(1) : undefined)); assert.equal(JSON.stringify(sim.trace()), before); };

test('happy lifecycle exposes frozen redacted values', () => {
  const sim = open(); sim.offer(Uint8Array.of(1, 2)); sim.feed(Uint8Array.of(3, 4));
  assert.deepEqual([...sim.take()], [3, 4]); assert.deepEqual(sim.accept(), { result: 'accepted' }); sim.finish();
  frozenTree(sim.snapshot()); frozenTree(sim.trace()); assert.equal(/token|frame|opaque|url|host|port/iu.test(JSON.stringify({ snapshot: sim.snapshot(), trace: sim.trace() })), false);
});
test('FIFO acceptance drains queued values head first without exposing identity', () => {
  const sim = open(); sim.offer(Uint8Array.of(1)); sim.offer(Uint8Array.of(2, 3));
  assert.deepEqual([sim.snapshot().outboundCount, sim.snapshot().outboundBytes, sim.snapshot().pending], [2, 3, true]);
  sim.accept(); assert.deepEqual([sim.snapshot().outboundCount, sim.snapshot().outboundBytes, sim.snapshot().pending], [1, 2, false]);
  sim.pressureOff(); assert.equal(sim.snapshot().pending, true);
  sim.accept(); assert.deepEqual([sim.snapshot().outboundCount, sim.snapshot().outboundBytes, sim.snapshot().pending], [0, 0, false]);
  sim.pressureOn(); assert.deepEqual(sim.offer(Uint8Array.of(4)), { result: 'pressure' });
  assert.equal(sim.snapshot().outboundCount, 0);
});
test('input and output copies are isolated', () => {
  const sim = open(); const input = Uint8Array.of(4, 5); sim.feed(input); input[0] = 9; const got = sim.take(); got[1] = 9;
  sim.feed(Uint8Array.of(4, 5)); assert.deepEqual([...sim.take()], [4, 5]);
});
test('invalid input and capacity failure clear reducer state', () => {
  for (const value of [new Uint8Array(), new Uint8Array(MAX_FRAME_BYTES + 1)]) { const sim = open(); assert.throws(() => sim.offer(value)); assert.equal(sim.snapshot().state, 'broken'); assert.equal(sim.snapshot().outboundCount, 0); }
});
test('clock failure, stop, break, and late events stay terminal', () => {
  const sim = open([1, 2, 0]); assert.throws(() => sim.tick()); assert.equal(sim.snapshot().state, 'broken'); late(sim);
  for (const action of ['stop', 'break']) { const x = open(); x.offer(Uint8Array.of(1)); if (action === 'break') assert.throws(() => x.break()); else x.stop(); assert.equal(x.snapshot().state, action === 'stop' ? 'stopped' : 'broken'); assert.equal(x.snapshot().outboundCount, 0); late(x); }
});
test('trace remains bounded and no automatic acceptance occurs', () => { const sim = open(); sim.offer(Uint8Array.of(1)); assert.equal(sim.snapshot().inFlight, true); for (let i = 0; i < 140; i++) sim.tick(); assert.equal(sim.trace().length, MAX_TRACE_ENTRIES); assert.equal(sim.trace().every(Object.isFrozen), true); });
