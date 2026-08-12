import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { AuthSimulator, AuthState } from '../src/raw-core/auth-sim.ts';
import { RawCoreError } from '../src/raw-core/errors.ts';

const n = Uint8Array.from({ length: 16 }, (_, i) => i);
const sn = Uint8Array.from({ length: 16 }, (_, i) => 15 - i);
const opaque = Uint8Array.of(1, 2, 3);
const input = (extra = {}) => ({ nonce: n, serverNonce: sn, ...extra });
function sim({ times = [1, 2, 3, 4, 5, 6], random = n, transcript = {} } = {}) {
  let i = 0;
  return new AuthSimulator({ clock: { nowMs: () => times[i++] ?? times.at(-1) }, random: { take: () => random }, transcript: { expect: (label, bytes) => transcript[label] ?? bytes } });
}
function pathToDh(s) {
  s.start(); s.receiveResPq(input({ fingerprints: ['synthetic-fp-a'] }));
  s.submitDhParams(input({ fingerprint: 'synthetic-fp-a', encryptedData: opaque }));
  s.receiveDhParamsOk(input({ encryptedAnswer: opaque })); s.submitClientDh(input({ encryptedData: opaque }));
}
function error(code, fn) { assert.throws(fn, (e) => e instanceof RawCoreError && e.code === code); }

const FIXTURE_KEYS = ['events', 'fingerprints', 'kind', 'nonce', 'notLive', 'serverNonce', 'source'];
const FIXTURE_EVENTS = ['start', 'receiveResPq', 'submitDhParams', 'receiveDhParamsOk', 'submitClientDh', 'receiveDhGen'];
const LIVE_MARKER = /\b(?:telegram|url|https?|wss?|api[_-]?(?:id|hash)|phone|otp|password|endpoint|dc(?:[_-]?\d+)?)\b/iu;

function validateFixture(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(FIXTURE_KEYS))
    throw new TypeError('invalid fixture schema');
  const values = (input) => {
    if (typeof input === 'string') { if (LIVE_MARKER.test(input)) throw new TypeError('forbidden live marker'); return; }
    if (Array.isArray(input)) { for (const item of input) values(item); return; }
    if (input && typeof input === 'object') for (const item of Object.values(input)) values(item);
  };
  values(value);
  if (value.kind !== 'synthetic-mtproto-auth-sim-v1' || value.notLive !== true || value.source !== 'project-authored')
    throw new TypeError('invalid fixture provenance');
  for (const key of ['nonce', 'serverNonce']) if (typeof value[key] !== 'string' || !/^[0-9a-f]{32}$/.test(value[key])) throw new TypeError(`invalid ${key}`);
  if (!Array.isArray(value.fingerprints) || value.fingerprints.some((fingerprint) => typeof fingerprint !== 'string' || !/^synthetic-fp-[a-z0-9-]+$/.test(fingerprint)))
    throw new TypeError('invalid fingerprints');
  if (!Array.isArray(value.events) || JSON.stringify(value.events) !== JSON.stringify(FIXTURE_EVENTS)) throw new TypeError('invalid events');
  return value;
}

test('happy synthetic path has frozen trace and opaque snapshot', () => {
  const s = sim(); pathToDh(s); s.receiveDhGen(input({ kind: 'ok', hash: opaque }));
  assert.equal(s.state, AuthState.established); assert.ok(Object.isFrozen(s.snapshot())); assert.ok(Object.isFrozen(s.trace()));
  assert.deepEqual(s.trace().map(({ from, event, to, atMs }) => ({ from, event, to, atMs })), [
    { from: 'idle', event: 'start', to: 'pq-requested', atMs: 1 }, { from: 'pq-requested', event: 'receiveResPq', to: 'pq-received', atMs: 2 },
    { from: 'pq-received', event: 'submitDhParams', to: 'dh-requested', atMs: 3 }, { from: 'dh-requested', event: 'receiveDhParamsOk', to: 'dh-received', atMs: 4 },
    { from: 'dh-received', event: 'submitClientDh', to: 'client-dh-requested', atMs: 5 }, { from: 'client-dh-requested', event: 'receiveDhGen', to: 'established', atMs: 6 },
  ]);
  assert.deepEqual(s.snapshot(), { state: 'established' }); assert.equal(JSON.stringify(s.trace()).includes('nonce'), false);
});

test('invalid order and identity fail closed', () => {
  const s = sim(); error('invalid-input', () => s.receiveResPq(input({ fingerprints: ['synthetic-fp-a'] }))); assert.equal(s.state, 'failed'); error('transport-closed', () => s.start());
  const x = sim(); x.start(); error('auth-rejected', () => x.receiveResPq(input({ nonce: Uint8Array.from({ length: 16 }, () => 99), fingerprints: ['synthetic-fp-a'] }))); assert.equal(x.state, 'failed');
});

test('shape, opaque, clock, random, transcript, retry and cancel reject', () => {
  error('random-unavailable', () => sim({ random: new Uint8Array(15) }).start());
  const clock = sim({ times: [2, 1] }); clock.start(); error('clock-invalid', () => clock.receiveResPq(input({ fingerprints: ['synthetic-fp-a'] })));
  const bad = sim({ transcript: { start: Uint8Array.of(1) } }); error('auth-rejected', () => bad.start());
  const malformed = sim(); malformed.start(); error('invalid-input', () => malformed.receiveResPq(input({ fingerprints: ['live'] }))); 
  for (const kind of ['retry', 'fail']) { const x = sim(); pathToDh(x); error('auth-rejected', () => x.receiveDhGen(input({ kind, hash: opaque }))); error('transport-closed', () => x.cancel()); }
  for (let i = 0; i < 5; i++) { const x = sim(); if (i) pathToDh(x); if (i === 0) x.start(); x.cancel(); error('transport-closed', () => x.start()); }
});

test('fixture is synthetic, strict, and hex-shaped', async () => {
  const fixture = validateFixture(JSON.parse(await readFile(new URL('./fixtures/auth-sim/happy.json', import.meta.url), 'utf8')));
  for (const [field, value] of [['kind', 'wrong'], ['notLive', false], ['source', 'live'], ['nonce', '0'.repeat(31)], ['serverNonce', 'G'.repeat(32)], ['fingerprints', ['live']], ['events', ['start']], ['unknown', true]])
    assert.throws(() => validateFixture({ ...fixture, [field]: value }), /invalid|forbidden/);
  for (const marker of ['telegram', 'https://live.test', 'ws://live.test', 'api_id', 'api_hash', 'phone', 'otp', 'password', 'endpoint', 'dc2'])
    assert.throws(() => validateFixture({ ...fixture, source: marker }), /forbidden live marker/);
  assert.throws(() => validateFixture({ ...fixture, fingerprints: ['synthetic-fp-INVALID_'] }), /invalid fingerprints/);
});
