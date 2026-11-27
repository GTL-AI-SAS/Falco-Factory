import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { createUiServer } from '../lib/ui-server.mjs';
import { startOrReopenStudio } from '../lib/studio-launch.mjs';

async function fixture(t, { timing = {}, runner = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'falco-browser-life-'));
  const app = createUiServer({ root, port: 0, runner, exitOnBrowserClose: { closeDelayMs: 100, retryMs: 10, pingMs: 20, startupTimeoutMs: 3000, ...timing } });
  const url = await app.listen();
  t.after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  const boot = await (await fetch(url + '/api/bootstrap')).json();
  assert.equal(boot.exitOnBrowserClose, true);
  const headers = { 'X-Falco-Local-Token': boot.token, Origin: url, 'Content-Type': 'application/json' };
  const connect = async () => {
    const controller = new AbortController();
    const response = await fetch(url + '/api/studio/session', { method: 'POST', headers, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    await reader.read();
    return () => { controller.abort(); reader.cancel().catch(() => {}); };
  };
  return { root, app, url, headers, connect };
}

test('Studio waits for its last tab, allows reload, and protects browser lifecycle requests', async t => {
  const e = await fixture(t);
  const closed = once(e.app.server, 'close');
  assert.equal((await fetch(e.url + '/api/studio/session', { method: 'POST' })).status, 403);
  assert.equal((await fetch(e.url + '/api/studio/reopen', { method: 'POST' })).status, 403);
  assert.equal((await fetch(e.url + '/api/studio/reopen', { method: 'POST', headers:{...e.headers,Origin:'https://other.example'} })).status, 403);
  const first = await e.connect();
  const second = await e.connect();
  first();
  await pause(150);
  assert.equal(e.app.server.listening, true, 'another tab keeps Studio alive');
  second();
  const reloaded = await e.connect();
  await pause(150);
  assert.equal(e.app.server.listening, true, 'reload reconnects within the shutdown grace period');
  reloaded();
  await closed;
  assert.equal(e.app.server.listening, false);
});

test('closing the last Studio tab lets the ongoing operation complete before stopping', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const e = await fixture(t, { runner: { generate: async config => { await pending; return { files: [], config }; } } });
  const disconnect = await e.connect();
  const response = await fetch(e.url + '/api/jobs', { method: 'POST', headers: e.headers,
    body: JSON.stringify({ mode: 'generate', name: 'falco-lifetime', business: 'Lifecycle test', provider: 'mock', faq: '', instructions: '' }) });
  assert.equal(response.status, 202);
  const { job } = await response.json();
  const closed = once(e.app.server, 'close');
  disconnect();
  await pause(150);
  assert.equal(e.app.server.listening, true);
  assert.equal(e.app.jobs.get(job.id).status, 'working');
  release();
  await closed;
  assert.equal(e.app.jobs.get(job.id).status, 'generated', 'the operation was not cancelled');
});

test('Studio stops after the startup grace period if no browser tab ever connects', async t => {
  const e = await fixture(t, { timing: { startupTimeoutMs: 100 } });
  await once(e.app.server, 'close');
  assert.equal(e.app.server.listening, false);
});

test('manual shutdown closes open browser connections without waiting for tab closure', async t => {
  const e = await fixture(t);
  const disconnect = await e.connect();
  await e.app.close();
  disconnect();
  assert.equal(e.app.server.listening, false);
});

test('immediate reopening reuses the workspace server and cancels its pending shutdown', async t => {
  const e = await fixture(t);
  const disconnect = await e.connect();
  disconnect();
  const result = await startOrReopenStudio({root:e.root,port:Number(new URL(e.url).port),
    createApp:()=>createUiServer({root:e.root,port:Number(new URL(e.url).port)})});
  assert.equal(result.reused,true);
  assert.equal(result.app,null);
  assert.equal(result.url,e.url);
  await pause(150);
  assert.equal(e.app.server.listening,true,'Reopening holds the server while the browser starts');
  const reconnected = await e.connect();
  const closed = once(e.app.server,'close');
  reconnected();await closed;
});

