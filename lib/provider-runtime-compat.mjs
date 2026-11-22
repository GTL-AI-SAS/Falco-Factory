/**
 * Detect and safely repair a known legacy provider-shared module before a
 * managed deployment. This specifically prevents newer index/client-actions
 * modules from importing helpers absent from an older shared.mjs.
 *
 * Only exact, known official source fingerprints may be replaced. Customized
 * or unknown source is never overwritten automatically.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicJson, atomicWrite } from './project-files.mjs';
import { sourceFingerprint } from './source-text.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED_FILE = 'src/providers/shared.mjs';
const TEMPLATE_SHARED = path.join(ROOT, 'templates/worker', SHARED_FILE);
const KNOWN_LEGACY_SHARED_HASHES = new Set([
  // Official v1.1 provider diagnostics module. It predates assertUsableOutput
  // and providerFailurePayload, both imported by the current runtime.
  '9ad005e070937871be8a955f9997f620456702005eea5423c48446b9f7cc3f30',
]);

const sha256 = value => createHash('sha256').update(value).digest('hex');

function parseNamedImports(source, importer, target) {
  const required = new Set();
  const expression = /import\s*\{([\s\S]*?)\}\s*from\s*(['"])([^'"]+)\2/g;
  for (const match of source.matchAll(expression)) {
    const specifier = match[3];
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
    if (resolved !== target) continue;
    for (const item of match[1].split(',')) {
      const name = item.trim().split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) required.add(name);
    }
  }
  return required;
}

function parseNamedExports(source) {
  const exported = new Set();
  const declaration = /\bexport\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of source.matchAll(declaration)) exported.add(match[1]);
  const list = /\bexport\s*\{([^}]+)\}/g;
  for (const match of source.matchAll(list)) {
    for (const item of match[1].split(',')) {
      const name = item.trim().split(/\s+as\s+/).at(-1)?.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) exported.add(name);
    }
  }
  return exported;
}

async function readRegularFile(project, relative) {
  const target = path.join(project.output, relative);
  const stat = await fs.lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Runtime integrity check: ${relative} is missing or is not a regular file. No deployment was attempted.`);
  }
  return fs.readFile(target, 'utf8');
}

/**
 * plannedSources lets the check validate modules that are about to be added
 * by a legacy Client Actions upgrade, before any source file is changed.
 */
export async function planProviderSharedRepair(project, { plannedSources = {} } = {}) {
  const current = await readRegularFile(project, SHARED_FILE);
  const sources = new Map();

  for (const relative of [
    'src/index.mjs',
    'src/client-actions.mjs',
    'src/providers/index.mjs',
    'src/providers/mock.mjs',
    'src/providers/openai.mjs',
    'src/providers/gemini.mjs',
  ]) {
    const planned = plannedSources[relative];
    if (typeof planned === 'string') sources.set(relative, planned);
    else {
      const stat = await fs.lstat(path.join(project.output, relative)).catch(error =>
        error.code === 'ENOENT' ? null : Promise.reject(error));
      if (stat?.isFile() && !stat.isSymbolicLink()) {
        sources.set(relative, await fs.readFile(path.join(project.output, relative), 'utf8'));
      }
    }
  }

  const required = new Set();
  const consumers = [];
  for (const [relative, source] of sources) {
    const imports = parseNamedImports(source, relative, SHARED_FILE);
    if (imports.size) {
      consumers.push(relative);
      for (const name of imports) required.add(name);
    }
  }

  const available = parseNamedExports(current);
  const missing = [...required].filter(name => !available.has(name)).sort();
  if (!missing.length) return { needed: false, file: SHARED_FILE, missing: [] };

  const digest = sourceFingerprint(current);
  if (!KNOWN_LEGACY_SHARED_HASHES.has(digest)) {
    throw new Error(
      `Runtime dependency mismatch: ${SHARED_FILE} is missing ${missing.join(', ')} required by ${consumers.join(', ')}. ` +
      'Its source is customized or not a recognized official Factory version. No files were modified and no deployment was attempted; review or migrate this module manually.'
    );
  }

  const next = await fs.readFile(TEMPLATE_SHARED, 'utf8');
  const nextExports = parseNamedExports(next);
  const stillMissing = missing.filter(name => !nextExports.has(name));
  if (stillMissing.length) {
    throw new Error(`Factory runtime template is incomplete: ${SHARED_FILE} does not export ${stillMissing.join(', ')}.`);
  }

  return {
    needed: true,
    file: SHARED_FILE,
    oldSource: current,
    newSource: next,
    missing,
    consumers,
  };
}

export async function applyProviderSharedRepair(project, plan, backupId) {
  if (!plan?.needed) return { repaired: false, file: plan?.file ?? SHARED_FILE };
  if (!/^[a-f0-9-]{36}$/i.test(backupId ?? '')) throw new Error('Invalid backup identifier for provider runtime repair.');

  const target = path.join(project.output, SHARED_FILE);
  const current = await readRegularFile(project, SHARED_FILE);
  if (current !== plan.oldSource) {
    throw new Error('Provider runtime changed after preflight. Reload the Worker and review its source before retrying.');
  }

  // Parse the optional manifest before mutating source so malformed local
  // metadata cannot turn a safe preflight into a partially applied repair.
  const manifestFile = path.join(project.output, '.falco-runtime.json');
  const manifest = await fs.readFile(manifestFile, 'utf8').then(JSON.parse, error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });

  const backupDir = path.join(project.output, '.falco-history', `${backupId}.provider-runtime`);
  const backupFile = path.join(backupDir, SHARED_FILE);
  await fs.mkdir(path.dirname(backupFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(backupFile, current, { flag: 'wx', mode: 0o600 });
  await atomicWrite(target, plan.newSource);

  // Keep an existing runtime manifest truthful without inventing one for legacy projects.
  if (manifest && manifest.files && typeof manifest.files === 'object') {
    manifest.files[SHARED_FILE] = sha256(plan.newSource);
    await atomicJson(manifestFile, manifest);
  }

  return { repaired: true, file: SHARED_FILE, missing: plan.missing, backupFile };
}
