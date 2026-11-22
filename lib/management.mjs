import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_MODELS } from './args.mjs';
import { budgetConfig } from '../templates/worker/src/operations.mjs';
import { asGenerateConfig, previewChanges } from './projects.mjs';
import { configureBudget } from './generate.mjs';
import { atomicJson, optionalStat, withProjectLock } from './project-files.mjs';
import { validateOrigin } from './origins.mjs';
import { runWrangler, getCloudflareSession, actualWorkerUrl, withDeploymentSecret, cfGet } from './deploy.mjs';
import { assertRemote, deploymentLedger, saveRemote, trackExpectedDeployment, uuidPattern } from './remote-state.mjs';
import { smoke } from './smoke.mjs';
import { zipFiles } from './zip.mjs';

const managedSettings = ['business','provider','model','rateLimit','mockReply','observability','budget'];

export function restoreProposal(project, snapshot, full) {
  const saved = snapshot.config;
  if (full && saved.knowledgeMode && saved.knowledgeMode !== project.knowledgeMode) {
    throw new Error('This snapshot uses a different knowledge mode. Use the guarded knowledge migration or restore knowledge only.');
  }
  const changes = { faq: saved.faq, instructions: saved.instructions, sections: saved.sections ?? null };
  if (full) {
    changes.origins = saved.origins ?? [saved.origin];
    changes.actions = saved.actions ?? [];
    for (const key of managedSettings) if (Object.hasOwn(saved, key)) changes[key] = saved[key];
  }
  const diff = previewChanges(project, changes);
  diff.settings = managedSettings.filter(key => Object.hasOwn(changes, key) && JSON.stringify(changes[key]) !== JSON.stringify(project[key]))
    .map(key => ({ field: key, before: project[key], after: changes[key] }));
  diff.changed ||= diff.settings.length > 0 || JSON.stringify(project.sections ?? null) !== JSON.stringify(changes.sections);
  return { changes, diff };
}

export function settingsProposal(project, raw) {
  const provider = raw.provider ?? project.provider;
  if (!Object.hasOwn(DEFAULT_MODELS, provider)) throw new Error('Choose Mock, Gemini, or OpenAI.');
  const model = raw.model ?? (provider === project.provider ? project.model : DEFAULT_MODELS[provider]);
  if (typeof model !== 'string' || !/^[\w.:-]{2,100}$/.test(model)) throw new Error('Invalid AI model identifier.');
  const observability = raw.observability ?? project.observability;
  if (typeof observability !== 'boolean') throw new Error('Invalid observability setting.');
  const budget = Object.hasOwn(raw, 'budget') ? budgetConfig(raw.budget) : project.budget;
  return { provider, model, observability, budget };
}

export async function updateSettings(project, config) {
  const file = path.join(project.output, 'wrangler.json');
  const wrangler = JSON.parse(await fs.readFile(file, 'utf8'));
  if (wrangler.name !== project.name || wrangler.account_id !== project.accountId) throw new Error('Worker target changed before saving settings.');
  Object.assign(wrangler.vars, { BUSINESS_NAME: config.business, PROVIDER: config.provider, MODEL: config.model,
    MOCK_REPLY: config.mockReply, FALCO_TELEMETRY: String(config.observability) });
  const rate = wrangler.ratelimits?.find(binding => binding.name === 'CHAT_RATE_LIMITER');
  if (rate) rate.simple.limit = config.rateLimit;
  wrangler.observability = config.observability ? { enabled: true, head_sampling_rate: 0.1, logs: { enabled: true, invocation_logs: false } } : { enabled: false };
  configureBudget(wrangler, config.budget);
  await atomicJson(file, wrangler);
}

export function normalizeSections(sections) {
  if (!Array.isArray(sections) || sections.length > 20) throw new Error('Use up to 20 knowledge sections.');
  const titles = new Set();
  return sections.map(section => {
    const { title, type, text } = section ?? {};
    if (typeof title !== 'string' || !title.trim() || title.length > 100 || /[\u0000-\u001f]/.test(title) || titles.has(title.trim()) ||
        !['faq','instructions'].includes(type) || typeof text !== 'string' || text.includes('\0')) throw new Error('Each section needs a unique title, type, and valid text.');
    titles.add(title.trim());
    return { title: title.trim(), type, text };
  });
}

export function compileSections(raw) {
  const sections = normalizeSections(raw);
  const join = type => sections.filter(section => section.type === type).map(({ title, text }) => '## ' + title + '\n\n' + text.trim()).join('\n\n');
  return { sections, faq: join('faq'), instructions: join('instructions') };
}

export async function saveSections(project, value) {
  await atomicJson(path.join(project.output, '.falco-sections.json'), value === null ? null : normalizeSections(value));
}

