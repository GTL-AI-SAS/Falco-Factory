import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeActions, validateAction, validateActionResult, isDate } from '../templates/worker/src/action-contract.mjs';
import { createActionController } from '../frontend-kit-template/actions/action-controller.js';
import { createFalcoClient } from '../frontend-kit-template/core/falco-client.js';
import { reservationAction } from '../frontend-kit-template/integration/reservation-actions.example.js';
import { askActionProvider } from '../templates/worker/src/client-actions.mjs';
import worker from '../templates/worker/src/index.mjs';
import { normalizeConfig } from '../lib/args.mjs';
import { generate } from '../lib/generate.mjs';
import { readProject, importLocalProject } from '../lib/projects.mjs';
import { prepareActionUpgrade, applyClientActions } from '../lib/action-updates.mjs';
import { applyRuntimeUpgrade, planRuntimeUpgrade } from '../lib/runtime-upgrades.mjs';
import { randomUUID } from 'node:crypto';

const actions=normalizeActions([reservationAction]);
const action={id:'reservation.create',params:{name:'Carlos',date:'2027-01-15'}};
const requestId='11111111-1111-4111-a111-111111111111';
const proposal=()=>({reply:'Revisa los datos antes de enviar.',action,actionRequestId:requestId,actionDefinition:actions[0]});
const result=(status='success')=>({requestId,action,status,data:{reservationId:'RES-123',date:'2027-01-15'}});
const environment=provider=>({BUSINESS_NAME:'Reservas',PROVIDER:provider,MODEL:'test-model',OPENAI_API_KEY:'FAKE_PROVIDER_SECRET',GEMINI_API_KEY:'FAKE_PROVIDER_SECRET',
  CLIENT_ACTIONS_JSON:JSON.stringify(actions),ALLOWED_ORIGIN:'https://site.example',CHAT_RATE_LIMITER:{limit:async()=>({success:true})}});

