import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { labFixture } from './helpers/test-lab.mjs';
import { createTestLab } from '../lib/test-lab.mjs';
import { prepareTestSource, createTestWorkspace, testEntry } from '../lib/test-lab-workspace.mjs';
import { configureBudget } from '../lib/generate.mjs';
import { parsePreview, previewUrl } from '../lib/preview-deploy.mjs';
import { TEST_ACTIONS, TEST_MARKERS, templateFields, validateTestTemplates } from '../lib/test-lab-templates.mjs';
import { createToyApi, redactLab } from '../lib/test-lab-api.mjs';
import { createActionController } from '../frontend-kit-template/actions/action-controller.js';
import { withProjectLock } from '../lib/project-files.mjs';
import { planRuntimeUpgrade } from '../lib/runtime-upgrades.mjs';

test('Preview lifecycle isolates config, source, resources, secrets and auth context; end verifies absence',async t => {
  const f=await labFixture(t);
  const original=await fs.readFile(path.join(f.project.output,'wrangler.json'));
  const context=await fs.readFile(path.join(f.project.output,'src/business-context.mjs'));
  const session=await f.lab.start(f.input);
  const dir=path.join(f.root,'.falco-test-lab/sessions',session.id);
  const config=JSON.parse(await fs.readFile(path.join(dir,'worker/wrangler.json')));
  assert.deepEqual(await fs.readFile(path.join(f.project.output,'wrangler.json')),original);
  assert.deepEqual(await fs.readFile(path.join(f.project.output,'src/business-context.mjs')),context);
  assert.equal(config.name,f.project.name);assert.equal(config.account_id,f.accountId);
  assert.equal(config.main,'src/test-lab-entry.mjs');assert.equal(config.compatibility_date,'2026-06-01');
  assert.equal(config.previews.vars.BUSINESS_NAME,'Falco Test Lab');
  assert.equal(config.previews.vars.KNOWLEDGE_MODE,'embedded');
  assert.equal(config.previews.vars.ALLOWED_ORIGINS,'[]');
  assert.equal(config.previews.vars.FALCO_TEST_LAB,'true');
  assert.equal(config.previews.vars.FALCO_TELEMETRY,'true');
  assert.equal(config.previews.observability.head_sampling_rate,1);
  assert.equal(config.previews.observability.logs.invocation_logs,true);
  assert.notEqual(config.previews.ratelimits[0].namespace_id,f.project.namespaceId);
  assert.ok(Number(config.previews.ratelimits[0].namespace_id)>0);
  assert.ok(templateFields({actions:config.previews.vars.CLIENT_ACTIONS_JSON}).length);
  for(const field of ['kv_namespaces','durable_objects','d1_databases','r2_buckets','vars','migrations']) assert.equal(config[field],undefined);
  assert.equal(config.previews.vars.FALCO_BUDGET,undefined);
  assert.equal(session.state,'ready');assert.equal(session.health,'verified');
  assert.equal(f.messages.length,1,'one bounded startup provider check');
  assert.equal(f.messages[0].actionProtocol,2);
  const start=f.commands[0];
  assert.ok(start.args.includes('--ignore-base-config'));assert.ok(start.args.includes('--json'));
  assert.ok(start.args.includes('--worker-name'));assert.equal(start.opts.accountId,f.accountId);assert.equal(start.opts.authProfile,f.authProfile);
  assert.equal(start.opts.env.WRANGLER_WRITE_LOGS,'false');
  const persisted=await fs.readFile(path.join(dir,'session.json'),'utf8');
  assert.doesNotMatch(persisted,new RegExp(f.token + '|dedicated-provider-key|cloudflare-management-secret'));
  assert.doesNotMatch(JSON.stringify(await f.lab.status()),new RegExp(f.token + '|dedicated-provider-key'));
  assert.doesNotMatch(JSON.stringify(config),/dedicated-provider-key|FALCO_TEST_TOKEN/);
  assert.equal(await fs.stat(f.secretFile).catch(()=>null),null,'temporary secret file removed');
  await f.lab.end(session.id);
  assert.equal(f.cloud.size,0);assert.equal(await fs.stat(dir).catch(()=>null),null);
  assert.ok(f.commands.at(-1).args.includes('--skip-confirmation'));
  assert.deepEqual(await fs.readFile(path.join(f.project.output,'wrangler.json')),original);
  assert.equal((await f.lab.status()).sessions.length,0);
});

