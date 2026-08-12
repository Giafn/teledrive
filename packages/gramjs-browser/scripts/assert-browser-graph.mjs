import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = path.join(PACKAGE_ROOT, 'src');
const STATIC_IMPORT = /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gu;
const FORBIDDEN_IMPORT = /(?:vendor|telegram|alias|polyfill|shim|stub|fallback)/iu;
const FORBIDDEN_BOUNDARY_IMPORT = /(?:^|\/)(?:session|auth|auth-sim|salt|message-id|abridged|intermediate|padded|obfuscation|crc32|quickAck|quick_ack)(?:\/|\.ts$|$)/u;
const FORBIDDEN_SOURCE = [
  /(?<!\.)\b(?:node:|fs|path|os|crypto|net|tls|http|https|stream|buffer|process|require)\b/iu,
  /\b(?:fetch\s*\(|WebSocket|XMLHttpRequest|EventSource|BroadcastChannel|Worker|SharedWorker|navigator|location)\b/u,
  /\b(?:setTimeout|setInterval|clearTimeout|clearInterval|requestAnimationFrame|queueMicrotask|Socket|TCPSocket|UDPSocket|abridged|intermediate|padded|obfuscation|crc32|quickAck|quick_ack)\b/u,
  /\bimport\s*\(/u,
  /(?<![\w-])(?:reconnect|resend|replay|proxy|multiplexer)(?![\w-])/iu,
  /\b(?:indexedDB|localStorage|sessionStorage|CacheStorage|caches|Storage)\b/u,
  /\beval\s*\(/u,
  /\bnew\s+Function\b/u,
  /\b(?:url|uri|host|hostname|domain|endpoint)\b\s*[:=]\s*['"]/iu,
  /(?:https?:\/\/|wss?:\/\/)/iu,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/u,
  /\b(?:endpoint|host|port|dc)\b/iu,
];

function fail(message) {
  throw new Error(`Browser source graph rejected: ${message}`);
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(entryPath)));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(entryPath);
    else if (!entry.isDirectory()) fail(`unsupported source entry ${path.relative(SOURCE_ROOT, entryPath)}`);
  }
  return files;
}

function resolveRelative(from, specifier, sourceRoot) {
  const resolved = path.resolve(path.dirname(from), specifier);
  if (!resolved.startsWith(`${sourceRoot}${path.sep}`)) fail(`relative import escapes src: ${specifier}`);
  if (!resolved.endsWith('.ts')) fail(`source import must pin .ts extension: ${specifier}`);
  return resolved;
}

export async function assertBrowserGraph(sourceRoot = SOURCE_ROOT) {
  const files = await sourceFiles(sourceRoot);
  const fileSet = new Set(files);
  const imports = new Map();
  for (const filePath of files) {
    const source = await readFile(filePath, 'utf8');
    for (const pattern of FORBIDDEN_SOURCE) if (pattern.test(source)) fail(`forbidden browser/runtime token in ${path.relative(sourceRoot, filePath)}`);
    const fileImports = [];
    STATIC_IMPORT.lastIndex = 0;
    for (const match of source.matchAll(STATIC_IMPORT)) {
      const specifier = match[1];
      if (FORBIDDEN_IMPORT.test(specifier) || FORBIDDEN_BOUNDARY_IMPORT.test(specifier) || (specifier.startsWith('.') && specifier.split('/').includes('tl'))) fail(`forbidden import ${specifier}`);
      if (!specifier.startsWith('.')) fail(`external import ${specifier}`);
      const importedFile = resolveRelative(filePath, specifier, sourceRoot);
      if (!fileSet.has(importedFile)) fail(`imported source is missing: ${path.relative(sourceRoot, importedFile)}`);
      fileImports.push(importedFile);
    }
    imports.set(filePath, fileImports);
  }
  const visited = new Set();
  function visit(filePath) {
    if (visited.has(filePath)) return;
    if (!fileSet.has(filePath)) fail(`imported source is missing: ${path.relative(sourceRoot, filePath)}`);
    visited.add(filePath);
    for (const importedFile of imports.get(filePath)) visit(importedFile);
  }
  visit(path.join(sourceRoot, 'index.ts'));
  const rootReachableFiles = visited.size;
  return { source: 'src', files: fileSet.size, auditedFiles: fileSet.size, rootReachableFiles, liveBrowserProof: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertBrowserGraph()
    .then((result) => console.log(JSON.stringify({ graph: 'verified', ...result })))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'Browser source graph rejected');
      process.exitCode = 1;
    });
}
