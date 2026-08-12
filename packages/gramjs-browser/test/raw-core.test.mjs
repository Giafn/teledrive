import assert from 'node:assert/strict';
import test from 'node:test';
import { ByteWriter, ByteReader, BYTE_WRITER_MAX } from '../src/raw-core/bytes.ts';
import { RawCoreError, RAW_CORE_ERROR_CODES } from '../src/raw-core/errors.ts';
import { MessageIdAllocator, MAX_OPEN_RESERVATIONS } from '../src/raw-core/message-id.ts';
import { normalizeSaltWindows, selectSalt } from '../src/raw-core/salt.ts';
import { Session } from '../src/raw-core/session.ts';

test('raw core bytes and errors', () => {
  const w = new ByteWriter();
  w.int32(-2147483648).int32(2147483647).int64(-(2n ** 63n)).int64(2n ** 63n - 1n);
  const b = w.finish();
  const r = new ByteReader(b);
  assert.equal(r.int32(), -2147483648);
  assert.equal(r.int32(), 2147483647);
  assert.equal(r.int64(), -(2n ** 63n));
  assert.equal(r.int64(), 2n ** 63n - 1n);
  r.finish();
  assert.throws(() => new ByteWriter().int32(2147483648));
  assert.throws(() => new ByteReader(new Uint8Array([1])).int32());
  assert.throws(() => new ByteReader(new Uint8Array([1, 2, 3, 4, 5])).finish());
  assert.deepEqual(RAW_CORE_ERROR_CODES, ['cancelled', 'invalid-input', 'random-unavailable', 'unsupported-capability', 'malformed-frame', 'integrity-failure', 'replay-or-sequence-failure', 'clock-invalid', 'rsa-key-untrusted', 'pq-or-dh-invalid', 'auth-rejected', 'salt-invalid', 'resource-limit', 'transport-closed']);
  assert.equal(new RawCoreError('cancelled').code, 'cancelled');
});

test('message IDs, salts, session clones', () => {
  let now = 10;
  const a = new MessageIdAllocator({ nowMs: () => now });
  const x = a.next();
  const y = a.next();
  assert.equal(y % 4n, 0n);
  now = 1;
  assert.ok(a.next() > y);
  const r = a.reserve(true);
  assert.equal(r.seqno, 1n);
  a.commit(r.id);
  assert.throws(() => a.commit(r.id), /replay/);
  const windows = normalizeSaltWindows([{ value: 1n, validSince: 0, validUntil: 10 }]);
  assert.equal(selectSalt(windows, 2).value, 1n);
  assert.throws(() => selectSalt(windows, 10), /salt/);
  const s = new Session(), key = new Uint8Array(256), id = new Uint8Array(8);
  s.replace({ key, keyId: id, dcId: 1, serverSalt: 2n, sessionId: 3n, msgId: 4n, sequence: 0 });
  const out = s.read();
  out.key[0] = 9;
  assert.equal(s.read().key[0], 0);
  s.clear();
  assert.throws(() => s.read(), /invalid/);
});

test('byte fixed values, limits, bounds, and isolation', () => {
  const input = new Uint8Array([1, 2, 3]);
  const writer = new ByteWriter(3);
  writer.fixed(input, 3);
  input[0] = 9;
  assert.deepEqual(writer.finish(), new Uint8Array([1, 2, 3]));
  for (const [value, size] of [[input, 2], [input, -1], [[1], 1], [input, 1.5]]) {
    assert.throws(() => new ByteWriter().fixed(value, size));
  }
  assert.throws(() => new ByteWriter(3).int32(1), /resource limit/);
  assert.throws(() => new ByteReader(new Uint8Array([1])).fixed(2), /truncated/);
  assert.throws(() => new ByteReader(new Uint8Array()).fixed(-1), RangeError);
  assert.throws(() => new ByteReader(new Uint8Array()).fixed(1.5), RangeError);
  const bytes = new Uint8Array([4, 5]);
  const reader = new ByteReader(bytes);
  bytes[0] = 8;
  assert.deepEqual(reader.fixed(2), new Uint8Array([4, 5]));
  assert.throws(() => new ByteWriter().int32(2147483648), RangeError);
  assert.throws(() => new ByteWriter().int32(-2147483649), RangeError);
  assert.throws(() => new ByteWriter().int64(2n ** 63n), RangeError);
  assert.throws(() => new ByteWriter().int64(-(2n ** 63n) - 1n), RangeError);
  assert.throws(() => new ByteWriter(BYTE_WRITER_MAX + 1), /resource limit/);
});

