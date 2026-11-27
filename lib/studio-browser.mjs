import { spawn } from 'node:child_process';

/** Wait for the OS browser handoff, including when a reused CLI exits immediately. */
export function openStudioBrowser(url, { platform = process.platform, spawnProcess = spawn } = {}) {
  const [command,args] = platform === 'win32' ? ['cmd.exe',['/d','/c','start','',url]]
    : platform === 'darwin' ? ['open',[url]] : ['xdg-open',[url]];
  return new Promise((resolve,reject)=>{
    const child=spawnProcess(command,args,{stdio:['ignore','ignore','pipe'],windowsHide:true});
    child.stderr?.resume();
    child.once('error',()=>reject(new Error(`Could not open your browser. Open ${url} directly.`)));
    child.once('close',code=>code === 0 ? resolve() : reject(new Error(`Could not open your browser. Open ${url} directly.`)));
  });
}
