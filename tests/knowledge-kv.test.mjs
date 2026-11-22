import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig } from '../lib/args.mjs';
import { generate, buildConfig } from '../lib/generate.mjs';
import { readProject, writeKnowledge, makeSnapshot, readVersion } from '../lib/projects.mjs';
import { namespaceId, parseCreatedNamespace, ensureKvNamespace, publishKv, checkKnowledge } from '../lib/knowledge-kv.mjs';
import { planKvMigration, migrateToKv } from '../lib/kv-migration.mjs';
import worker from '../templates/worker/src/index.mjs';

async function fixture(t, mode='kv') {
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'falco-kv-test-'));
  t.after(()=>fs.rm(tmp,{recursive:true,force:true}));
  const config=normalizeConfig({name:'falco-kv-test',business:'Test Restaurant',provider:'mock','knowledge-mode':mode,origin:'http://localhost:3000'},tmp);
  config.faq='The menu has chicken and salads.';
  config.instructions='Answer in Spanish.';
  await generate(config);
  return {tmp,config,p:await readProject(tmp,'falco-kv-test')};
}
const readJson=async file=>JSON.parse(await fs.readFile(file,'utf8'));

test('embedded stays default, KV is strictly opt-in and uses only local editable knowledge copy',async t=>{
  const embedded=await fixture(t,'embedded');
  assert.equal(embedded.p.knowledgeMode,'embedded');
  assert.equal(embedded.p.kvNamespaceId,null);
  assert.match(await fs.readFile(path.join(embedded.p.output,'src/business-context.mjs'),'utf8'),/chicken and salads/);
  const kv=await fixture(t,'kv');
  assert.equal(kv.p.knowledgeMode,'kv');
  assert.equal(kv.p.faq,'The menu has chicken and salads.');
  const source=await fs.readFile(path.join(kv.p.output,'src/business-context.mjs'),'utf8');
  assert.doesNotMatch(source,/chicken and salads/);
  const local=await readJson(path.join(kv.p.output,'.falco-knowledge.json'));
  assert.equal(local.faq,kv.p.faq);
  assert.match(await fs.readFile(path.join(kv.p.output,'.gitignore'),'utf8'),/\.falco-knowledge\.json/);
  assert.equal(buildConfig(kv.config).vars.KNOWLEDGE_MODE,'kv');
});

test('KV size limits are independent from bundle limits',async()=>{
  assert.throws(()=>checkKnowledge('embedded',{faq:'f'.repeat(24001),instructions:''}),/faq must/);
  assert.doesNotThrow(()=>checkKnowledge('kv',{faq:'f'.repeat(64000),instructions:'a'.repeat(20000)}));
  assert.throws(()=>checkKnowledge('kv',{faq:'f'.repeat(96001),instructions:''}),/faq must/);
  assert.throws(()=>checkKnowledge('kv',{faq:'',instructions:'i'.repeat(24001)}),/instructions must/);
});

test('new KV namespace is created through Wrangler once, bound, and reused',async t=>{
  const {config}=await fixture(t);
  const id='f'.repeat(32); let calls=0;
  const wrangler=async args=>{
    calls++;
    assert.deepEqual(args,['kv','namespace','create','FALCO_KNOWLEDGE','--config','wrangler.json']);
    return {code:0,stdout:`Created! { "kv_namespaces": [{ "binding": "FALCO_KNOWLEDGE", "id": "${id}" }] }`,stderr:''};
  };
  assert.equal(await ensureKvNamespace(config,{wrangler}),id);
  assert.equal(namespaceId(await readJson(path.join(config.output,'wrangler.json'))),id);
  assert.equal(await ensureKvNamespace(config,{wrangler}),id);
  assert.equal(calls,1);
  assert.throws(()=>parseCreatedNamespace('Success but no id'),/did not return a valid ID/);
});

test('KV publish uses remote Wrangler namespace and temporary 0600 file, never process arguments',async t=>{
  const {config}=await fixture(t);
  const id='f'.repeat(32);
  const file=path.join(config.output,'wrangler.json');
  const c=await readJson(file);c.kv_namespaces=[{binding:'FALCO_KNOWLEDGE',id}];await fs.writeFile(file,JSON.stringify(c));
  const pending = new Map();
  const keys = [];
  const wrangler = async args => {
    assert.ok(!args.join(' ').includes(config.faq));
    assert.ok(args.includes('--remote'));
    const [, , command, key] = args;
    if (command === 'get') return { code: 0, stdout: pending.get(key) ?? 'Value not found' };
    const filename = args[args.indexOf('--path') + 1];
    if (process.platform !== 'win32') assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    const body = await fs.readFile(filename, 'utf8');
    assert.equal(JSON.parse(body).faq, config.faq);
    pending.set(key, body); keys.push(key);
    return { code: 0, stdout: 'ok' };
  };
  const result = await publishKv(config, { wrangler });
  assert.equal(result.namespaceId, id);
  assert.deepEqual(keys, ['knowledge:revision:' + result.revision, 'knowledge:active']);
  assert.equal(JSON.parse(pending.get('knowledge:active')).revision, result.revision);
});

