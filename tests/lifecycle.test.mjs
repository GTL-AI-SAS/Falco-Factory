import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeConfig } from '../lib/args.mjs';
import { generate } from '../lib/generate.mjs';
import { createUiServer } from '../lib/ui-server.mjs';
import { loadExistingFalco, deleteCloudflareFalco, findLegacySources } from '../lib/worker-lifecycle.mjs';
import { readProject } from '../lib/projects.mjs';

const ACCOUNT = '0a5220fa1002c5f33c00f358bf5085b2';
const OTHER = 'abcdefabcdefabcdefabcdefabcdefab';
const GEMINI = 'falco-gallinas-gemini';
const MOCK = 'falco-gallinas';
const workers = [{name:MOCK},{name:GEMINI}];
const discovery = async ({accountId}) => ({accountId, workers});
async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'falco-v05-'));
  t.after(() => fs.rm(parent,{recursive:true,force:true}));
  const old = path.join(parent, 'GTL_AI_Falco_Factory_v0.2_UN_CLIC');
  const root = path.join(parent, 'Falco-v0.5');
  await fs.mkdir(old,{recursive:true}); await fs.mkdir(root,{recursive:true});
  const c = normalizeConfig({name:GEMINI,business:'Gallinas y Valientes',provider:'gemini',model:'gemini-2.5-flash',origin:'https://example.com','account-id':ACCOUNT},old);
  c.faq = 'Original knowledge verified'; c.instructions = 'Speak Spanish, do not invent prices';
  await generate(c);
  return {parent,old,root};
}

test('one-click load automatically imports matching old v0.2 project without changing Cloudflare',async t=>{
  const e = await fixture(t);
  let touched = 0;
  const result = await loadExistingFalco({root:e.root,accountId:ACCOUNT,name:GEMINI,
    searchRoots:[e.parent],discover:async x=>{touched++;return discovery(x);}});
  assert.equal(result.status,'loaded');
  assert.equal(result.source,'auto-linked');
  assert.equal(touched,1);
  const p = await readProject(e.root,GEMINI);
  assert.equal(p.faq,'Original knowledge verified');
  assert.equal(p.provider,'gemini');
  assert.equal(p.accountId,ACCOUNT);
  assert.equal((await readProject(e.old,GEMINI)).faq, p.faq);
  const second = await loadExistingFalco({root:e.root,accountId:ACCOUNT,name:GEMINI,searchRoots:[e.parent],discover:discovery});
  assert.equal(second.source,'existing-local');
});

test('load never substitutes a different account or Worker',async t=>{
  const e = await fixture(t);
  const wrongAccount = await loadExistingFalco({root:e.root,accountId:OTHER,name:GEMINI,searchRoots:[e.parent],discover:async x=>({accountId:x.accountId,workers})});
  assert.equal(wrongAccount.status,'source-unavailable');
  await assert.rejects(fs.stat(path.join(e.root,'.generated',GEMINI)),/ENOENT/);
  await assert.rejects(loadExistingFalco({root:e.root,accountId:ACCOUNT,name:'falco-unknown',searchRoots:[e.parent],discover:discovery}),/not found/);
});

test('load without local editable source returns explanation, never generates guessed knowledge',async t=>{
  const e = await fixture(t);
  const empty = path.join(e.parent,'empty'); await fs.mkdir(empty);
  const result = await loadExistingFalco({root:e.root,accountId:ACCOUNT,name:MOCK,searchRoots:[empty],discover:discovery});
  assert.equal(result.status,'source-unavailable');
  assert.match(result.message,/editable Falco Factory source/);
  assert.deepEqual(await fs.readdir(e.root),[]);
});

test('search is bounded to known Factory project folders',async t=>{
  const e = await fixture(t);
  const results = await findLegacySources(e.root,GEMINI,{searchRoots:[e.parent]});
  assert.equal(results.length,1); assert.ok(results[0].includes('GTL_AI_Falco_Factory_v0.2_UN_CLIC'));
  await assert.rejects(findLegacySources(e.root,'../../untrusted'),/Invalid Falco/);
});

