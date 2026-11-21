import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import worker from '../templates/worker/src/index.mjs';
import { ProviderError, postJson, assertUsableOutput, providerFailurePayload } from '../templates/worker/src/providers/shared.mjs';
import { FalcoError, createFalcoClient } from '../frontend-kit-template/core/falco-client.js';
import { planRuntimeUpgrade, applyRuntimeUpgrade } from '../lib/runtime-upgrades.mjs';
import { generate } from '../lib/generate.mjs';
import { normalizeConfig } from '../lib/args.mjs';
import { readProject } from '../lib/projects.mjs';
import { createUiServer } from '../lib/ui-server.mjs';

const account='0a5220fa1002c5f33c00f358bf5085b2';
const baseEnv=()=>({BUSINESS_NAME:'Gallinas', ALLOWED_ORIGIN:'http://localhost:3000', PROVIDER:'gemini', MODEL:'gemini-fixture',GEMINI_API_KEY:'VERY_SECRET_KEY_FIXTURE',
  CHAT_RATE_LIMITER:{limit:async()=>({success:true})}, CLIENT_ACTIONS_JSON:JSON.stringify([{
    id:'demo.open',description:'Open one of three available presentation options',parameters:{option:{type:'string',enum:['01','02','03']}}
  }])});
const post=()=>new Request('https://falco.example/chat',{method:'POST',headers:{Origin:'http://localhost:3000','Content-Type':'application/json'},body:JSON.stringify({message:'Ir a 03',history:[]})});

for(const [upstream,code,http] of [
  [400,'provider_invalid_request',502],[401,'provider_auth_failed',503],[403,'provider_auth_failed',503],
  [404,'provider_model_not_found',502],[429,'provider_rate_limited',503],[500,'provider_upstream_unavailable',503],[503,'provider_upstream_unavailable',503]
]) {
  test(`upstream HTTP ${upstream} maps to safe ${code}, never includes provider error body`,async()=>{
    const token='PRIVATE_TOKEN_NEVER_OUTPUT';
    const secret='PRIVATE_UPSTREAM_RESPONSE_NEVER_OUTPUT';
    const realFetch=globalThis.fetch;
    let captured=[];const saved=console.warn;
    globalThis.fetch=async()=>new Response(`${secret} ${token}`,{status:upstream,headers:upstream===429?{'Retry-After':'60'}:{}});
    console.warn=(...args)=>captured.push(args.join(' '));
    try {
      const response=await worker.fetch(post(),baseEnv());
      const body=await response.json();
      assert.equal(response.status,http);
      assert.equal(body.error,code);
      assert.equal(body.providerStatus,upstream);
      assert.match(body.requestId,/^[0-9a-f-]{36}$/);
      assert.equal(response.headers.get('X-Falco-Request-Id'),body.requestId);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'),'http://localhost:3000');
      assert.equal(response.headers.get('Cache-Control'),'no-store');
      assert.equal(captured.length,1);
      assert.ok(captured[0].includes('falco_provider_failure'));
      assert.ok(captured[0].includes(body.requestId));
      const all=JSON.stringify([captured,body]);
      for(const forbidden of [token,secret,'VERY_SECRET_KEY_FIXTURE','Ir a 03']) assert.ok(!all.includes(forbidden));
      if(upstream===429){assert.equal(response.headers.get('Retry-After'),'60');assert.equal(body.retryable,true)}
    } finally {globalThis.fetch=realFetch;console.warn=saved;}
  });
}

test('no upstream errors copied into ProviderError; network timeout and generic network failure classified',async()=>{
  await assert.rejects(postJson('https://provider.example',{},async()=>{throw new DOMException('secret', 'TimeoutError')}), e=>e.code==='provider_timeout' && e.status===504);
  await assert.rejects(postJson('https://provider.example',{},async()=>{throw Error('secret')}), e=>e.code==='provider_unavailable' && !e.message.includes('secret'));
  await assert.rejects(postJson('https://provider.example',{},async()=>new Response('not-json',{headers:{'content-type':'application/json'}})), e=>e.code==='provider_invalid_response');
  assert.throws(()=>assertUsableOutput('',{finishReason:'MAX_TOKENS'}),e=>e.code==='provider_output_truncated');
  assert.throws(()=>assertUsableOutput('',{finishReason:'SAFETY'}),e=>e.code==='provider_blocked');
  const d=providerFailurePayload(new ProviderError('provider_invalid_request',502,{upstreamStatus:400}), 'sample');
  assert.equal(d.providerStatus,400);
  assert.equal(d.retryable,false);
});

