import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyProvenance } from '../scripts/verify-provenance.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'gramjs-browser-provenance-'));
  await cp(path.join(packageRoot, 'UPSTREAM.json'), path.join(root, 'UPSTREAM.json'));
  await cp(path.join(packageRoot, 'vendor'), path.join(root, 'vendor'), { recursive: true });
  return root;
}

async function withFixture(callback) {
  const root = await fixture();
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('verifies pinned tarball provenance and every extracted vendor file without importing vendor code', async () => {
  const result = await verifyProvenance(packageRoot);
  assert.equal(result.package, 'telegram');
  assert.equal(result.version, '2.26.22');
  assert.equal(result.treeFiles, 226);
  assert.equal(result.sha1, '16beb73e52403b5d5bcc4602226e39dc24217333');
  assert.equal(result.sha512, 'EIj7Yrjiu0Yosa3FZ/7EyPg9s6UiTi/zDQrFmR/2Mg7pIUU+XjAit1n1u9OU9h2oRnRM5M+67/fxzQluZpaJJg==');
  assert.match(await readFile(path.join(packageRoot, 'vendor', 'telegram-2.26.22', 'LICENSE'), 'utf8'), /MIT License/);
});

test('rejects changed UPSTREAM hash and registry metadata', async () => {
  const mutations = [
    ['integrity', (metadata) => { metadata.integrity = `sha512-${'A'.repeat(86)}==`; }, /integrity is not pinned/],
    ['registry gitHead', (metadata) => { metadata.registryGitHead = 'unsupported-commit-claim'; }, /registryGitHead is not pinned/],
    ['publish timestamp', (metadata) => { metadata.sourceTimestamp = '2025-02-12T14:46:56.292Z'; }, /sourceTimestamp is not pinned/],
  ];
  for (const [, mutate, expectedError] of mutations) {
    await withFixture(async (root) => {
      const upstreamPath = path.join(root, 'UPSTREAM.json');
      const metadata = JSON.parse(await readFile(upstreamPath, 'utf8'));
      mutate(metadata);
      await writeFile(upstreamPath, `${JSON.stringify(metadata)}\n`);
      await assert.rejects(verifyProvenance(root), expectedError);
    });
  }
});

test('rejects changed tarball bytes before archive comparison', async () => {
  await withFixture(async (root) => {
    const tarballPath = path.join(root, 'vendor', 'telegram-2.26.22.tgz');
    const tarball = Buffer.from(await readFile(tarballPath));
    tarball[tarball.length - 1] ^= 1;
    await writeFile(tarballPath, tarball);
    await assert.rejects(verifyProvenance(root), /tarball SHA-512 integrity/);
  });
});

test('rejects added, removed, and changed extracted tree files without touching repository vendor', async () => {
  const mutations = [
    ['added', async (root) => writeFile(path.join(root, 'vendor', 'telegram-2.26.22', 'added-by-test.js'), 'unexpected'), /vendor tree mismatch/],
    ['removed', async (root) => unlink(path.join(root, 'vendor', 'telegram-2.26.22', 'Version.js')), /vendor tree mismatch/],
    ['changed', async (root) => {
      const file = path.join(root, 'vendor', 'telegram-2.26.22', 'Version.js');
      await writeFile(file, Buffer.concat([await readFile(file), Buffer.from('\nchanged-by-test\n')]));
    }, /vendor tree mismatch/],
  ];
  for (const [, mutate, expectedError] of mutations) {
    await withFixture(async (root) => {
      await mutate(root);
      await assert.rejects(verifyProvenance(root), expectedError);
    });
  }
});
