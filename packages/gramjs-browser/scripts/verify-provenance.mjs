import { createHash } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_PACKAGE = 'telegram';
const EXPECTED_VERSION = '2.26.22';
const EXPECTED_TARBALL_URL = 'https://registry.npmjs.org/telegram/-/telegram-2.26.22.tgz';
const EXPECTED_INTEGRITY = 'sha512-EIj7Yrjiu0Yosa3FZ/7EyPg9s6UiTi/zDQrFmR/2Mg7pIUU+XjAit1n1u9OU9h2oRnRM5M+67/fxzQluZpaJJg==';
const EXPECTED_SHA1 = '16beb73e52403b5d5bcc4602226e39dc24217333';
const EXPECTED_REGISTRY_GIT_HEAD = '3aedb2e6ef216d307607f3d0f3f5b0ace6701378';
const EXPECTED_PUBLISH_TIMESTAMP = '2025-02-12T14:46:56.291Z';
const EXPECTED_AUDIT_TIMESTAMP = '2026-08-11T08:10:31.289Z';
const EXPECTED_GIT_HEAD_CAVEAT =
  'Registry-advertised metadata only; the public commit is unreachable and this tarball is not claimed equivalent to any GitHub commit or source tree.';
const EXPECTED_SOURCE_OF_TRUTH =
  'The immutable vendored npm tarball bytes and their independently verified hashes are source of truth for this Phase 1 baseline. The extracted vendor tree is verified file-by-file against that tarball; no generic source equivalence or GitHub commit equivalence is claimed.';
const EXPECTED_METADATA = Object.freeze({
  npmPackage: EXPECTED_PACKAGE,
  version: EXPECTED_VERSION,
  tarballUrl: EXPECTED_TARBALL_URL,
  integrity: EXPECTED_INTEGRITY,
  sha1: EXPECTED_SHA1,
  registryGitHead: EXPECTED_REGISTRY_GIT_HEAD,
  gitHeadCaveat: EXPECTED_GIT_HEAD_CAVEAT,
  sourceTimestamp: EXPECTED_PUBLISH_TIMESTAMP,
  auditTimestamp: EXPECTED_AUDIT_TIMESTAMP,
  sourceOfTruth: EXPECTED_SOURCE_OF_TRUTH,
});
const TAR_BLOCK_SIZE = 512;
const TAR_PACKAGE_ROOT = 'package';
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function fail(message) {
  throw new Error(`Provenance verification failed: ${message}`);
}

function requireExact(value, expected, field) {
  if (value !== expected) fail(`${field} is not pinned to the expected value`);
}

function requireFile(filePath, label) {
  return access(filePath).catch(() => fail(`${label} is missing`));
}

function hash(bytes, algorithm, encoding) {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes);
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function validateMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('UPSTREAM.json must contain an object');
  const expectedKeys = Object.keys(EXPECTED_METADATA).sort();
  const actualKeys = Object.keys(metadata).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) fail('UPSTREAM.json fields are not exactly pinned');
  for (const key of expectedKeys) requireExact(metadata[key], EXPECTED_METADATA[key], key);
}