test('message ID reservation, cancellation, clock, and monotonicity', () => {
  let now = 10;
  const allocator = new MessageIdAllocator({ nowMs: () => now });
  const nonContent = allocator.reserve(false);
  const content = allocator.reserve(true);
  const nextContent = allocator.reserve(true);
  assert.deepEqual([nonContent.seqno, content.seqno, nextContent.seqno], [0n, 1n, 3n]);
  allocator.commit(nonContent.id);
  allocator.commit(content.id);
  allocator.cancel(nextContent.id);
  const afterCancelNonContent = allocator.reserve(false);
  const afterCancelContent = allocator.reserve(true);
  assert.equal(afterCancelNonContent.seqno, 4n);
  assert.equal(afterCancelContent.seqno, 3n);
  assert.throws(() => allocator.commit(nextContent.id), /replay/);
  assert.throws(() => allocator.cancel(nextContent.id), /replay/);
  assert.throws(() => allocator.cancel(content.id), /replay/);
  const older = allocator.reserve(true);
  const newer = allocator.reserve(true);
  assert.throws(() => allocator.cancel(older.id), /replay/);
  allocator.cancel(newer.id);
  allocator.cancel(older.id);
  assert.equal(allocator.reserve(true).seqno, older.seqno);
  now = 1;
  const previous = allocator.next();
  assert.equal(allocator.next(), previous + 4n);
  for (const invalid of [() => 1.5, () => -1]) {
    assert.throws(() => new MessageIdAllocator({ nowMs: invalid }).next(), /clock/);
  }
  assert.throws(() => new MessageIdAllocator({ nowMs: () => 2 ** 31 }).next(), /clock-invalid/);
  const capped = new MessageIdAllocator({ nowMs: () => 10 });
  for (let i = 0; i < MAX_OPEN_RESERVATIONS; i++) capped.reserve(false);
  assert.throws(() => capped.reserve(false), /resource-limit/);
});

test('salt windows validate, normalize, isolate, and select boundaries', () => {
  const input = [
    { value: 2n, validSince: 10, validUntil: 20 },
    { value: 1n, validSince: 0, validUntil: 10 },
  ];
  const windows = normalizeSaltWindows(input);
  assert.deepEqual(windows.map(w => w.value), [1n, 2n]);
  input[0].validSince = 100;
  input.push({ value: 3n, validSince: 20, validUntil: 30 });
  assert.equal(selectSalt(windows, 0).value, 1n);
  assert.equal(selectSalt(windows, 10).value, 2n);
  assert.throws(() => selectSalt(windows, 20), /salt-invalid/);
  assert.throws(() => selectSalt(windows, -1), /clock-invalid/);
  assert.throws(() => selectSalt(windows, 1.5), /clock-invalid/);
  for (const bad of [
    [{ value: 1n, validSince: 0, validUntil: 2 }, { value: 2n, validSince: 1, validUntil: 3 }],
    [{ value: 2n ** 63n, validSince: 0, validUntil: 1 }],
    [{ value: 1n, validSince: 0.5, validUntil: 1 }],
    [{ value: 1n, validSince: -1, validUntil: 1 }],
    [{ value: 1n, validSince: 2, validUntil: 2 }],
    [],
    null,
  ]) assert.throws(() => normalizeSaltWindows(bad), /salt-invalid/);
  assert.throws(() => normalizeSaltWindows(input), /salt-invalid/);
  assert.throws(() => { windows[0].validSince = 4; }, TypeError);
  const selected = selectSalt(windows, 5);
  assert.throws(() => { selected.value = 9n; }, TypeError);
  assert.equal(selectSalt(windows, 5).value, 1n);
  for (const bad of [[null], [1]]) assert.throws(() => normalizeSaltWindows(bad), /salt-invalid/);
  assert.throws(() => selectSalt([null], 0), /salt-invalid/);
  assert.equal(selectSalt([
    { value: 2n, validSince: 10, validUntil: 20 },
    { value: 1n, validSince: 0, validUntil: 10 },
  ], 15).value, 2n);
});

test('session validates, isolates, wipes, and clears safely', () => {
  const valid = () => ({ key: new Uint8Array(256), keyId: new Uint8Array(8), dcId: 1, serverSalt: 2n, sessionId: 3n, msgId: 4n, sequence: 0 });
  const session = new Session();
  for (const change of [
    s => { s.key = new Uint8Array(255); }, s => { s.keyId = new Uint8Array(7); },
    s => { s.dcId = 0; }, s => { s.dcId = 1.5; }, s => { s.serverSalt = 2n ** 63n; },
    s => { s.sessionId = -(2n ** 63n) - 1n; }, s => { s.msgId = 3n; },
    s => { s.sequence = -1; }, s => { s.key = []; }, s => { s.keyId = []; },
    s => { s.dcId = 2147483648; }, s => { s.sequence = 2147483648; },
  ]) { const state = valid(); change(state); assert.throws(() => session.replace(state), /invalid/); }
  for (const bad of [null, 1]) assert.throws(() => session.replace(bad), /invalid/);
  const state = valid();
  session.replace(state);
  state.key[0] = 7; state.keyId[0] = 7;
  assert.deepEqual([session.read().key[0], session.read().keyId[0]], [0, 0]);
  const exposed = session.read(); exposed.key[0] = 8; exposed.keyId[0] = 8;
  assert.deepEqual([session.read().key[0], session.read().keyId[0]], [0, 0]);
  const wiped = session.clearAndExposeWipedForTest();
  assert.equal(wiped.key.length, 256); assert.equal(wiped.keyId.length, 8);
  assert.ok(wiped.key.every(byte => byte === 0)); assert.ok(wiped.keyId.every(byte => byte === 0));
  assert.throws(() => session.read(), /invalid/);
  session.clear(); session.clear();
  assert.equal(session.clearAndExposeWipedForTest(), undefined);
});

test('raw core error codes reject unknown values', () => {
  for (const code of RAW_CORE_ERROR_CODES) assert.equal(new RawCoreError(code).code, code);
  assert.throws(() => new RawCoreError('bogus'), /invalid/);
});
