import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeClientActions, GALLINAS_ACTIONS } from '../lib/client-actions.mjs';
import { readActions, validateProposedAction, parseActionResponse, askActionProvider } from '../templates/worker/src/client-actions.mjs';
import { createActionController } from '../frontend-kit-template/actions/action-controller.js';
import { createFrontendKit } from '../lib/frontend-kit.mjs';
import { createFalcoClient } from '../frontend-kit-template/core/falco-client.js';
import { generate } from '../lib/generate.mjs';
import { normalizeConfig } from '../lib/args.mjs';
import { readProject, previewChanges, listVersions } from '../lib/projects.mjs';
import { createUiServer } from '../lib/ui-server.mjs';
import { getDeployedClientActions, readCloudflareActionBindings } from '../lib/worker-actions.mjs';
import { prepareActionUpgrade } from '../lib/action-updates.mjs';
const ACCOUNT='0a5220fa1002c5f33c00f358bf5085b2';
const ENDPOINT='https://falco-gallinas-gemini.gtl-ai.workers.dev/chat';
const good={id:'demo.open',params:{option:'03'}};

test('closed action manifest validation enforces enums, unique IDs, size limits and no executable URLs',()=>{
 const a=normalizeClientActions(GALLINAS_ACTIONS);
 assert.deepEqual(a,GALLINAS_ACTIONS);
 assert.deepEqual(normalizeClientActions(JSON.stringify(a)),a);
 for (const invalid of [
   [{...a[0],id:'../x'}], [{...a[0],url:'https://evil.example'}],
   [...a,a[0]], [{...a[0],parameters:{option:{type:'number',enum:['01']}}}],
   [{...a[0],parameters:{option:{type:'string',enum:['01','01']}}}],
   Array(9).fill(0).map((_,i)=>({...a[0],id:'action.'+i})),
 ]) assert.throws(()=>normalizeClientActions(invalid));
 assert.deepEqual(normalizeClientActions([]),[]);
});

test('Worker validates provider proposals against configured allowed action ids and exact enum params',()=>{
 const spec=GALLINAS_ACTIONS;
 assert.deepEqual(validateProposedAction(good,spec),good);
 for(const invalid of [
   {id:'demo.delete',params:{option:'03'}},
   {id:'demo.open',params:{option:'04'}},
   {id:'demo.open',params:{option:'03',url:'https://evil.test'}},
   {id:'demo.open',params:{option:'03'},foo:'yes'},
   {id:'demo.open',params:{option:3}},
   {id:'demo.open',params:{option:'__proto__'}},
 ]) assert.equal(validateProposedAction(invalid,spec),null);
 assert.deepEqual(parseActionResponse(JSON.stringify({reply:'Listo',action:good}),spec),{reply:'Listo',action:good});
 assert.deepEqual(parseActionResponse(JSON.stringify({reply:'No disponible',action:{id:'admin.delete',params:{}}}),spec),{reply:'No disponible'});
 assert.throws(()=>parseActionResponse('```json\n{}\n```',spec),/provider_invalid_response/);
 assert.throws(()=>parseActionResponse(JSON.stringify({reply:''}),spec),/provider_invalid_response/);
});

test('Worker returns chat-only if action catalog is empty or invalid',()=>{
 assert.deepEqual(readActions({CLIENT_ACTIONS_JSON:'[]'}),[]);
 assert.deepEqual(readActions({CLIENT_ACTIONS_JSON:'bad'}),[]);
 assert.deepEqual(readActions({CLIENT_ACTIONS_JSON:JSON.stringify([{id:'not.allowed',description:'Some action',parameters:{option:{type:'string',enum:['x']}}}])}).length,1);
});

test('Gemini action mode sends JSON instructions and does not execute provider-proposed actions',async()=>{
 let body; let url;
 const result=await askActionProvider({env:{PROVIDER:'gemini',GEMINI_API_KEY:'secret_fixture_only',MODEL:'gemini-test'}, instructions:'Restaurant policy',history:[],message:'Muéstrame la tres',actions:GALLINAS_ACTIONS,
   fetcher:async(u,options)=>{url=u; body=JSON.parse(options.body);return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({reply:'Te mostraré la tercera opción.',action:good})}]}}]});}});
 assert.match(url,/generativelanguage\.googleapis\.com/);
 assert.equal(body.generationConfig.responseMimeType,'application/json');
 assert.match(body.systemInstruction.parts[0].text,/demo\.open/);
 assert.deepEqual(result.action,good);
 assert.deepEqual(result.reply,'Te mostraré la tercera opción.');
 const rejected=await askActionProvider({env:{PROVIDER:'gemini',GEMINI_API_KEY:'fixture',MODEL:'gemini-test'},instructions:'',history:[],message:'borrar reserva',actions:GALLINAS_ACTIONS,
   fetcher:async()=>Response.json({candidates:[{content:{parts:[{text:JSON.stringify({reply:'No puedo realizar esa operación.',action:{id:'reservation.cancel',params:{}}})}]}}]})});
 assert.equal(rejected.action,undefined);
});

