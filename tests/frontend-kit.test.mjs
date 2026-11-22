import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { createFrontendKit, validateKitInfo } from '../lib/frontend-kit.mjs';
import { createFalcoClient, FalcoError } from '../frontend-kit-template/core/falco-client.js';
import { createUiServer } from '../lib/ui-server.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStaticServer } from '../frontend-kit-template/integration/tools/falco-static-server.mjs';

const ACCOUNT_ID = '0a5220fa1002c5f33c00f358bf5085b2';
const WORKER = 'falco-gallinas-gemini';
const ENDPOINT = `https://${WORKER}.gtl-ai.workers.dev/chat`;

function unzipBuffer(buffer) {
  const files = new Map();
  let cursor = 0;
  while (buffer.readUInt32LE(cursor) === 0x04034b50) {
    assert.equal(buffer.readUInt16LE(cursor + 8), 8);
    const compressedSize = buffer.readUInt32LE(cursor + 18);
    const nameLength = buffer.readUInt16LE(cursor + 26);
    const extraLength = buffer.readUInt16LE(cursor + 28);
    const filename = buffer.subarray(cursor + 30, cursor + 30 + nameLength).toString('utf8');
    const first = cursor + 30 + nameLength + extraLength;
    files.set(filename, inflateRawSync(buffer.subarray(first, first + compressedSize)).toString('utf8'));
    cursor = first + compressedSize;
  }
  assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
  assert.ok(buffer.includes(Buffer.from('PK\x05\x06')));
  return files;
}