test('unique sessions, invalid account/provider/model/key, stale revision and concurrency fail closed',async t => {
  const f=await labFixture(t);
  for(const changes of [{provider:'mock'},{model:'$(bad)'},{apiKey:''},{revision:'stale'},{folder:'../escape'}])
    await assert.rejects(f.lab.start({...f.input,...changes}));
  const session=await f.lab.start(f.input);
  await assert.rejects(f.lab.start(f.input),/active Test Lab/);
  await f.lab.end(session.id);
  const next=await f.lab.start(f.input);assert.notEqual(next.previewName,session.previewName);await f.lab.end(next.id);
  const bad=createTestLab({...f.dependencies,sessionReader:async()=>({accountId:'b'.repeat(32),authProfile:f.authProfile})});
  await assert.rejects(bad.start(f.input),/identity mismatch/);
  assert.equal((await bad.status()).emergencies.length,1);
});

for(const flag of ['failCreate','malformed','missingUrl','unexpectedSecret']) test('failed Preview setup is cleaned up: '+flag,async t => {
  const f=await labFixture(t,{flags:{[flag]:true}});
  await assert.rejects(f.lab.start(f.input));
  assert.equal(f.cloud.size,0);assert.equal((await f.lab.status()).sessions.length,0);
  if(f.secretFile) assert.equal(await fs.stat(f.secretFile).catch(()=>null),null);
});

test('uncertain deletion retains manifest, survives restart, blocks chat and supports exact cleanup',async t => {
  const f=await labFixture(t);const session=await f.lab.start(f.input);f.flags.failDelete=true;
  await assert.rejects(f.lab.end(session.id));
  assert.equal((await f.lab.state(session.id)).state,'cleanup_required');
  assert.deepEqual((await f.lab.status()).emergencies,[]);
  const recovered=createTestLab(f.dependencies);const status=await recovered.status();
  assert.equal(status.sessions[0].state,'cleanup_required');
  await assert.rejects(recovered.chat(session.id,{message:'Hi'}),/unavailable/);
  assert.throws(()=>recovered.assertIdle(),/unfinished cleanup/);
  f.flags.failDelete=false;await recovered.end(session.id);assert.equal(f.cloud.size,0);
});

test('failed creation with failed cleanup is recoverable rather than a production emergency',async t => {
  const f=await labFixture(t,{flags:{failCreate:true,failDelete:true}});
  await assert.rejects(f.lab.start(f.input));
  const status=await f.lab.status();assert.equal(status.sessions[0].state,'cleanup_required');assert.equal(status.emergencies.length,0);
  f.flags.failDelete=false;await f.lab.end(status.sessions[0].id);
});

test('production fingerprint drift persists Emergency Mode and never deploys a restoration',async t => {
  const f=await labFixture(t);const session=await f.lab.start(f.input);f.flags.drift=true;
  await assert.rejects(f.lab.end(session.id),/fingerprint changed/);
  const status=await f.lab.status();assert.equal(status.sessions[0].state,'emergency');assert.match(status.emergencies[0].reason,/Production/);
  assert.equal(f.cloud.size,0,'Preview can be deleted even when production requires review');
  const recovered=createTestLab(f.dependencies);assert.equal((await recovered.status()).emergencies.length,1);
});

