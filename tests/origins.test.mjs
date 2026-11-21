import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrigins, readCloudflareOriginsBindings } from '../lib/origins.mjs';
import { getDeployedOrigins } from '../lib/worker-origins.mjs';
import { normalizeConfig } from '../lib/args.mjs';
import { buildConfig } from '../lib/generate.mjs';
import { cfGet } from '../lib/deploy.mjs';
const accountId='a'.repeat(32), name='falco-gallinas-gemini';
test('one or multiple HTTPS sites and localhost are valid exact origins',()=>{
  const origins=normalizeOrigins('http://localhost:3000\nhttps://gtl-ai-sas.github.io\nhttps://gallinas.pages.dev');
  assert.equal(origins.length,3);
  assert.deepEqual(JSON.parse(buildConfig(normalizeConfig({name,business:'Gallinas',origins})).vars.ALLOWED_ORIGINS),origins);
  for(const bad of ['null','*','file://C:/index.html','http://remote.com','https://example.com/path','https://example.com/','https://*.pages.dev','https://example.com?x=1'])
    assert.throws(()=>normalizeOrigins([bad]));
  assert.throws(()=>normalizeOrigins(['https://example.com','https://example.com']),/Duplicate/);
});
test('Cloudflare read uses deployed plain_text bindings, not unrelated secrets',()=>{
  assert.deepEqual(readCloudflareOriginsBindings({bindings:[{type:'secret_text',name:'GEMINI_API_KEY'}, {type:'plain_text',name:'ALLOWED_ORIGINS',text:'["https://site.example","http://localhost:3000"]'}]}),['https://site.example','http://localhost:3000']);
  assert.deepEqual(readCloudflareOriginsBindings({bindings:[{type:'plain_text',name:'ALLOWED_ORIGIN',text:'https://site.example'}]}),['https://site.example']);
  assert.throws(()=>readCloudflareOriginsBindings({bindings:[{type:'secret_text',name:'ALLOWED_ORIGINS'}]}),/No allowed-origin/);
});
test('Remote metadata endpoint requires the correct account and refuses unavailable Worker settings',async()=>{
  let requested='';
  const options={accountId,name,sessionProvider:async()=>({accountId}), cloudflareGet:async(s,url)=>{requested=url;return {found:true,result:{bindings:[{type:'plain_text',name:'ALLOWED_ORIGIN',text:'https://site.example'}]}}}};
  assert.deepEqual(await getDeployedOrigins(options),['https://site.example']);
  assert.equal(requested,`/workers/scripts/${name}/settings`);
  await assert.rejects(getDeployedOrigins({...options,cloudflareGet:async()=>({found:false})}),/Export refused/);
  await assert.rejects(getDeployedOrigins({...options,sessionProvider:async()=>({accountId:'b'.repeat(32)})}),/account mismatch/);
});


test('Cloudflare cfGet parses /scripts/name/settings JSON instead of discarding the Worker settings body',async()=>{
  const oldFetch=globalThis.fetch;
  try {
    let counter=0;
    globalThis.fetch=async(url,opts)=>{counter++;assert.match(url,/\/workers\/scripts\/falco-gallinas-gemini\/settings$/);assert.match(opts.headers.Authorization,/^Bearer /);return Response.json({success:true,result:{bindings:[{type:'plain_text',name:'ALLOWED_ORIGIN',text:'https://site.example'}]}})};
    const data=await cfGet({accountId,token:'TEST_TOKEN_NOT_REAL'},`/workers/scripts/${name}/settings`);
    assert.equal(data.found,true);
    assert.deepEqual(readCloudflareOriginsBindings(data.result),['https://site.example']);
    assert.equal(counter,1);
  } finally {globalThis.fetch=oldFetch;}
});
