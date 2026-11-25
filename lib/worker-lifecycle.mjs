/**
 * Falco v0.5 lifecycle operations: safe one-click local source discovery and
 * explicitly confirmed remote deletion. Credentials stay server-side.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getCloudflareSession, cfGet } from './deploy.mjs';
import { importLocalProject, listProjects } from './projects.mjs';

const ACCOUNT = /^[a-f0-9]{32}$/i;
const FALCO_NAME = /^falco-[a-z0-9](?:[a-z0-9-]{1,60}[a-z0-9])?$/;
function fail(message, status = 400) { const error = new Error(message); error.httpStatus = status; return error; }
function assertTarget(accountId, name) {
  if (!ACCOUNT.test(accountId || '')) throw fail('Choose a valid Cloudflare account.');
  if (!FALCO_NAME.test(name || '')) throw fail('Only falco-* Workers can be managed by this action.');
}

/**
 * Search ONLY well-known local Factory installations; never perform an
 * unrestricted recursive disk scan. The remote script cannot reliably give
 * us the editable unbundled source and must not be reconstructed by guessing.
 */
export async function findLegacySources(root, name, { searchRoots } = {}) {
  if (!FALCO_NAME.test(name || '')) throw fail('Invalid Falco Worker name.');
  const home = process.env.USERPROFILE || os.homedir();
  const roots = searchRoots || [path.dirname(root), path.join(home, 'Downloads'), path.join(home, 'Desktop'), path.dirname(path.dirname(root))];
  const candidates = new Set();
  for (const base of new Set(roots.map(x => path.resolve(x)))) {
    // A user may have extracted a ZIP directly into this directory.
    candidates.add(path.join(base, '.generated', name));
    let entries = [];
    try { entries = await fs.readdir(base, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.slice(0, 250)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      // One level below Downloads or alongside the current installation.
      candidates.add(path.join(base, entry.name, '.generated', name));
    }
  }
  const existing = [];
  for (const candidate of candidates) {
    if (path.resolve(candidate) === path.resolve(path.join(root, '.generated', name))) continue;
    try {
      const st = await fs.lstat(candidate);
      if (st.isDirectory() && !st.isSymbolicLink()) existing.push(candidate);
    } catch { /* no such folder */ }
  }
  return existing.slice(0, 100);
}

export async function loadExistingFalco({ root, accountId, name, authProfile, searchRoots, discover, importer = importLocalProject } = {}) {
  assertTarget(accountId, name);
  const inventory = await discover({ accountId, ...(authProfile ? { authProfile } : {}) });
  if (inventory.accountId.toLowerCase() !== accountId.toLowerCase() || !inventory.workers.some(w => w.name === name)) {
    throw fail(`'${name}' was not found in the selected Cloudflare account. Refresh Workers.`, 404);
  }
  const localProjects = await listProjects(root);
  const sameName = localProjects.filter(p => p.name === name);
  const matching = sameName.find(p => p.accountId.toLowerCase() === accountId.toLowerCase() && (p.authProfile ?? '') === (authProfile ?? ''));
  if (matching) return { status: 'loaded', source: 'existing-local', folder: matching.folder, name };
  if (sameName.length) throw fail(`A local project named '${name}' belongs to a different Cloudflare account or connection. Open the local project and explicitly change its connection after verification.`, 409);
  const sources = await findLegacySources(root, name, { searchRoots });
  for (const source of sources) {
    try {
      const imported = await importer(root, source, { expectedName: name, expectedAccountId: accountId, expectedAuthProfile: authProfile || '' });
      if ((imported.authProfile || '') !== (authProfile || '')) throw fail('Imported source uses another connection. Select the local project and verify its assignment before managing it.');
      return { status: 'loaded', source: 'auto-linked', folder: imported.folder, name };
    } catch { /* Continue checking trusted local projects; never overwrite. */ }
  }
  // Important: Cloudflare's bundled script isn't guaranteed to contain the
  // exact editable Factory sources. Don't fabricate FAQ/instructions.
  return { status: 'source-unavailable', name,
    message: 'Worker found on Cloudflare, but its editable Falco Factory source was not found in your older installations. Keep the original Factory folder and use the manual link fallback. No remote changes were made.' };
}

export async function deleteCloudflareFalco({ accountId, name, authProfile, sessionProvider = getCloudflareSession, cloudflareGet = cfGet, cloudflareFetch = fetch } = {}) {
  assertTarget(accountId, name);
  const session = await sessionProvider({ accountId, ...(authProfile ? { authProfile } : {}) });
  if (session.accountId.toLowerCase() !== accountId.toLowerCase()) throw fail('Cloudflare account mismatch. Deletion blocked.', 409);
  if (!(await cloudflareGet(session, `/workers/scripts/${encodeURIComponent(name)}`)).found) {
    throw fail(`Worker '${name}' no longer exists in the selected account.`, 404);
  }
  let response;
  try {
    response = await cloudflareFetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(20000), redirect: 'error',
    });
  } catch { throw fail('Cloudflare could not be reached. Deletion is unconfirmed; refresh the list before retrying.', 502); }
  if (!response.ok) {
    await response.body?.cancel();
    throw fail(`Cloudflare returned HTTP ${response.status}. Check the selected connection and account; HTTP 401 requires reauthentication and HTTP 403 requires Workers Scripts write permission. Deletion is unconfirmed; refresh before retrying.`, 502);
  }
  // The official endpoint normally returns a JSON envelope. Reject a reported
  // API failure instead of displaying a false success.
  const raw = await response.text();
  if (raw) {
    let body;
    try { body = JSON.parse(raw); } catch { throw fail('Cloudflare returned an unexpected delete response; refresh to verify status.', 502); }
    if (body.success !== true) throw fail('Cloudflare did not confirm deletion. Refresh the Worker list.', 502);
  }
  return { deleted: true, accountId, name };
}