test('browser FalcoError exposes safe diagnostics but no raw upstream body',async()=>{
  const client=createFalcoClient({endpoint:'https://example.workers.dev/chat',fetchImpl:async()=>Response.json({error:'provider_model_not_found',
    requestId:'c31f7cc5-ff17-4474-b7fb-6f871763e9cd',providerStatus:404,retryable:false,message:'SECRET DO NOT SHOW'}, {status:502})});
  await assert.rejects(client.send('Hola'),e=> e instanceof FalcoError && e.code==='provider_model_not_found' && e.providerStatus===404 &&
    e.requestId==='c31f7cc5-ff17-4474-b7fb-6f871763e9cd' && !e.message.includes('SECRET'));
});

test('v1.2 runtime upgrade recognizes only known v1.1 managed sources and backs up all replacements',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'falco-v12-upgrade-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const c=normalizeConfig({name:'falco-test-upgrade',business:'Gallinas',provider:'gemini',origin:'http://localhost:3000','account-id':account},root);
  await generate(c);
  const official=path.resolve('tests','fixtures','v1.1');
  const runtimeFiles=['src/index.mjs','src/client-actions.mjs','src/providers/shared.mjs','src/providers/gemini.mjs','src/providers/openai.mjs'];
  for(const file of runtimeFiles) await fs.copyFile(path.join(official,file),path.join(c.output,file));
  let p=await readProject(root,'falco-test-upgrade');
  let plan=await planRuntimeUpgrade(p);
  assert.equal(plan.needed,true);
  const snapshotId='00000000-0000-4000-8000-000000000123';
  await fs.mkdir(path.join(c.output,'.falco-history'),{recursive:true});
  const result=await applyRuntimeUpgrade(p,plan,snapshotId);
  assert.equal(result.upgraded,true);
  for(const file of runtimeFiles){
    assert.equal(await fs.readFile(path.join(c.output,'.falco-history',snapshotId+'.runtime-source',file),'utf8'), await fs.readFile(path.join(official,file),'utf8'));
  }
  assert.equal((await planRuntimeUpgrade(p)).needed,false);
  const sourceFile=path.join(c.output,'src/providers/gemini.mjs');
  await fs.appendFile(sourceFile,'\n// custom local patch');
  await assert.rejects(planRuntimeUpgrade(p),/Customized or unknown/);
});

test('Studio can upgrade existing runtime without changing Gemini secret, account or URL',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'falco-v12-studio-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const c=normalizeConfig({name:'falco-test-studio',business:'Gallinas',provider:'gemini',origin:'http://localhost:3000','account-id':account},root); c.faq='FAQ';c.instructions='Instructions';
  await generate(c);
  const official=path.resolve('tests','fixtures','v1.1');
  for(const file of ['src/index.mjs','src/client-actions.mjs','src/providers/shared.mjs','src/providers/gemini.mjs','src/providers/openai.mjs']) await fs.copyFile(path.join(official,file),path.join(c.output,file));
  const app=createUiServer({root,port:0,runner:{managedPreflight:async()=>{},deploy:async(config,opts)=>{
    assert.equal(opts.preserveSecret,true);assert.equal(opts.requireExisting,true);
    assert.equal(config.name,'falco-test-studio');return {status:'deployed',url:'https://falco-test-studio.gtl-ai.workers.dev',secret:'preserved'};
  }, smoke:async()=>({health:{status:'ok'}})}});
  const host=await app.listen();t.after(()=>app.close());
  const token=(await(await fetch(host+'/api/bootstrap')).json()).token;
  const status=await(await fetch(host+'/api/projects/falco-test-studio/runtime-status')).json();assert.equal(status.state,'upgrade_available');
  const project=await readProject(root,'falco-test-studio');
  const response=await fetch(host+'/api/jobs',{method:'POST',headers:{'Content-Type':'application/json','X-Falco-Local-Token':token,Origin:host},body:JSON.stringify({mode:'upgrade-runtime',folder:project.folder,revision:project.revision})});
  assert.equal(response.status,202);
  const {job:initial}=await response.json();let job;
  for(let i=0;i<120;i++){job=(await(await fetch(host+'/api/jobs/'+initial.id)).json()).job;if(['updated','partial','failed'].includes(job.status))break;await new Promise(r=>setTimeout(r,15));}
  assert.equal(job.status,'updated',job.error);
  assert.equal((await(await fetch(host+'/api/projects/falco-test-studio/runtime-status')).json()).state,'current');
  const after=await readProject(root,'falco-test-studio');assert.equal(after.faq,'FAQ');assert.equal(after.instructions,'Instructions');
  assert.equal(after.accountId,account);assert.equal(after.provider,'gemini');
  assert.ok(!(await fs.readFile(path.join(c.output,'wrangler.json'),'utf8')).includes('VERY_SECRET_KEY_FIXTURE'));
});
