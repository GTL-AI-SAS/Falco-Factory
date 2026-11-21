import test from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createUiServer } from '../lib/ui-server.mjs';
import { normalizeConfig } from '../lib/args.mjs';
import { generate } from '../lib/generate.mjs';
import { readProject, previewChanges, listVersions, readVersion, importLocalProject, makeSnapshot } from '../lib/projects.mjs';

const base = { name:'falco-manage-test',business:'Managed Café',provider:'gemini',model:'gemini-2.5-flash',origin:'https://example.com',faq:'FAQ original',instructions:'Be helpful.' };
const accountId='1234567890abcdef1234567890abcdef';
const url='https://falco-manage-test.gtl-ai.workers.dev';
async function setup(t,{runner={}}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'falco-manage-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const c=normalizeConfig({name:base.name,business:base.business,provider:base.provider,model:base.model,origin:base.origin,'account-id':accountId},root);
  Object.assign(c,{faq:base.faq,instructions:base.instructions});
  await generate(c);
  // v0.2 deploy persisted account ID in wrangler.json.
  const server=createUiServer({root,port:0,runner:{managedPreflight:async()=>{},deploy:async()=>({status:'deployed',url,secret:'preserved (not changed)'}),smoke:async()=>({health:{status:'ok'}}),...runner}});
  const origin=await server.listen();
  t.after(()=>server.close());
  const boot=await (await fetch(origin+'/api/bootstrap')).json();
  const request=async(route,data)=>{const response=await fetch(origin+route,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,'X-Falco-Local-Token':boot.token},body:JSON.stringify(data)});return {status:response.status,body:await response.json()};};
  const get=async(route)=>{const r=await fetch(origin+route);return {status:r.status,body:await r.json()};};
  const wait=async(id)=>{for(let i=0;i<100;i++){const r=await get('/api/jobs/'+id);if(['failed','partial','updated','restored'].includes(r.body.job.status))return r.body.job;await new Promise(done=>setTimeout(done,20));}throw Error('Timed out waiting for managed job')};
  return {root,c,server,origin,get,request,wait};
}

test('manage editor reads existing project and previews changes without writing',async t=>{
  const e=await setup(t);
  const listing=await e.get('/api/projects'); assert.equal(listing.body.projects.length,1);
  const details=await e.get('/api/projects/falco-manage-test');
  assert.equal(details.status,200);assert.equal(details.body.project.faq,base.faq);
  const revision=details.body.project.revision;
  const diff=await e.request('/api/projects/falco-manage-test/preview-update',{revision,faq:'FAQ original\nNew special',instructions:base.instructions});
  assert.equal(diff.status,200);assert.equal(diff.body.diff.faq.changed,true);
  assert.equal(diff.body.diff.instructions.changed,false);
  assert.equal((await readProject(e.root,base.name)).revision,revision);
});

test('update changes only knowledge, preserves secret and source code, archives prior version',async t=>{
  let deploymentArgs;let preflightCount=0;
  const e=await setup(t,{runner:{managedPreflight:async()=>{preflightCount++},deploy:async(c,args)=>{deploymentArgs={c,args};return {status:'deployed',url,secret:'preserved (not changed)'}}}});
  const codeBefore=await fs.readFile(path.join(e.c.output,'src/index.mjs'),'utf8');
  const wranglerBefore=await fs.readFile(path.join(e.c.output,'wrangler.json'),'utf8');
  const before=await readProject(e.root,base.name);
  const started=await e.request('/api/jobs',{mode:'update',folder:base.name,revision:before.revision,faq:'FAQ updated with new menu',instructions:base.instructions});
  assert.equal(started.status,202);
  const job=await e.wait(started.body.job.id);
  assert.equal(job.status,'updated');assert.ok(job.backupId);assert.equal(preflightCount,1);
  assert.equal(deploymentArgs.args.preserveSecret,true);assert.equal(deploymentArgs.args.requireExisting,true);
  assert.equal(deploymentArgs.args.apiKey,undefined);
  assert.equal(await fs.readFile(path.join(e.c.output,'src/index.mjs'),'utf8'),codeBefore);
  assert.equal(await fs.readFile(path.join(e.c.output,'wrangler.json'),'utf8'),wranglerBefore);
  const changed=await readProject(e.root,base.name);assert.equal(changed.faq,'FAQ updated with new menu');
  const versions=await listVersions(changed);assert.equal(versions.length,1);
  assert.equal((await readVersion(changed,job.backupId)).config.faq,base.faq);
  assert.ok(!JSON.stringify(job).includes('sensitive-test-api-key'));
});

