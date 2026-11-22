import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, WRANGLER_VERSION } from './args.mjs';
import { normalizeClientActions } from './client-actions.mjs';
import { budgetConfig } from '../templates/worker/src/operations.mjs';
import { checkKnowledge } from './knowledge-kv.mjs';
import { readProjectAt, makeSnapshot, previewChanges } from './projects.mjs';
import { applyProjectFiles, optionalStat, withProjectLock, assertNoPendingTransaction } from './project-files.mjs';
import { runtimeFiles, runtimeManifest } from './runtime-manifest.mjs';
import { planRuntimeUpgrade } from './runtime-upgrades.mjs';
import { normalizeSource } from './source-text.mjs';

const BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(BASE, 'templates/worker');
const pretty = value => JSON.stringify(value, null, 2) + '\n';

export function buildConfig(c) {
  const config = { $schema: 'node_modules/wrangler/config-schema.json', name: c.name, main: 'src/index.mjs',
    compatibility_date: '2026-06-01', workers_dev: true, preview_urls: false,
    ...(c.accountId ? { account_id: c.accountId } : {}),
    observability: c.observability ? { enabled: true, head_sampling_rate: 0.1, logs: { enabled: true, invocation_logs: false } } : { enabled: false },
    vars: { BUSINESS_NAME: c.business, PROVIDER: c.provider, MODEL: c.model, KNOWLEDGE_MODE: c.knowledgeMode ?? 'embedded',
      ALLOWED_ORIGIN: c.origin, ALLOWED_ORIGINS: JSON.stringify(c.origins ?? [c.origin]), MOCK_REPLY: c.mockReply,
      CLIENT_ACTIONS_JSON: JSON.stringify(normalizeClientActions(c.actions ?? [])), FALCO_TELEMETRY: String(Boolean(c.observability)) },
    ratelimits: [{ name: 'CHAT_RATE_LIMITER', namespace_id: c.namespaceId, simple: { limit: c.rateLimit, period: 60 } }] };
  configureBudget(config, c.budget);
  return config;
}

export function configureBudget(config, raw) {
  const limits = budgetConfig(raw);
  if (!limits) { delete config.vars.FALCO_BUDGET; return; }
  if (!['src/index.mjs', 'src/entry.mjs'].includes(config.main)) throw new Error('Budget requires the standard Falco Worker entrypoint.');
  config.main = 'src/entry.mjs';
  config.vars.FALCO_BUDGET = JSON.stringify(limits);
  config.durable_objects ??= { bindings: [] };
  const bindings = config.durable_objects.bindings;
  if (bindings.some(binding => binding.name === 'FALCO_BUDGET_DO' && (binding.class_name !== 'FalcoBudgetObject' || binding.script_name))) {
    throw new Error('Falco budget Durable Object binding conflicts with existing configuration.');
  }
  if (!bindings.some(binding => binding.name === 'FALCO_BUDGET_DO')) bindings.push({ name: 'FALCO_BUDGET_DO', class_name: 'FalcoBudgetObject' });
  config.migrations ??= [];
  if (!config.migrations.some(migration => migration.new_sqlite_classes?.includes('FalcoBudgetObject'))) {
    if (config.migrations.some(migration => migration.tag === 'falco-budget-1')) throw new Error('Falco budget migration tag is already in use.');
    config.migrations.push({ tag: 'falco-budget-1', new_sqlite_classes: ['FalcoBudgetObject'] });
  }
}

function preserveUnusedInputs(c, previous) {
  const supplied = new Set(c.specified ?? []);
  const effective = { ...c };
  if (!supplied.has('knowledge-mode')) effective.knowledgeMode = previous.knowledgeMode;
  for (const [key, flag] of [['faq', 'clearFaq'], ['instructions', 'clearInstructions']]) {
    if (c[flag]) effective[key] = '';
    else if (!c[key]?.trim() && supplied.has(key) && c.source === 'cli' && previous[key].trim()) {
      throw new Error(`Use --clear-${key} to empty existing knowledge deliberately.`);
    } else if (!c[key]?.trim()) effective[key] = previous[key];
  }
  for (const [key, flags] of [
    ['provider', ['provider']], ['model', ['model', 'provider']], ['origin', ['origin', 'origins']],
    ['origins', ['origin', 'origins']], ['actions', ['actions']], ['rateLimit', ['rate-limit']],
    ['namespaceId', ['rate-namespace']], ['accountId', ['account-id']], ['mockReply', ['mock-reply']],
    ['observability', ['observability']]
  ]) {
    if (!flags.some(flag => supplied.has(flag))) effective[key] = previous[key];
  }
  effective.budget ??= previous.budget;
  if (!Object.hasOwn(effective, 'sections') && previous.sections && (previous.faq !== effective.faq || previous.instructions !== effective.instructions)) effective.sections = null;
  if (previous.accountId && effective.accountId !== previous.accountId) throw new Error('Regeneration cannot retarget a project to a different Cloudflare account.');
  if (effective.knowledgeMode !== previous.knowledgeMode) throw new Error('Changing knowledge modes requires the guarded Manage Existing migration.');
  return effective;
}