export function architecture(project) {
  const faqBytes = Buffer.byteLength(project.faq);
  const instructionsBytes = Buffer.byteLength(project.instructions);
  const ratio = Math.max(faqBytes / 24000, instructionsBytes / 12000);
  return { mode: project.knowledgeMode, faqBytes, instructionsBytes,
    approximateContextTokens: Math.ceil((faqBytes + instructionsBytes) / 4),
    kvReadsPerChat: project.knowledgeMode === 'kv' ? 1 : 0,
    recommendation: ratio > 1 ? 'Content exceeds Embedded limits. Use KV or reduce the knowledge size.'
      : ratio > 0.75 ? 'Knowledge is approaching the Embedded size limit. Consider KV if you also need independent publishing.'
      : 'Embedded fits this knowledge. Consider KV if updates must publish without a code deployment.' };
}

export async function verifyCustomDomain(project, url, session) {
  const origin = validateOrigin(url);
  if (!origin.startsWith('https://')) throw new Error('Use a registered HTTPS Worker custom domain.');
  const lookup = await cfGet(session, '/workers/domains?hostname=' + encodeURIComponent(new URL(origin).hostname));
  if (!lookup.found || !lookup.result?.some(domain => domain.hostname === new URL(origin).hostname && domain.service === project.name && ['production', undefined].includes(domain.environment))) {
    throw new Error('This HTTPS domain is not registered to the selected Worker in Cloudflare.');
  }
  return origin;
}

const allowedExport = [
  'wrangler.json','package.json','package-lock.json','README.md','.gitignore','.falco-generated.json','.falco-runtime.json',
  '.falco-sections.json','.falco-knowledge.json','src/entry.mjs','src/operations.mjs','src/budget-object.mjs','src/index.mjs',
  'src/business-context.mjs','src/knowledge-store.mjs','src/client-actions.mjs','src/providers/index.mjs','src/providers/mock.mjs',
  'src/providers/openai.mjs','src/providers/gemini.mjs','src/providers/shared.mjs'
];
export async function exportProject(project) {
  const entries = new Map();
  for (const file of allowedExport) {
    const target = path.join(project.output, file);
    const stat = await optionalStat(target);
    if (!stat) continue;
    if (!stat.isFile()) throw new Error('Backup contains a non-regular managed file.');
    if (file === 'wrangler.json') {
      const config = JSON.parse(await fs.readFile(target, 'utf8'));
      const fields = ['BUSINESS_NAME','PROVIDER','MODEL','MOCK_REPLY','KNOWLEDGE_MODE','ALLOWED_ORIGIN','ALLOWED_ORIGINS','CLIENT_ACTIONS_JSON','FALCO_TELEMETRY','FALCO_BUDGET'];
      config.vars = Object.fromEntries(Object.entries(config.vars ?? {}).filter(([key]) => fields.includes(key)));
      delete config.env;
      entries.set(file, JSON.stringify(config, null, 2));
    } else entries.set(file, await fs.readFile(target));
  }
  return zipFiles(entries);
}

export async function stageDeployment(project, { session, signal, smokeCheck = smoke, wrangler = runWrangler, apiKey, config = project } = {}) {
  session ??= await getCloudflareSession(project, { signal });
  if (!config.checkProvider && config.provider !== 'mock') throw new Error('Authorize one provider call to verify a staged version.');
  const remote = await assertRemote(project, session);
  const state = await cfGet(session, '/workers/scripts/' + encodeURIComponent(project.name) + '/subdomain');
  if (!state.result?.previews_enabled) throw new Error('Enable Cloudflare version URLs for this Worker and review the updated remote baseline first.');
  const result = await withDeploymentSecret(config, apiKey, flags => wrangler(['versions','upload','--config','wrangler.json', ...flags],
    { cwd: project.output, accountId: project.accountId, signal }));
  if (result.code !== 0) throw new Error('Version upload failed. First-time bindings or structural migrations may require a regular guarded deployment.');
  const id = result.stdout.match(/Worker Version ID:\s*([a-f0-9-]{36})/i)?.[1];
  const url = result.stdout.match(/Version Preview URL:\s*(https:\/\/[a-z0-9.-]+\.workers\.dev)\b/i)?.[1];
  if (!uuidPattern.test(id ?? '') || !url || !new URL(url).hostname.startsWith(id.slice(0, 8) + '-' + project.name + '.')) {
    throw new Error('Wrangler did not report a verifiable preview URL. No version was promoted.');
  }
  const checked = await smokeCheck(url, { business: config.business, origins: config.origins, chat: true, actionConfigured: (config.actions ?? []).length > 0, actionSupported: config.provider !== 'mock' });
  await assertRemote(project, session);
  await atomicJson(path.join(project.output, '.falco-staged.json'), { id, url, fingerprint: remote.fingerprint,
    name: project.name, accountId: project.accountId, createdAt: new Date().toISOString() });
  return { id, url, verification: checked.verification };
}

