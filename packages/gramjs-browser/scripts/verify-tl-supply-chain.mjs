import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {extractApi, parseApi, parseMtproto, parseMtprotoHtml, readPolicy, select} from '../tools/tlgen/index.mjs';

const arg = process.argv.find((x) => x.startsWith('--root='));
const root = path.resolve(arg ? arg.slice(7) : path.resolve(new URL('..', import.meta.url).pathname));
const rel = (x) => path.join(root, x);
const bytes = (x) => { const b = fs.readFileSync(rel(x)); return {bytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex'), sha512: crypto.createHash('sha512').update(b).digest('hex')}; };
const json = (x) => JSON.parse(fs.readFileSync(rel(x), 'utf8'));
const strictJson = (x) => { const raw = fs.readFileSync(rel(x), 'utf8'); const value = JSON.parse(raw); if (raw !== JSON.stringify(value, null, 2) + '\n') throw new Error(`${x} noncanonical`); return value; };
const same = (a, b, label) => { const keys = (x) => Object.keys(x).sort(); if (JSON.stringify(keys(a)) !== JSON.stringify(keys(b)) || keys(a).some((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))) throw new Error(`${label} mismatch`); };
const git = (args, label) => { const result = spawnSync('git', args, {cwd: root, encoding: 'utf8'}); if (result.status !== 0) throw new Error(`${label}: ${result.stderr.trim() || result.stdout.trim()}`); return result.stdout.trim(); };
const files = (dir) => fs.readdirSync(rel(dir), {withFileTypes: true}).map((x) => x.name + (x.isDirectory() ? '/' : '')).sort();
const expectSet = (dir, expected) => same(files(dir), [...expected].sort(), `${dir} file set`);
const sourceFiles = ['tl/official/layer-223/schema-layer-223.html', 'tl/official/layer-223/schema-layer-223.tl', 'tl/official/layer-223/schema-layer-223.html.headers', 'tl/official/layer-223/SOURCE.json', 'tl/official/mtproto/snapshot-9088824ec1f1/schema.html', 'tl/official/mtproto/snapshot-9088824ec1f1/schema.html.headers', 'tl/official/mtproto/snapshot-9088824ec1f1/schema.json', 'tl/official/mtproto/snapshot-9088824ec1f1/schema.json.headers', 'tl/official/mtproto/snapshot-9088824ec1f1/SOURCE.json'];
expectSet('tl/official/layer-223', ['schema-layer-223.html', 'schema-layer-223.html.headers', 'schema-layer-223.tl', 'SOURCE.json']);
expectSet('tl/official/mtproto/snapshot-9088824ec1f1', ['schema.html', 'schema.html.headers', 'schema.json', 'schema.json.headers', 'SOURCE.json']);
for (const x of sourceFiles) if (!fs.statSync(rel(x)).isFile()) throw new Error(`missing input: ${x}`);
const apiSource = json('tl/official/layer-223/SOURCE.json');
const mtSource = json('tl/official/mtproto/snapshot-9088824ec1f1/SOURCE.json');
same(bytes('tl/official/layer-223/schema-layer-223.html'), {bytes: apiSource.rawBytes, sha256: apiSource.rawSha256, sha512: apiSource.rawSha512}, 'API raw');
same(bytes('tl/official/layer-223/schema-layer-223.html.headers'), apiSource.rawHeader, 'API headers');
same(bytes('tl/official/layer-223/schema-layer-223.tl'), {bytes: apiSource.extracted.bytes, sha256: apiSource.extracted.sha256, sha512: apiSource.extracted.sha512}, 'API extracted');
if (apiSource.termsUrl !== 'https://core.telegram.org/api/terms') throw new Error('API terms mismatch');
for (const item of mtSource.rawFiles) same(bytes(`tl/official/mtproto/snapshot-9088824ec1f1/${item.file}`), {bytes: item.bytes, sha256: item.sha256, sha512: item.sha512}, `MT raw ${item.file}`);
for (const [file, info] of Object.entries(mtSource.headerFiles)) same(bytes(`tl/official/mtproto/snapshot-9088824ec1f1/${file}`), {bytes: info.bytes, sha256: info.sha256, sha512: info.sha512}, `MT headers ${file}`);
if (mtSource.termsUrl !== 'https://core.telegram.org/api/terms') throw new Error('MT terms mismatch');
const apiTl = extractApi(fs.readFileSync(rel('tl/official/layer-223/schema-layer-223.html'), 'utf8'));
if (fs.readFileSync(rel('tl/official/layer-223/schema-layer-223.tl'), 'utf8') !== apiTl) throw new Error('extracted API TL mismatch');
const policies = {api: 'tl/policy/api-layer-223.json', mt: 'tl/policy/mtproto-9088824ec1f1.json', composition: 'tl/policy/composition.json'};
for (const p of Object.values(policies)) if (!fs.statSync(rel(p)).isFile()) throw new Error(`missing policy: ${p}`);
const apiPolicy = readPolicy(rel(policies.api)); const mtPolicy = readPolicy(rel(policies.mt));
if (apiPolicy.source !== 'api-layer-223' || apiPolicy.mode !== 'metadata-only' || mtPolicy.source !== 'mtproto-9088824ec1f1' || mtPolicy.mode !== 'static-selected-codecs') throw new Error('invalid policy modes');
if (json(policies.composition).layer !== 223) throw new Error('invalid composition');
const apiSelected = select(parseApi(apiTl), apiPolicy);
const mtSelected = select(parseMtproto(fs.readFileSync(rel('tl/official/mtproto/snapshot-9088824ec1f1/schema.json'), 'utf8')), mtPolicy);
const signature = (x) => ({name: x.name, id: x.id, kind: x.kind, fields: x.fields, generic: x.generic, result: x.result});
if (JSON.stringify(mtSelected.map(signature)) !== JSON.stringify(select(parseMtprotoHtml(fs.readFileSync(rel('tl/official/mtproto/snapshot-9088824ec1f1/schema.html'), 'utf8')), mtPolicy).map(signature))) throw new Error('MTProto HTML/JSON selected declaration mismatch');
const generator = json('tools/tlgen/GENERATOR.json');
if (generator.network !== false || generator.dependencies.length || generator.kind !== 'project-owned-tl-generator' || generator.runtime !== process.version) throw new Error('invalid generator manifest/runtime');
const generatorFiles = ['tools/tlgen/index.mjs', 'tools/tlgen/parser.mjs', 'tools/tlgen/emit.mjs', 'tools/tlgen/GENERATOR.json'];
if (JSON.stringify(Object.keys(generator.sourceFiles ?? {}).sort()) !== JSON.stringify(generatorFiles.slice(0, 3).sort())) throw new Error('generator source file set mismatch');
for (const file of generatorFiles.slice(0, 3)) { const actual = bytes(file); const expected = generator.sourceFiles[file]; if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error(`generator source ${file} mismatch`); }
const generated = {api: ['constructors.ts', 'registry.ts', 'MANIFEST.json'], mt: ['constructors.ts', 'encode.ts', 'decode.ts', 'registry.ts', 'MANIFEST.json']};
const dirs = {api: 'tl/generated/api-layer-223', mt: 'tl/generated/mtproto-9088824ec1f1'};
expectSet('tl/generated', ['BUILD-MANIFEST.json', 'api-layer-223/', 'mtproto-9088824ec1f1/']);
for (const [kind, dir] of Object.entries(dirs)) {
  expectSet(dir, generated[kind]);
  const manifest = strictJson(`${dir}/MANIFEST.json`);
  same(manifest.sourceHashes, Object.fromEntries(sourceFiles.map((x) => [x, bytes(x)])), `${kind} sources`);
  same(manifest.generatorHashes, Object.fromEntries(generatorFiles.map((x) => [x, bytes(x)])), `${kind} generators`);
  if (manifest.node !== process.version || manifest.projectGenerated !== true || manifest.official !== false || manifest.gramjsEquivalent !== false) throw new Error(`${kind} claims/runtime mismatch`);
  if (kind === 'api' && JSON.stringify(manifest.extracted) !== JSON.stringify(bytes('tl/official/layer-223/schema-layer-223.tl'))) throw new Error('API extracted hash mismatch');
  if (manifest.declarationCount !== (kind === 'api' ? apiSelected.length : mtSelected.length)) throw new Error(`${kind} declaration count mismatch`);
  for (const [file, info] of Object.entries(manifest.files ?? {})) same(bytes(`${dir}/${file}`), info, `${kind}/${file}`);
}
const build = strictJson('tl/generated/BUILD-MANIFEST.json');
same(build.sources, Object.fromEntries(sourceFiles.map((x) => [x, bytes(x)])), 'build sources');
same(build.policies, Object.fromEntries([['api', policies.api], ['mtproto', policies.mt], ['composition', policies.composition]].map(([k, x]) => [k, bytes(x)])), 'build policies');
same(build.generators, Object.fromEntries(generatorFiles.map((x) => [x, bytes(x)])), 'build generators');
same(build.generatedFiles, Object.fromEntries(Object.entries(dirs).flatMap(([, dir]) => [`${dir.split('/').pop()}/MANIFEST.json`, ...Object.keys(json(`${dir}/MANIFEST.json`).files).map((file) => `${dir.split('/').pop()}/${file}`)].map((file) => [file, bytes(`tl/generated/${file}`)]))), 'build generated files');
if (build.layer !== 223 || JSON.stringify(build.generated) !== JSON.stringify(['api-layer-223', 'mtproto-9088824ec1f1']) || !build.claims?.includes('schema-only; no runtime')) throw new Error('invalid build manifest claims');
const repoRoot = git(['rev-parse', '--show-toplevel'], 'B1 trust root unavailable');
const tag = 'tl-supply-chain-b1-v2';
const tagResult = spawnSync('git', ['verify-tag', tag], {cwd: repoRoot, encoding: 'utf8'});
if (tagResult.status !== 0) throw new Error(`B1 trust tag is not a valid signed tag: ${tagResult.stderr.trim()}`);
const tagCommit = spawnSync('git', ['rev-parse', `${tag}^{commit}`], {cwd: repoRoot, encoding: 'utf8'});
if (tagCommit.status !== 0) throw new Error(`B1 trust tag commit resolution failed: ${tag}`);
const packagePath = path.relative(repoRoot, root);
const protectedPaths = [
  `${packagePath}/tl`, `${packagePath}/tools/tlgen`,
  `${packagePath}/scripts/verify-tl-supply-chain.mjs`, `${packagePath}/scripts/regenerate-tl-layer.mjs`, `${packagePath}/scripts/assert-tl-generated-graph.mjs`,
  `${packagePath}/test/tl-supply-chain.test.mjs`
];
const trackedDiff = spawnSync('git', ['diff', '--name-status', `${tag}^{commit}`, '--', ...protectedPaths], {cwd: repoRoot, encoding: 'utf8'});
if (trackedDiff.status !== 0) throw new Error('B1 trust tag diff inspection failed');
if (trackedDiff.stdout.trim()) throw new Error(`B1 trust tag/worktree tracked diff: ${trackedDiff.stdout.trim()}`);
const untracked = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', ...protectedPaths], {cwd: repoRoot, encoding: 'utf8'});
if (untracked.status !== 0) throw new Error('B1 trust tag untracked inspection failed');
if (untracked.stdout.split('\n').some((line) => line.startsWith('?? '))) throw new Error(`B1 trust tag untracked package files: ${untracked.stdout.trim()}`);
console.log(JSON.stringify({tlSupplyChain: 'verified', offline: true, outputs: 2, apiDeclarations: apiSelected.length, mtprotoDeclarations: mtSelected.length}));
