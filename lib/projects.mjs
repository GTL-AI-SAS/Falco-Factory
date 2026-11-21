import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeConfig } from './args.mjs';
import { normalizeOrigins } from './origins.mjs';

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

export async function readProject(root, folder) {
  const output = projectDir(root, folder);
  const projectStat = await fs.lstat(output);
  if (!projectStat.isDirectory()) throw failure('Project folder must be a regular directory.');
  await Promise.all(MANAGED.map(f => ensureRegular(path.join(output, f))));
  const [marker, config, context] = await Promise.all([
    fs.readFile(path.join(output, '.falco-generated.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(output, 'wrangler.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(output, 'src/business-context.mjs'), 'utf8')
  ]);
  if (marker.generator !== 'falco-factory' || !VALID_ID.test(marker.worker) || config.name !== marker.worker) throw failure('Project is not a valid Falco Factory project.');
  const faq = parseContext(context, 'faqText');
  const instructions = parseContext(context, 'businessInstructions');
  assertText(faq, 'faq', 24000); assertText(instructions, 'instructions', 12000);
  const c = {
    folder, name: marker.worker, business: config.vars?.BUSINESS_NAME, provider: config.vars?.PROVIDER,
    model: config.vars?.MODEL, origin: config.vars?.ALLOWED_ORIGIN,
    origins: config.vars?.ALLOWED_ORIGINS ? JSON.parse(config.vars.ALLOWED_ORIGINS) : [config.vars?.ALLOWED_ORIGIN],
    mockReply: config.vars?.MOCK_REPLY, rateLimit: config.ratelimits?.[0]?.simple?.limit,
    namespaceId: String(config.ratelimits?.[0]?.namespace_id || ''),
    accountId: config.account_id || '', faq, instructions,
  };
  const normalized = normalizeConfig({
    name: c.name, business: c.business, provider: c.provider, model: c.model,
    origins: c.origins, 'mock-reply': c.mockReply,
    'rate-limit': String(c.rateLimit), 'rate-namespace': c.namespaceId,
    ...(c.accountId ? { 'account-id': c.accountId } : {}),
  }, root);
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
      projects.push({ folder: p.folder, name: p.name, business: p.business, provider: p.provider, model: p.model, origin: p.origin, origins: p.origins, accountId: p.accountId, revision: p.revision });
    } catch { /* skip foreign or broken local folders */ }
    if (projects.length >= 100) break;
  }
  return projects.sort((a, b) => a.business.localeCompare(b.business));
}
export function asGenerateConfig(root, p, changes = {}) {
  const c = normalizeConfig({
    name: p.name, business: p.business, provider: p.provider, model: p.model,
    origins: changes.origins ?? p.origins, output: path.join('.generated', p.folder),
    'mock-reply': p.mockReply, 'rate-limit': String(p.rateLimit),
    'rate-namespace': p.namespaceId, 'account-id': p.accountId, force: true,
  }, root);
  c.faq = changes.faq ?? p.faq; c.instructions = changes.instructions ?? p.instructions;
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
  assertText(input.faq, 'faq', 24000); assertText(input.instructions, 'instructions', 12000);
  const faq = lineChanges(current.faq, input.faq);
  const instructions = lineChanges(current.instructions, input.instructions);
  const origins = normalizeOrigins(input.origins ?? current.origins);
  const originsChanged = JSON.stringify(origins) !== JSON.stringify(current.origins);
  return { changed: faq.changed || instructions.changed || originsChanged, faq, instructions, originsChanged, origins };
}
export async function writeKnowledge(project, changes) {
  assertText(changes.faq, 'faq', 24000);
  assertText(changes.instructions, 'instructions', 12000);
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
      rateLimit: project.rateLimit, namespaceId: project.namespaceId, accountId: project.accountId,
      faq: project.faq, instructions: project.instructions } };
  const dir = path.join(project.output, '.falco-history');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(entry, null, 2), { flag: 'wx', mode: 0o600 });
  return entry;
}
export async function listVersions(project) {
  const folder = path.join(project.output, '.falco-history');
  const files = await fs.readdir(folder).catch(() => []);
  const result = [];
  for (const file of files.filter(f => /^[a-f0-9-]{36}\.json$/.test(f)).slice(-100)) {
    try {
      const record = JSON.parse(await fs.readFile(path.join(folder, file), 'utf8'));
      if (record.config.name !== project.name || record.config.folder !== project.folder) continue;
      result.push({ id: record.id, createdAt: record.createdAt, reason: record.reason,
        revision: record.revision, faqSize: Buffer.byteLength(record.config.faq, 'utf8'),
        instructionsSize: Buffer.byteLength(record.config.instructions, 'utf8') });
    } catch { /* skip corrupted record */ }
  }
  return result.sort((a,b) => b.createdAt.localeCompare(a.createdAt));
}
export async function readVersion(project, id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw failure('Invalid snapshot ID.');
  const raw = await fs.readFile(path.join(project.output, '.falco-history', `${id}.json`), 'utf8').catch(() => { throw failure('Snapshot not found.', 404); });
  const record = JSON.parse(raw);
  if (record.config.name !== project.name || record.config.folder !== project.folder || record.config.accountId !== project.accountId || record.config.provider !== project.provider) throw failure('Snapshot belongs to a different Worker configuration.');
  // v0.3 management intentionally restores only instructions/FAQ: no hidden provider/account changes.
  assertText(record.config.faq, 'faq', 24000); assertText(record.config.instructions, 'instructions', 12000);
  return record;
}
export async function importLocalProject(root, rawSource, { expectedName = '', expectedAccountId = '' } = {}) {
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
    const check = await readProject(root, path.basename(tmp));
    if (check.name !== marker.worker) throw failure('Imported project name does not match its marker.');
    if (expectedAccountId && check.accountId?.toLowerCase() !== expectedAccountId.toLowerCase()) throw failure('Local project belongs to a different Cloudflare account. Nothing was imported.');
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
        if (stat.size > 100000) continue;
        try {
          const entry = JSON.parse(await fs.readFile(original, 'utf8'));
          if (entry.id + '.json' !== filename || entry.config?.name !== check.name || entry.config?.folder !== marker.worker ||
              entry.config?.accountId !== check.accountId || entry.config?.provider !== check.provider) continue;
          assertText(entry.config.faq, 'faq', 24000);
          assertText(entry.config.instructions, 'instructions', 12000);
          const saved = { id: entry.id, createdAt: entry.createdAt, reason: entry.reason, revision: entry.revision,
            config: { folder: marker.worker, name: check.name, business: check.business, provider: check.provider,
              model: check.model, origin: check.origin, origins: check.origins, mockReply: check.mockReply, rateLimit: check.rateLimit,
              namespaceId: check.namespaceId, accountId: check.accountId,
              faq: entry.config.faq, instructions: entry.config.instructions } };
          await fs.mkdir(historyDestination, {recursive: true});
          await fs.writeFile(path.join(historyDestination, filename), JSON.stringify(saved, null, 2), {flag: 'wx', mode: 0o600});
        } catch { /* skip invalid or unrecognized historical data */ }
      }
    }
    await fs.rename(tmp, destination);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  return readProject(root, marker.worker);
}