for(const field of ['actions','faq','instructions']) test('independent production template marker triggers persistent emergency: '+field,async t => {
  const f=await labFixture(t);assert.equal(validateTestTemplates(),true);
  await f.lab.scan(f.project,{[field]:TEST_MARKERS[field]});
  assert.equal((await f.lab.status()).emergencies.length,1);
  assert.throws(()=>f.lab.assertIdle(),/emergency/);
  const recovered=createTestLab(f.dependencies);assert.equal((await recovered.status()).emergencies.length,1);
});

test('corrupt metadata and external bindings fail closed; custom source is preserved for Preview',async t => {
  const f=await labFixture(t);const session=await f.lab.start(f.input);
  const file=path.join(f.root,'.falco-test-lab/sessions',session.id,'session.json');
  const m=JSON.parse(await fs.readFile(file));m.accountId='b'.repeat(32);await fs.writeFile(file,JSON.stringify(m));
  await assert.rejects(f.lab.end(session.id),/metadata/);assert.equal(f.cloud.size,1,'identity mismatch cannot delete another resource');
  const recovered=createTestLab(f.dependencies);
  assert.equal((await recovered.status()).emergencies.length,1);
  const configFile=path.join(f.project.output,'wrangler.json');
  const config=JSON.parse(await fs.readFile(configFile));config.d1_databases=[{binding:'DB',database_id:'production'}];
  await fs.writeFile(configFile,JSON.stringify(config));await assert.rejects(prepareTestSource(f.project),/Custom bindings/);
  delete config.d1_databases;await fs.writeFile(configFile,JSON.stringify(config));
  await fs.appendFile(path.join(f.project.output,'src/index.mjs'),'\n// custom dependency\n');
  const prepared=await prepareTestSource(f.project);
  assert.match(prepared.sources.get('src/index.mjs'),/custom dependency/);
  await assert.rejects(planRuntimeUpgrade(f.project),/Customized or unknown/);
});

test('Preview JSON and URL parsing rejects production, version-only, guessed, unsafe and missing URLs',() => {
  for(const value of ['http://test.demo.workers.dev','https://falco-worker.demo.workers.dev','https://evil.test','https://test.demo.workers.dev/path','https://a:b@test.demo.workers.dev'])
    assert.throws(()=>previewUrl(value,'falco-worker'));
  assert.throws(()=>parsePreview(JSON.stringify({deployment:{id:'x',urls:['https://1234-worker.demo.workers.dev']}}),{previewName:'test'}));
  assert.throws(()=>parsePreview('{}',{previewName:'test'}));
  assert.throws(()=>parsePreview(JSON.stringify({preview:{id:'preview-id',name:'test',urls:[]},deployment:{id:'deployment-id',urls:['https://version-only.demo.workers.dev']}}),{previewName:'test'}),/without an active Preview URL/);
  assert.throws(()=>parsePreview('null',{previewName:'test'}),/expected Preview identity/);
});

test('disabled Cloudflare Preview routing is explained before creating resources or uploading secrets',async t => {
  const f=await labFixture(t,{flags:{previewUrlsDisabled:true}});
  await assert.rejects(f.lab.checkRouting(f.project),/Cloudflare Preview URLs are disabled/);
  await assert.rejects(f.lab.start(f.input),/Cloudflare Preview URLs are disabled/);
  assert.equal(f.commands.length,0);assert.equal(f.cloud.size,0);
  assert.deepEqual((await f.lab.status()).sessions,[]);
  assert.deepEqual((await f.lab.status()).emergencies,[]);
});

test('test-only wrapper rejects absent/invalid tokens, disabled flag and forwards authenticated requests without Authorization',async () => {
  const source=testEntry('src/index.mjs').replace(/^import worker[^\n]*\n/,'');
  let calls=0;
  const worker={fetch:async req=>{calls++;assert.equal(req.headers.get('Authorization'),null);return new Response('ok');}};
  const url='data:text/javascript;base64,' + Buffer.from('const worker = globalThis.__labWorker;\n'+source).toString('base64');
  globalThis.__labWorker=worker;
  const module=await import(url);delete globalThis.__labWorker;
  const token='x'.repeat(64),env={FALCO_TEST_LAB:'true',FALCO_TEST_TOKEN:token};
  assert.equal((await module.default.fetch(new Request('https://lab/health'),env)).status,401);
  assert.equal((await module.default.fetch(new Request('https://lab/chat',{headers:{Authorization:'Bearer wrong'}}),env)).status,401);
  const req=()=>new Request('https://lab/chat',{headers:{Authorization:'Bearer '+token}});
  assert.equal((await module.default.fetch(req(),{...env,FALCO_TEST_LAB:'false'})).status,401);
  assert.equal((await module.default.fetch(req(),env)).status,200);assert.equal(calls,1);
});

