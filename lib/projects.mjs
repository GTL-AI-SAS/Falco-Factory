import fs from 'node:fs/promises';
import { validateAuthProfile } from './cloudflare-auth.mjs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeConfig } from './args.mjs';
import { normalizeOrigins } from './origins.mjs';
import { normalizeClientActions } from './client-actions.mjs';
import { checkKnowledge, limitsForMode, namespaceId, saveLocalKv } from './knowledge-kv.mjs';

const VALID_ID = /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/;
export const MANAGED = ['package.json', 'wrangler.json', '.gitignore', 'README.md', 'src/index.mjs', 'src/business-context.mjs', 'src/providers/index.mjs', 'src/providers/mock.mjs', 'src/providers/openai.mjs', 'src/providers/gemini.mjs', 'src/providers/shared.mjs', '.falco-generated.json'];
function failure(message, status = 400) { const error = new Error(message); error.httpStatus = status; return error; }
function projectDir(root, folder) {
  if (typeof folder !== 'string' || !VALID_ID.test(folder)) throw failure('Invalid local project folder.');
  return path.join(root, '.generated', folder);
}
function assertText(s, key, max) {
  if (typeof s !== 'string' || s.includes('\0') || Buffer.byteLength(s, 'utf8') > max) throw failure(`${key} must be UTF-8 text under ${max / 1000} KB.`);
}
async function ensureRegular(p) { const st = await fs.lstat(p); if (!st.isFile()) throw failure('Expected a regular Falco project file.'); }
function parseContext(source, name) {
  const found = source.match(new RegExp(`^export const ${name} = (.+);$`, 'm'));
  if (!found) throw failure(`Business context is not Factory-generated (${name}).`);
  let result;
  try { result = JSON.parse(found[1]); } catch { throw failure('Business context contains invalid text encoding.'); }
  if (typeof result !== 'string') throw failure('Invalid business context type.');
  return result;
}
function digest(config) { return createHash('sha256').update(JSON.stringify(config)).digest('hex'); }