test('official migration uploads KV before switching runtime, keeps URL and provider config',async t=>{
  const {config,p}=await fixture(t,'embedded');
  const plan=await planKvMigration(p);
  const snapshot=await makeSnapshot(p,'before_kv_migration');
  let published=false;
  await migrateToKv(p,plan,snapshot.id,{
    provision:async input=>{
      const file=path.join(input.output,'wrangler.json');const c=await readJson(file);
      c.kv_namespaces=[{binding:'FALCO_KNOWLEDGE',id:'a'.repeat(32)}];await fs.writeFile(file,JSON.stringify(c));
    },
    publish:async input=>{
      const config=await readJson(path.join(input.output,'wrangler.json'));
      assert.equal(config.vars.KNOWLEDGE_MODE,'embedded');
      assert.equal(input.faq,p.faq);published=true;
    }
  });
  assert.equal(published,true);
  const loaded=await readProject(config.output.replace(/\.generated\/falco-kv-test$/,''), 'falco-kv-test').catch(()=>null);
  const cfg=await readJson(path.join(config.output,'wrangler.json'));
  assert.equal(cfg.vars.KNOWLEDGE_MODE,'kv');
  assert.equal(cfg.vars.PROVIDER,'mock');
  assert.equal((await readJson(path.join(config.output,'.falco-knowledge.json'))).faq,p.faq);
  assert.doesNotMatch(await fs.readFile(path.join(config.output,'src/business-context.mjs'),'utf8'),/chicken and salads/);
  assert.equal((await readVersion({...p,knowledgeMode:'kv'},snapshot.id)).config.faq,p.faq);
});

test('migration failure during KV upload preserves embedded runtime and knowledge',async t=>{
  const {config,p}=await fixture(t,'embedded');
  const plan=await planKvMigration(p);
  const snapshot=await makeSnapshot(p,'before_kv_migration');
  await assert.rejects(migrateToKv(p,plan,snapshot.id,{
    provision:async input=>{
      const file=path.join(input.output,'wrangler.json');const c=await readJson(file);
      c.kv_namespaces=[{binding:'FALCO_KNOWLEDGE',id:'a'.repeat(32)}];await fs.writeFile(file,JSON.stringify(c));
    },
    publish:async()=>{throw Error('simulated KV outage')}
  }),/simulated KV outage/);
  assert.equal((await readJson(path.join(config.output,'wrangler.json'))).vars.KNOWLEDGE_MODE,'embedded');
  assert.match(await fs.readFile(path.join(config.output,'src/business-context.mjs'),'utf8'),/chicken and salads/);
});

