import fs from 'node:fs';

const ENTITIES = {'&lt;':'<','&gt;':'>','&amp;':'&','&quot;':'"','&#39;':"'"};
const primitive = new Set(['int','long','int128','int256','bytes','string','double','Bool','true','Object','Type','#','True','Null']);

export function extractApi(html) {
  const matches = [...html.matchAll(/<pre class="page_scheme"><code>([\s\S]*?)<\/code><\/pre>/g)];
  if (matches.length !== 1) throw new Error('API schema selector count is not exactly one');
  let body = matches[0][1].replace(/<a\s+href="[^"]*"\s*>([^<]*)<\/a>/g, '$1');
  if (/<|>/.test(body)) throw new Error('API schema contains unexpected markup');
  body = body.replace(/&(?:lt|gt|amp|quot|#39);/g, (x) => ENTITIES[x]);
  if (!body.includes('Layer 223') && !/Layer 223/.test(html)) throw new Error('API Layer 223 evidence missing');
  if (!body.includes('---functions---')) throw new Error('API functions section missing');
  return body.split(/\r?\n/).map((x) => x.replace(/[ \t]+$/u, '')).join('\n').replace(/^\n+|\n+$/gu, '') + '\n';
}

function parseLine(line, kind) {
  const m = line.match(/^([\w.]+)#([0-9a-f-]+)(?:\s+((?:\{[^}]+\}\s*)?[^=]*?))?\s*=\s*([\w.<> !]+);?$/iu);
  if (!m) throw new Error(`unsupported TL declaration: ${line}`);
  const [, name, idText, fieldText = '', result] = m;
  const generic = [...fieldText.matchAll(/\{([^}]+)\}/g)].map((x) => x[1]);
  const fields = [];
  const tokens = fieldText.replace(/\{[^}]+\}/g, '').trim().split(/\s+/u).filter(Boolean);
  for (let i = 0; i < tokens.length;) {
    const token = tokens[i++];
    if (token === '#' || token === '[' || token === ']' || (tokens[i - 2] === '[' && !token.includes(':'))) continue;
    const colon = token.indexOf(':');
    if (colon < 1) throw new Error(`unsupported field in ${name}`);
    fields.push({name: token.slice(0, colon), type: token.slice(colon + 1)});
  }
  const id = idText.startsWith('-') ? Number(idText) : Number.parseInt(idText, 16) | 0;
  if (!Number.isInteger(id)) throw new Error(`invalid constructor ID in ${name}`);
  return {name, id, idText, fields, result: result.trim(), generic, kind};
}

function crc32(value) {
  let crc = -1;
  for (const byte of new TextEncoder().encode(value)) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ -1) | 0;
}

function parseHtmlLine(line, kind) {
  const m = line.match(/^([\w.]+)(?:#([0-9a-f-]+))?\s*(.*?)\s*=\s*([\w.<> !]+);?$/iu);
  if (!m || (!m[2] && !['vector', 'message'].includes(m[1]))) return null;
  const [, name, idText, fields, result] = m;
  if (name === 'vector') return {name, id: 481674261, idText: '481674261', fields: [], result: 'Vector t', generic: [], kind};
  if (name === 'message') return parseLine(`message#5bb8e511 ${fields}= ${result};`, kind);
  const declaration = `${name}${fields ? ` ${fields.trim()}` : ''} = ${result.trim()};`;
  const id = idText ? (idText.startsWith('-') ? Number(idText) : Number.parseInt(idText, 16) | 0) : crc32(declaration);
  return parseLine(`${name}#${id < 0 ? id : (id >>> 0).toString(16)} ${fields}= ${result};`, kind);
}

export function parseApi(tl) {
  let kind = 'constructor'; const result = [];
  for (const raw of tl.split('\n')) {
    const x = raw.trim();
    if (x === '---functions---') { kind = 'method'; continue; }
    if (x && !x.startsWith('---')) result.push(parseLine(x, kind));
  }
  return result;
}

export function parseMtproto(json) {
  const value = JSON.parse(json);
  return [...value.constructors.map((x) => ({name:x.predicate,id:Number(x.id),idText:x.id,fields:x.params.map((p)=>({name:p.name,type:p.type})),result:x.type,generic:[],kind:'constructor'})), ...value.methods.map((x) => ({name:x.method,id:Number(x.id),idText:x.id,fields:x.params.map((p)=>({name:p.name,type:p.type})),result:x.type,generic:[],kind:'method'}))];
}

export function extractMtproto(html) {
  const match = html.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/u);
  if (!match) throw new Error('MTProto schema declaration block missing');
  let block = match[1].replace(/<a\s+href="[^"]*"\s*>([^<]*)<\/a>/gu, '$1');
  if (/<\/?[a-z][^>]*>/iu.test(block)) throw new Error('MTProto schema contains unexpected markup');
  block = block.replace(/&(?:lt|gt|amp|quot|#39);/gu, (x) => ENTITIES[x]);
  if (!block.includes('---functions---')) throw new Error('MTProto functions section missing');
  return block;
}

export function parseMtprotoHtml(html) {
  let kind = 'constructor'; const result = [];
  for (const raw of extractMtproto(html).split('\n')) {
    const line = raw.trim();
    if (line === '---functions---') { kind = 'method'; continue; }
    if (line && !line.startsWith('---')) { const declaration = parseHtmlLine(line, kind); if (declaration) result.push(declaration); }
  }
  return result.map((x) => x.name === 'vector' ? {...x, generic: []} : x);
}

export function readPolicy(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
export function select(declarations, policy) {
  const entries = [...policy.declarations ?? [], ...policy.methods ?? []];
  const names = new Set(); const ids = new Set();
  for (const p of entries) {
    if (!p.name || !Number.isInteger(p.id) || !p.kind || !p.purpose || !Array.isArray(p.fields) || typeof p.result !== 'string') throw new Error(`incomplete policy entry: ${p.name ?? '<unnamed>'}`);
    if (names.has(p.name) || ids.has(p.id)) throw new Error(`duplicate policy declaration: ${p.name}`);
    names.add(p.name); ids.add(p.id);
  }
  const byName = new Map(declarations.map((d) => [d.name, d]));
  if (byName.size !== declarations.length) throw new Error('duplicate declaration name');
  const selected = entries.map((p) => {
    const d = byName.get(p.name);
    if (!d || d.id !== p.id || d.kind !== p.kind || JSON.stringify(d.fields) !== JSON.stringify(p.fields) || d.result !== p.result || JSON.stringify(d.generic) !== JSON.stringify(p.generic ?? [])) throw new Error(`policy signature mismatch: ${p.name}`);
    return {...d, purpose:p.purpose};
  });
  const authorized = new Set(selected.map((d) => d.name));
  const resultTypes = new Map();
  for (const d of selected) { if (!resultTypes.has(d.result)) resultTypes.set(d.result, []); resultTypes.get(d.result).push(d); }
  for (const d of selected) for (const field of [...d.fields, {type:d.result}]) {
    const type = field.type.replace(/^flags\.\d+\?/u, '').replace(/^Vector<(.+)>$/u, '$1').replace(/^!/u, '').trim();
    if (primitive.has(type) || type === 'Object' || type === 'Type' || /^%Message$/u.test(type) || /^vector<%Message>$/iu.test(type)) continue;
    if (policy.mode === 'metadata-only') continue;
    const deps = resultTypes.get(type) ?? [];
    if (!deps.length) throw new Error(`unknown or unauthorized dependency ${type} in ${d.name}`);
  }
  return selected;
}