function isZeroBlock(block) {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

function decodeTarField(field, label) {
  const nul = field.indexOf(0);
  const end = nul === -1 ? field.length : nul;
  if (nul !== -1) {
    for (let index = nul + 1; index < field.length; index += 1) {
      if (field[index] !== 0) fail(`tar ${label} has non-zero padding`);
    }
  }
  try {
    return UTF8.decode(field.subarray(0, end));
  } catch {
    fail(`tar ${label} is not valid UTF-8`);
  }
}

function parseTarNumber(field, label) {
  if (field[0] & 0x80) fail(`tar ${label} uses unsupported base-256 encoding`);
  const text = field.toString('ascii').replace(/\0.*$/u, '').trim();
  if (!/^[0-7]+$/u.test(text)) fail(`tar ${label} is not an octal number`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail(`tar ${label} is out of range`);
  return value;
}

function validateTarChecksum(header) {
  const stored = parseTarNumber(header.subarray(148, 156), 'checksum');
  let calculated = 0;
  for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
    calculated += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (stored !== calculated) fail('tar checksum mismatch');
}

function normalizeTarPath(name, prefix, type) {
  const raw = prefix ? `${prefix}/${name}` : name;
  if (raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:/u.test(raw)) fail('tar path is absolute');
  if (!raw.startsWith(`${TAR_PACKAGE_ROOT}/`) && raw !== TAR_PACKAGE_ROOT && !raw.startsWith(`${TAR_PACKAGE_ROOT}/`))
    fail('tar path is outside package root');
  let relative = raw === TAR_PACKAGE_ROOT ? '' : raw.slice(`${TAR_PACKAGE_ROOT}/`.length);
  if (type === '5' && relative.endsWith('/')) relative = relative.slice(0, -1);
  const parts = relative.split('/');
  if (relative && parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\')))
    fail('tar path contains empty, traversal, or backslash component');
  return parts.filter(Boolean).join('/');
}

function parseTar(tarball) {
  let archive;
  try {
    archive = gunzipSync(tarball);
  } catch {
    fail('tarball is not valid gzip');
  }
  const files = new Map();
  const directories = new Set();
  let offset = 0;
  let entries = 0;
  let ended = false;
  while (offset + TAR_BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (isZeroBlock(header)) {
      if (offset + TAR_BLOCK_SIZE * 2 > archive.length || !isZeroBlock(archive.subarray(offset + TAR_BLOCK_SIZE, offset + TAR_BLOCK_SIZE * 2)))
        fail('tar has incomplete end-of-archive marker');
      for (let index = offset + TAR_BLOCK_SIZE * 2; index < archive.length; index += 1) {
        if (archive[index] !== 0) fail('tar has non-zero data after end-of-archive marker');
      }
      ended = true;
      break;
    }
    const magic = header.toString('ascii', 257, 263);
    const version = header.toString('ascii', 263, 265);
    if (magic !== 'ustar\0' || version !== '00') fail('tar format is unsupported; expected POSIX ustar 00');
    validateTarChecksum(header);
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    if (type !== '0' && type !== '5') fail(`tar entry type ${JSON.stringify(type)} is unsupported`);
    const name = decodeTarField(header.subarray(0, 100), 'name');
    const prefix = decodeTarField(header.subarray(345, 500), 'prefix');
    const relative = normalizeTarPath(name, prefix, type);
    const size = parseTarNumber(header.subarray(124, 136), 'size');
    const dataStart = offset + TAR_BLOCK_SIZE;
    const dataEnd = dataStart + size;
    const paddedEnd = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    if (dataEnd > archive.length || paddedEnd > archive.length) fail('tar entry is truncated');
    if (!relative) {
      if (type !== '5' || size !== 0) fail('tar package root entry is invalid');
    } else if (type === '5') {
      if (size !== 0 || files.has(relative) || directories.has(relative)) fail('tar directory entry is invalid or duplicated');
      directories.add(relative);
    } else {
      if (files.has(relative) || directories.has(relative)) fail(`tar entry ${relative} is duplicated`);
      files.set(relative, Buffer.from(archive.subarray(dataStart, dataEnd)));
    }
    entries += 1;
    offset = paddedEnd;
  }
  if (!ended) fail('tar is missing end-of-archive marker');
  if (entries === 0) fail('tar contains no entries');
  return { files, directories };
}

function addDirectoryParents(directories, relative) {
  const parts = relative.split('/');
  for (let length = parts.length - 1; length > 0; length -= 1) directories.add(parts.slice(0, length).join('/'));
}

function expectedTree(parsed) {
  const directories = new Set(parsed.directories);
  for (const file of parsed.files.keys()) addDirectoryParents(directories, file);
  for (const file of parsed.files.keys()) if (directories.has(file)) fail(`tar path is both file and directory: ${file}`);
  return { files: parsed.files, directories };
}

async function readExtractedTree(vendorRoot) {
  const files = new Map();
  const directories = new Set();
  async function visit(directory, relative) {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const childRelative = relative ? `${relative}/${child.name}` : child.name;
      const childPath = path.join(directory, child.name);
      if (child.isSymbolicLink()) fail(`extracted tree contains symlink: ${childRelative}`);
      if (child.isDirectory()) {
        directories.add(childRelative);
        await visit(childPath, childRelative);
      } else if (child.isFile()) {
        files.set(childRelative, await readFile(childPath));
      } else {
        fail(`extracted tree contains unsupported entry: ${childRelative}`);
      }
    }
  }
  await visit(vendorRoot, '');
  return { files, directories };
}

function compareSet(expected, actual, label) {
  const expectedValues = [...expected].sort();
  const actualValues = [...actual].sort();
  if (JSON.stringify(expectedValues) !== JSON.stringify(actualValues)) fail(`vendor tree mismatch: ${label} set differs`);
}

async function compareExtractedTree(vendorRoot, parsed) {
  const expected = expectedTree(parsed);
  const actual = await readExtractedTree(vendorRoot);
  compareSet(expected.files.keys(), actual.files.keys(), 'file');
  compareSet(expected.directories, actual.directories, 'directory');
  for (const [relative, expectedBytes] of expected.files) {
    const actualBytes = actual.files.get(relative);
    if (!actualBytes || !actualBytes.equals(expectedBytes)) fail(`vendor tree mismatch: file bytes differ for ${relative}`);
  }
}

export async function verifyProvenance(packageRoot = PACKAGE_ROOT) {
  const upstreamPath = path.join(packageRoot, 'UPSTREAM.json');
  const tarballPath = path.join(packageRoot, 'vendor', 'telegram-2.26.22.tgz');
  const vendorRoot = path.join(packageRoot, 'vendor', 'telegram-2.26.22');
  const vendorPackagePath = path.join(vendorRoot, 'package.json');
  const licensePath = path.join(vendorRoot, 'LICENSE');

  await Promise.all([
    requireFile(upstreamPath, 'UPSTREAM.json'),
    requireFile(tarballPath, 'vendored tarball'),
    requireFile(vendorPackagePath, 'vendored package.json'),
    requireFile(licensePath, 'vendored LICENSE'),
  ]);

  const metadata = parseJson(await readFile(upstreamPath, 'utf8'), 'UPSTREAM.json');
  validateMetadata(metadata);
  const vendorPackage = parseJson(await readFile(vendorPackagePath, 'utf8'), 'vendored package.json');
  requireExact(vendorPackage.name, EXPECTED_PACKAGE, 'vendored package name');
  requireExact(vendorPackage.version, EXPECTED_VERSION, 'vendored package version');
  const license = await readFile(licensePath, 'utf8');
  if (!license.includes('MIT License') || !license.includes('GramJS')) fail('vendored LICENSE is not the expected upstream MIT notice');

  const tarball = await readFile(tarballPath);
  const sha512 = hash(tarball, 'sha512', 'base64');
  const sha1 = hash(tarball, 'sha1', 'hex');
  requireExact(`sha512-${sha512}`, EXPECTED_INTEGRITY, 'tarball SHA-512 integrity');
  requireExact(sha1, EXPECTED_SHA1, 'tarball SHA-1');
  const parsed = parseTar(tarball);
  await compareExtractedTree(vendorRoot, parsed);

  return {
    package: EXPECTED_PACKAGE,
    version: EXPECTED_VERSION,
    tarballBytes: tarball.byteLength,
    sha512,
    sha1,
    treeFiles: parsed.files.size,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyProvenance()
    .then((result) => {
      console.log(JSON.stringify({ provenance: 'verified', ...result }));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'Provenance verification failed');
      process.exitCode = 1;
    });
}