test('kit exports its public files, Windows launchers, mandatory agent instructions and no secrets', async () => {
  const kit = await createFrontendKit({ name: WORKER, endpoint: ENDPOINT, allowedOrigins: ['http://localhost:3000', 'https://gtl-ai-sas.github.io'] });
  const files = unzipBuffer(kit.bytes);
  assert.equal(files.size, 23);
  assert.match(files.get('config/falco.config.js'), /https:\/\/falco-gallinas-gemini\.gtl-ai\.workers\.dev\/chat/);
  assert.match(files.get('README.md'), /http:\/\/localhost:3000/);
  assert.match(files.get('ALLOWED_ORIGINS.md'), /gtl-ai-sas.github.io/);
  assert.match(files.get('AGENT_GUIDE.md'), /transport/);
  assert.match(files.get('AGENT_GUIDE.md'), /MANDATORY DELIVERY CONTRACT/);
  assert.match(files.get('LEER_PRIMERO_AGENTE.md'), /ABRIR_DEMO\.cmd/);
  assert.match(files.get('LEER_PRIMERO_AGENTE.md'), /RAÍZ de la web FINAL/);
  assert.match(files.get('LEER_PRIMERO_AGENTE.md'), /file:\/\//);
  assert.match(files.get('ABRIR_FALCO_KIT.cmd'), /node\.exe .*demo\\server\.mjs/);
  assert.match(files.get('integration/ABRIR_DEMO.cmd'), /node\.exe .*falco-static-server\.mjs/);
  assert.match(files.get('integration/tools/falco-static-server.mjs'), /createStaticServer/);
  assert.match(files.get('widget/falco-widget.js'), /createFalcoClient/);
  assert.match(files.get('demo/index.html'), /falco-widget/);
  assert.ok(![...files.values()].join('\n').includes('__FALCO_CONFIG__'));
  assert.ok(![...files.values()].join('\n').includes('__WORKER_NAME__'));
  assert.ok(![...files.values()].join('\n').includes('CLOUDFLARE_API_TOKEN'));
  assert.ok(![...files.values()].join('\n').includes('GEMINI_API_KEY'));
  assert.ok(![...files.values()].join('\n').includes('OPENAI_API_KEY'));
});

test('kit validates worker identity and safe HTTPS endpoint', () => {
  assert.throws(() => validateKitInfo({name:'../bad', endpoint:ENDPOINT}), /valid Falco Worker/);
  assert.throws(() => validateKitInfo({name:WORKER, endpoint:'http://external.example/chat'}), /HTTPS/);
  assert.throws(() => validateKitInfo({name:WORKER, endpoint:'https://example.com/chat?api_key=secret'}), /HTTPS/);
  assert.deepEqual(validateKitInfo({name:WORKER, endpoint:ENDPOINT, allowedOrigins:['http://localhost:3000']}).name, WORKER);
});

test('core client sends bounded successful history, then resets', async () => {
  const bodies = [];
  const client = createFalcoClient({ endpoint:ENDPOINT, maxHistory:8, fetchImpl:async (url, init) => {
    assert.equal(url, ENDPOINT);
    bodies.push(JSON.parse(init.body));
    return {ok:true, status:200, json:async()=>({reply:'a'.repeat(1200)})};
  } });
  for (let i=0; i<6; i++) await client.send(`question ${i}`);
  assert.equal(bodies[0].history.length,0);
  assert.equal(bodies[5].history.length,8);
  assert.ok(bodies[5].history.every(item => item.content.length <= 1000));
  assert.equal(client.getHistory().length,8);
  client.reset();
  assert.deepEqual(client.getHistory(),[]);
});

test('core client rejects oversize messages without network call, and handles rate limits', async () => {
  let calls=0;
  const client=createFalcoClient({endpoint:ENDPOINT,fetchImpl:async()=>{calls++; return {ok:false,status:429,json:async()=>({error:'rate_limited'})};}});
  await assert.rejects(client.send('x'.repeat(2001)), e=>e.code==='invalid_message');
  assert.equal(calls,0);
  await assert.rejects(client.send('Hola'), e=>e instanceof FalcoError && e.code==='rate_limited' && e.status===429);
  assert.equal(client.getHistory().length,0);
});

test('core client surfaces network errors without leaking raw fetch exception or user message', async () => {
  const client=createFalcoClient({endpoint:ENDPOINT, fetchImpl:async()=>{throw new Error('SECRET_FETCH_INTERNAL');}});
  await assert.rejects(client.send('Hola'), e=>e.code==='network_error' && !e.message.includes('SECRET_FETCH_INTERNAL'));
});

test('Studio export endpoint sends an actual ZIP without changing Workers or using project files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'falco-kit-test-'));
  let discoveryCount=0, endpointCount=0;
  const app = createUiServer({root,port:0,runner:{
    cloudWorkers:async()=>{discoveryCount++;return {accountId:ACCOUNT_ID,workers:[{name:WORKER}]};},
    workerEndpoint:async()=>{endpointCount++;return ENDPOINT;},
    remoteOrigins:async()=>['http://localhost:3000','https://gtl-ai-sas.github.io'],
    remoteActions:async()=>[],
  }});
  const base=await app.listen();
  t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
  const bootstrap=await (await fetch(`${base}/api/bootstrap`)).json();
  const post=(body,headers={})=>fetch(`${base}/api/frontend-kit/export`,{method:'POST',headers:{'Content-Type':'application/json', 'X-Falco-Local-Token':bootstrap.token, Origin:base,...headers},body:JSON.stringify(body)});
  const unauthorized=await post({accountId:ACCOUNT_ID,name:WORKER},{'X-Falco-Local-Token':'invalid'});
  assert.equal(unauthorized.status,403);
  const absent=await post({accountId:ACCOUNT_ID,name:'falco-absent'});
  assert.equal(absent.status,404);
  const success=await post({accountId:ACCOUNT_ID,name:WORKER});
  assert.equal(success.status,200);
  assert.match(success.headers.get('content-type'),/application\/zip/);
  assert.match(success.headers.get('content-disposition'),/falco-gallinas-gemini-frontend-kit.zip/);
  const files=unzipBuffer(Buffer.from(await success.arrayBuffer()));
  assert.equal(files.size,23);
  assert.match(files.get('config/falco.config.js'),/gtl-ai\.workers\.dev\/chat/);
  assert.deepEqual(JSON.parse(files.get('ALLOWED_ORIGINS.json')).origins, ['http://localhost:3000','https://gtl-ai-sas.github.io']);
  assert.equal(endpointCount,1);
  assert.equal(discoveryCount,2);
});


