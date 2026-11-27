import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile,spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { chromium } from 'playwright';

if (process.platform!=='win32') throw new Error('This regression checks the Windows native launcher.');
const execute=promisify(execFile),root=await fs.mkdtemp(path.join(os.tmpdir(),'falco reopen browser '));
const children=[];let browser;
const compiler=path.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const executable=path.join(root,'Falco Studio.exe'),handoffs=path.join(root,'browser-handoffs.txt');
async function waitFor(check,label) {
  const deadline=Date.now()+10000;
  do {const result=await check();if(result)return result;await pause(25);} while(Date.now()<deadline);
  throw new Error('Timed out: '+label);
}
try {
  await execute(compiler,['/nologo','/target:winexe','/reference:System.Windows.Forms.dll','/out:'+executable,path.resolve('scripts/studio-launcher.cs')],{windowsHide:true});
  // Stand in for Windows' browser handler, preserving the real EXE → CMD → CLI
  // chain and its process lifetimes. No user browser associations are changed.
  const browserSource=path.join(root,'BrowserHandoff.cs');
  await fs.writeFile(browserSource,`using System; using System.IO; using System.Threading;
class BrowserHandoff { static int Main(string[] args) {
  Thread.Sleep(600);
  File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"browser-handoffs.txt"),args[args.Length-1]+"\\n");
  return 0;
} }`);
  await execute(compiler,['/nologo','/target:exe','/out:'+path.join(root,'cmd.exe'),browserSource],{windowsHide:true});
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const url=`http://127.0.0.1:${port}`;
  await fs.writeFile(path.join(root,'package.json'),'{}');
  await fs.writeFile(path.join(root,'run-studio.mjs'),`import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(path.join(root,'cli-pids.txt'))},String(process.pid)+'\\n');await import(${JSON.stringify(pathToFileURL(path.resolve('bin/falco-ui.mjs')).href)});`);
  await fs.writeFile(path.join(root,'main.cmd'),`@echo off\r\n"${process.execPath}" "%~dp0run-studio.mjs" --root "%~dp0." --port ${port} --exit-on-close\r\nexit /b %errorlevel%\r\n`);
  const launch=()=>{
    const child=spawn(executable,[],{cwd:root,windowsHide:true,stdio:'ignore'});
    child.done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    children.push(child);return child;
  };
  const readHandoffs=async()=> (await fs.readFile(handoffs,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;})).trim().split('\n').filter(Boolean);
  const first=launch();
  await waitFor(async()=> (await readHandoffs()).length===1,'first Windows browser handoff');
  const boot=await (await fetch(url+'/api/bootstrap')).json();
  browser=await chromium.launch({headless:true,...(process.env.FALCO_CHROMIUM?{executablePath:process.env.FALCO_CHROMIUM}:{})});
  const context=await browser.newContext({reducedMotion:'reduce'});
  await context.route('**/api/**',route=>{
    const pathname=new URL(route.request().url()).pathname;
    if (pathname==='/api/cloudflare') return route.fulfill({json:{connected:false,accounts:[]}});
    return route.continue();
  });
  let page=await context.newPage();
  await page.goto(url);await page.locator('#studioApp:not([inert])').waitFor();
  for (let cycle=0;cycle<3;cycle++) {
    await page.close();
    const reopened=launch();
    assert.equal(await waitFor(async()=>{
      if((await readHandoffs()).length===cycle+2) return 'handed-off';
      if(reopened.exitCode!==null) return 'exited';
      return false;
    },'reopen handoff before native launcher exit'),'handed-off','Reused native launch must wait for the browser handoff');
    assert.equal(await Promise.race([reopened.done,pause(5000).then(()=>{throw new Error('Reused native launcher did not exit after browser handoff.');})]),0);
    assert.equal((await readHandoffs()).at(-1),url);
    assert.equal((await (await fetch(url+'/api/bootstrap')).json()).token,boot.token,'Reopening keeps the original session');
    page=await context.newPage();await page.goto(url);await page.locator('#studioApp:not([inert])').waitFor();
  }
  await page.close();
  assert.equal(await Promise.race([first.done,pause(10000).then(()=>{throw new Error('Studio did not stop after the final tab closed.');})]),0);
  assert.deepEqual((await fs.readdir(root)).filter(name=>/^falco-launcher-.*\.exe$/i.test(name)),[]);
  console.log('Native reopening passed: three immediate close/reopen cycles, completed Windows handoffs, browser page loads, same-session reuse and final shutdown. Data workspace was isolated.');
} catch (error) {
  console.error('Native reopening regression:',error.message);
  throw error;
} finally {
  await browser?.close();
  const pids=(await fs.readFile(path.join(root,'cli-pids.txt'),'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(Number);
  for(const pid of pids) {try {process.kill(pid);} catch(error){if(error.code!=='ESRCH')throw error;}}
  for(const child of children) if(child.exitCode===null) {
    try {await execute('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000});} catch {child.kill();}
  }
  assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(),'falco reopen browser ')));
  await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