test('relaunch waits for a stopping listener and then starts cleanly on the same port', async t => {
  const e = await fixture(t);
  const stopping = http.createServer((req,res)=>{res.writeHead(503,{'Connection':'close'});res.end('Stopping');});
  await new Promise(resolve=>stopping.listen(0,'127.0.0.1',resolve));
  const port = stopping.address().port;
  t.after(()=>{if(stopping.listening)stopping.close();});
  let attempts=0, replacement, listeningHandlers;
  const timer = setTimeout(()=>stopping.close(),150);
  t.after(()=>clearTimeout(timer));
  const result = await startOrReopenStudio({root:e.root,port,retryMs:20,createApp:()=>{
    replacement=createUiServer({root:e.root,port});
    listeningHandlers=replacement.server.listenerCount('listening');
    const listen=replacement.listen;
    replacement.listen=()=>{attempts++;return listen();};
    return replacement;
  }});
  t.after(()=>replacement.close());
  assert.equal(result.reused,false);
  assert.ok(attempts>1,'Port binding retries until the previous listener releases it');
  assert.equal(result.app.server.listenerCount('error'),0);
  assert.equal(result.app.server.listenerCount('listening'),listeningHandlers);
  assert.equal((await fetch(result.url+'/api/bootstrap')).status,200);
});

test('relaunch refuses to reuse another Factory workspace on the selected port', async t => {
  const e = await fixture(t), port=Number(new URL(e.url).port),root=path.join(e.root,'another-factory');
  await assert.rejects(startOrReopenStudio({root,port,createApp:()=>createUiServer({root,port})}),/another Falco Factory folder/);
  assert.equal(e.app.server.listening,true);
});

test('the Studio CLI process exits naturally after its last browser connection closes', { timeout: 10000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'falco-cli-life-'));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['bin/falco-ui.mjs', '--root', root, '--port', String(port), '--no-open', '--exit-on-close'],
    { cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => { if (!output.includes('Local UI:')) reject(new Error('Studio exited before listening: ' + code)); });
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('Local UI:')) resolve(); });
  });
  await ready;
  const url = 'http://127.0.0.1:' + port;
  const boot = await (await fetch(url + '/api/bootstrap')).json();
  assert.deepEqual((await (await fetch(url+'/api/test-lab/status')).json()).sessions,[],'CLI uses its isolated workspace rather than any active real Lab');
  assert.deepEqual((await (await fetch(url+'/api/projects')).json()).projects,[]);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(url + '/api/studio/session', { method: 'POST',
    headers: { 'X-Falco-Local-Token': boot.token }, signal: controller.signal });
  assert.equal(response.status, 200);
  const exited = once(child, 'exit');
  controller.abort();
  const reopened = spawn(process.execPath,['bin/falco-ui.mjs','--root',root,'--port',String(port),'--no-open','--exit-on-close'],
    {cwd:path.resolve('.'),stdio:['ignore','pipe','pipe'],windowsHide:true});
  t.after(()=>{if(reopened.exitCode===null)reopened.kill();});
  let reopenOutput='';
  reopened.stdout.on('data',chunk=>{reopenOutput+=chunk;});
  const [reopenCode] = await once(reopened,'close');
  assert.equal(reopenCode,0,'A second launch during shutdown grace exits successfully');
  assert.match(reopenOutput,/Reopened the existing Studio session/);
  assert.equal(child.exitCode,null,'The original Studio process owns the reused session');
  assert.equal((await (await fetch(url+'/api/bootstrap')).json()).token,boot.token);
  const newTab = new AbortController();
  t.after(()=>newTab.abort());
  assert.equal((await fetch(url+'/api/studio/session',{method:'POST',headers:{'X-Falco-Local-Token':boot.token},signal:newTab.signal})).status,200);
  newTab.abort();
  const [code, signal] = await exited;
  assert.equal(code, 0);
  assert.equal(signal, null);
});
