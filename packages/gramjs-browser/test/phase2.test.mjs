import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  LOGICAL_PART_BYTES,
  MAX_OBJECT_BYTES,
  PROTOCOL_CHUNK_BYTES,
  createAttemptIdentity,
  createAttemptSnapshot,
  createGuardedByteSource,
  createDocumentFileDescriptor,
  decideRetry,
  evaluateFileReference,
  normalizeTransferConfig,
  planUpload,
  validateSmallFilePartMd5,
} from '../src/index.ts';
import { assertBrowserGraph } from '../scripts/assert-browser-graph.mjs';
import { assertNonProductionScope } from '../scripts/assert-nonproduction-scope.mjs';

function config(source = 'mock', defaultCap = 128) {
  return normalizeTransferConfig({
    source,
    uploadMaxFilePartsDefault: defaultCap,
    uploadMaxFilePartsPremium: defaultCap + 1,
    smallQueueMaxActiveOperations: 1,
    largeQueueMaxActiveOperations: 1,
    fetchedAt: '2026-08-11T00:00:00.000Z',
    schemaVersion: 'layer-198-fixture',
  });
}

function spans(plan) {
  return plan.parts.flatMap((part) => [...part.protocolChunks()]);
}

test('plans bounded logical documents and lazy protocol chunks without allocating objects', () => {
  const transferConfig = config();
  const oneByte = planUpload(1, transferConfig);
  assert.equal(oneByte.source, 'mock');
  assert.equal(oneByte.parts[0].uploadMode, 'saveFilePart');
  assert.equal(oneByte.parts[0].requiresMd5, true);
  assert.deepEqual(spans(oneByte).map((chunk) => chunk.sizeBytes), [1]);

  assert.equal(planUpload(10 * 1024 * 1024, transferConfig).parts[0].uploadMode, 'saveFilePart');
  assert.equal(planUpload(10 * 1024 * 1024 + 1, transferConfig).parts[0].uploadMode, 'saveBigFilePart');

  const exactLogicalPart = planUpload(LOGICAL_PART_BYTES, transferConfig);
  assert.equal(exactLogicalPart.parts[0].protocolChunkCount, 128);
  assert.equal(exactLogicalPart.parts[0].protocolChunks().next().value.sizeBytes, PROTOCOL_CHUNK_BYTES);

  const plusOne = planUpload(LOGICAL_PART_BYTES + 1, transferConfig);
  const chunks = spans(plusOne);
  assert.equal(plusOne.logicalPartCount, 2);
  assert.equal(chunks.length, 129);
  assert.equal(chunks.at(-1).sizeBytes, 1);
  let expectedOffset = 0;
  for (const chunk of chunks) {
    assert.equal(chunk.offsetBytes, expectedOffset);
    assert.ok(chunk.sizeBytes <= PROTOCOL_CHUNK_BYTES);
    expectedOffset += chunk.sizeBytes;
  }
  assert.equal(expectedOffset, LOGICAL_PART_BYTES + 1);

  const max = planUpload(MAX_OBJECT_BYTES, transferConfig);
  assert.equal(max.logicalPartCount, 160);
  assert.equal(max.parts.length, 160);
  assert.equal(max.parts.at(-1).protocolChunkCount, 128);
  assert.throws(() => planUpload(MAX_OBJECT_BYTES + 1, transferConfig), /object size/);
  assert.throws(() => planUpload(0, transferConfig), /object size/);
  assert.throws(() => planUpload(LOGICAL_PART_BYTES, config('mock', 127)), /protocol part cap/);

  const tiered = normalizeTransferConfig({
    source: 'mock',
    uploadMaxFilePartsDefault: 128,
    uploadMaxFilePartsPremium: 127,
    smallQueueMaxActiveOperations: 1,
    largeQueueMaxActiveOperations: 1,
    fetchedAt: '2026-08-11T00:00:00.000Z',
    schemaVersion: 'layer-198-fixture',
  });
  assert.equal(planUpload(LOGICAL_PART_BYTES, tiered, 'unknown').tier, 'default');
  assert.throws(() => planUpload(LOGICAL_PART_BYTES, tiered, 'premium'), /protocol part cap/);
  assert.match(JSON.stringify(planUpload(1, transferConfig)), /"source":"mock"/);
});

test('rejects malformed transfer configuration before planning', () => {
  const valid = {
    source: 'mock',
    uploadMaxFilePartsDefault: 128,
    uploadMaxFilePartsPremium: 128,
    smallQueueMaxActiveOperations: 1,
    largeQueueMaxActiveOperations: 1,
    fetchedAt: '2026-08-11T00:00:00.000Z',
    schemaVersion: 'layer-198-fixture',
  };
  for (const input of [
    { ...valid, source: 'unknown' },
    { ...valid, uploadMaxFilePartsDefault: 0 },
    { ...valid, uploadMaxFilePartsPremium: 1.5 },
    { ...valid, smallQueueMaxActiveOperations: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, fetchedAt: 'never' },
    { ...valid, schemaVersion: '' },
  ]) {
    assert.throws(() => normalizeTransferConfig(input), /invalid|positive safe integer/);
  }
});