export async function publishVersion(project, { operation, versionId, checkProvider, signal, wrangler = runWrangler } = {}) {
  if (!uuidPattern.test(versionId ?? '')) throw new Error('Invalid Cloudflare version ID.');
  return withProjectLock(project.output, async () => {
    const session = await getCloudflareSession(project, { signal });
    const remote = await assertRemote(project, session);
    if (operation === 'promote') {
      const staged = JSON.parse(await fs.readFile(path.join(project.output, '.falco-staged.json'), 'utf8'));
      if (staged.id !== versionId || staged.name !== project.name || staged.accountId !== project.accountId || staged.fingerprint !== remote.fingerprint) {
        throw new Error('The staged version does not match the current remote baseline. Stage and check it again.');
      }
    } else if (!(await deploymentLedger(project))?.verified?.some(entry => entry.id === versionId)) {
      throw new Error('Rollback is limited to previously verified versions for this Worker.');
    }
    const marker = 'Falco Factory ' + operation + ' ' + randomUUID();
    const args = operation === 'promote' ? ['versions','deploy',versionId+'@100%','--yes'] : ['rollback',versionId];
    const result = await wrangler([...args,'--message',marker,'--config','wrangler.json'], { cwd:project.output, accountId:project.accountId, signal });
    if (result.code !== 0) throw new Error('Cloudflare rejected the operation. Inspect compatibility of the version, bindings and provider secrets.');
    await trackExpectedDeployment(project, session, state => state.detail.versions.length === 1 &&
      state.detail.versions[0].id === versionId && state.detail.versions[0].percentage === 100 && state.message === marker);
    const url = await actualWorkerUrl(project, session, result.stdout);
    const checked = await smoke(url, { chat: project.provider === 'mock' || checkProvider, actionConfigured: (project.actions ?? []).length > 0, actionSupported: project.provider !== 'mock', ...(operation === 'promote' ? { origins: project.origins } : {}) });
    if (operation === 'promote') await fs.rm(path.join(project.output, '.falco-staged.json'), { force: true });
    if (checked.chat) await saveRemote(project, await assertCurrentVersion(project, session, versionId), { verified: true });
    return { id: versionId, url, verification: checked.verification };
  });
}

async function assertCurrentVersion(project, session, versionId) {
  const result = await assertRemote(project, session);
  if (result.current.versions.length !== 1 || result.current.versions[0].id !== versionId) throw new Error('Version changed while checking its live behavior.');
  return { detail: result.current, fingerprint: result.fingerprint };
}

export async function replaceProviderSecret(project, { apiKey, signal, wrangler = runWrangler } = {}) {
  const session = await getCloudflareSession(project, { signal });
  const remote = await assertRemote(project, session);
  const [live] = remote.current.versions;
  if (remote.current.versions.length !== 1 || live.percentage !== 100) throw new Error('Finish the Cloudflare traffic split before replacing a secret.');
  const versions = await cfGet(session, '/workers/scripts/' + encodeURIComponent(project.name) + '/versions');
  if (!versions.found || versions.result?.items?.[0]?.id !== live.id) {
    throw new Error('The most recent uploaded Worker version is not active. Review unpublished versions in Cloudflare before rotating the key.');
  }
  const name = project.provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY';
  const marker = 'Falco Factory secret rotation ' + randomUUID();
  const context = { cwd: project.output, accountId: project.accountId, signal };
  const created = await wrangler(['versions','secret','put',name,'--message',marker,'--config','wrangler.json'], { ...context, input: apiKey });
  const id = created.stdout.match(/Created version\s+([a-f0-9-]{36})\s+with secret/i)?.[1];
  if (created.code !== 0 || !uuidPattern.test(id ?? '')) throw new Error('Cloudflare did not confirm a new version with the replacement key.');
  await assertRemote(project, session);
  const result = await wrangler(['versions','deploy',id+'@100%','--yes','--message',marker,'--config','wrangler.json'], context);
  if (result.code !== 0) throw new Error('Secret version uploaded but activation failed. Review the deployment in Cloudflare.');
  await trackExpectedDeployment(project, session, state => state.message === marker && state.detail.versions.length === 1 &&
    state.detail.versions[0].id === id && state.detail.versions[0].percentage === 100);
  return { status: 'deployed', accountId: project.accountId, url: await actualWorkerUrl(project, session, result.stdout), secret: 'configured' };
}