test('browser controller runs only registered local handler, rejects forged requests',async()=>{
 let changed=null;
 const controller=createActionController(GALLINAS_ACTIONS,{'demo.open':({option})=>{changed=option;return {ok:true}}});
 assert.deepEqual(await controller.dispatch(good),{executed:true});
 assert.equal(changed,'03');
 for(const request of [
  {id:'demo.open',params:{option:'99'}},
  {id:'demo.open',params:{option:'01',extra:'foo'}},
  {id:'system.eval',params:{option:'01'}},
 ]){changed=null;const result=await controller.dispatch(request);assert.equal(result.executed,false);assert.equal(changed,null)}
 const inactive=createActionController(GALLINAS_ACTIONS,{});
 assert.deepEqual(await inactive.dispatch(good),{executed:false,reason:'handler_missing'});
});

test('client returns safe action proposal but never executes it automatically',async()=>{
 const client=createFalcoClient({endpoint:ENDPOINT, fetchImpl:async()=>Response.json({reply:'Te llevo a la 03.',action:good})});
 assert.deepEqual((await client.send('Ir a 03')).action,good);
 assert.equal(client.getHistory().length,2);
});

test('Cloudflare action metadata export comes from remote settings; legacy absent means none',async()=>{
 const provider=async()=>({accountId:ACCOUNT});
 const remote=async()=>({found:true,result:{bindings:[{type:'plain_text',name:'CLIENT_ACTIONS_JSON',text:JSON.stringify(GALLINAS_ACTIONS)}]}});
 assert.deepEqual(await getDeployedClientActions({accountId:ACCOUNT,name:'falco-gallinas-gemini',sessionProvider:provider,cloudflareGet:remote}),GALLINAS_ACTIONS);
 assert.deepEqual(readCloudflareActionBindings({bindings:[]}),[]);
 assert.throws(()=>readCloudflareActionBindings({bindings:[{name:'CLIENT_ACTIONS_JSON',type:'plain_text',text:'{broken'}]}));
 const zip=await createFrontendKit({name:'falco-gallinas-gemini',endpoint:ENDPOINT,allowedOrigins:['http://localhost:3000'],actions:GALLINAS_ACTIONS});
 assert.ok(zip.files.includes('ACTIONS_MANIFEST.json'));
 assert.ok(zip.files.includes('ACTION_INTEGRATION_GUIDE.md'));
 assert.ok(zip.files.includes('actions/action-controller.js'));
 assert.ok(!zip.bytes.includes(Buffer.from('secret_fixture_only')));
});

test('existing v1.0 Worker can enable actions with code backup, preserve keys and restore previous manifest',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'falco-actions-migrate-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const conf=normalizeConfig({name:'falco-actions-legacy',business:'Gallinas y Valientes',provider:'gemini',origin:'http://localhost:3000','account-id':ACCOUNT},root);
 conf.faq='FAQ'; conf.instructions='instructions';
 await generate(conf);
 const indexFile=path.join(conf.output,'src/index.mjs');
 const original=await fs.readFile('tests/fixtures/v1.0-worker-index.mjs.txt','utf8');
 await fs.writeFile(indexFile,original);
 await fs.rm(path.join(conf.output,'src/client-actions.mjs'));
 // Reproduce the actual legacy runtime mismatch: the v1.1 shared provider
 // module lacks exports consumed by the v1.6 Client Actions runtime.
 await fs.copyFile('tests/fixtures/v1.1/src/providers/shared.mjs',path.join(conf.output,'src/providers/shared.mjs'));
 const p=await readProject(root,'falco-actions-legacy');
 assert.equal((await prepareActionUpgrade(p,GALLINAS_ACTIONS)).upgrade,true);
 assert.equal(previewChanges(p,{faq:p.faq,instructions:p.instructions,actions:GALLINAS_ACTIONS}).actionsChanged,true);
 const app=createUiServer({root,port:0,runner:{managedPreflight:async()=>{},deploy:async()=>({status:'deployed',url:'https://falco-actions-legacy.gtl-ai.workers.dev',secret:'preserved'}),smoke:async()=>({health:true})}});
 const host=await app.listen(); t.after(()=>app.close());
 const boot=await(await fetch(host+'/api/bootstrap')).json();
 const request=async(data)=>{const r=await fetch(host+'/api/jobs',{method:'POST',headers:{'Content-Type':'application/json','X-Falco-Local-Token':boot.token,Origin:host},body:JSON.stringify(data)});return {status:r.status,body:await r.json()};};
 const poll=async id=>{for(let i=0;i<120;i++){const r=await(await fetch(host+'/api/jobs/'+id)).json();if(['updated','restored','failed','partial'].includes(r.job.status))return r.job;await new Promise(ok=>setTimeout(ok,12));}throw Error('Timed out')};
 let response=await request({mode:'update',folder:p.folder,revision:p.revision,faq:p.faq,instructions:p.instructions,origins:p.origins,actions:GALLINAS_ACTIONS});
 assert.equal(response.status,202);
 let job=await poll(response.body.job.id);
 assert.equal(job.status,'updated',job.error);
 const upgraded=await readProject(root,p.folder);
 assert.deepEqual(upgraded.actions,GALLINAS_ACTIONS);
 assert.match(await fs.readFile(indexFile,'utf8'),/askActionProvider/);
 const repairedShared=await fs.readFile(path.join(conf.output,'src/providers/shared.mjs'),'utf8');
 assert.match(repairedShared,/export function assertUsableOutput/);
 assert.match(repairedShared,/export function providerFailurePayload/);
 assert.equal((await fs.readFile(path.join(conf.output,'wrangler.json'),'utf8')).includes('GEMINI_API_KEY'),false);
 assert.equal((await listVersions(upgraded)).length,1);
 assert.equal(await fs.readFile(path.join(conf.output,'.falco-history',`${job.backupId}.action-pre-upgrade-index.mjs`),'utf8'),original);
 const snapshot=job.backupId;
 response=await request({mode:'restore',folder:p.folder,revision:upgraded.revision,versionId:snapshot});
 job=await poll(response.body.job.id);
 assert.equal(job.status,'restored',job.error);
 const restored=await readProject(root,p.folder);
 assert.deepEqual(restored.actions,GALLINAS_ACTIONS);
 response=await request({mode:'restore-config',folder:p.folder,revision:restored.revision,versionId:snapshot,confirmName:p.name,acknowledge:'RESTORE CONFIG'});
 job=await poll(response.body.job.id);
 assert.equal(job.status,'restored',job.error);
 assert.deepEqual((await readProject(root,p.folder)).actions,[]);
});

