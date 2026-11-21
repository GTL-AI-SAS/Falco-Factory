/**
 * Read-only discovery of Workers using the official Cloudflare REST API.
 * Wrangler remains responsible for OAuth/token retrieval and every deployment.
 * No Cloudflare credentials are returned to the browser or persisted here.
 */
import { cfGet, getCloudflareSession } from './deploy.mjs';

const ACCOUNT_ID = /^[a-f0-9]{32}$/i;
const WORKER_NAME = /^[a-z0-9][a-z0-9_-]{0,126}$/i;

export function normalizeCloudflareWorkers(result) {
  if (!Array.isArray(result)) throw new Error('Cloudflare returned an unexpected Worker list. Refresh or update Wrangler.');
  const seen = new Set();
  const workers = [];
  for (const item of result) {
    if (!item || typeof item !== 'object') continue;
    const name = item.id || item.name || item.script_name;
    if (typeof name !== 'string' || !WORKER_NAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    workers.push({
      name,
      createdOn: /^\d{4}-\d{2}-\d{2}/.test(item.created_on || '') ? item.created_on : null,
      modifiedOn: /^\d{4}-\d{2}-\d{2}/.test(item.modified_on || '') ? item.modified_on : null,
    });
  }
  return workers.sort((a, b) => a.name.localeCompare(b.name));
}

export function mergeRemoteWithLocal(workers, projects, accountId) {
  if (!ACCOUNT_ID.test(accountId)) throw new Error('Invalid Cloudflare Account ID.');
  const locals = new Map();
  for (const project of projects) {
    if (!project || typeof project.name !== 'string') continue;
    const entries = locals.get(project.name) || [];
    entries.push(project);
    locals.set(project.name, entries);
  }
  return workers.map(w => {
    const variants = locals.get(w.name) || [];
    const exact = variants.find(p => p.accountId?.toLowerCase() === accountId.toLowerCase());
    const conflict = !exact && variants.length > 0;
    return {
      ...w,
      accountId,
      source: exact ? 'linked' : conflict ? 'account-mismatch' : 'remote-only',
      editable: Boolean(exact),
      folder: exact?.folder || null,
      business: exact?.business || null,
      provider: exact?.provider || null,
    };
  });
}

export async function discoverCloudflareWorkers({ accountId = '', sessionProvider = getCloudflareSession, cloudflareGet = cfGet } = {}) {
  if (accountId && !ACCOUNT_ID.test(accountId)) throw new Error('Account ID must be 32 hexadecimal characters.');
  const session = await sessionProvider({ accountId });
  if (!ACCOUNT_ID.test(session.accountId || '')) throw new Error('Cloudflare session returned an invalid Account ID.');
  const data = await cloudflareGet(session, '/workers/scripts');
  if (!data?.found) throw new Error('Cloudflare did not return a Worker list. Check Workers read permissions.');
  return { accountId: session.accountId, workers: normalizeCloudflareWorkers(data.result) };
}
