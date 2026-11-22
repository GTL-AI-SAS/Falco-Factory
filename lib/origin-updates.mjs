import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeOrigins } from './origins.mjs';
import { normalizeSource } from './source-text.mjs';

const OLD = `    const allowed = env.ALLOWED_ORIGIN;
    const cors = origin && origin === allowed ? corsHeaders(origin) : { Vary: 'Origin' };
    if (origin && origin !== allowed) return error('origin_not_allowed', 403, cors);`;
const NEW = String.raw`    let allowed = [];
    if (env.ALLOWED_ORIGINS !== undefined) {
      try {
        const parsed = JSON.parse(env.ALLOWED_ORIGINS);
        if (Array.isArray(parsed)) allowed = parsed.filter(o => typeof o === 'string');
      } catch { /* invalid CORS configuration: fail closed */ }
    } else if (env.ALLOWED_ORIGIN) allowed = [env.ALLOWED_ORIGIN];
    const isAllowed = Boolean(origin && origin !== 'null' && /^https?:\/\//.test(origin) && allowed.includes(origin));
    const cors = isAllowed ? corsHeaders(origin) : { Vary: 'Origin' };
    if (origin && !isAllowed) return error('origin_not_allowed', 403, cors);`;

async function atomicText(file, data) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(tmp, data, { flag: 'wx' }); await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }); }
}
export async function prepareCorsUpgrade(project) {
  const target = path.join(project.output, 'src/index.mjs');
  const source = await fs.readFile(target, 'utf8');
  if (source.includes('env.ALLOWED_ORIGINS')) return { changed: false };
  const canonical = normalizeSource(source);
  if (!canonical.includes(OLD)) throw new Error('This Worker has custom or unknown CORS code. Studio will not replace it automatically.');
  return { changed: true, previous: source, upgraded: canonical.replace(OLD, NEW) };
}
export async function applyOriginChanges(project, origins, upgrade, backupId) {
  const accepted = normalizeOrigins(origins);
  const file = path.join(project.output, 'wrangler.json');
  const json = JSON.parse(await fs.readFile(file, 'utf8'));
  if (json.name !== project.name) throw new Error('Worker name mismatch in wrangler configuration.');
  json.vars = { ...json.vars, ALLOWED_ORIGIN: accepted[0], ALLOWED_ORIGINS: JSON.stringify(accepted) };
  if (upgrade.changed) {
    // Keep original transport source in the same history folder as the snapshot.
    const archive = path.join(project.output, '.falco-history', `${backupId}.src-index.mjs`);
    await fs.writeFile(archive, upgrade.previous, { flag: 'wx', mode: 0o600 });
    await atomicText(path.join(project.output, 'src/index.mjs'), upgrade.upgraded);
  }
  await atomicText(file, JSON.stringify(json, null, 2) + '\n');
}
