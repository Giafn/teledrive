import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const PRODUCTION_ROOTS = ['apps/web', 'apps/worker'];
const FORBIDDEN_REFERENCES = ['@teledrive/gramjs-browser', 'packages/gramjs-browser'];
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.ts', '.tsx', '.json']);
const IGNORED_DIRECTORIES = new Set(['.next', '.wrangler', 'node_modules', 'out']);

function fail(message) {
  throw new Error(`Non-production scope rejected: ${message}`);
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) files.push(...(await sourceFiles(entryPath)));
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(entryPath);
  }
  return files;
}

export async function assertNonProductionScope(repositoryRoot = REPOSITORY_ROOT) {
  let checkedFiles = 0;
  for (const relativeRoot of PRODUCTION_ROOTS) {
    const root = path.join(repositoryRoot, relativeRoot);
    for (const filePath of await sourceFiles(root)) {
      checkedFiles += 1;
      const source = await readFile(filePath, 'utf8');
      for (const reference of FORBIDDEN_REFERENCES) {
        if (source.includes(reference)) fail(`${path.relative(repositoryRoot, filePath)} references ${reference}`);
      }
    }
  }
  return { checkedFiles, packageReferencedByProduction: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertNonProductionScope()
    .then((result) => console.log(JSON.stringify({ scope: 'verified', ...result })))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'Non-production scope rejected');
      process.exitCode = 1;
    });
}