test('actual action-controller pipeline executes all seven actions, confirms writes, reports errors and returns results through chat',async t => {
  const f=await labFixture(t);const session=await f.lab.start(f.input);
  const controller=createActionController(TEST_ACTIONS,{
    ...Object.fromEntries(['celebrate','cry','sing'].map(effect=>['ui.'+effect,async()=>({ok:true,data:{effect}})])),
    'ui.write_text':async ({text})=>({ok:true,data:{text}}),
    'toy.read_record':async(params,ctx)=>(await f.lab.toy(session.id,{method:'GET',query:params,actionId:'toy.read_record',requestId:ctx.requestId})).body,
    'toy.create_record':async(params,ctx)=>(await f.lab.toy(session.id,{method:'POST',payload:params,actionId:'toy.create_record',requestId:ctx.requestId})).body,
    'toy.create_reservation':async(params,ctx)=>(await f.lab.toy(session.id,{resource:'reservations',method:'POST',payload:params,actionId:'toy.create_reservation',requestId:ctx.requestId})).body
  });
  for(const spec of TEST_ACTIONS) {
    const params=spec.id === 'toy.read_record' ? {entity:'product'} : spec.id === 'toy.create_record' ? {type:'customer',name:'Test Person'} : spec.id === 'toy.create_reservation' ? {name:'Ana Torres',date:'2027-01-15'} : spec.id === 'ui.write_text' ? {text:'Falco'} : {};
    const action={id:spec.id,params},requestId=randomUUID();
    if(spec.requiresConfirmation) assert.equal((await controller.dispatch(action,{requestId})).reason,'confirmation_required');
    const result=await controller.dispatch(action,{requestId,confirmed:true});assert.equal(result.executed,true);
    assert.equal((await controller.dispatch(action,{requestId,confirmed:true})).result.requestId,requestId);
    await f.lab.chat(session.id,{message:'Acknowledge action result.',actionResult:result.result});
    assert.deepEqual(f.messages.at(-1).actionResult,result.result);
  }
  const missing=createActionController(TEST_ACTIONS,{});
  assert.equal((await missing.dispatch({id:'ui.sing',params:{}},{requestId:randomUUID()})).result.status,'error');
  assert.equal((await controller.dispatch({id:'toy.read_record',params:{entity:'https://evil'}},{requestId:randomUUID()})).reason,'not_allowed');
  assert.equal((await f.lab.inspector(session.id)).length,3);
  await f.lab.end(session.id);
});

test('reservation Toy API rejects incomplete data and logs confirmed, idempotent POST responses',async t=>{
  const f=await labFixture(t),toy=createToyApi(f.root),requestId=randomUUID();
  const post=(payload,id=requestId)=>toy.request({method:'POST',resource:'reservations',actionId:'toy.create_reservation',requestId:id,payload});
  for(const payload of [{},{name:'Ana Torres'},{date:'2027-01-15'},{name:'Ana Torres',date:'2027-02-30'}]) assert.equal((await post(payload)).status,400);
  const payload={name:'Ana Torres',date:'2027-01-15'};
  const first=await post(payload),second=await post(payload);
  assert.equal(first.status,201);assert.deepEqual(first,second);assert.match(first.body.data.reservationId,/^TEST-R-/);
  assert.equal((await post({...payload,date:'2027-01-16'})).status,409);
  const log=toy.records().at(-2);assert.equal(log.method,'POST');assert.match(log.endpoint,/\/toy-db\/reservations$/);assert.deepEqual(log.requestPayload,payload);assert.equal(log.responseStatus,201);assert.equal(log.idempotencyKey,requestId);
});

