import fs from 'node:fs';
import path from 'node:path';
const arg = process.argv.find((x) => x.startsWith('--root='));
const root = path.resolve(arg ? arg.slice(7) : path.resolve(new URL('..', import.meta.url).pathname));
const base = path.join(root, 'tl/generated');
const allowed = { 'api-layer-223': ['MANIFEST.json', 'constructors.ts', 'registry.ts'], 'mtproto-9088824ec1f1': ['MANIFEST.json', 'constructors.ts', 'encode.ts', 'decode.ts', 'registry.ts'] };
const files = [];
for (const [dir, names] of Object.entries(allowed)) { const actual = fs.readdirSync(path.join(base, dir)).sort(); if (JSON.stringify(actual) !== JSON.stringify([...names].sort())) throw new Error(`generated file set mismatch: ${dir}`); for (const name of names) if (name.endsWith('.ts')) files.push(path.join(base, dir, name)); }
for (const file of files) { const source = fs.readFileSync(file, 'utf8'); if (/\b(eval|fetch|WebSocket|node:|require\s*\(|network|storage|session|auth|transport|vendor|dynamic)\b|\bnew\s+Function\b|\bimport\s*\(/iu.test(source)) throw new Error(`unsafe generated graph: ${file}`); for (const spec of [...source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/gu)].map((x) => x[1])) if (!spec.startsWith('./')) throw new Error(`external import: ${file}`); }
console.log(JSON.stringify({tlGraph: 'verified', files: files.length, externalImports: false, dynamicCode: false}));
