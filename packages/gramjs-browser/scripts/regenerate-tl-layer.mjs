import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {emit, extractApi, parseApi, parseMtproto, parseMtprotoHtml, readPolicy, select} from '../tools/tlgen/index.mjs';

const mode = process.argv.find((x) => x === '--write' || x === '--check');
if (!mode) throw new Error('explicit --write or --check required');
const arg = process.argv.find((x) => x.startsWith('--root='));
const root = path.resolve(arg ? arg.slice(7) : path.resolve(new URL('..', import.meta.url).pathname));
const rel = (x) => path.join(root, x);
const digest = (file) => { const b = fs.readFileSync(file); return {bytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex'), sha512: crypto.createHash('sha512').update(b).digest('hex')}; };
const text = (file) => fs.readFileSync(rel(file), 'utf8');
const generatorFiles = ['tools/tlgen/index.mjs', 'tools/tlgen/parser.mjs', 'tools/tlgen/emit.mjs'];
const generatorManifest = 'tools/tlgen/GENERATOR.json';
const generator = JSON.parse(text(generatorManifest));
if (JSON.stringify(Object.keys(generator.sourceFiles ?? {}).sort()) !== JSON.stringify([...generatorFiles].sort())) throw new Error('generator source file set mismatch');
for (const file of generatorFiles) { const actual = digest(rel(file)); const expected = generator.sourceFiles[file]; if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error(`generator source mismatch: ${file}`); }
if (generator.runtime !== process.version || process.version !== 'v24.15.0') throw new Error('generator Node version mismatch');
const apiRaw = 'tl/official/layer-223/schema-layer-223.html';
const apiTl = 'tl/official/layer-223/schema-layer-223.tl';
const mtDir = 'tl/official/mtproto/snapshot-9088824ec1f1';
const raw = [apiRaw, `${mtDir}/schema.html`, `${mtDir}/schema.json`];
const apiSource = JSON.parse(text('tl/official/layer-223/SOURCE.json'));
const mtSource = JSON.parse(text(`${mtDir}/SOURCE.json`));
if (digest(apiRaw).sha256 !== apiSource.rawSha256 || digest(apiRaw).bytes !== apiSource.rawBytes) throw new Error('API raw SOURCE mismatch');
for (const item of mtSource.rawFiles) { const d = digest(`${mtDir}/${item.file}`); if (d.bytes !== item.bytes || d.sha256 !== item.sha256) throw new Error(`MT raw SOURCE mismatch: ${item.file}`); }
const extracted = extractApi(text(apiRaw));
if (text(apiTl) !== extracted) throw new Error('extracted API TL mismatch');
const policies = {api: 'tl/policy/api-layer-223.json', mtproto: 'tl/policy/mtproto-9088824ec1f1.json', composition: 'tl/policy/composition.json'};
const apiPolicy = readPolicy(rel(policies.api)); const mtPolicy = readPolicy(rel(policies.mtproto));
const api = select(parseApi(extracted), apiPolicy); const mt = select(parseMtproto(text(`${mtDir}/schema.json`)), mtPolicy); const mtHtml = select(parseMtprotoHtml(text(`${mtDir}/schema.html`)), mtPolicy);
const signature = (x) => ({name: x.name, id: x.id, kind: x.kind, fields: x.fields, generic: x.generic, result: x.result});
if (JSON.stringify(mt.map(signature)) !== JSON.stringify(mtHtml.map(signature))) throw new Error('MTProto HTML/JSON selected declaration mismatch');
const sourceHashes = Object.fromEntries([...raw, apiTl, 'tl/official/layer-223/schema-layer-223.html.headers', `${mtDir}/schema.html.headers`, `${mtDir}/schema.json.headers`, 'tl/official/layer-223/SOURCE.json', `${mtDir}/SOURCE.json`].map((x) => [x, digest(rel(x))]));
const generatorHashes = Object.fromEntries([...generatorFiles, generatorManifest].map((x) => [x, digest(rel(x))]));
if (mode === '--check' && fs.existsSync(rel('tl/generated/BUILD-MANIFEST.json'))) {
  const current = JSON.parse(text('tl/generated/BUILD-MANIFEST.json'));
  const currentPolicies = Object.fromEntries(Object.entries(policies).map(([k, x]) => [k, digest(rel(x))]));
  if (JSON.stringify(current.policies) !== JSON.stringify(currentPolicies)) throw new Error('policy provenance changed');
}
const common = {projectGenerated: true, official: false, gramjsEquivalent: false, sourceHashes, generatorHashes, command: 'node scripts/regenerate-tl-layer.mjs', node: process.version, layer: 223};
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'tlgen-'));
try {
  emit(api, {...common, mode: 'metadata-only', origin: 'API capture layer223; not official, not GramJS equivalent, not executable codec/auth/transport readiness', source: 'api-layer-223', extracted: digest(rel(apiTl))}, path.join(output, 'api-layer-223'), 'metadata-only');
  emit(mt, {...common, mode: 'static-selected-codecs', origin: 'Unlayered frozen MTProto snapshot; not layer-223/version-coupled; not official, not GramJS equivalent, not auth/transport/runtime readiness', source: 'mtproto-9088824ec1f1', rawFiles: Object.fromEntries(raw.slice(1).map((x) => [path.basename(x), digest(x)]))}, path.join(output, 'mtproto-9088824ec1f1'));
  const generated = ['api-layer-223', 'mtproto-9088824ec1f1'];
  const generatedFiles = Object.fromEntries([...generated.flatMap((d) => fs.readdirSync(path.join(output, d)).map((f) => [`${d}/${f}`, digest(path.join(output, d, f))]))]);
  const top = {kind: 'project-generated-tl-build', layer: 223, sources: sourceHashes, policies: Object.fromEntries(Object.entries(policies).map(([k, x]) => [k, digest(rel(x))])), generators: generatorHashes, generated, generatedFiles, claims: ['not official', 'not GramJS-equivalent', 'schema-only; no runtime']};
  fs.writeFileSync(path.join(output, 'BUILD-MANIFEST.json'), JSON.stringify(top, null, 2) + '\n');
  const expected = ['BUILD-MANIFEST.json', ...generated.flatMap((d) => fs.readdirSync(path.join(output, d)).map((f) => `${d}/${f}`))];
  const target = rel('tl/generated');
  const actual = fs.existsSync(target) ? [] : [];
  if (fs.existsSync(target)) for (const d of fs.readdirSync(target, {withFileTypes: true})) for (const f of d.isDirectory() ? fs.readdirSync(path.join(target, d.name)) : [d.name]) actual.push(d.isDirectory() ? `${d.name}/${f}` : f);
  actual.sort(); expected.sort();
  if (mode === '--check') { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('generated tree file set mismatch'); for (const f of expected) if (!fs.readFileSync(path.join(output, f)).equals(fs.readFileSync(path.join(target, f)))) throw new Error(`generated output mismatch: ${f}`); }
  else { fs.rmSync(target, {recursive: true, force: true}); fs.mkdirSync(target, {recursive: true}); for (const f of expected) { fs.mkdirSync(path.dirname(path.join(target, f)), {recursive: true}); fs.copyFileSync(path.join(output, f), path.join(target, f)); } }
} finally { fs.rmSync(output, {recursive: true, force: true}); }
console.log(JSON.stringify({tlGeneration: mode.slice(2), deterministic: true, apiDeclarations: api.length, mtprotoDeclarations: mt.length}));