test('restore previous version redeploys only prior knowledge and archives replaced version',async t=>{
  const e=await setup(t);
  const before=await readProject(e.root,base.name);
  let started=await e.request('/api/jobs',{mode:'update',folder:base.name,revision:before.revision,faq:'Now includes daily dishes',instructions:'New tone'});
  const updated=await e.wait(started.body.job.id);assert.equal(updated.status,'updated');
  const current=await readProject(e.root,base.name);
  started=await e.request('/api/jobs',{mode:'restore',folder:base.name,revision:current.revision,versionId:updated.backupId});
  const restored=await e.wait(started.body.job.id);assert.equal(restored.status,'restored');
  const p=await readProject(e.root,base.name);
  assert.equal(p.faq,base.faq);assert.equal(p.instructions,base.instructions);
  assert.equal((await listVersions(p)).length,2);
  assert.equal((await readVersion(p,restored.backupId)).config.faq,'Now includes daily dishes');
});

test('stale or unchanged edits rejected before a job is created',async t=>{
  const e=await setup(t);const p=await readProject(e.root,base.name);
  const noChange=await e.request('/api/jobs',{mode:'update',folder:p.folder,revision:p.revision,faq:p.faq,instructions:p.instructions});
  assert.equal(noChange.status,409);
  const stale=await e.request('/api/jobs',{mode:'update',folder:p.folder,revision:'0000000',faq:'new info',instructions:p.instructions});
  assert.equal(stale.status,409);
  assert.equal((await listVersions(p)).length,0);
});

test('preflight failure avoids any local write or backup',async t=>{
  const e=await setup(t,{runner:{managedPreflight:async()=>{throw Error('remote Worker not available')}}});
  const p=await readProject(e.root,base.name);
  const started=await e.request('/api/jobs',{mode:'update',folder:p.folder,revision:p.revision,faq:'Changed',instructions:p.instructions});
  const job=await e.wait(started.body.job.id);
  assert.equal(job.status,'failed');assert.match(job.error,/remote Worker/);
  assert.equal((await readProject(e.root,base.name)).revision,p.revision);
  assert.equal((await listVersions(p)).length,0);
});

test('deployment failure after local changes creates PARTIAL with recoverable snapshot',async t=>{
  const e=await setup(t,{runner:{deploy:async()=>{throw Error('Wrangler failed');}}});
  const p=await readProject(e.root,base.name);
  const started=await e.request('/api/jobs',{mode:'update',folder:p.folder,revision:p.revision,faq:'Changed',instructions:p.instructions});
  const job=await e.wait(started.body.job.id);
  assert.equal(job.status,'partial');assert.equal(job.partial,true);assert.ok(job.backupId);
  assert.equal((await listVersions(p)).length,1);
});

test('import from old v0.2 folder copies managed files without touching the original or cloud',async t=>{
  const e=await setup(t);
  const dest=await fs.mkdtemp(path.join(os.tmpdir(),'falco-import-other-'));
  t.after(()=>fs.rm(dest,{recursive:true,force:true}));
  const source=e.c.output;
  await makeSnapshot(await readProject(e.root,base.name),'before_upgrade');
  const imported=await importLocalProject(dest,source);
  assert.equal((await listVersions(imported)).length,1, 'old v0.3 version history survives import');
  assert.equal(imported.name,base.name);
  assert.equal(imported.faq,base.faq);
  assert.equal((await readProject(e.root,base.name)).faq,base.faq);
  await assert.rejects(importLocalProject(dest,source),/already exists/);
  await fs.writeFile(path.join(dest,'.generated','falco-manage-test','src/business-context.mjs'),'tampered');
  assert.equal((await readProject(e.root,base.name)).faq,base.faq);
});

