/** Safe in-place runtime upgrade from official v1.1 sources to v1.2 diagnostics. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'src/index.mjs',
  'src/client-actions.mjs',
  'src/providers/shared.mjs',
  'src/providers/gemini.mjs',
  'src/providers/openai.mjs',
];
// Fingerprints from the published v1.1 Factory ZIP; never use substring matching
// to authorize overwriting developer-customized code.
const known = Object.freeze({
  'src/index.mjs': '97ca03ffe8b9f86eda3f7a2f2b1eec6d913d7da04abdbd3e82853af3b7294df5',
  'src/client-actions.mjs': '4c3544934c26a41ca7ca07c0d218316c582ea64bc08a45e28b90ce55a250cf1d',
  'src/providers/shared.mjs': '9ad005e070937871be8a955f9997f620456702005eea5423c48446b9f7cc3f30',
  'src/providers/gemini.mjs': '7fad82f0e27c5a0c94bddf6f3159b208ba0b383460018f181f00f59441afe3ce',
  'src/providers/openai.mjs': '69a3290eed97b91ae747b555bcd61f8a6b89ec6527ae57019b56eb41c93a2bd8',
});
const digest = text => createHash('sha256').update(text).digest('hex');
async function readSource(dir, file) {
  const target = path.join(dir,file);
  const st = await fs.lstat(target).catch(() => null);
  if (!st?.isFile() || st.isSymbolicLink()) throw new Error(`Missing or non-regular Worker file: ${file}. Upgrade refused.`);
  return fs.readFile(target,'utf8');
}
export async function planRuntimeUpgrade(project) {
  const changes=[];
  for (const file of files) {
    const current=await readSource(project.output,file);
    const next=await readSource(path.join(root,'templates/worker'),file);
    if (current === next) continue;
    if (digest(current) !== known[file]) throw new Error(`Customized or unknown Worker file ${file}. Automatic runtime upgrade refused; no files modified.`);
    changes.push({file,oldSource:current,newSource:next});
  }
  return {needed:changes.length>0,changes};
}
async function atomicWrite(target, text) {
  const temp = target+'.'+randomUUID()+'.tmp';
  try { await fs.writeFile(temp,text,{flag:'wx'}); await fs.rename(temp,target); }
  finally { await fs.rm(temp,{force:true}); }
}
export async function applyRuntimeUpgrade(project, plan, snapshotId) {
  if (!plan.needed) return {upgraded:false,files:[]};
  if (!/^[a-f0-9-]{36}$/i.test(snapshotId)) throw new Error('Invalid backup identifier.');
  // Revalidate ALL hashes before mutating ANY managed source.
  for (const entry of plan.changes) {
    const current=await readSource(project.output,entry.file);
    if (current !== entry.oldSource) throw new Error(`Source changed during preflight (${entry.file}). Reload Worker before retrying.`);
  }
  const backupDir=path.join(project.output,'.falco-history',snapshotId+'.runtime-source');
  await fs.mkdir(backupDir,{recursive:false,mode:0o700});
  for (const entry of plan.changes) {
    const backup=path.join(backupDir,entry.file);
    await fs.mkdir(path.dirname(backup),{recursive:true});
    await fs.writeFile(backup,entry.oldSource,{flag:'wx',mode:0o600});
  }
  for (const entry of plan.changes) await atomicWrite(path.join(project.output,entry.file),entry.newSource);
  return {upgraded:true,files:plan.changes.map(x=>x.file),backupDir};
}
