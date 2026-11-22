import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeCloudflareWorkers, mergeRemoteWithLocal, discoverCloudflareWorkers } from '../lib/cloudflare-workers.mjs';
import { createUiServer } from '../lib/ui-server.mjs';
import { normalizeConfig } from '../lib/args.mjs';
import { generate } from '../lib/generate.mjs';

const ID='0a5220fa1002c5f33c00f358bf5085b2';
const OTHER='abcdefabcdefabcdefabcdefabcdefab';
const SCRIPTS=[{id:'falco-gallinas',created_on:'2026-11-21T12:00:00Z'},{id:'falco-gallinas-gemini',modified_on:'2026-11-21T16:00:00Z'}];

function mock() { return SCRIPTS.map(x => ({name:x.id,createdOn:x.created_on||null,modifiedOn:x.modified_on||null})); }

async function makeServer(t, { withLocal=false, workerList=mock(), cloudWorks }={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'falco-cloud-list-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  if(withLocal){
    const c=normalizeConfig({name:'falco-gallinas-gemini',business:'Gallinas y Valientes',provider:'gemini',model:'gemini-2.5-flash',origin:'http://localhost:3000','account-id':ID},root);
    Object.assign(c,{faq:'Test FAQ',instructions:'Test instructions'});
    await generate(c);
  }
  const calls=[];
  const server=createUiServer({root,port:0,runner:{cloudWorkers: cloudWorks || (async({accountId})=>{calls.push(accountId);return {accountId:accountId||ID,workers:workerList};})}});
  const base=await server.listen();
  t.after(()=>server.close());
  const get=async (uri)=>{const r=await fetch(base+uri);return {status:r.status,body:await r.json()};};
  return {root,base,get,calls};
}

test('Cloudflare list normalizes Worker IDs and excludes API token or unknown fields',()=>{
  const result=normalizeCloudflareWorkers([
    {id:'falco-gallinas',token:'SECRET_DO_NOT_EXPOSE',created_on:'2026-11-21T12:00:00Z'},
    {id:'falco-gallinas'}, {id:'falco-bakery',created_on:'bad'}, {id:'../../invalid'}, {}, null,
  ]);
  assert.deepEqual(result.map(x=>x.name), ['falco-bakery','falco-gallinas']);
  assert.equal(result[0].createdOn,null);
  assert.ok(!JSON.stringify(result).includes('SECRET_DO_NOT_EXPOSE'));
  assert.throws(()=>normalizeCloudflareWorkers({result:[]}),/unexpected/);
});

test('read-only discoverCloudflareWorkers retrieves scripts through Cloudflare account API',async()=>{
  let calledEndpoint,calledAccount;
  const result=await discoverCloudflareWorkers({accountId:ID,
    sessionProvider:async ({accountId})=>({accountId,token:'secret'}),
    cloudflareGet:async (session,endpoint)=>{
      calledEndpoint=endpoint;calledAccount=session.accountId;
      return {found:true,result:SCRIPTS};
    },
  });
  assert.equal(calledEndpoint,'/workers/scripts');assert.equal(calledAccount,ID);
  assert.deepEqual(result.workers.map(x=>x.name),['falco-gallinas','falco-gallinas-gemini']);
  assert.ok(!JSON.stringify(result).includes('secret'));
  await assert.rejects(discoverCloudflareWorkers({accountId:'oops'}),/Account ID/);
});

test('remote-only Workers still display even with no local projects',async t=>{
  const e=await makeServer(t);
  const response=await e.get('/api/cloudflare/workers');
  assert.equal(response.status,200);
  assert.equal(response.body.accountId,ID);
  assert.equal(response.body.workers.length,2);
  assert.ok(response.body.workers.every(x=>x.source==='remote-only' && !x.editable && x.folder===null));
  assert.deepEqual(e.calls,['']);
  assert.equal((await e.get('/api/projects')).body.projects.length,0);
});

test('matching local source is editable; remote-only remains read-only',async t=>{
  const e=await makeServer(t,{withLocal:true});
  const body=(await e.get(`/api/cloudflare/workers?accountId=${ID}`)).body;
  const mockRow=body.workers.find(x=>x.name==='falco-gallinas');
  const geminiRow=body.workers.find(x=>x.name==='falco-gallinas-gemini');
  assert.equal(mockRow.source,'remote-only');assert.equal(mockRow.editable,false);
  assert.equal(geminiRow.source,'linked');assert.equal(geminiRow.editable,true);
  assert.equal(geminiRow.folder,'falco-gallinas-gemini');
  assert.equal(geminiRow.provider,'gemini');
});

test('account mismatch cannot be presented as editable',async t=>{
  const e=await makeServer(t,{withLocal:true,cloudWorks:async()=>({accountId:OTHER,workers:mock()})});
  const body=(await e.get(`/api/cloudflare/workers?accountId=${OTHER}`)).body;
  const gemini=body.workers.find(x=>x.name==='falco-gallinas-gemini');
  assert.equal(gemini.source,'account-mismatch');assert.equal(gemini.editable,false);
});

test('invalid account IDs rejected before Cloudflare request',async t=>{
  const e=await makeServer(t);
  const r=await e.get('/api/cloudflare/workers?accountId=../oops');
  assert.equal(r.status,400);
  assert.match(r.body.error,/Account ID/);
  assert.equal(e.calls.length,0);
});

test('Cloudflare errors are visible, not presented as empty account',async t=>{
  const e=await makeServer(t,{cloudWorks:async()=>{throw new Error('Cloudflare API HTTP 403. Check permissions.');}});
  const r=await e.get('/api/cloudflare/workers');
  assert.notEqual(r.status,200);
  assert.match(r.body.error,/403/);
});

test('linking a remote Worker refuses a source with wrong Worker name or account ID',async t=>{
  const e=await makeServer(t,{withLocal:true});
  const dest=await fs.mkdtemp(path.join(os.tmpdir(),'falco-cloud-import-'));
  t.after(()=>fs.rm(dest,{recursive:true,force:true}));
  const {importLocalProject}=await import('../lib/projects.mjs');
  const source=path.join(e.root,'.generated','falco-gallinas-gemini');
  await assert.rejects(importLocalProject(dest,source,{expectedName:'falco-gallinas',expectedAccountId:ID}),/does not match/);
  await assert.rejects(importLocalProject(dest,source,{expectedName:'falco-gallinas-gemini',expectedAccountId:OTHER}),/different Cloudflare account/);
  await assert.rejects(fs.stat(path.join(dest,'.generated','falco-gallinas-gemini')),/ENOENT/);
  assert.equal((await fs.readFile(path.join(source,'wrangler.json'),'utf8')).includes(ID),true);
});


test('Cloudflare auth diagnostics endpoint returns safe metadata only',async t=>{
  const e=await makeServer(t);
  // The default endpoint is allowed to report unauthenticated state without leaking raw Wrangler output.
  const r=await e.get('/api/cloudflare');
  assert.equal(r.status,200);
  assert.equal(typeof r.body.connected,'boolean');
  assert.ok(r.body.permissions);
  assert.ok(!JSON.stringify(r.body).includes('token'));
});

test('merger isolates Workers from separate accounts',()=>{
  const linked={name:'falco-one',folder:'falco-one',accountId:ID,business:'Alpha',provider:'mock'};
  const list=[{name:'falco-one'}];
  assert.equal(mergeRemoteWithLocal(list,[linked],ID)[0].source,'linked');
  assert.equal(mergeRemoteWithLocal(list,[linked],OTHER)[0].source,'account-mismatch');
});