test('KV-mode Worker reads knowledge only for chat; missing/corrupt binding fails closed with safe 503',async()=>{
  const env={BUSINESS_NAME:'Test Restaurant',PROVIDER:'mock',MODEL:'mock-v1',MOCK_REPLY:'Hello',KNOWLEDGE_MODE:'kv',
    CHAT_RATE_LIMITER:{limit:async()=>({success:true})},ALLOWED_ORIGIN:'http://localhost:3000'};
  const health=await worker.fetch(new Request('https://example.workers.dev/health'),env);
  assert.equal(health.status,200);
  let response=await worker.fetch(new Request('https://example.workers.dev/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'Hola'})}),env);
  assert.equal(response.status,503);assert.equal((await response.json()).error,'knowledge_unavailable');
  let calls=0;
  env.FALCO_KNOWLEDGE={get:async (key,type)=>{calls++;assert.equal(key,'knowledge:active');assert.equal(type,'json');return {version:1,faq:'El restaurante abre a las 9',instructions:'No inventar precios'};}};
  response=await worker.fetch(new Request('https://example.workers.dev/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'Hola'})}),env);
  assert.equal(response.status,200);assert.equal(calls,1);
  env.FALCO_KNOWLEDGE.get=async()=>({version:999,faq:'x',instructions:'y'});
  response=await worker.fetch(new Request('https://example.workers.dev/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'Hola'})}),env);
  assert.equal(response.status,503);
});

test('Studio publishes changed KV knowledge without redeploying, preserving settings and API key',async t=>{
  const {tmp,config}=await fixture(t);
  const file=path.join(config.output,'wrangler.json');
  const wrangler=await readJson(file);wrangler.account_id='b'.repeat(32);
  wrangler.kv_namespaces=[{binding:'FALCO_KNOWLEDGE',id:'a'.repeat(32)}];
  await fs.writeFile(file,JSON.stringify(wrangler));
  let publications=0,deployments=0;
  const {createUiServer}=await import('../lib/ui-server.mjs');
  const server=createUiServer({root:tmp,port:0,runner:{
    managedPreflight:async()=>{},
    workerEndpoint:async()=> 'https://falco-kv-test.gtl-ai.workers.dev/chat',
    publishKv:async input=>{publications++;assert.equal(input.faq,'New weekend menu');},
    deploy:async()=>{deployments++;return {status:'deployed',url:'https://falco-kv-test.gtl-ai.workers.dev',secret:'preserved'}},
    smoke:async()=>({health:true})
  }});
  const origin=await server.listen();t.after(()=>server.close());
  const token=(await (await fetch(origin+'/api/bootstrap')).json()).token;
  const project=await readProject(tmp,'falco-kv-test');
  const r=await fetch(origin+'/api/jobs',{method:'POST',headers:{'Content-Type':'application/json','Origin':origin,'X-Falco-Local-Token':token},
    body:JSON.stringify({mode:'update',folder:project.folder,revision:project.revision,faq:'New weekend menu',instructions:project.instructions,origins:project.origins,actions:project.actions})});
  assert.equal(r.status,202);const started=await r.json();let job;
  for(let i=0;i<50;i++){job=(await (await fetch(origin+'/api/jobs/'+started.job.id)).json()).job;if(['updated','failed','partial'].includes(job.status))break;await new Promise(done=>setTimeout(done,15));}
  assert.equal(job.status,'updated');assert.equal(publications,1);assert.equal(deployments,0);
  const after=await readProject(tmp,'falco-kv-test');assert.equal(after.faq,'New weekend menu');
  assert.equal((await readJson(file)).vars.PROVIDER,'mock');
});

test('Studio guarded KV migration preserves Gemini provider and marks partial on remote failure',async t=>{
  const {tmp,config}=await fixture(t,'embedded');
  const file=path.join(config.output,'wrangler.json');
  const cfg=await readJson(file);cfg.account_id='a'.repeat(32);cfg.vars.PROVIDER='gemini';cfg.vars.MODEL='gemini-2.5-flash';await fs.writeFile(file,JSON.stringify(cfg));
  const {createUiServer}=await import('../lib/ui-server.mjs');
  let deployments=0;
  const server=createUiServer({root:tmp,port:0,runner:{
    managedPreflight:async()=>{},
    migrateToKv:async(project,plan,id,options)=>migrateToKv(project,plan,id,{...options,
      provision:async p=>{const cf=await readJson(file);cf.kv_namespaces=[{binding:'FALCO_KNOWLEDGE',id:'b'.repeat(32)}];await fs.writeFile(file,JSON.stringify(cf));},
      publish:async()=>{}}),
    deploy:async(c,opts)=>{deployments++;assert.equal(opts.preserveSecret,true);assert.equal(c.knowledgeMode,'kv');return {status:'deployed',url:'https://falco-kv-test.gtl-ai.workers.dev',secret:'preserved'};},
    smoke:async()=>({health:true})
  }});
  const origin=await server.listen();t.after(()=>server.close());
  const token=(await (await fetch(origin+'/api/bootstrap')).json()).token;
  const project=await readProject(tmp,'falco-kv-test');
  const r=await fetch(origin+'/api/jobs',{method:'POST',headers:{'Content-Type':'application/json','Origin':origin,'X-Falco-Local-Token':token},
    body:JSON.stringify({mode:'enable-kv',folder:project.folder,revision:project.revision})});
  assert.equal(r.status,202);const started=await r.json();let job;
  for(let i=0;i<50;i++){job=(await (await fetch(origin+'/api/jobs/'+started.job.id)).json()).job;if(['updated','failed','partial'].includes(job.status))break;await new Promise(done=>setTimeout(done,15));}
  assert.equal(job.status,'updated');assert.equal(deployments,1);
  const after=await readProject(tmp,'falco-kv-test');
  assert.equal(after.knowledgeMode,'kv');assert.equal(after.provider,'gemini');
});
