import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openStudioBrowser } from '../lib/studio-browser.mjs';

test('browser opening waits for the Windows handoff before a reused launcher can exit', async () => {
  const child=new EventEmitter();child.stderr={resume(){}};
  let completed=false;
  const pending=openStudioBrowser('http://127.0.0.1:4317',{platform:'win32',spawnProcess:(command,args,options)=>{
    assert.equal(command,'cmd.exe');
    assert.deepEqual(args,['/d','/c','start','','http://127.0.0.1:4317']);
    assert.equal(options.windowsHide,true);
    return child;
  }}).then(()=>{completed=true;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(completed,false,'Starting the child is not a completed browser handoff');
  child.emit('close',0);await pending;
  assert.equal(completed,true);
});

test('browser command failure and missing OS opener produce an actionable error', async () => {
  for (const event of ['close','error']) {
    const child=new EventEmitter();
    const pending=openStudioBrowser('http://127.0.0.1:4317',{spawnProcess:()=>child});
    child.emit(event,event==='close'?1:new Error('Unavailable'));
    await assert.rejects(pending,/Could not open your browser.*http:\/\/127\.0\.0\.1:4317/);
  }
});
