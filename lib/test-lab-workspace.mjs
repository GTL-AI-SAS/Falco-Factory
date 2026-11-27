import fs from 'node:fs/promises';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { atomicJson, atomicWrite } from './project-files.mjs';
import { sha256 } from './runtime-manifest.mjs';
import { snapshotTestSource, preparePreviewModules } from './test-lab-source.mjs';
import { TEST_ACTIONS, TEST_KNOWLEDGE, TEST_INSTRUCTIONS, validateTestTemplates } from './test-lab-templates.mjs';

export async function regularPath(base, relative, directory = false) {
  const resolved = path.resolve(base, relative);
  if (resolved !== path.resolve(base) && !resolved.startsWith(path.resolve(base) + path.sep)) throw Error('Unsafe Test Lab path.');
  const parts = path.relative(base, resolved).split(path.sep).filter(Boolean);
  let current = path.resolve(base);
  for (const part of ['', ...parts]) {
    if (part) current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (current !== resolved || directory ? !stat.isDirectory() : !stat.isFile())) {
      throw Error('Test Lab requires regular files and directories; symlinks are refused.');
    }
  }
  return resolved;
}
export async function protectedDirectory(base, name) {
  await regularPath(base, '', true);
  const target = path.resolve(base, name);
  if (path.dirname(target) !== path.resolve(base)) throw Error('Invalid Test Lab directory name.');
  await fs.mkdir(target, { mode:0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await regularPath(base, name, true);
  await fs.chmod(target, 0o700);
  return target;
}

export function testEntry(main, gatewayProfile) {
  return `import worker from ${JSON.stringify('./' + path.posix.basename(main))};
async function authenticated(request, env) {
  if (env.FALCO_TEST_LAB !== 'true' || typeof env.FALCO_TEST_TOKEN !== 'string' || env.FALCO_TEST_TOKEN.length < 32) return false;
  const supplied = request.headers.get('Authorization') || '';
  if (supplied.length > 1024) return false;
  const digest = async text => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  const [a,b] = await Promise.all([digest(supplied),digest('Bearer ' + env.FALCO_TEST_TOKEN)]);
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}
export default { async fetch(request, env, ctx) {
  if (!await authenticated(request, env)) return new Response('Unauthorized', {status:401});
  const headers = new Headers(request.headers);
  headers.delete('Authorization');
  headers.delete('Cookie');
  ${gatewayProfile ? `headers.set('Authorization', 'Bearer ' + env.FALCO_TEST_TOKEN);\n  headers.set('X-Falco-Profile', ${JSON.stringify(gatewayProfile)});` : ''}
  return worker.fetch(new Request(request, {headers}), ${gatewayProfile ? '{...env, FALCO_GATEWAY_SECRET:env.FALCO_TEST_TOKEN}' : 'env'}, ctx);
} };
`;
}

export async function prepareTestSource(project) {
  await regularPath(project.output, 'wrangler.json');
  const configText = await fs.readFile(path.join(project.output, 'wrangler.json'), 'utf8');
  const config = JSON.parse(configText);
  if (config.name !== project.name || config.account_id !== project.accountId || !/^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date ?? '')) throw Error('Worker configuration identity or compatibility date is invalid.');
  if (!['src/index.mjs','src/entry.mjs'].includes(config.main)) throw Error('Test Lab supports the Factory module entrypoints only. Review the custom entrypoint manually.');
  const allowed = ['$schema','name','main','account_id','compatibility_date','compatibility_flags','workers_dev','preview_urls','vars','ratelimits','observability','kv_namespaces','durable_objects','migrations'];
  if (Object.keys(config).some(key => !allowed.includes(key)) ||
      (config.kv_namespaces ?? []).some(b => b.binding !== 'FALCO_KNOWLEDGE') ||
      (config.durable_objects?.bindings ?? []).some(b => b.name !== 'FALCO_BUDGET_DO' || b.class_name !== 'FalcoBudgetObject' || b.script_name)) {
    throw Error('Custom bindings or build settings cannot be safely reproduced in an isolated Preview. No production files were changed.');
  }
  const {snapshot,checksums} = await snapshotTestSource(project,regularPath);
  checksums['wrangler.json'] = sha256(configText);
  const modules = await preparePreviewModules(snapshot,config.main);
  return {config,...modules,checksums};
}

export async function createTestWorkspace(dir, project, provider, model, prepared) {
  validateTestTemplates();
  const worker = await protectedDirectory(dir, 'worker');
  await protectedDirectory(worker, 'src');
  await protectedDirectory(path.join(worker, 'src'), 'providers');
  for (const [file, source] of prepared.sources) {
    const dirs = path.posix.dirname(file).split('/');
    let parent = worker;
    for (const dir of dirs) parent = await protectedDirectory(parent,dir);
    await atomicWrite(path.join(worker, file), source);
  }
  await atomicWrite(path.join(worker, 'src/business-context.mjs'),
    `export const businessInstructions = ${JSON.stringify(TEST_INSTRUCTIONS)};\nexport const faqText = ${JSON.stringify(TEST_KNOWLEDGE)};\n`);
  await atomicWrite(path.join(worker, 'src/test-lab-entry.mjs'), testEntry(prepared.config.main,prepared.gatewayProfile));
  let namespace;
  do { namespace = String(randomInt(1, 2 ** 48 - 1)); }
  while ((prepared.config.ratelimits ?? []).some(b => String(b.namespace_id) === namespace));
  const config = {
    name:project.name, account_id:project.accountId, main:'src/test-lab-entry.mjs',
    compatibility_date:prepared.config.compatibility_date,
    ...(prepared.config.compatibility_flags ? { compatibility_flags:prepared.config.compatibility_flags } : {}),
    previews:{
      vars:{ BUSINESS_NAME:'Falco Test Lab', PROVIDER:provider, MODEL:model, KNOWLEDGE_MODE:'embedded',
        ALLOWED_ORIGINS:'[]', CLIENT_ACTIONS_JSON:JSON.stringify(TEST_ACTIONS), MOCK_REPLY:'Test Lab requires a real provider.',
        FALCO_TELEMETRY:'true', FALCO_TEST_LAB:'true' },
      ratelimits:[{name:'CHAT_RATE_LIMITER', namespace_id:namespace, simple:{limit:60,period:60}}],
      observability:{ enabled:true, head_sampling_rate:1, logs:{enabled:true,invocation_logs:true}, traces:{enabled:true,head_sampling_rate:1} }
    }
  };
  await atomicJson(path.join(worker, 'wrangler.json'), config);
  return config;
}