test('exported launcher contract demands a CMD in the final client repo and browser CORS test', async () => {
  const kit = await createFrontendKit({name:WORKER, endpoint:ENDPOINT, allowedOrigins:['http://localhost:3000']});
  const files=unzipBuffer(kit.bytes);
  const guide=files.get('LEER_PRIMERO_AGENTE.md');
  for (const required of [
    'ABRIR_DEMO.cmd', 'http://localhost:3000/', 'index.html',
    'integration/ABRIR_DEMO.cmd', 'integration/tools/falco-static-server.mjs',
    'React', 'GitHub Pages', 'Cloudflare Pages', 'ALLOWED_ORIGINS.json',
    'OPTIONS /chat', 'POST /chat', 'file://',
  ]) assert.ok(guide.includes(required), `Agent must be told about ${required}`);
  assert.match(files.get('README.md'), /LEER_PRIMERO_AGENTE\.md/);
  assert.match(files.get('README.md'), /doble clic/);
  assert.match(files.get('AGENT_GUIDE.md'), /MUST provide `ABRIR_DEMO\.cmd`/);
  for (const name of ['ABRIR_FALCO_KIT.cmd','integration/ABRIR_DEMO.cmd']) {
    const cmd=files.get(name);
    assert.match(cmd, /cd \/d "%~dp0"/);
    assert.match(cmd, /http:\/\/localhost:3000\//);
    assert.match(cmd, /node\.exe/);
    assert.match(cmd, /Start-Process/);
    assert.match(cmd, /\r\n/);
  }
});

test('frontend export normalizes Windows launcher line endings from any checkout', async t => {
  const templateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'falco-kit-eol-'));
  t.after(() => fs.rm(templateDir, { recursive: true, force: true }));
  await fs.cp(new URL('../frontend-kit-template/', import.meta.url), templateDir, { recursive: true });
  const launchers = ['ABRIR_FALCO_KIT.cmd', 'integration/ABRIR_DEMO.cmd'];
  const sources = new Map(await Promise.all(launchers.map(async name => [name,
    (await fs.readFile(path.join(templateDir, name), 'utf8')).replace(/\r\n|\r/g, '\n')])));
  for (const ending of ['\n', '\r\n', '\r']) {
    for (const [name, source] of sources) await fs.writeFile(path.join(templateDir, name), source.replace(/\n/g, ending));
    const kit = await createFrontendKit({ name: WORKER, endpoint: ENDPOINT, allowedOrigins: ['http://localhost:3000'] }, { templateDir });
    const files = unzipBuffer(kit.bytes);
    for (const [name, source] of sources) {
      assert.equal(files.get(name), source.replace(/\n/g, '\r\n'), name);
      assert.equal(await fs.readFile(path.join(templateDir, name), 'utf8'), source.replace(/\n/g, ending), 'export leaves source files unchanged');
    }
  }
});

test('copy-ready local static server serves only site files over HTTP and never secrets', async t => {
  const site = await fs.mkdtemp(path.join(os.tmpdir(), 'falco-web-site-'));
  await fs.mkdir(path.join(site,'assets'));
  await fs.mkdir(path.join(site,'.git'));
  await fs.writeFile(path.join(site,'index.html'), '<h1>Actual integrated site</h1>');
  await fs.writeFile(path.join(site,'assets','app.js'), 'console.log("Falco")');
  await fs.writeFile(path.join(site,'.git','config'), 'PRIVATE');
  await fs.writeFile(path.join(site,'package.json'), '{"private":true}');
  const server=await createStaticServer({ root:site, port:0 });
  t.after(async()=>{await new Promise(ok=>server.close(ok));await fs.rm(site,{recursive:true,force:true});});
  const base=`http://localhost:${server.address().port}`;
  const page=await fetch(base);
  assert.equal(page.status,200);
  assert.match(await page.text(), /Actual integrated site/);
  assert.match(page.headers.get('content-type'),/text\/html/);
  const js=await fetch(base+'/assets/app.js');
  assert.equal(js.status,200);
  assert.match(await js.text(), /Falco/);
  for (const p of ['/.git/config','/package.json','/no-such-file','/node_modules/foo.js']) {
    const result=await fetch(base+p);
    assert.notEqual(result.status,200,`should not expose ${p}`);
  }
  const post=await fetch(base,{method:'POST'});
  assert.equal(post.status,405);
});
