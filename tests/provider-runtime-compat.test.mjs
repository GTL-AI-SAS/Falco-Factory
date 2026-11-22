import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { planProviderSharedRepair, applyProviderSharedRepair } from '../lib/provider-runtime-compat.mjs';

const OLD_SHARED = await fs.readFile('tests/fixtures/v1.1/src/providers/shared.mjs','utf8');
const CURRENT_SHARED = await fs.readFile('templates/worker/src/providers/shared.mjs','utf8');
const INDEX = "import { ProviderError, providerFailurePayload } from './providers/shared.mjs';\n";
const ACTIONS = "import { ProviderError, assertUsableOutput } from './providers/shared.mjs';\n";

async function project(t, shared = OLD_SHARED) {
  const output = await fs.mkdtemp(path.join(os.tmpdir(),'falco-provider-runtime-'));
  t.after(()=>fs.rm(output,{recursive:true,force:true}));
  await fs.mkdir(path.join(output,'src/providers'),{recursive:true});
  await fs.writeFile(path.join(output,'src/providers/shared.mjs'),shared);
  await fs.writeFile(path.join(output,'src/index.mjs'),INDEX);
  await fs.writeFile(path.join(output,'src/client-actions.mjs'),ACTIONS);
  return { output };
}

test('provider compatibility detects missing exports in the exact known v1.1 shared module',async t=>{
  const p=await project(t);
  const plan=await planProviderSharedRepair(p);
  assert.equal(plan.needed,true);
  assert.deepEqual(plan.missing,['assertUsableOutput','providerFailurePayload']);
  assert.equal(plan.file,'src/providers/shared.mjs');
  assert.equal(plan.newSource,CURRENT_SHARED);
});

test('provider compatibility refuses customized or unknown shared modules without changing them',async t=>{
  const custom=OLD_SHARED+'\n// custom local modification\n';
  const p=await project(t,custom);
  await assert.rejects(planProviderSharedRepair(p),/customized or not a recognized official Factory version/);
  assert.equal(await fs.readFile(path.join(p.output,'src/providers/shared.mjs'),'utf8'),custom);
});

test('provider compatibility repair snapshots old shared source and updates the runtime manifest',async t=>{
  const p=await project(t);
  const id=randomUUID();
  await fs.writeFile(path.join(p.output,'.falco-runtime.json'),JSON.stringify({
    schema:1,version:'1.1.0',files:{'src/providers/shared.mjs':'old-hash'}
  }));
  const plan=await planProviderSharedRepair(p);
  const result=await applyProviderSharedRepair(p,plan,id);
  assert.equal(result.repaired,true);
  assert.equal(await fs.readFile(path.join(p.output,'src/providers/shared.mjs'),'utf8'),CURRENT_SHARED);
  assert.equal(await fs.readFile(path.join(p.output,'.falco-history',`${id}.provider-runtime`,'src/providers/shared.mjs'),'utf8'),OLD_SHARED);
  const manifest=JSON.parse(await fs.readFile(path.join(p.output,'.falco-runtime.json'),'utf8'));
  assert.notEqual(manifest.files['src/providers/shared.mjs'],'old-hash');
});

test('current provider shared module requires no compatibility repair',async t=>{
  const p=await project(t,CURRENT_SHARED);
  const plan=await planProviderSharedRepair(p);
  assert.equal(plan.needed,false);
});
