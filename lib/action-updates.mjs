/** Upgrade only Factory-known Worker handlers, keep Cloudflare credentials and all other files. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizeClientActions } from './client-actions.mjs';
import { sameSource, sourceFingerprint } from './source-text.mjs';
import { planRuntimeUpgrade } from './runtime-upgrades.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT,'templates/worker/src');
const runtimeTag = "import { readActions, askActionProvider } from './client-actions.mjs';";

const KNOWN_FACTORY_RUNTIME_HASHES = new Set([
  // v0.1 through v0.6 (also the generated v0.2 Gallinas worker)
  'cb35ac4d8e618e0f3825f279cd3953bfef38e8ce433a1aeec7dcea7b068f3a1a',
  // v0.7 and v1.0 (formerly v0.8)
  '9799504b2e2b9ef0b4c30c6905e047d0edbe6d9c8581f3c406ae42836432378e',
  // v0.2 runtime upgraded by v0.7's allowed-origin compatibility patch
  'c6cb05e8b301871146715d07f3b366a3900b004bcd936b2743abc15c62da9650',
]);
function recognizeFactoryRuntime(text) {
  // Exact SHA-256 fingerprints avoid silently clobbering manually customized handlers.
  return KNOWN_FACTORY_RUNTIME_HASHES.has(sourceFingerprint(text));
}

export async function prepareActionUpgrade(project, actions) {
  const next = normalizeClientActions(actions);
  const file = path.join(project.output, 'src/index.mjs');
  const current = await fs.readFile(file,'utf8');
  const replacement = await fs.readFile(path.join(TEMPLATE,'index.mjs'),'utf8');
  if (sameSource(current, replacement)) return { upgrade:false, actions:next };
  if (!next.length) return { upgrade:false, actions:next };
  if (!recognizeFactoryRuntime(current)) {
    try { return { upgrade:false, actions:next, runtimePlan:await planRuntimeUpgrade(project) }; }
    catch { throw Error('Cannot safely upgrade a customized/unknown Worker runtime. Client actions were NOT enabled. Back up and migrate source manually.'); }
  }
  // A conservative allowlist of source shapes: validate other core protected behaviors before proceeding.
  return { upgrade:true, actions:next, oldSource:current, newSource:replacement };
}
async function atomic(file,text) {
  const temp=`${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp,text,{flag:'wx'}); await fs.rename(temp,file); }
  finally { await fs.rm(temp,{force:true}); }
}
export async function applyClientActions(project, actions, upgrade, backupId) {
  const normalized=normalizeClientActions(actions);
  const pathConfig=path.join(project.output,'wrangler.json');
  const config=JSON.parse(await fs.readFile(pathConfig,'utf8'));
  if (config.name!==project.name) throw Error('Worker mismatch: action deployment refused.');
  config.vars = {...config.vars, CLIENT_ACTIONS_JSON:JSON.stringify(normalized)};
  const moduleFile=path.join(project.output,'src/client-actions.mjs');
  const sourceTemplate=await fs.readFile(path.join(TEMPLATE,'client-actions.mjs'),'utf8');
  if (upgrade.upgrade) {
    await fs.mkdir(path.join(project.output,'.falco-history'),{recursive:true});
    await fs.writeFile(path.join(project.output,'.falco-history',`${backupId}.action-pre-upgrade-index.mjs`),upgrade.oldSource,{flag:'wx',mode:0o600});
    if (await fs.stat(moduleFile).catch(()=>null)) throw Error('Unrecognized client-actions.mjs already exists. Refusing runtime overwrite.');
    await atomic(moduleFile,sourceTemplate);
    for (const file of ['operations.mjs', 'knowledge-store.mjs', 'action-contract.mjs']) {
      const destination = path.join(project.output, 'src', file);
      await fs.copyFile(path.join(TEMPLATE, file), destination, fs.constants.COPYFILE_EXCL).catch(error => { if (error.code !== 'EEXIST') throw error; });
    }
    await atomic(path.join(project.output,'src/index.mjs'),upgrade.newSource);
  } else if (!(await fs.stat(moduleFile).catch(()=>null))) {
    // A valid modern handler must have its companion module, otherwise deployment is unsafe.
    const src=await fs.readFile(path.join(project.output,'src/index.mjs'),'utf8');
    const currentTemplate=await fs.readFile(path.join(TEMPLATE,'index.mjs'),'utf8');
    if (src.includes(runtimeTag) || sameSource(src, currentTemplate)) await atomic(moduleFile,sourceTemplate);
  }
  await atomic(pathConfig,JSON.stringify(config,null,2)+'\n');
  return { upgraded:upgrade.upgrade, hash:createHash('sha256').update(JSON.stringify(normalized)).digest('hex') };
}