async function plan(c) {
  const existing = await optionalStat(c.output);
  if (existing && !c.force) throw new Error(`Project directory exists: ${c.output}. Choose --output or use --force (generated projects only).`);
  let previous;
  let priorConfig;
  if (existing) {
    if (!existing.isDirectory()) throw new Error('Refusing to overwrite a non-Falco directory.');
    await assertNoPendingTransaction(c.output);
    previous = await readProjectAt(c.output).catch(() => { throw new Error(`Refusing to overwrite non-Falco directory: ${c.output}`); });
    if (previous.name !== c.name) throw new Error('Refusing to overwrite directory belonging to a different Worker');
    await planRuntimeUpgrade(previous);
    c = preserveUnusedInputs(c, previous);
    priorConfig = JSON.parse(await fs.readFile(path.join(c.output, 'wrangler.json'), 'utf8'));
  }
  checkKnowledge(c.knowledgeMode ?? 'embedded', c);
  const inBundle = c.knowledgeMode !== 'kv';
  const files = new Map();
  for (const file of runtimeFiles) files.set(file, normalizeSource(await fs.readFile(path.join(TEMPLATE, file), 'utf8')));
  files.set('.falco-runtime.json', pretty(runtimeManifest(files)));
  files.set('src/business-context.mjs', `// Embedded content is used only when KNOWLEDGE_MODE=embedded.\nexport const businessInstructions = ${JSON.stringify(inBundle ? c.instructions : '')};\nexport const faqText = ${JSON.stringify(inBundle ? c.faq : '')};\n`);
  if (Object.hasOwn(c, 'sections') && (c.sections !== null || previous?.sections)) files.set('.falco-sections.json', pretty(c.sections));
  if (!inBundle) files.set('.falco-knowledge.json', pretty({ version: 1, instructions: c.instructions, faq: c.faq }));
  const pkg = { name: c.name, private: true, version: VERSION, type: 'module',
    scripts: { dev: 'wrangler dev', deploy: 'wrangler deploy', 'secret:openai': 'wrangler secret put OPENAI_API_KEY', 'secret:gemini': 'wrangler secret put GEMINI_API_KEY' },
    devDependencies: { wrangler: WRANGLER_VERSION } };
  const lock = JSON.parse(await fs.readFile(path.join(BASE, 'package-lock.json'), 'utf8'));
  delete lock.packages['node_modules/playwright'];
  delete lock.packages['node_modules/playwright-core'];
  delete lock.packages['node_modules/playwright/node_modules/fsevents'];
  lock.name = pkg.name;
  lock.version = pkg.version;
  lock.packages[''] = { name: pkg.name, version: pkg.version, devDependencies: pkg.devDependencies };
  files.set('package.json', pretty(pkg));
  files.set('package-lock.json', pretty(lock));
  const config = buildConfig(c);
  if (priorConfig) {
    const oldVars = priorConfig.vars ?? {};
    Object.assign(config, { ...priorConfig, ...config, vars: { ...oldVars, ...config.vars } });
    if (!c.specified?.includes('observability') && priorConfig.observability) config.observability = priorConfig.observability;
    for (const key of ['workers_dev', 'preview_urls', 'main', 'compatibility_date']) {
      if (priorConfig[key] !== undefined) config[key] = priorConfig[key];
    }
    configureBudget(config, c.budget);
    config.ratelimits = [...config.ratelimits, ...(priorConfig.ratelimits ?? []).filter(limit => limit.name !== 'CHAT_RATE_LIMITER')];
  }
  files.set('wrangler.json', pretty(config));
  files.set('.gitignore', 'node_modules/\n.wrangler/\n.dev.vars*\n.env*\n*.log\n.falco-knowledge.json\n.falco-history/\n.falco-deployments.json\n.falco-kv-state.json\n.falco-sections.json\n.falco-staged.json\n');
  files.set('README.md', `# ${c.name}\n\nGenerated by GTL AI Falco Factory v${VERSION}.\n\nBusiness: ${c.business}\nProvider: ${c.provider}\nKnowledge mode: ${c.knowledgeMode}\n\nInstall with npm install on first setup (then npm ci is available from the generated lockfile). Run npm run dev for local development. Use Factory for guarded deployments. Provider keys are Cloudflare secrets.\n`);
  files.set('.falco-generated.json', pretty({ generator: 'falco-factory', version: VERSION, worker: c.name, managedFiles: [...files.keys(), '.falco-generated.json'] }));
  const diff = previous ? { ...previewChanges(previous, c), settings: ['business','provider','model','rateLimit','observability'].filter(key => previous[key] !== c[key]),
    files: await changedFiles(c.output, files) } : null;
  return { c, files, previous, diff };
}

async function changedFiles(output, files) {
  const changed = [];
  for (const [file, next] of files) {
    const before = await fs.readFile(path.join(output, file)).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!before?.equals(Buffer.from(next))) changed.push(file);
  }
  return changed;
}

export async function generate(input) {
  if (input.dryRun) {
    const { c, files, previous, diff } = await plan(input);
    return { files: [...files.keys()], exists: Boolean(previous), written: false, diff, config: c };
  }
  return withProjectLock(input.output, async () => {
    const { c, files, previous, diff } = await plan(input);
    let backupId = null;
    if (previous) {
      const snapshot = await makeSnapshot(previous, 'before_regenerate');
      backupId = await applyProjectFiles(c.output, files, { reason: 'before-regenerate', snapshot });
    } else {
      const staging = await fs.mkdtemp(path.join(path.dirname(c.output), '.falco-generate-'));
      try {
        for (const [file, data] of files) {
          const target = path.join(staging, file);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, data, { flag: 'wx', mode: 0o600 });
        }
        if (await optionalStat(c.output)) throw new Error('Output directory appeared during generation. Retry after reviewing it.');
        await fs.rename(staging, c.output);
      } finally { await fs.rm(staging, { recursive: true, force: true }); }
    }
    return { files: [...files.keys()], exists: Boolean(previous), written: true, backupId, diff, config: { ...c, publishChangedKv: c.knowledgeMode === 'kv' && Boolean(diff?.faq.changed || diff?.instructions.changed) } };
  });
}
