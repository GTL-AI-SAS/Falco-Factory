/** Safe in-place runtime upgrade to official v1.3 knowledge-capable runtime. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runtimeFiles, runtimeManifest } from './runtime-manifest.mjs';
import { atomicJson, optionalStat } from './project-files.mjs';
import { sameSource, sourceFingerprint } from './source-text.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Fingerprints from the published v1.1 Factory ZIP; never use substring matching
// to authorize overwriting developer-customized code.
const known = Object.freeze({
  "src/index.mjs": [
    "611fed099761f2e3dd67916035581db2ea832e32565c900f4d525ecfdb8c703c",
    "97ca03ffe8b9f86eda3f7a2f2b1eec6d913d7da04abdbd3e82853af3b7294df5",
    "770723c0ae941962a1bb6e0f66101ab2574488875455be63b2efadc0064a9266",
    "43ab112804c5dd0e48303981dfed94eba119a4e874e9c2c8ec88aae941dda021"
  ],
  "src/knowledge-store.mjs": [
    "b96a1a90f8b61ce951c559325b563bad405644121ce7e8d14c28e75c0694d3be"
  ],
  "src/client-actions.mjs": [
    "47a21a7c3d40fd97052533b4a25c7c6e5b19f4b7913091bc0325100e21ba6978",
    "4c3544934c26a41ca7ca07c0d218316c582ea64bc08a45e28b90ce55a250cf1d",
    "a9df34ab2c8e4f97b55341084044314e9bf1e9ab3a52091829c8f36184f8bf22"
  ],
  "src/providers/index.mjs": [
    "1b99ea9ea2d4559d0b9333a946126b7a674127f7904f3ad9f88af893388a1434"
  ],
  "src/providers/mock.mjs": [
    "787fcf53b1bf15c77daf7ad589492d523195d1e870f3f71f18c7af5f98ffe6c3"
  ],
  "src/providers/gemini.mjs": [
    "7fad82f0e27c5a0c94bddf6f3159b208ba0b383460018f181f00f59441afe3ce",
    "2d3b976359cf0ca6e68a37a6ff77f3e643cd0f99a2e7358d9eaf5beab26dd64e"
  ],
  "src/providers/openai.mjs": [
    "69a3290eed97b91ae747b555bcd61f8a6b89ec6527ae57019b56eb41c93a2bd8",
    "68b9a0997749ea136674c162a460ae81b15380e0b2736e4f42485738d287029f"
  ],
  "src/providers/shared.mjs": [
    "9ad005e070937871be8a955f9997f620456702005eea5423c48446b9f7cc3f30",
    "eb983273b29340345ecc5db77bedca1546ef553978b7665d4e30f0d36fa099a2"
  ]
});
async function readSource(dir, file) {
  const target = path.join(dir,file);
  const st = await fs.lstat(target).catch(() => null);
  if (!st?.isFile() || st.isSymbolicLink()) throw new Error(`Missing or non-regular Worker file: ${file}. Upgrade refused.`);
  return fs.readFile(target,'utf8');
}
export async function planRuntimeUpgrade(project) {
  const changes=[];
  for (const file of runtimeFiles) {
    const current = await optionalStat(path.join(project.output, file)) ? await readSource(project.output, file) : null;
    if (current === null && !['src/knowledge-store.mjs','src/operations.mjs','src/entry.mjs','src/budget-object.mjs','src/action-contract.mjs'].includes(file)) throw new Error(`Missing protected runtime file ${file}.`);
    const next=await readSource(path.join(root,'templates/worker'),file);
    if (current !== null && sameSource(current, next)) continue;
    if (current !== null && !known[file]?.includes(sourceFingerprint(current))) throw new Error(`Customized or unknown Worker file ${file}. Automatic runtime upgrade refused; no files modified.`);
    changes.push({file,oldSource:current,newSource:next});
  }
  return {needed:changes.length>0,changes};
}

// Preview-only planning: preserve custom modules, upgrade only recognized legacy
// modules in the snapshot. This does not authorize an in-place production upgrade.
export async function planPreviewRuntime(snapshot) {
  const sources = new Map(snapshot);
  for (const file of runtimeFiles) {
    const current = sources.get(file);
    const next = await readSource(path.join(root,'templates/worker'),file);
    if (current === undefined && ['src/knowledge-store.mjs','src/operations.mjs','src/entry.mjs','src/budget-object.mjs','src/action-contract.mjs'].includes(file)) sources.set(file,next);
    else if (current !== undefined && known[file]?.includes(sourceFingerprint(current))) sources.set(file,next);
  }
  return sources;
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
    const current=entry.oldSource===null ? await fs.readFile(path.join(project.output,entry.file),'utf8').catch(e=>e.code==='ENOENT'?null:Promise.reject(e)) : await readSource(project.output,entry.file);
    if (current !== entry.oldSource) throw new Error(`Source changed during preflight (${entry.file}). Reload Worker before retrying.`);
  }
  const backupDir=path.join(project.output,'.falco-history',snapshotId+'.runtime-source');
  await fs.mkdir(backupDir,{recursive:false,mode:0o700});
  for (const entry of plan.changes) {
    const backup=path.join(backupDir,entry.file);
    await fs.mkdir(path.dirname(backup),{recursive:true});
    if (entry.oldSource !== null) await fs.writeFile(backup,entry.oldSource,{flag:'wx',mode:0o600});
  }
  for (const entry of plan.changes) await atomicWrite(path.join(project.output,entry.file),entry.newSource);
  const sources = await Promise.all(runtimeFiles.map(async file => [file, await readSource(project.output, file)]));
  await atomicJson(path.join(project.output, '.falco-runtime.json'), runtimeManifest(sources));
  return {upgraded:true,files:plan.changes.map(x=>x.file),backupDir};
}