test('Toy API logs real GET/POST errors, validates payloads, bounds logs, redacts secrets and enforces idempotency',async t => {
  const f=await labFixture(t);const toy=createToyApi(f.root,{maxRecords:4,secrets:['dedicated-key']});
  const request=(method,data={},requestId=randomUUID())=>toy.request({method,actionId:method === 'GET' ? 'toy.read_record' : 'toy.create_record',requestId,...data});
  const get=await request('GET',{query:{entity:'weekly_expenses'}});assert.equal(get.body.data.total,1245.80);
  assert.equal((await request('GET',{query:{entity:'unknown'}})).status,404);
  assert.equal((await request('GET',{query:{entity:'customer',url:'https://evil'}})).status,400);
  assert.equal((await request('POST',{payload:{type:'SQL',name:'bad'}})).status,400);
  const id=randomUUID(),payload={type:'expense',name:'Lunch',date:'2027-01-15',amount:12.9};
  const a=await request('POST',{payload},id),b=await request('POST',{payload},id);assert.equal(a.status,201);assert.deepEqual(a,b);
  assert.equal((await request('POST',{payload:{...payload,name:'Changed'}},id)).status,409);
  await request('POST',{payload:{...payload,name:'dedicated-key'}},randomUUID());
  const logs=toy.records();assert.equal(logs.length,4);assert.equal(logs[0].idempotencyKey,id);
  assert.equal(logs[0].responseStatus,201);assert.equal(logs[0].method,'POST');assert.equal(logs[0].success,true);
  assert.equal(logs[0].requestPayload.name,'Lunch');assert.ok(logs[0].durationMs>=0);
  const disk=await fs.readFile(path.join(f.root,'api-calls.jsonl'),'utf8');assert.equal(disk.trim().split('\n').length,4);assert.doesNotMatch(disk,/dedicated-key/);
  assert.deepEqual(redactLab({Authorization:'Bearer abc',cookie:'x',apiKey:'x',text:'dedicated-key'},['dedicated-key']),
    {Authorization:'[REDACTED]',cookie:'[REDACTED]',apiKey:'[REDACTED]',text:'[REDACTED]'});
});

test('OpenAI from Mock requires explicit real provider and uses only the dedicated environment key',async t => {
  const f=await labFixture(t,{provider:'mock'});
  const lab=createTestLab({...f.dependencies,env:{FALCO_TEST_LAB_API_KEY:'environment-dedicated-key'}});
  const session=await lab.start({...f.input,provider:'openai',model:'gpt-5.4-mini',apiKey:''});
  const secrets=[...f.cloud.values()][0].secrets;
  assert.equal(secrets.OPENAI_API_KEY,'environment-dedicated-key');assert.equal(secrets.GEMINI_API_KEY,undefined);
  assert.equal((await lab.status()).hasEnvironmentKey,true);
  assert.doesNotMatch(JSON.stringify(await lab.status()),/environment-dedicated-key/);
  await lab.end(session.id);
});

test('CLI/project locks reject normal mutations during a Lab and permit them after confirmed cleanup',async t => {
  const f=await labFixture(t);const session=await f.lab.start(f.input);
  await assert.rejects(withProjectLock(f.project.output,async()=>{}),/active Test Lab/);
  await f.lab.end(session.id);await withProjectLock(f.project.output,async()=>{});
});

test('successful CLI deletion without API-confirmed absence keeps cleanup_required',async t => {
  const f=await labFixture(t);const session=await f.lab.start(f.input);f.flags.lingerDelete=true;
  await assert.rejects(f.lab.end(session.id),/not confirmed/);
  const status=await f.lab.status();assert.equal(status.sessions[0].state,'cleanup_required');assert.equal(status.emergencies.length,0);
  f.flags.lingerDelete=false;await f.lab.end(session.id);
});