test('guarded source accepts only one exact protocol-sized read at a time', async () => {
  let resolveFirst;
  const source = {
    sizeBytes: PROTOCOL_CHUNK_BYTES + 1,
    read(offset, length) {
      if (offset === 0) return new Promise((resolve) => (resolveFirst = () => resolve(new Uint8Array(length))));
      return Promise.resolve(new Uint8Array(length));
    },
  };
  const guarded = createGuardedByteSource(source);
  const first = guarded.read(0, 1);
  await assert.rejects(guarded.read(1, 1), /serial/);
  resolveFirst();
  assert.equal((await first).byteLength, 1);
  await assert.rejects(guarded.read(0, PROTOCOL_CHUNK_BYTES + 1), /exceeds protocol chunk/);
  await assert.rejects(guarded.read(source.sizeBytes, 1), /known size/);
  const wrongLength = createGuardedByteSource({ sizeBytes: 1, read: async () => new Uint8Array(0) });
  await assert.rejects(wrongLength.read(0, 1), /unexpected length/);
  assert.equal(validateSmallFilePartMd5('a'.repeat(32)), 'a'.repeat(32));
  assert.throws(() => validateSmallFilePartMd5(''), /MD5/);
});

test('retry and file-reference policies preserve identity and fail closed', () => {
  const identity = createAttemptIdentity({
    fileId: 17n,
    randomId: -23n,
    filename: 'r'.repeat(22),
    logicalPartIndex: 3,
    planId: 'p'.repeat(16),
  });
  const snapshot = createAttemptSnapshot(identity, 2);
  const flood = decideRetry(snapshot, { kind: 'flood-wait', serverMinimumMs: 3000 });
  assert.equal(flood.kind, 'retry');
  assert.equal(flood.delayMs, 3000);
  assert.equal(flood.snapshot.identity, identity);
  assert.equal(Object.isFrozen(identity), true);
  for (const decision of [flood, decideRetry(snapshot, { kind: 'random-id-duplicate' })])
    assert.deepEqual(decision.snapshot.identity, { fileId: 17n, randomId: -23n, filename: 'r'.repeat(22), logicalPartIndex: 3, planId: 'p'.repeat(16) });
  assert.equal(decideRetry(snapshot, { kind: 'file-migration' }).kind, 'retry');
  assert.equal(decideRetry(snapshot, { kind: 'random-id-duplicate' }).kind, 'reconcile');
  assert.equal(decideRetry(snapshot, { kind: 'auth' }).kind, 'fail');
  assert.equal(decideRetry(snapshot, { kind: 'cancellation' }).kind, 'fail');
  const refresh = decideRetry(snapshot, { kind: 'file-reference-expired' });
  assert.equal(refresh.kind, 'refetch-file-reference');
  assert.equal(refresh.snapshot.retryCount, 0);
  assert.equal(refresh.snapshot.identity, identity);
  assert.deepEqual([...['fileId', 'randomId', 'filename'].map((key) => refresh.snapshot.identity[key])], [17n, -23n, 'r'.repeat(22)]);
  assert.equal(decideRetry(refresh.snapshot, { kind: 'file-reference-invalid' }).kind, 'fail');

  for (const value of [-(2n ** 63n) - 1n, 2n ** 63n])
    assert.throws(() => createAttemptIdentity({ fileId: value, randomId: 1n, filename: 'r'.repeat(22), logicalPartIndex: 0, planId: 'p' }), /64-bit/);

  const expected = { channelId: 'c', messageId: 'm', documentId: 'd' };
  assert.equal(evaluateFileReference(expected, { identity: expected, freshness: 'expired', refreshCount: 0 }).kind, 'refresh-once');
  assert.equal(evaluateFileReference(expected, { identity: expected, freshness: 'fresh', refreshCount: 1 }).kind, 'accepted');
  assert.equal(evaluateFileReference(expected, { identity: expected, freshness: 'expired', refreshCount: 1 }).kind, 'rejected');
  assert.equal(
    evaluateFileReference(expected, { identity: { ...expected, documentId: 'other' }, freshness: 'fresh', refreshCount: 0 }).kind,
    'rejected',
  );
});

test('final descriptors require whole-file MD5 only for small files', () => {
  assert.throws(() => createDocumentFileDescriptor({ fileId: 1n, parts: 1, sizeBytes: 1 }), /MD5/);
  assert.throws(() => createDocumentFileDescriptor({ fileId: 1n, parts: 1, sizeBytes: 1, wholeFileMd5: '' }), /MD5/);
  const md5 = '0123456789abcdef0123456789abcdef';
  assert.equal(createDocumentFileDescriptor({ fileId: 1n, parts: 1, sizeBytes: 10 * 1024 * 1024, wholeFileMd5: md5 }).md5Checksum, md5);
  assert.deepEqual(createDocumentFileDescriptor({ fileId: 2n, parts: 2, sizeBytes: 10 * 1024 * 1024 + 1 }), { kind: 'big', fileId: 2n, parts: 2 });
});