test('delete sends official Cloudflare DELETE for exact name and account, never returns token',async()=>{
  let called;
  const result = await deleteCloudflareFalco({accountId:ACCOUNT,name:MOCK,
    sessionProvider:async ({accountId})=>({accountId,token:'NEVER-PRINT-THIS'}),
    cloudflareGet:async()=>({found:true}),
    cloudflareFetch:async (url,options)=>{called={url,options};return new Response(JSON.stringify({success:true}),{status:200});},
  });
  assert.equal(result.deleted,true); assert.equal(result.name,MOCK);
  assert.match(called.url,new RegExp(`/accounts/${ACCOUNT}/workers/scripts/${MOCK}$`));
  assert.equal(called.options.method,'DELETE');
  assert.equal(called.options.headers.Authorization,'Bearer NEVER-PRINT-THIS');
  assert.ok(!JSON.stringify(result).includes('NEVER-PRINT-THIS'));
});

test('delete safely rejects wrong account, missing Worker and Cloudflare errors',async()=>{
  await assert.rejects(deleteCloudflareFalco({accountId:ACCOUNT,name:MOCK,
    sessionProvider:async()=>({accountId:OTHER,token:'token'})}),/mismatch/);
  await assert.rejects(deleteCloudflareFalco({accountId:ACCOUNT,name:MOCK,
    sessionProvider:async()=>({accountId:ACCOUNT,token:'token'}),cloudflareGet:async()=>({found:false})}),/no longer exists/);
  await assert.rejects(deleteCloudflareFalco({accountId:ACCOUNT,name:GEMINI,
    sessionProvider:async()=>({accountId:ACCOUNT,token:'token'}),cloudflareGet:async()=>({found:true}),
    cloudflareFetch:async()=>new Response('{"success":false}',{status:200})}),/did not confirm/);
  await assert.rejects(deleteCloudflareFalco({accountId:ACCOUNT,name:'my-other-worker'}),/falco/);
});

test('Studio HTTP protects DELETE with exact name confirmation and checks live inventory',async t=>{
  const e=await fixture(t);
  const removed=[];
  const server=createUiServer({root:e.root,port:0,runner:{cloudWorkers:discovery,
    removeCloudflareWorker:async args=>{removed.push(args);return {deleted:true,name:args.name,accountId:args.accountId};}}});
  const base=await server.listen(); t.after(()=>server.close());
  const token=(await (await fetch(base+'/api/bootstrap')).json()).token;
  const send=async (route,data,{key=token}={})=>{
    const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','Origin':base,'X-Falco-Local-Token':key},body:JSON.stringify(data)});
    return {status:r.status,json:await r.json()};
  };
  let result=await send('/api/cloudflare/workers/delete',{accountId:ACCOUNT,name:MOCK,confirmation:GEMINI,acknowledge:'DELETE'});
  assert.equal(result.status,400); assert.equal(removed.length,0);
  result=await send('/api/cloudflare/workers/delete',{accountId:ACCOUNT,name:MOCK,confirmation:MOCK,acknowledge:'DELETE'},{key:'bad'});
  assert.equal(result.status,403); assert.equal(removed.length,0);
  result=await send('/api/cloudflare/workers/delete',{accountId:ACCOUNT,name:GEMINI,confirmation:GEMINI,acknowledge:'WRONG'});
  assert.equal(result.status,400); assert.equal(removed.length,0);
  result=await send('/api/cloudflare/workers/delete',{accountId:ACCOUNT,name:MOCK,confirmation:MOCK,acknowledge:'DELETE'});
  assert.equal(result.status,200);assert.equal(removed.length,1); assert.equal(removed[0].name,MOCK);
  assert.equal((await fs.readFile(path.join(e.old,'.generated',GEMINI,'src/business-context.mjs'),'utf8')).includes('Original knowledge verified'),true);
});

test('Studio Load Worker API auto-imports local source and opens same Worker knowledge',async t=>{
  const e=await fixture(t);
  const server=createUiServer({root:e.root,port:0,runner:{cloudWorkers:discovery,
    autoLoadWorker:args=>loadExistingFalco({...args,searchRoots:[e.parent]})}});
  const base=await server.listen();t.after(()=>server.close());
  const token=(await (await fetch(base+'/api/bootstrap')).json()).token;
  const r=await fetch(base+'/api/cloudflare/workers/load',{method:'POST',headers:{'Content-Type':'application/json','Origin':base,'X-Falco-Local-Token':token},body:JSON.stringify({accountId:ACCOUNT,name:GEMINI})});
  assert.equal(r.status,200);assert.equal((await r.json()).folder,GEMINI);
  const info=await (await fetch(base+'/api/projects/'+GEMINI)).json();
  assert.equal(info.project.faq,'Original knowledge verified');
  assert.equal(info.project.provider,'gemini');
});
