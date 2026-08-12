import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
const root=path.resolve(new URL('..',import.meta.url).pathname);
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const repoRoot=spawnSync('git',['rev-parse','--show-toplevel'],{cwd:root,encoding:'utf8'}).stdout.trim();
const worktree=()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tl-b1-'));fs.rmSync(dir,{recursive:true,force:true});const result=spawnSync('git',['worktree','add','--detach',dir,'HEAD'],{cwd:repoRoot,encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr);return path.join(dir,'packages/gramjs-browser');};
const cleanup=(dir)=>spawnSync('git',['worktree','remove','--force',path.dirname(path.dirname(dir))],{cwd:repoRoot,encoding:'utf8'});
const run=(script,dir,flag)=>spawnSync(process.execPath,[path.join(root,'scripts',script),flag,`--root=${dir}`],{encoding:'utf8'});
test('B1 generated graph and manifests exist without API codec',()=>{
  assert.deepEqual(fs.readdirSync(path.join(root,'tl/generated/api-layer-223')).sort(),['MANIFEST.json','constructors.ts','registry.ts']);
  assert.deepEqual(JSON.parse(read('tl/policy/api-layer-223.json')).unresolved,['Config','DcOption','Reaction','InputClientProxy','JSONValue','X']);
  assert.doesNotMatch(read('tl/generated/api-layer-223/constructors.ts'),/encode|decode/);
});
test('B1 supply-chain verifier is independent and offline',()=>{
  assert.doesNotMatch(read('scripts/verify-tl-supply-chain.mjs'),/regenerate-tl-layer/);
  assert.match(read('tl/generated/BUILD-MANIFEST.json'),/schema-only/);
});
test('B1 copied-package tamper matrix rejects every mutation',()=>{
  const cases=[
    'tl/official/layer-223/schema-layer-223.html', 'tl/official/layer-223/schema-layer-223.tl', 'tl/official/layer-223/schema-layer-223.html.headers', 'tl/official/layer-223/SOURCE.json',
    'tl/official/mtproto/snapshot-9088824ec1f1/schema.html', 'tl/official/mtproto/snapshot-9088824ec1f1/schema.json', 'tl/official/mtproto/snapshot-9088824ec1f1/schema.html.headers', 'tl/official/mtproto/snapshot-9088824ec1f1/schema.json.headers', 'tl/official/mtproto/snapshot-9088824ec1f1/SOURCE.json',
    'tl/policy/api-layer-223.json', 'tl/policy/mtproto-9088824ec1f1.json', 'tl/policy/composition.json',
    'tools/tlgen/index.mjs', 'tools/tlgen/parser.mjs', 'tools/tlgen/emit.mjs', 'tools/tlgen/GENERATOR.json',
    'tl/generated/api-layer-223/constructors.ts', 'tl/generated/api-layer-223/registry.ts', 'tl/generated/api-layer-223/MANIFEST.json',
    'tl/generated/mtproto-9088824ec1f1/constructors.ts', 'tl/generated/mtproto-9088824ec1f1/encode.ts', 'tl/generated/mtproto-9088824ec1f1/decode.ts', 'tl/generated/mtproto-9088824ec1f1/registry.ts', 'tl/generated/mtproto-9088824ec1f1/MANIFEST.json', 'tl/generated/BUILD-MANIFEST.json'
  ];
  for (const file of cases) { const dir=worktree();try { const target=path.join(dir,file);fs.writeFileSync(target,Buffer.concat([fs.readFileSync(target),Buffer.from('x')]));assert.notEqual(run('verify-tl-supply-chain.mjs',dir).status,0,file);assert.notEqual(run('regenerate-tl-layer.mjs',dir,'--check').status,0,file); } finally { cleanup(dir); } }
  for (const [file, action] of [['tl/generated/api-layer-223/extra.ts','add-api'],['tl/generated/mtproto-9088824ec1f1/extra.ts','add-mt'],['tl/generated/api-layer-223/registry.ts','remove-api'],['tl/generated/mtproto-9088824ec1f1/registry.ts','remove-mt']]) { const dir=worktree();try { const target=path.join(dir,file);if(action.startsWith('add'))fs.writeFileSync(target,'export const x=1;\n');else fs.rmSync(target);assert.notEqual(run('verify-tl-supply-chain.mjs',dir).status,0,action);assert.notEqual(run('regenerate-tl-layer.mjs',dir,'--check').status,0,action); } finally { cleanup(dir); } }
  const clean=worktree();try { assert.equal(run('regenerate-tl-layer.mjs',clean,'--check').status,0); } finally { cleanup(clean); }
});
test('B1 copied graph rejects Node, bare import, and extra TS',()=>{
  for (const mutate of [s=>s+'\nimport "node:fs";\n',s=>s+'\nimport "external";\n']) { const dir=worktree();try { const f=path.join(dir,'tl/generated/api-layer-223/registry.ts');fs.writeFileSync(f,mutate(fs.readFileSync(f,'utf8')));assert.notEqual(spawnSync(process.execPath,[path.join(root,'scripts/assert-tl-generated-graph.mjs'),`--root=${dir}`]).status,0); } finally { cleanup(dir); } }
  const dir=worktree();try { fs.writeFileSync(path.join(dir,'tl/generated/api-layer-223/extra.ts'),'export const extra=1;');assert.notEqual(spawnSync(process.execPath,[path.join(root,'scripts/assert-tl-generated-graph.mjs'),`--root=${dir}`]).status,0); } finally { cleanup(dir); }
});
test('B1 v2 anchor scopes trust to protected paths',()=>{
  const protectedFiles=spawnSync('git',['ls-files','packages/gramjs-browser/tl','packages/gramjs-browser/tools/tlgen','packages/gramjs-browser/scripts/verify-tl-supply-chain.mjs','packages/gramjs-browser/scripts/regenerate-tl-layer.mjs','packages/gramjs-browser/scripts/assert-tl-generated-graph.mjs','packages/gramjs-browser/test/tl-supply-chain.test.mjs'],{cwd:repoRoot,encoding:'utf8'}).stdout.trim().split('\n').filter(Boolean);
  for (const file of protectedFiles) { const dir=worktree();try { const target=path.join(dir,file.slice('packages/gramjs-browser/'.length));fs.writeFileSync(target,Buffer.concat([fs.readFileSync(target),Buffer.from('x')]));assert.notEqual(run('verify-tl-supply-chain.mjs',dir).status,0,file); } finally { cleanup(dir); } }
  const dir=worktree();try { const probe=path.join(dir,'src/raw-core/probe.ts');fs.mkdirSync(path.dirname(probe),{recursive:true});fs.writeFileSync(probe,'export const probe = true;\n');assert.equal(run('verify-tl-supply-chain.mjs',dir).status,0); } finally { cleanup(dir); }
});
test('generated MTProto codec uses literal constructor IDs and fails closed', async()=>{
  const encode=await import('../tl/generated/mtproto-9088824ec1f1/encode.ts');
  const decode=await import('../tl/generated/mtproto-9088824ec1f1/decode.ts');
  const hex=(b)=>Buffer.from(b).toString('hex');
  const nonce=new Uint8Array(16), pq=new Uint8Array([1,2,3]);
  const req={name:'req_pq_multi',nonce};
  assert.equal(hex(encode.encode(req)), 'f18e7ebe'+ '00'.repeat(16));
  assert.throws(()=>decode.decode(encode.encode(req)),/response constructor/);
  const res={name:'resPQ',nonce,server_nonce:nonce,pq,server_public_key_fingerprints:[1n,-2n]};
  const golden='63241605'+'00'.repeat(16)+'00'.repeat(16)+'03'+'010203'+'15c4b51c'+'02000000'+'0100000000000000'+'feffffffffffffff';
  assert.equal(hex(encode.encode(res)),golden);
  assert.equal(decode.decode(encode.encode(res)).name,'resPQ');
  assert.throws(()=>decode.decode(Uint8Array.from([0,0,0,0])),/unknown/);
  assert.throws(()=>decode.decode(Uint8Array.from([...encode.encode(res),0])),/trailing/);
  assert.throws(()=>encode.encode({...req,extra:1}),/unknown field/);
  assert.throws(()=>encode.encode({name:'server_DH_inner_data',nonce,server_nonce:nonce,g:2147483648,dh_prime:pq,g_a:pq,server_time:0}),/invalid int/);
});

