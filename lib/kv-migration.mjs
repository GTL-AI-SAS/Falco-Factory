/** Guarded, opt-in migration of an existing *official* v1.2/1.3 Worker to KV. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ensureKvNamespace, publishKv, saveLocalKv } from './knowledge-kv.mjs';
import { sameSource, sourceFingerprint as hash } from './source-text.mjs';
import { planRuntimeUpgrade, applyRuntimeUpgrade } from './runtime-upgrades.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT, 'templates/worker/src');
const oldV12Hash = '770723c0ae941962a1bb6e0f66101ab2574488875455be63b2efadc0064a9266';
const oldV13Hash = '43ab112804c5dd0e48303981dfed94eba119a4e874e9c2c8ec88aae941dda021';
const oldV17Hash = '611fed099761f2e3dd67916035581db2ea832e32565c900f4d525ecfdb8c703c';
const oldKnowledge = 'b96a1a90f8b61ce951c559325b563bad405644121ce7e8d14c28e75c0694d3be';
async function atomic(file,text) {
  const tmp=file+'.'+randomUUID()+'.tmp';
  try { await fs.writeFile(tmp,text,{flag:'wx',mode:0o600}); await fs.rename(tmp,file); }
  finally { await fs.rm(tmp,{force:true}); }
}
export async function planKvMigration(project) {
  if (project.knowledgeMode === 'kv') throw new Error('This Worker is already configured for KV.');
  const source = await fs.readFile(path.join(project.output,'src/index.mjs'),'utf8');
  const next = await fs.readFile(path.join(TEMPLATE,'index.mjs'),'utf8');
  const oldHash=hash(source);
  if (![oldV12Hash,oldV13Hash,oldV17Hash].includes(oldHash) && !sameSource(source, next)) throw new Error('Unknown or customized Worker runtime. KV migration refused; update to an official runtime first or review source manually.');
  const existing = await fs.lstat(path.join(project.output,'src/knowledge-store.mjs')).catch(()=>null);
  if (existing) {
    const template=await fs.readFile(path.join(TEMPLATE,'knowledge-store.mjs'),'utf8');
    const currentStore = existing.isFile() ? await fs.readFile(path.join(project.output,'src/knowledge-store.mjs'),'utf8') : '';
    if (!sameSource(currentStore, template) && hash(currentStore) !== oldKnowledge) throw new Error('Unknown knowledge-store module; migration refused.');
  }
  return {previousSource:source, nextSource:next, needsRuntime:!sameSource(source, next),runtimePlan:await planRuntimeUpgrade(project)};
}
/** Create, upload, then switch runtime: old live Worker stays embedded until final deployment. */
export async function migrateToKv(project, plan, backupId, {logger=()=>{}, provision=ensureKvNamespace, publish=publishKv, signal}={}) {
  const output=project.output;
  if (project.knowledgeMode!=='embedded' || !/^[a-f0-9-]{36}$/.test(backupId)) throw new Error('Migration prerequisites not met.');
  const current=await fs.readFile(path.join(output,'src/index.mjs'),'utf8');
  if (current!==plan.previousSource) throw new Error('Worker runtime changed during KV preflight.');
  await fs.mkdir(path.join(output,'.falco-history'),{recursive:true});
  const save=path.join(output,'.falco-history',`${backupId}.before-kv`);
  await fs.mkdir(save,{recursive:false});
  for (const file of ['src/index.mjs','src/business-context.mjs','wrangler.json']) {
    const dst=path.join(save,file); await fs.mkdir(path.dirname(dst),{recursive:true});
    await fs.copyFile(path.join(output,file),dst,fs.constants.COPYFILE_EXCL);
  }
  await provision(project,{logger,signal});
  // Upload *before* switching remote code; a failed upload does not change live chat.
  await publish(project,{logger,signal});
  if (plan.runtimePlan?.needed) await applyRuntimeUpgrade(project,plan.runtimePlan,backupId);
  await saveLocalKv(project,project);
  const nextContext='// KV-backed Worker: business text is stored in FALCO_KNOWLEDGE.\nexport const businessInstructions = "";\nexport const faqText = "";\n';
  if (plan.needsRuntime) await atomic(path.join(output,'src/index.mjs'),plan.nextSource);
  for (const file of ['knowledge-store.mjs', 'operations.mjs']) {
    const target = path.join(output, 'src', file);
    const template = await fs.readFile(path.join(TEMPLATE, file), 'utf8');
    const old = await fs.readFile(target, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (old !== null && !sameSource(old, template) && (file !== 'knowledge-store.mjs' || hash(old) !== oldKnowledge)) throw new Error('Customized knowledge or operations module. Migration refused.');
    if (old !== template) await atomic(target, template);
  }
  await atomic(path.join(output,'src/business-context.mjs'),nextContext);
  const configFile=path.join(output,'wrangler.json');
  const config=JSON.parse(await fs.readFile(configFile,'utf8'));
  if (config.name!==project.name || !config.kv_namespaces?.some(b=>b.binding==='FALCO_KNOWLEDGE')) throw new Error('KV binding disappeared during migration.');
  config.vars={...config.vars,KNOWLEDGE_MODE:'kv'};
  await atomic(configFile,JSON.stringify(config,null,2)+'\n');
  logger('KV migration prepared. Original source and knowledge backed up locally.');
}