test('restart scrubs abandoned protected secret files and retains redacted Inspector records',async t => {
  const f=await labFixture(t);const session=await f.lab.start(f.input);
  await f.lab.toy(session.id,{method:'GET',query:{entity:'customer'},requestId:randomUUID(),actionId:'toy.read_record'});
  const file=path.join(f.root,'.falco-test-lab/sessions',session.id,randomUUID()+'.secrets.json');
  await fs.writeFile(file,JSON.stringify({FALCO_TEST_TOKEN:'abandoned-secret'}),{mode:0o600});
  const recovered=createTestLab(f.dependencies);await recovered.initialize();
  assert.equal(await fs.stat(file).catch(()=>null),null);
  assert.equal((await recovered.inspector(session.id)).length,1);await recovered.end(session.id);
});

test('source directory junctions are refused without following their target',async t => {
  const f=await labFixture(t),providers=path.join(f.project.output,'src/providers'),backup=path.join(f.root,'provider-backup');
  await fs.rename(providers,backup);
  try {await fs.symlink(backup,providers,process.platform === 'win32' ? 'junction' : 'dir');}
  catch(error) {if(error.code === 'EPERM') {t.skip('Creating symlinks requires additional OS privileges.');return;}throw error;}
  await assert.rejects(prepareTestSource(f.project),/symlinks/);
  assert.ok((await fs.stat(path.join(backup,'gemini.mjs'))).isFile());
  await fs.unlink(providers);
});

test('malformed provider chat contract prevents readiness and cleans up the Preview',async t => {
  const f=await labFixture(t,{chat:async()=>Response.json({reply:'',action:{id:'toy.run_sql',params:{}}})});
  await assert.rejects(f.lab.start(f.input),/chat contract/);assert.equal(f.cloud.size,0);assert.equal((await f.lab.status()).sessions.length,0);
});

test('ending rejects new chat while safely waiting for an in-flight operation',async t => {
  let started,release;const began=new Promise(resolve=>{started=resolve;});
  const waiting=new Promise(resolve=>{release=resolve;});
  const f=await labFixture(t,{chat:async payload=>{
    if(payload.message === 'Wait') {started();await waiting;}
    return Response.json({reply:'Falco Test Lab.'});
  }});
  const session=await f.lab.start(f.input);
  const chat=f.lab.chat(session.id,{message:'Wait'});await began;
  const end=f.lab.end(session.id);
  await new Promise(resolve=>setTimeout(resolve,20));
  await assert.rejects(f.lab.chat(session.id,{message:'New message'}),/unavailable/);
  release();await chat;await end;assert.equal(f.cloud.size,0);
});

test('KV/budget production resources and variables are omitted while compatibility flags and entry requirements survive',async t => {
  const f=await labFixture(t),file=path.join(f.project.output,'wrangler.json');
  const config=JSON.parse(await fs.readFile(file));
  config.compatibility_flags=['nodejs_compat'];config.kv_namespaces=[{binding:'FALCO_KNOWLEDGE',id:'b'.repeat(32)}];
  config.vars.KNOWLEDGE_MODE='kv';config.vars.PRODUCTION_ONLY='must-not-inherit';
  configureBudget(config,{day:100,month:2000,breakerSeconds:60,maintenance:false,turnstile:false});
  const original=JSON.stringify(config);await fs.writeFile(file,original);
  const source=await prepareTestSource(f.project);
  const preview=await createTestWorkspace(f.root,f.project,'gemini',f.project.model,source);
  assert.equal(await fs.readFile(file,'utf8'),original);
  assert.deepEqual(preview.compatibility_flags,['nodejs_compat']);
  assert.equal(preview.previews.vars.KNOWLEDGE_MODE,'embedded');
  assert.equal(preview.kv_namespaces,undefined);assert.equal(preview.durable_objects,undefined);assert.equal(preview.migrations,undefined);
  assert.equal(preview.previews.vars.FALCO_BUDGET,undefined);assert.equal(preview.previews.vars.PRODUCTION_ONLY,undefined);
  assert.match(await fs.readFile(path.join(f.root,'worker/src/test-lab-entry.mjs'),'utf8'),/import worker from "\.\/entry.mjs"/);
});