test('every selected MTProto declaration has independent literal TL golden', async()=>{
  const encode=await import('../tl/generated/mtproto-9088824ec1f1/encode.ts');
  const decode=await import('../tl/generated/mtproto-9088824ec1f1/decode.ts');
  const bytes=(hex)=>Uint8Array.from(hex.match(/../g).map((x)=>parseInt(x,16)));
  const zero16=new Uint8Array(16), zero32=new Uint8Array(32), three=Uint8Array.from([1,2,3]);
  const res={name:'resPQ',nonce:zero16,server_nonce:zero16,pq:three,server_public_key_fingerprints:[1n,-2n]};
  const message={name:'message',msg_id:-2n,seqno:-1,bytes:64,body:res};
  const cases=[
    ['vector',{name:'vector'},'15c4b51c'],
    ['resPQ',res,'63241605'+'00'.repeat(16)+'00'.repeat(16)+'03'+'010203'+'15c4b51c02000000'+'0100000000000000'+'feffffffffffffff'],
    ['p_q_inner_data_dc',{name:'p_q_inner_data_dc',pq:three,p:three,q:three,nonce:zero16,server_nonce:zero16,new_nonce:zero32,dc:-7},'955ff5a9'+'030102030301020303010203'+'00'.repeat(16)+'00'.repeat(16)+'00'.repeat(32)+'f9ffffff'],
    ['p_q_inner_data_temp_dc',{name:'p_q_inner_data_temp_dc',pq:three,p:three,q:three,nonce:zero16,server_nonce:zero16,new_nonce:zero32,dc:-7,expires_in:2147483647},'88dffd56'+'030102030301020303010203'+'00'.repeat(16)+'00'.repeat(16)+'00'.repeat(32)+'f9ffffff'+'ffffff7f'],
    ['server_DH_params_ok',{name:'server_DH_params_ok',nonce:zero16,server_nonce:zero16,encrypted_answer:three},'5c07e8d0'+'00'.repeat(16)+'00'.repeat(16)+'03010203'],
    ['server_DH_inner_data',{name:'server_DH_inner_data',nonce:zero16,server_nonce:zero16,g:-1,dh_prime:three,g_a:three,server_time:2147483647},'ba0d89b5'+'00'.repeat(16)+'00'.repeat(16)+'ffffffff'+'0301020303010203'+'ffffff7f'],
    ['client_DH_inner_data',{name:'client_DH_inner_data',nonce:zero16,server_nonce:zero16,retry_id:-2n,g_b:three},'54b64366'+'00'.repeat(16)+'00'.repeat(16)+'feffffffffffffff'+'03010203'],
    ['dh_gen_ok',{name:'dh_gen_ok',nonce:zero16,server_nonce:zero16,new_nonce_hash1:zero16},'34f7cb3b'+'00'.repeat(16)+'00'.repeat(16)+'00'.repeat(16)],
    ['dh_gen_retry',{name:'dh_gen_retry',nonce:zero16,server_nonce:zero16,new_nonce_hash2:zero16},'b91fdc46'+'00'.repeat(16)+'00'.repeat(16)+'00'.repeat(16)],
    ['dh_gen_fail',{name:'dh_gen_fail',nonce:zero16,server_nonce:zero16,new_nonce_hash3:zero16},'02ae9da6'+'00'.repeat(16)+'00'.repeat(16)+'00'.repeat(16)],
    ['rpc_result',{name:'rpc_result',req_msg_id:-2n,result:res},'016d5cf3'+'feffffffffffffff'+'63241605'+'00'.repeat(16)+'00'.repeat(16)+'03010203'+'15c4b51c02000000'+'0100000000000000'+'feffffffffffffff'],
    ['msg_container',{name:'msg_container',messages:[message]},'dcf8f17315c4b51c01000000'+'feffffffffffffffffffffff40000000'+'63241605'+'00'.repeat(16)+'00'.repeat(16)+'03010203'+'15c4b51c02000000'+'0100000000000000'+'feffffffffffffff'],
    ['message',message,'11e5b85b'+'feffffffffffffff'+'ffffffff'+'40000000'+'63241605'+'00'.repeat(16)+'00'.repeat(16)+'03010203'+'15c4b51c02000000'+'0100000000000000'+'feffffffffffffff'],
    ['gzip_packed',{name:'gzip_packed',packed_data:three},'a1cf723003010203'],
    ['req_pq_multi',{name:'req_pq_multi',nonce:zero16},'f18e7ebe'+'00'.repeat(16)],
    ['req_DH_params',{name:'req_DH_params',nonce:zero16,server_nonce:zero16,p:three,q:three,public_key_fingerprint:-2n,encrypted_data:three},'bee412d7'+'00'.repeat(16)+'00'.repeat(16)+'0301020303010203'+'feffffffffffffff'+'03010203'],
    ['set_client_DH_params',{name:'set_client_DH_params',nonce:zero16,server_nonce:zero16,encrypted_data:three},'1f5f04f5'+'00'.repeat(16)+'00'.repeat(16)+'03010203'],
  ];
  for(const [name,value,expected] of cases){const actual=encode.encode(value);assert.equal(Buffer.from(actual).toString('hex'),expected,name);if(!['req_pq_multi','req_DH_params','set_client_DH_params'].includes(name)&&name!=='vector'){try{assert.equal(decode.decode(actual).name,name,name);}catch(error){throw new Error(`${name}: ${error.message}`);}}}
  assert.throws(()=>encode.encode({name:'server_DH_params_fail',nonce:zero16,server_nonce:zero16,encrypted_answer:three}),/unknown constructor/);
  assert.throws(()=>decode.decode(encode.encode(cases.find((x)=>x[0]==='req_pq_multi')[1])),/response constructor/);
  assert.throws(()=>encode.encode({...message,bytes:63}),/message byte length/);
  assert.throws(()=>encode.encode({...res,nonce:new Uint8Array(15)}),/fixed bytes/);
  assert.throws(()=>encode.encode({...message,body:new Uint8Array(64)}),/nested constructor/);
  assert.throws(()=>encode.encode({...res,server_public_key_fingerprints:[9223372036854775808n]}),/invalid long/);
  assert.throws(()=>encode.encode({name:'server_DH_inner_data',nonce:zero16,server_nonce:zero16,g:-2147483649,dh_prime:three,g_a:three,server_time:0}),/invalid int/);
  assert.throws(()=>decode.decode(bytes('63241605'+'00'.repeat(16)+'00'.repeat(16)+'03'+'010203'+'15c4b51c02000000'+'0100000000000000'+'feffffffffffffff'+'00')),/trailing/);
});
