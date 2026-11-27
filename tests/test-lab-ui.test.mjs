import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { labFixture } from './helpers/test-lab.mjs';
import { createUiServer } from '../lib/ui-server.mjs';
import { TEST_MARKERS } from '../lib/test-lab-templates.mjs';

async function serverFixture(t,options={}) {
  const f=await labFixture(t,options);
  const app=createUiServer({root:f.root,port:0,runner:{session:f.sessionReader,remoteReader:f.remoteReader,
    preview:f.dependencies.preview,previewFetch:f.fetcher,testLabEnv:{},
    readDeployedProject:async()=>({vars:{},knowledge:{faq:f.project.faq,instructions:f.project.instructions},actions:f.project.actions,remote:f.production})}});
  const url=await app.listen();t.after(()=>app.close());
  const {token}=await (await fetch(url+'/api/bootstrap')).json();
  const post=async(route,data,headers={})=>{
    const response=await fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json','X-Falco-Local-Token':token,...headers},body:JSON.stringify(data)});
    return {status:response.status,body:await response.json()};
  };
  const read=async route=>(await fetch(url+route)).json();
  const job=async job=>{for(let n=0;n<100;n++){const result=await read('/api/jobs/'+job.id);if(['ready','failed'].includes(result.job.status))return result.job;await new Promise(r=>setTimeout(r,20));}throw Error('Job did not finish');};
  return {...f,app,url,token,post,read,job};
}

test('Studio API authenticates launch/chat/Toy writes/cleanup, tracks jobs and blocks production conflicts',async t=>{
  const f=await serverFixture(t);
  assert.equal((await f.post('/api/test-lab/start',f.input,{'X-Falco-Local-Token':'bad'})).status,403);
  const eligible=await f.read('/api/test-lab/projects/'+f.project.folder+'/eligibility');assert.equal(eligible.eligible,true);
  const start=await f.post('/api/test-lab/start',f.input);assert.equal(start.status,202);
  const completed=await f.job(start.body.job);assert.equal(completed.status,'ready',completed.error);
  const status=await f.read('/api/test-lab/status'),session=status.sessions[0];assert.equal(session.state,'ready');
  assert.equal((await f.post('/api/studio/reopen',{})).status,200,'An active Lab permits reopening Studio without cleanup');
  assert.equal((await f.read('/api/test-lab/status')).sessions[0].id,session.id,'Reopening preserves the active Lab');
  assert.doesNotMatch(JSON.stringify(status),/dedicated-provider-key|cloudflare-management-secret/);
  const route='/api/test-lab/sessions/'+session.id;
  assert.equal((await f.post(route+'/chat',{message:'Hi'})).status,200);
  assert.equal((await f.post(route+'/chat',{message:'Hi',url:'https://evil'})).status,400);
  assert.equal((await f.post('/api/jobs',{mode:'settings',folder:f.project.folder})).status,409);
  assert.equal((await f.post('/api/connections/save',{})).status,409);
  assert.equal((await f.post('/api/cloudflare/workers/delete',{})).status,409);
  assert.equal((await fetch(f.url+route+'/toy-db/records?entity=customer')).status,403);
  const requestId=randomUUID();
  const create=await f.post(route+'/toy-db/records',{type:'customer',name:'Toy Client'},
    {'X-Falco-Action-Request-Id':requestId,'X-Falco-Action-Id':'toy.create_record'});
  assert.equal(create.status,201);
  const get=await fetch(f.url+route+'/toy-db/records?entity=weekly_expenses',{headers:{'X-Falco-Local-Token':f.token,
    'X-Falco-Action-Request-Id':randomUUID(),'X-Falco-Action-Id':'toy.read_record'}});
  assert.equal(get.status,200);assert.equal((await get.json()).data.total,1245.80);
  assert.equal((await f.read(route+'/inspector')).records.length,2);
  assert.equal((await f.post(route+'/end',{confirmation:'wrong'})).status,400);
  const end=await f.post(route+'/end',{confirmation:session.previewName});assert.equal(end.status,202);
  assert.equal((await f.job(end.body.job)).status,'ready');assert.equal((await f.read('/api/test-lab/status')).sessions.length,0);
});

test('Studio marks each independently contaminated local field as emergency before normal operations',async t=>{
  const f=await serverFixture(t);const file=path.join(f.project.output,'src/business-context.mjs');
  await fs.writeFile(file,`export const businessInstructions = ${JSON.stringify(TEST_MARKERS.instructions)};\nexport const faqText = "safe";\n`);
  const response=await fetch(f.url+'/api/projects/'+f.project.folder);assert.equal(response.status,400);
  const state=await f.read('/api/test-lab/status');assert.equal(state.emergencies.length,1);assert.match(state.emergencies[0].reason,/instructions/);
  assert.equal((await f.post('/api/jobs',{})).status,409);
});

test('Studio serves shared controller and dedicated Lab module under the existing CSP',async t=>{
  const f=await serverFixture(t);
  for(const asset of ['/test-lab.js','/test-lab-actions.js','/actions/action-controller.js','/actions/action-contract.js']){
    const response=await fetch(f.url+asset);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/javascript/);
    assert.match(response.headers.get('content-security-policy'),/connect-src 'self'/);
  }
});

test('Studio explains disabled Preview routing in eligibility and prevents a remote creation attempt',async t=>{
  const f=await serverFixture(t,{flags:{previewUrlsDisabled:true}});
  const result=await f.read('/api/test-lab/projects/'+f.project.folder+'/eligibility');
  assert.equal(result.eligible,false);assert.match(result.reason,/Preview URLs are disabled/);
  assert.equal(f.commands.length,0);
});

test('reservation route requires authentication, validates both fields and persists real Inspector calls',async t=>{
  const f=await serverFixture(t),start=await f.post('/api/test-lab/start',f.input);
  assert.equal((await f.job(start.body.job)).status,'ready');
  const session=(await f.read('/api/test-lab/status')).sessions[0],route='/api/test-lab/sessions/'+session.id;
  const requestId=randomUUID(),headers={'X-Falco-Action-Request-Id':requestId,'X-Falco-Action-Id':'toy.create_reservation'};
  assert.equal((await f.post(route+'/toy-db/reservations',{name:'Ana Torres',date:'2027-01-15'},{...headers,'X-Falco-Local-Token':'bad'})).status,403);
  assert.equal((await f.post(route+'/toy-db/reservations',{name:'Ana Torres'},headers)).status,400);
  const created=await f.post(route+'/toy-db/reservations',{name:'Ana Torres',date:'2027-01-15'},headers);
  assert.equal(created.status,201);assert.match(created.body.data.reservationId,/TEST-R-/);
  const logs=(await f.read(route+'/inspector')).records;assert.equal(logs.length,2);assert.match(logs[1].endpoint,/\/reservations$/);
  const end=await f.post(route+'/end',{confirmation:session.previewName});assert.equal((await f.job(end.body.job)).status,'ready');
});