test('Factory, browser and Worker share the exact action contract source',async()=>{
  assert.equal(await fs.readFile('templates/worker/src/action-contract.mjs','utf8'),await fs.readFile('frontend-kit-template/actions/action-contract.js','utf8'));
});
test('typed actions support required/optional fields, bounded text/numbers, dates and booleans',()=>{
  const spec=normalizeActions([{...reservationAction,parameters:{...reservationAction.parameters,
    guests:{type:'integer',minimum:1,maximum:12},price:{type:'number',minimum:0,maximum:1000,required:false},outside:{type:'boolean',required:false}}}]);
  assert.ok(validateAction({...action,params:{...action.params,guests:2}},spec));
  for(const values of [{guests:0},{guests:1.5},{guests:'2'},{guests:2,price:Infinity},{guests:2,outside:'yes'},
    {guests:2,name:''},{guests:2,date:'2027-02-29'},{guests:2,date:'mañana'},{guests:2,url:'https://evil.example'}]) {
    assert.equal(validateAction({...action,params:{...action.params,...values}},spec),null);
  }
  assert.equal(validateAction({id:action.id,params:{date:action.params.date}},actions),null);
  assert.equal(isDate('2028-02-29'),true);assert.equal(isDate('2026-04-31'),false);assert.equal(isDate('0000-01-01'),false);
});
test('new schemas default to confirmation and reject executable fields, credentials and unbounded values',()=>{
  const {requiresConfirmation,...implicit}=reservationAction;
  assert.equal(normalizeActions([implicit])[0].requiresConfirmation,true);
  for(const entry of [{...reservationAction,url:'https://evil.example'},{...reservationAction,resultFields:['access_token']},
    {...reservationAction,parameters:{name:{type:'string'}}},{...reservationAction,parameters:{count:{type:'number',minimum:0,maximum:Infinity}}},
    {...reservationAction,parameters:{constructor:{type:'boolean'}}}])assert.throws(()=>normalizeActions([entry]));
});
test('confirmation is enforced by the local controller and concurrent replays invoke the API once',async()=>{
  let calls=0;
  const controller=createActionController(actions,{[action.id]:async(params,context)=>{
    calls++;assert.deepEqual(params,action.params);assert.equal(context.idempotencyKey,requestId);
    await new Promise(resolve=>setTimeout(resolve,10));return {ok:true,data:{reservationId:'RES-123',date:params.date,token:'PRIVATE'}};
  }});
  assert.equal((await controller.dispatch(action,{requestId})).reason,'confirmation_required');assert.equal(calls,0);
  const [a,b]=await Promise.all([controller.dispatch(action,{requestId,confirmed:true}),controller.dispatch(action,{requestId,confirmed:true})]);
  assert.equal(calls,1);assert.deepEqual(a,b);assert.deepEqual(a.result,result());assert.doesNotMatch(JSON.stringify(a),/PRIVATE|token/);
  assert.equal((await controller.dispatch({...action,params:{...action.params,name:'Other'}},{requestId,confirmed:true})).reason,'request_id_reused');assert.equal(calls,1);
});
test('handler failure, missing acknowledgment and timeouts return uncertain outcomes without leaking exceptions',async()=>{
  for(const handler of [async()=>{throw Error('PRIVATE_BACKEND_TOKEN');},async()=>new Response('raw private body'),async()=>new Promise(()=>{})]) {
    const controller=createActionController(actions,{[action.id]:handler});
    const outcome=await controller.dispatch(action,{requestId,confirmed:true,timeoutMs:15});
    assert.equal(outcome.result.status,'unknown');assert.equal(outcome.executed,false);assert.doesNotMatch(JSON.stringify(outcome),/PRIVATE|raw private/);
  }
  const denied=await createActionController(actions,{[action.id]:()=>({ok:false,code:'date_unavailable',message:'Fecha no disponible',data:{reservationId:null,secret:'PRIVATE'}})}).dispatch(action,{requestId,confirmed:true});
  assert.equal(denied.result.status,'error');assert.equal(denied.result.code,'date_unavailable');assert.doesNotMatch(JSON.stringify(denied),/PRIVATE|secret/);
});
test('aborted operations do not start a handler, and results cannot add undeclared public fields',async()=>{
  let calls=0;const control=new AbortController();control.abort();
  const outcome=await createActionController(actions,{[action.id]:()=>{calls++;return {ok:true};}}).dispatch(action,{requestId,confirmed:true,signal:control.signal});
  assert.equal(calls,0);assert.equal(outcome.result.status,'cancelled');
  assert.ok(validateActionResult(result(),actions));
  assert.equal(validateActionResult({...result(),data:{token:'PRIVATE'}},actions),null);
  assert.equal(validateActionResult({...result(),status:'pending'},actions),null);
  assert.equal(validateActionResult({...result(),action:{id:'system.exec',params:{}}},actions),null);
});
test('client feedback is correlated, retryable without repeating the API, and recorded in conversational memory',async()=>{
  const bodies=[];let feedbackCalls=0;
  const client=createFalcoClient({endpoint:'https://worker.example/chat',actions,fetchImpl:async(url,init)=>{
    const body=JSON.parse(init.body);bodies.push(body);
    if(!body.actionResult)return Response.json(proposal());
    if(++feedbackCalls===1)throw Error('NETWORK_SECRET');
    return Response.json({reply:'Reserva confirmada: RES-123.',action}); // Even a bad server cannot start an automatic chain.
  }});
  const proposed=await client.send('Reserva para Carlos el 15 de enero de 2027');assert.equal(proposed.actionRequestId,requestId);
  await assert.rejects(client.send('otra pregunta'),e=>e.code==='action_pending');
  await assert.rejects(client.completeAction({...result(),requestId:randomUUID()}),e=>e.code==='invalid_action_result');
  await assert.rejects(client.completeAction(result()),e=>e.code==='network_error');
  const feedback=await client.retryActionResult();assert.equal(feedback.action,undefined);assert.equal(client.pendingAction,null);
  assert.equal(bodies[1].actionProtocol,2);assert.deepEqual(bodies[1].actionResult,result());
  assert.ok(client.getHistory().some(entry=>entry.content.includes('RES-123')));
  assert.equal(bodies.length,3);
});
test('stale frontend policy is rejected before execution even if action names and fields still match',async()=>{
  const client=createFalcoClient({endpoint:'https://worker.example/chat',actions:[{...reservationAction,requiresConfirmation:false}],fetchImpl:async()=>Response.json(proposal())});
  await assert.rejects(client.send('reserva'),e=>e.code==='invalid_action');assert.equal(client.pendingAction,null);
});
test('OpenAI and Gemini receive history and result data; continuation cannot emit another action',async()=>{
  for(const provider of ['openai','gemini']) {
    let sent;
    const response=await askActionProvider({env:environment(provider),instructions:'Business policy',history:[{role:'user',content:'Me llamo Carlos'}],
      message:'Explica el resultado',actions,actionResult:result(),fetcher:async(url,init)=>{
        sent=JSON.parse(init.body);const text=JSON.stringify({reply:'Reserva RES-123 confirmada.',action});
        return Response.json(provider==='gemini'?{candidates:[{content:{parts:[{text}]}}]}:{output_text:text});
      }});
    assert.equal(response.action,undefined);assert.match(JSON.stringify(sent),/RES-123/);assert.match(JSON.stringify(sent),/Me llamo Carlos/);
    assert.match(JSON.stringify(sent),/UNTRUSTED CLIENT-REPORTED/);
  }
});
test('real Worker endpoint gates old clients, validates feedback before the provider, and adds server-owned proposal metadata',async()=>{
  const originalFetch=globalThis.fetch;let providerCalls=0;
  globalThis.fetch=async()=>{providerCalls++;return Response.json({output_text:JSON.stringify({reply:'Revisa la reserva.',action})});};
  const env=environment('openai');
  const post=body=>worker.fetch(new Request('https://worker.example/chat',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://site.example'},body:JSON.stringify({message:'Reserva',history:[],...body})}),env);
  try {
    const old=await(await post({})).json();assert.equal(old.action,undefined);
    const modern=await(await post({actionProtocol:2})).json();assert.deepEqual(modern.action,action);assert.deepEqual(modern.actionDefinition,actions[0]);assert.match(modern.actionRequestId,/^[a-f0-9-]{36}$/);
    const prior=providerCalls;assert.equal((await post({actionProtocol:2,actionResult:{...result(),data:{secret:'PRIVATE'}}})).status,400);assert.equal(providerCalls,prior);
    const feedback=await(await post({actionProtocol:2,actionResult:result()})).json();assert.equal(feedback.action,undefined);
  } finally {globalThis.fetch=originalFetch;}
});
test('published 1.7 projects upgrade safely, keep profile/account, and import the new contract',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'falco-action-upgrade-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const config=normalizeConfig({name:'falco-action-upgrade',business:'Reservations','auth-profile':'team-a','account-id':'a'.repeat(32)},root);await generate(config);
  const legacy=JSON.parse(await fs.readFile('tests/fixtures/v1.7-runtime.json','utf8'));
  for(const[file,source]of Object.entries(legacy))await fs.writeFile(path.join(config.output,file),source);
  await fs.unlink(path.join(config.output,'src/action-contract.mjs'));
  const p=await readProject(root,config.name),plan=await prepareActionUpgrade(p,actions);assert.equal(plan.runtimePlan.needed,true);
  const backupId=randomUUID();await fs.mkdir(path.join(p.output,'.falco-history'),{recursive:true});
  await applyRuntimeUpgrade(p,plan.runtimePlan,backupId);await applyClientActions(p,actions,plan,backupId);
  const current=await readProject(root,p.folder);assert.equal(current.authProfile,'team-a');assert.equal(current.accountId,'a'.repeat(32));assert.deepEqual(current.actions,actions);
  assert.equal((await planRuntimeUpgrade(current)).needed,false);
  const other=await fs.mkdtemp(path.join(os.tmpdir(),'falco-action-import-'));t.after(()=>fs.rm(other,{recursive:true,force:true}));
  const imported=await importLocalProject(other,p.output);assert.equal((await fs.readFile(path.join(imported.output,'src/action-contract.mjs'),'utf8')).includes('validateActionResult'),true);
});