test('browser graph is pure planner source, not a live browser proof', async () => {
  const result = await assertBrowserGraph();
  assert.equal(result.liveBrowserProof, false);
  assert.equal(result.auditedFiles, result.files);
  assert.equal(result.rootReachableFiles, 5);
});

test('browser graph audits unreachable source files', async () => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'gramjs-browser-graph-'));
  try {
    await writeFile(path.join(sourceRoot, 'index.ts'), 'export const ok = true;\n');
    await writeFile(path.join(sourceRoot, 'hidden.ts'), 'eval("blocked");\n');
    await assert.rejects(assertBrowserGraph(sourceRoot), /forbidden browser\/runtime token/);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test('browser graph rejects unreachable generated-TL import', async () => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'gramjs-browser-graph-'));
  try {
    await writeFile(path.join(sourceRoot, 'index.ts'), 'export const ok = true;\n');
    await writeFile(path.join(sourceRoot, 'hidden.ts'), "import x from './tl/generated.ts';\n");
    await assert.rejects(assertBrowserGraph(sourceRoot), /forbidden import/);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test('browser graph rejects unreachable WebSocket source', async () => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'gramjs-browser-graph-'));
  try {
    await writeFile(path.join(sourceRoot, 'index.ts'), 'export const ok = true;\n');
    await writeFile(path.join(sourceRoot, 'hidden.ts'), 'WebSocket;\n');
    await assert.rejects(assertBrowserGraph(sourceRoot), /forbidden browser\/runtime token/);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test('browser graph rejects unreachable crypto source', async () => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'gramjs-browser-graph-'));
  try {
    await writeFile(path.join(sourceRoot, 'index.ts'), 'export const ok = true;\n');
    await writeFile(path.join(sourceRoot, 'hidden.ts'), 'crypto;\n');
    await assert.rejects(assertBrowserGraph(sourceRoot), /forbidden browser\/runtime token/);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test('browser graph rejects unreachable fetch source', async () => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'gramjs-browser-graph-'));
  try {
    await writeFile(path.join(sourceRoot, 'index.ts'), 'export const ok = true;\n');
    await writeFile(path.join(sourceRoot, 'hidden.ts'), 'fetch(x);\n');
    await assert.rejects(assertBrowserGraph(sourceRoot), /forbidden browser\/runtime token/);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

for (const [label, source, pattern] of [
  ['vendor import', "import x from './vendor.ts';", /forbidden import/],
  ['storage', 'localStorage.getItem("x");', /forbidden browser\/runtime token/],
  ['endpoint literal', 'const endpoint = "x";', /forbidden browser\/runtime token/],
  ['raw-core session import', "import x from './raw-core/session.ts';", /forbidden import/],
  ['raw-core auth import', "import x from './raw-core/auth.ts';", /forbidden import/],
  ['raw-core auth-sim import', "import x from './raw-core/auth-sim.ts';", /forbidden import/],
  ['raw-core salt import', "import x from './raw-core/salt.ts';", /forbidden import/],
  ['raw-core message-id import', "import x from './raw-core/message-id.ts';", /forbidden import/],
  ['dynamic import', "import('./raw-core/auth.ts');", /forbidden browser\/runtime token/],
  ['timer', 'setTimeout(() => {}, 0);', /forbidden browser\/runtime token/],
  ['socket', 'Socket;', /forbidden browser\/runtime token/],
  ['abridged framing', 'abridged;', /forbidden browser\/runtime token/],
  ['obfuscation', 'obfuscation;', /forbidden browser\/runtime token/],
  ['crc32', 'crc32;', /forbidden browser\/runtime token/],
  ['quickAck', 'quickAck;', /forbidden browser\/runtime token/],
  ['reconnect', 'reconnect;', /forbidden browser\/runtime token/],
  ['resend', 'resend;', /forbidden browser\/runtime token/],
  ['replay', 'replay;', /forbidden browser\/runtime token/],
  ['proxy', 'proxy;', /forbidden browser\/runtime token/],
  ['multiplexer', 'multiplexer;', /forbidden browser\/runtime token/],
]) {
  test(`browser graph rejects unreachable ${label}`, async () => {
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'gramjs-browser-graph-'));
    try {
      await writeFile(path.join(sourceRoot, 'index.ts'), 'export const ok = true;\n');
      await writeFile(path.join(sourceRoot, 'hidden.ts'), source);
      await assert.rejects(assertBrowserGraph(sourceRoot), pattern);
    } finally { await rm(sourceRoot, { recursive: true, force: true }); }
  });
}

test('production apps do not reference the private planner package', async () => {
  const result = await assertNonProductionScope();
  assert.equal(result.packageReferencedByProduction, false);
  assert.ok(result.checkedFiles > 0);
});