test('managed projects reject invalid files, tampering and version traversal',async t=>{
  const e=await setup(t);
  const p=await readProject(e.root,base.name);
  await assert.rejects(readVersion(p,'../../etc/passwd'),/Invalid snapshot ID/);
  assert.throws(()=>previewChanges(p,{faq:'x'.repeat(24001),instructions:'okay'}),/faq must/);
  await fs.rm(path.join(p.output,'src/index.mjs'));
  await fs.symlink(path.join(p.output,'wrangler.json'),path.join(p.output,'src/index.mjs'));
  await assert.rejects(readProject(e.root,base.name),/regular/);
});


test('legacy Gemini Worker can add origins without modifying knowledge, credentials or URL; restore works', async t => {
  const e = await setup(t);
  const current = await readProject(e.root, base.name);
  const code = await fs.readFile(path.join(current.output, 'src/index.mjs'), 'utf8');
  // Existing project was generated with current v0.7 runtime: replace with the exact older CORS snippet
  // to validate the upgrade of real v0.2/0.6 projects.
  const old = `    const allowed = env.ALLOWED_ORIGIN;
    const cors = origin && origin === allowed ? corsHeaders(origin) : { Vary: 'Origin' };
    if (origin && origin !== allowed) return error('origin_not_allowed', 403, cors);`;
  const modern = String.raw`    // Prefer the JSON allowlist; retain legacy ALLOWED_ORIGIN for older deployments.
    // Invalid JSON fails closed instead of silently broadening browser access.
    let allowed = [];
    if (env.ALLOWED_ORIGINS !== undefined) {
      try {
        const parsed = JSON.parse(env.ALLOWED_ORIGINS);
        if (Array.isArray(parsed)) allowed = parsed.filter(o => typeof o === 'string');
      } catch { /* invalid CORS configuration: fail closed */ }
    } else if (env.ALLOWED_ORIGIN) allowed = [env.ALLOWED_ORIGIN];
    const isAllowed = Boolean(origin && origin !== 'null' && /^https?:\/\//.test(origin) && allowed.includes(origin));
    const cors = isAllowed ? corsHeaders(origin) : { Vary: 'Origin' };
    if (origin && !isAllowed) return error('origin_not_allowed', 403, cors);`;
  assert.ok(code.includes(modern));
  await fs.writeFile(path.join(current.output, 'src/index.mjs'), code.replace(modern, old));
  const jsonFile = path.join(current.output, 'wrangler.json');
  const wrangler = JSON.parse(await fs.readFile(jsonFile, 'utf8'));
  delete wrangler.vars.ALLOWED_ORIGINS;
  await fs.writeFile(jsonFile, JSON.stringify(wrangler, null, 2));
  const legacy = await readProject(e.root, base.name);
  const origins = ['https://example.com', 'https://gtl-ai-sas.github.io','http://localhost:3000'];
  const pre = await e.request('/api/projects/falco-manage-test/preview-update', {revision:legacy.revision,faq:legacy.faq,instructions:legacy.instructions,origins});
  assert.equal(pre.body.diff.originsChanged,true);
  assert.equal(pre.body.diff.faq.changed,false);
  const started = await e.request('/api/jobs',{mode:'update',folder:legacy.folder,revision:legacy.revision,faq:legacy.faq,instructions:legacy.instructions,origins});
  const job = await e.wait(started.body.job.id);
  assert.equal(job.status,'updated');
  const changed = await readProject(e.root, base.name);
  assert.deepEqual(changed.origins,origins);
  assert.equal(changed.faq,legacy.faq);
  const updatedCode = await fs.readFile(path.join(changed.output,'src/index.mjs'),'utf8');
  assert.match(updatedCode,/ALLOWED_ORIGINS/);
  execFileSync(process.execPath,['--check',path.join(changed.output,'src/index.mjs')]);
  assert.ok((await fs.readFile(jsonFile,'utf8')).includes('ALLOWED_ORIGINS'));
  assert.deepEqual((await readVersion(changed,job.backupId)).config.origins,['https://example.com']);
  assert.ok((await fs.readFile(path.join(changed.output,'.falco-history',`${job.backupId}.src-index.mjs`),'utf8')).includes('const allowed = env.ALLOWED_ORIGIN'));
  const restored = await e.request('/api/jobs',{mode:'restore',folder:changed.folder,revision:changed.revision,versionId:job.backupId});
  assert.equal((await e.wait(restored.body.job.id)).status,'restored');
  assert.deepEqual((await readProject(e.root,base.name)).origins,['https://example.com']);
});
