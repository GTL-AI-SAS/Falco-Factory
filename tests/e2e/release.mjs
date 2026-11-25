import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { inflateRawSync } from 'node:zlib';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { VERSION } from '../../lib/args.mjs';

if (process.platform !== 'win32') throw new Error('Packaged native Studio verification requires Windows.');
const archive = path.resolve(process.argv[2] || `dist/GTL_AI_Falco_Factory_v${VERSION}.zip`);
const bytes = await fs.readFile(archive), entries = new Map();
for (let pos = 0; bytes.readUInt32LE(pos) === 0x04034b50;) {
  const size = bytes.readUInt32LE(pos + 18), nameSize = bytes.readUInt16LE(pos + 26), extraSize = bytes.readUInt16LE(pos + 28);
  const name = bytes.subarray(pos + 30,pos + 30 + nameSize).toString('utf8'), start = pos + 30 + nameSize + extraSize;
  assert.ok(!name.includes('..') && !name.includes('\\') && !name.startsWith('/') && !name.includes(':'), 'safe archive path');
  const body = bytes.subarray(start,start + size);
  entries.set(name, bytes.readUInt16LE(pos + 8) === 8 ? inflateRawSync(body) : body);
  pos = start + size;
}
for (const name of ['Falco Studio.exe','main.cmd','package.json','package-lock.json','bin/falco-ui.mjs','lib/cloudflare-auth.mjs',
  'lib/wrangler-process.mjs','lib/project-connection.mjs','ui/connections.js','ui/index.html','docs/CLOUDFLARE_CONNECTIONS.md',
  'docs/releases/VALIDATION_v1.7.0.md']) assert.ok(entries.has(name), name + ' is packaged');
assert.equal(JSON.parse(entries.get('package.json')).version, VERSION);
assert.ok(![...entries.keys()].some(name => /(?:^|\/)(?:\.generated|\.wrangler|\.falco-operations|\.falco-connections\.json|\.env(?:\.|$)|\.dev\.vars(?:\.|$))/.test(name)));
assert.equal(entries.get('Falco Studio.exe').subarray(0,2).toString(),'MZ');
const root = await fs.mkdtemp(path.join(os.tmpdir(),'falco packaged studio '));
let browser, child;
try {
  for (const [name, content] of entries) { const file = path.join(root,name); await fs.mkdir(path.dirname(file),{recursive:true}); await fs.writeFile(file,content); }
  // Reuse the exact installed, pinned dependency tree; the release itself excludes node_modules.
  await fs.symlink(path.resolve('node_modules'),path.join(root,'node_modules'),'junction');
  const env = { ...process.env,WRANGLER_LOG_PATH:path.join(root,'.falco-operations','wrangler-check.log') };
  await promisify(execFile)(path.join(root,'Falco Studio.exe'),['--check'],{cwd:root,windowsHide:true,env,timeout:30000});
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0,'127.0.0.1',resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  child = spawn(path.join(root,'Falco Studio.exe'),['--no-open','--port',String(port),'--exit-on-close'],{cwd:root,env,windowsHide:true,stdio:'ignore',shell:false});
  let exitCode; const exited = new Promise(resolve => child.once('exit',code => {exitCode=code;resolve(code);}));
  child.on('error',error => {throw error;});
  const url = `http://127.0.0.1:${port}`; let boot;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (exitCode !== undefined) throw new Error('Packaged launcher exited before startup: '+exitCode);
    try { const r = await fetch(url+'/api/bootstrap',{signal:AbortSignal.timeout(500)}); if (r.ok) {boot=await r.json();break;} } catch {}
    await new Promise(resolve => setTimeout(resolve,100));
  }
  assert.equal(boot?.version,VERSION); assert.equal(boot.exitOnBrowserClose,true);
  browser = await chromium.launch({ ...(process.env.FALCO_CHROMIUM ? {executablePath:process.env.FALCO_CHROMIUM} : {}),headless:true });
  const page = await browser.newPage({reducedMotion:'reduce'}); page.setDefaultTimeout(10000);
  await page.goto(url); await page.waitForSelector('#studioApp:not([inert])');
  await page.locator('#authDiagnosticsPanel').evaluate(el => {el.open=true;}); await page.locator('#openConnections').click();
  await page.locator('#addConnection').click(); await page.locator('#connectionName').fill('Packaged connection');
  assert.equal(await page.locator('#connectionProfile').inputValue(),'packaged-connection');
  const invalid = await fetch(url+'/api/connections/authenticate',{method:'POST',headers:{'Content-Type':'application/json','X-Falco-Local-Token':boot.token},body:JSON.stringify({authProfile:'../blocked-path'})});
  assert.equal(invalid.status,400);
  await page.close();
  assert.equal(await Promise.race([exited,new Promise((_,reject) => setTimeout(() => reject(new Error('Packaged Studio did not stop after its last tab closed.')),15000))]),0);
  console.log(`Packaged release passed: ${entries.size} files; native EXE → original CMD → packaged Studio; version, connection UI, request validation and browser shutdown.`);
} finally {
  await browser?.close();
  if (child && child.exitCode === null) { try { await promisify(execFile)('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true}); } catch {child.kill();} }
  // Remove only the checked temporary extraction; unlink the junction before recursive cleanup.
  await fs.unlink(path.join(root,'node_modules')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(),'falco packaged studio ')));
  await fs.rm(root,{recursive:true,force:true});
}