test('knowledge-only update repairs a recognized stale provider shared module before deployment',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'falco-provider-compat-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const conf=normalizeConfig({name:'falco-provider-compat',business:'Gallinas y Valientes',provider:'gemini',origin:'http://localhost:3000','account-id':ACCOUNT},root);
 conf.faq='FAQ anterior'; conf.instructions='Instrucciones'; conf.actions=GALLINAS_ACTIONS;
 await generate(conf);
 const sharedFile=path.join(conf.output,'src/providers/shared.mjs');
 await fs.copyFile('tests/fixtures/v1.1/src/providers/shared.mjs',sharedFile);
 const p=await readProject(root,'falco-provider-compat');
 const app=createUiServer({root,port:0,runner:{
   managedPreflight:async()=>{},
   deploy:async()=>({status:'deployed',url:'https://falco-provider-compat.gtl-ai.workers.dev',secret:'preserved'}),
   smoke:async()=>({health:true})
 }});
 const host=await app.listen();t.after(()=>app.close());
 const boot=await(await fetch(host+'/api/bootstrap')).json();
 const request=async(data)=>{
   const r=await fetch(host+'/api/jobs',{method:'POST',headers:{'Content-Type':'application/json','X-Falco-Local-Token':boot.token,Origin:host},body:JSON.stringify(data)});
   return {status:r.status,body:await r.json()};
 };
 const poll=async id=>{
   for(let i=0;i<120;i++){
     const r=await(await fetch(host+'/api/jobs/'+id)).json();
     if(['updated','restored','failed','partial'].includes(r.job.status))return r.job;
     await new Promise(ok=>setTimeout(ok,12));
   }
   throw Error('Timed out');
 };
 const response=await request({mode:'update',folder:p.folder,revision:p.revision,faq:'FAQ actualizado con una nueva línea',instructions:p.instructions,origins:p.origins,actions:GALLINAS_ACTIONS});
 assert.equal(response.status,202);
 const job=await poll(response.body.job.id);
 assert.equal(job.status,'updated',job.error);
 const repaired=await fs.readFile(sharedFile,'utf8');
 assert.match(repaired,/export function assertUsableOutput/);
 assert.match(repaired,/export function providerFailurePayload/);
 const backups=await fs.readdir(path.join(conf.output,'.falco-history'));
 assert.ok(backups.some(name=>name.endsWith('.provider-runtime')));
});

test('customized legacy handler fails closed before any source overwrite',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'falco-actions-unknown-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const c=normalizeConfig({name:'falco-unknown-code',business:'Demo',origin:'http://localhost:3000','account-id':ACCOUNT},root);
 await generate(c);
 const file=path.join(c.output,'src/index.mjs');
 const old=await fs.readFile('tests/fixtures/v1.0-worker-index.mjs.txt','utf8');
 await fs.writeFile(file,old.replace('const MAX_BYTES = 16384;', 'const MAX_BYTES = 32000;'));
 await fs.rm(path.join(c.output,'src/client-actions.mjs'));
 const p=await readProject(root,'falco-unknown-code');
 await assert.rejects(prepareActionUpgrade(p,GALLINAS_ACTIONS),/customized\/unknown/);
});