export function readProject(root, folder) {
  return readProjectAt(projectDir(root, folder), folder);
}
export async function readProjectAt(output, folder = path.basename(output)) {
  const projectStat = await fs.lstat(output);
  if (!projectStat.isDirectory()) throw failure('Project folder must be a regular directory.');
  await Promise.all(MANAGED.map(f => ensureRegular(path.join(output, f))));
  const [marker, config, context] = await Promise.all([
    fs.readFile(path.join(output, '.falco-generated.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(output, 'wrangler.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(output, 'src/business-context.mjs'), 'utf8')
  ]);
  if (marker.generator !== 'falco-factory' || !VALID_ID.test(marker.worker) || config.name !== marker.worker) throw failure('Project is not a valid Falco Factory project.');
  const knowledgeMode = config.vars?.KNOWLEDGE_MODE === 'kv' ? 'kv' : 'embedded';
  let faq, instructions;
  if (knowledgeMode === 'kv') {
    await ensureRegular(path.join(output,'.falco-knowledge.json'));
    const data=JSON.parse(await fs.readFile(path.join(output,'.falco-knowledge.json'),'utf8'));
    if (data.version!==1) throw failure('Unrecognized KV knowledge document.');
    faq=data.faq; instructions=data.instructions;
  } else {
    faq = parseContext(context, 'faqText');
    instructions = parseContext(context, 'businessInstructions');
  }
  checkKnowledge(knowledgeMode,{faq,instructions});
  const c = {
    folder, name: marker.worker, business: config.vars?.BUSINESS_NAME, provider: config.vars?.PROVIDER,
    model: config.vars?.MODEL, origin: config.vars?.ALLOWED_ORIGIN,
    origins: config.vars?.ALLOWED_ORIGINS ? JSON.parse(config.vars.ALLOWED_ORIGINS) : [config.vars?.ALLOWED_ORIGIN],
    mockReply: config.vars?.MOCK_REPLY, rateLimit: config.ratelimits?.[0]?.simple?.limit,
    namespaceId: String(config.ratelimits?.[0]?.namespace_id || ''),
    accountId: config.account_id || '', authProfile: validateAuthProfile(marker.authProfile ?? ''), faq, instructions, knowledgeMode, kvNamespaceId: namespaceId(config),
    actions: normalizeClientActions(config.vars?.CLIENT_ACTIONS_JSON ?? []),
  };
  c.sections = await fs.readFile(path.join(output, '.falco-sections.json'), 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error; });
  c.observability = config.observability?.enabled === true;
  c.budget = config.vars?.FALCO_BUDGET ? JSON.parse(config.vars.FALCO_BUDGET) : null;
  const normalized = normalizeConfig({
    name: c.name, business: c.business, provider: c.provider, model: c.model,
    origins: c.origins, 'knowledge-mode': c.knowledgeMode, 'mock-reply': c.mockReply,
    'rate-limit': String(c.rateLimit), 'rate-namespace': c.namespaceId,
    ...(c.accountId ? { 'account-id': c.accountId } : {}),
  }, path.dirname(output));
  if (normalized.name !== c.name || normalized.provider !== c.provider || normalized.origin !== c.origin) throw failure('Project configuration is invalid or its legacy origin differs from its allowlist.');
  return { ...c, output, revision: digest(c) };
}
export async function listProjects(root) {
  const entries = await fs.readdir(path.join(root, '.generated'), { withFileTypes: true }).catch(() => []);
  const projects = [];
  for (const entry of entries.slice(0, 150)) {
    if (!entry.isDirectory() || !VALID_ID.test(entry.name)) continue;
    try {
      const p = await readProject(root, entry.name);
      projects.push({ folder: p.folder, name: p.name, business: p.business, provider: p.provider, model: p.model, origin: p.origin, origins: p.origins, accountId: p.accountId, authProfile: p.authProfile, actions: p.actions, revision: p.revision });
    } catch { /* skip foreign or broken local folders */ }
    if (projects.length >= 100) break;
  }
  return projects.sort((a, b) => a.business.localeCompare(b.business));
}
export function asGenerateConfig(root, p, changes = {}) {
  const c = normalizeConfig({
    name: p.name, business: changes.business ?? p.business, provider: changes.provider ?? p.provider, model: changes.model ?? p.model,
    origins: changes.origins ?? p.origins, output: path.join('.generated', p.folder),
    'mock-reply': changes.mockReply ?? p.mockReply, 'rate-limit': String(changes.rateLimit ?? p.rateLimit),
    'rate-namespace': p.namespaceId, 'account-id': p.accountId, 'auth-profile': p.authProfile ?? '', 'knowledge-mode': p.knowledgeMode, force: true,
  }, root);
  c.observability = changes.observability ?? p.observability; c.budget = 'budget' in changes ? changes.budget : p.budget;
  c.faq = changes.faq ?? p.faq; c.instructions = changes.instructions ?? p.instructions; c.actions = normalizeClientActions(changes.actions ?? p.actions ?? []);
  return c;
}
function lineChanges(oldText, nextText) {
  const a = oldText.split(/\r?\n/), b = nextText.split(/\r?\n/);
  const oldCounts = new Map(), newCounts = new Map();
  a.forEach(l => oldCounts.set(l, (oldCounts.get(l) || 0) + 1));
  b.forEach(l => newCounts.set(l, (newCounts.get(l) || 0) + 1));
  const removed = [], added = [];
  for (const [line, count] of oldCounts) for (let i = 0; i < Math.max(0, count - (newCounts.get(line) || 0)); i++) removed.push(line);
  for (const [line, count] of newCounts) for (let i = 0; i < Math.max(0, count - (oldCounts.get(line) || 0)); i++) added.push(line);
  return { changed: oldText !== nextText, addedLines: added.length, removedLines: removed.length,
    sampleAdded: added.filter(Boolean).slice(0, 3), sampleRemoved: removed.filter(Boolean).slice(0, 3) };
}
export function previewChanges(current, input) {
  checkKnowledge(current.knowledgeMode ?? 'embedded',input);
  const faq = lineChanges(current.faq, input.faq);
  const instructions = lineChanges(current.instructions, input.instructions);
  const origins = normalizeOrigins(input.origins ?? current.origins);
  const originsChanged = JSON.stringify(origins) !== JSON.stringify(current.origins);
  const actions = normalizeClientActions(input.actions ?? current.actions ?? []);
  const actionsChanged = JSON.stringify(actions) !== JSON.stringify(current.actions ?? []);
  return { changed: faq.changed || instructions.changed || originsChanged || actionsChanged, faq, instructions, originsChanged, origins, actionsChanged, actions, ...(originsChanged ? { previousOrigins: current.origins } : {}), ...(actionsChanged ? { previousActions: current.actions ?? [] } : {}) };
}
export async function writeKnowledge(project, changes) {
  checkKnowledge(project.knowledgeMode ?? 'embedded',changes);
  if (project.knowledgeMode === 'kv') return saveLocalKv(project,changes);
  const target = path.join(project.output, 'src/business-context.mjs');
  await ensureRegular(target);
  const source = `// Public, non-secret business text bundled by Falco Factory.\nexport const businessInstructions = ${JSON.stringify(changes.instructions)};\nexport const faqText = ${JSON.stringify(changes.faq)};\n`;
  const temporary = target + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, source, { flag: 'wx' });
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function makeSnapshot(project, reason) {
  const id = randomUUID();
  const entry = { id, createdAt: new Date().toISOString(), reason, revision: project.revision,
    config: { folder: project.folder, name: project.name, business: project.business, provider: project.provider,
      model: project.model, origin: project.origin, origins: project.origins, mockReply: project.mockReply,
      rateLimit: project.rateLimit, namespaceId: project.namespaceId, accountId: project.accountId, authProfile: project.authProfile ?? '',
      faq: project.faq, instructions: project.instructions, knowledgeMode:project.knowledgeMode ?? 'embedded', actions: project.actions ?? [], sections: project.sections ?? null, budget: project.budget ?? null, observability: project.observability ?? false } };
  const dir = path.join(project.output, '.falco-history');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(dir)).isDirectory()) throw failure('Invalid project history directory.');
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(entry, null, 2), { flag: 'wx', mode: 0o600 });
  return entry;
}
export async function listVersions(project) {
  const folder = path.join(project.output, '.falco-history');
  const files = await fs.readdir(folder).catch(() => []);
  const result = [];
  for (const file of files.filter(f => /^[a-f0-9-]{36}\.json$/.test(f))) {
    try {
      const record = JSON.parse(await fs.readFile(path.join(folder, file), 'utf8'));
      if (record.config.name !== project.name || record.config.folder !== project.folder) continue;
      result.push({ id: record.id, createdAt: record.createdAt, reason: record.reason,
        revision: record.revision, faqSize: Buffer.byteLength(record.config.faq, 'utf8'),
        instructionsSize: Buffer.byteLength(record.config.instructions, 'utf8'), actionsCount: (record.config.actions ?? []).length });
    } catch { /* skip corrupted record */ }
  }
  return result.sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
}
export async function readVersion(project, id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw failure('Invalid snapshot ID.');
  const raw = await fs.readFile(path.join(project.output, '.falco-history', `${id}.json`), 'utf8').catch(() => { throw failure('Snapshot not found.', 404); });
  const record = JSON.parse(raw);
  if (record.config.name !== project.name || record.config.folder !== project.folder || (record.config.accountId && record.config.accountId !== project.accountId)) throw failure('Snapshot belongs to a different Worker configuration.');
  checkKnowledge(project.knowledgeMode ?? 'embedded',record.config);
  record.config.actions = normalizeClientActions(record.config.actions ?? []);
  return record;
}
export async function importLocalProject(root, rawSource, { expectedName = '', expectedAccountId = '', expectedAuthProfile } = {}) {
  if (typeof rawSource !== 'string' || rawSource.length > 700 || !path.isAbsolute(rawSource)) throw failure('Paste the full absolute path to an existing .generated\\WORKER project.');
  const source = path.resolve(rawSource.trim());
  const sstat = await fs.lstat(source).catch(() => null);
  if (!sstat?.isDirectory() || path.resolve(path.dirname(source)) === path.resolve(path.join(root, '.generated'))) throw failure('Source must be an existing project from another Falco Factory installation.');
  const marker = JSON.parse(await fs.readFile(path.join(source, '.falco-generated.json'), 'utf8'));
  if (marker.generator !== 'falco-factory' || !VALID_ID.test(marker.worker)) throw failure('Only Falco Factory-generated projects may be imported.');
  if (expectedName && (!VALID_ID.test(expectedName) || marker.worker !== expectedName)) throw failure('Selected remote Worker does not match the local project being imported. Nothing was changed.');
  if (expectedAccountId && !/^[a-f0-9]{32}$/i.test(expectedAccountId)) throw failure('Invalid Cloudflare account for import.');
  const destination = projectDir(root, marker.worker);
  if (await fs.stat(destination).then(() => true, () => false)) throw failure(`Local project '${marker.worker}' already exists. Import did not overwrite anything.`, 409);
  const tmp = projectDir(root, `falco-import-${randomUUID().replaceAll('-', '').slice(0, 12)}`);
  await fs.mkdir(path.dirname(tmp), { recursive: true });
  try {
    for (const filename of MANAGED) await ensureRegular(path.join(source, filename));
    await fs.mkdir(path.join(tmp, 'src/providers'), { recursive: true });
    for (const filename of MANAGED) await fs.copyFile(path.join(source, filename), path.join(tmp, filename));
    const actionFile = path.join(source, 'src/client-actions.mjs');
    if (await fs.lstat(actionFile).then(() => true, e => e.code === 'ENOENT' ? false : Promise.reject(e))) {
      await ensureRegular(actionFile);
      await fs.copyFile(actionFile, path.join(tmp, 'src/client-actions.mjs'));
    }
    for (const extra of ['src/action-contract.mjs','src/knowledge-store.mjs','src/operations.mjs','src/budget-object.mjs','src/entry.mjs','package-lock.json','.falco-runtime.json','.falco-knowledge.json','.falco-deployments.json','.falco-kv-state.json','.falco-sections.json']) {
      const candidate=path.join(source,extra);
      const stat=await fs.lstat(candidate).catch(()=>null);
      if (stat) { await ensureRegular(candidate); await fs.mkdir(path.dirname(path.join(tmp,extra)),{recursive:true}); await fs.copyFile(candidate,path.join(tmp,extra)); }
    }
    const check = await readProject(root, path.basename(tmp));
    if (check.name !== marker.worker) throw failure('Imported project name does not match its marker.');
    if (expectedAccountId && check.accountId?.toLowerCase() !== expectedAccountId.toLowerCase()) throw failure('Local project belongs to a different Cloudflare account. Nothing was imported.');
    if (expectedAuthProfile !== undefined && check.authProfile !== validateAuthProfile(expectedAuthProfile)) throw failure('Local project uses a different connection. Import it as a local project and explicitly change its connection after verification.');
    // Preserve genuine v0.3 knowledge history when upgrading without copying
    // unrelated files or hidden secrets from an arbitrary source directory.
    const historySource = path.join(source, '.falco-history');
    const historyStat = await fs.lstat(historySource).catch(err => { if (err.code === 'ENOENT') return null; throw err; });
    if (historyStat) {
      if (!historyStat.isDirectory()) throw failure('Invalid local knowledge history directory.');
      const names = await fs.readdir(historySource);
      if (names.length > 500) throw failure('Knowledge history contains too many files to import safely.');
      const historyDestination = path.join(tmp, '.falco-history');
      for (const filename of names) {
        if (!/^[a-f0-9-]{36}\.json$/.test(filename)) continue;
        const original = path.join(historySource, filename);
        await ensureRegular(original);
        const stat = await fs.stat(original);
        if (stat.size > 400000) continue;
        try {
          const entry = JSON.parse(await fs.readFile(original, 'utf8'));
          if (entry.id + '.json' !== filename || entry.config?.name !== check.name || entry.config?.folder !== marker.worker ||
              entry.config?.accountId !== check.accountId) continue;
          checkKnowledge(check.knowledgeMode,entry.config);
          const saved = { id: entry.id, createdAt: entry.createdAt, reason: entry.reason, revision: entry.revision,
            config: { ...entry.config, folder: marker.worker, name: check.name, accountId: check.accountId,
              faq: entry.config.faq, instructions: entry.config.instructions, knowledgeMode:check.knowledgeMode, actions: normalizeClientActions(entry.config.actions ?? []) } };
          await fs.mkdir(historyDestination, {recursive: true});
          await fs.writeFile(path.join(historyDestination, filename), JSON.stringify(saved, null, 2), {flag: 'wx', mode: 0o600});
        } catch { /* skip invalid or unrecognized historical data */ }
      }
    }
    await fs.rename(tmp, destination);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  return readProject(root, marker.worker);
}