test('custom local module graph is copied with exact source; package and escaping imports are refused',async t => {
  const f=await labFixture(t),index=path.join(f.project.output,'src/index.mjs');
  const original=await fs.readFile(index,'utf8');
  await fs.mkdir(path.join(f.project.output,'src/custom'));
  await fs.writeFile(path.join(f.project.output,'src/custom/helpers.mjs'),'export const customValue = 42;\n');
  const custom="import {customValue} from './custom/helpers.mjs';\n"+original;
  await fs.writeFile(index,custom);
  const prepared=await prepareTestSource(f.project);
  assert.equal(prepared.sources.get('src/index.mjs'),custom);
  assert.match(prepared.sources.get('src/custom/helpers.mjs'),/42/);
  await createTestWorkspace(f.root,f.project,'gemini',f.project.model,prepared);
  assert.equal(await fs.readFile(path.join(f.root,'worker/src/custom/helpers.mjs'),'utf8'),'export const customValue = 42;\n');
  assert.equal(await fs.readFile(index,'utf8'),custom);
  for (const bad of ["import value from 'some-package';", "import value from '../../outside.mjs';", "const value = import('./custom/helpers.mjs');"]) {
    await fs.writeFile(index,bad+'\n'+original);
    await assert.rejects(prepareTestSource(f.project),/Unsupported|within local|Dynamic/);
  }
});

test('reviewed Movens wrapper is retained and authenticates with a Lab-only credential',async t => {
  const f=await labFixture(t),index=path.join(f.project.output,'src/index.mjs');
  const guard=await fs.readFile(new URL('./fixtures/movens-auth.mjs.txt',import.meta.url),'utf8');
  const original=await fs.readFile(index,'utf8');
  const custom="import { withMovensAuth } from './movens-auth.mjs';\n"+original.replace('export default {','const movensFalcoWorker = {')+"\nexport default withMovensAuth(movensFalcoWorker, 'admin');\n";
  await fs.writeFile(index,custom);await fs.writeFile(path.join(f.project.output,'src/movens-auth.mjs'),guard);
  const prepared=await prepareTestSource(f.project);
  assert.equal(prepared.gatewayProfile,'admin');assert.equal(prepared.sources.get('src/movens-auth.mjs'),guard);
  assert.match(prepared.sources.get('src/index.mjs'),/withMovensAuth\(movensFalcoWorker, 'admin'\)/);
  assert.equal(await fs.readFile(index,'utf8'),custom);
  const guardModule=await import('data:text/javascript;base64,'+Buffer.from(guard).toString('base64'));
  let calls=0;
  globalThis.__labGuardedWorker=guardModule.withMovensAuth({fetch:async request=>{
    calls++;assert.equal(request.headers.get('Authorization'),null);assert.equal(request.headers.get('Cookie'),null);return new Response('ok');
  }},'admin');
  const source=testEntry('src/index.mjs',prepared.gatewayProfile).replace(/^import worker[^\n]*\n/,'const worker = globalThis.__labGuardedWorker;\n');
  const wrapper=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  delete globalThis.__labGuardedWorker;
  const env={FALCO_TEST_LAB:'true',FALCO_TEST_TOKEN:'a'.repeat(64)};
  assert.equal((await wrapper.default.fetch(new Request('https://lab/health'),env)).status,401);
  assert.equal((await wrapper.default.fetch(new Request('https://lab/health',{headers:{Authorization:'Bearer '+env.FALCO_TEST_TOKEN,Cookie:'production-cookie'}}),env)).status,200);
  assert.equal(calls,1);assert.equal(env.FALCO_GATEWAY_SECRET,undefined);
});
