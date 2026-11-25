import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { atomicJson, withProjectLock, assertNoPendingTransaction } from './project-files.mjs';
import { assertRemote, deploymentLedger, readRemote, trackExpectedDeployment, uuidPattern } from './remote-state.mjs';

import { runWrangler, getCloudflareSession } from './cloudflare-auth.mjs';
import { cfGet } from './cloudflare-api.mjs';
export { runProcess } from './wrangler-process.mjs';
export { runWrangler, getCloudflareSession, getCloudflareAuthDiagnostics, classifyCredentialStorage, selectAccount } from './cloudflare-auth.mjs';
export { cfGet } from './cloudflare-api.mjs';

export async function remoteWorkerExists(session, name) {
  return (await cfGet(session, `/workers/scripts/${encodeURIComponent(name)}`)).found;
}
function extractUrl(output) {
  const sanitized = output.replace(/\x1b\[[0-9;]*m/g, '');
  const matches = sanitized.match(/https:\/\/[a-z0-9.-]+\.workers\.dev(?:\/[a-z0-9_/-]*)?/gi) || [];
  return matches.length ? new URL(matches.at(-1)).origin : null;
}
export async function actualWorkerUrl(c, session, output) {
  const parsed = extractUrl(output);
  if (parsed) return parsed;
  // Fallback: account subdomain from official Cloudflare API. Health check validates the URL.
  const info = await cfGet(session, '/workers/subdomain');
  const subdomain = info.result?.subdomain;
  if (!info.found || !/^[a-z0-9-]+$/i.test(subdomain || '')) {
    throw new Error('Worker deployed but workers.dev URL could not be determined. Inspect the Cloudflare dashboard and ensure workers.dev is enabled.');
  }
  return `https://${c.name}.${subdomain}.workers.dev`;
}
export async function withDeploymentSecret(project, apiKey, work) {
  if (!apiKey) return work([]);
  if (typeof apiKey !== 'string' || apiKey.length > 1024 || /[\r\n\0]/.test(apiKey)) throw new Error('Invalid provider API key format.');
  const name = project.provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY';
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'falco-deploy-'));
  try {
    const file = path.join(dir, 'secret.json');
    await fsp.writeFile(file, JSON.stringify({ [name]: apiKey }), { flag: 'wx', mode: 0o600 });
    return await work(['--secrets-file', file]);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
}

export async function deploy(c, options = {}) {
  if (options.projectLocked) return deployLocked(c, options);
  return withProjectLock(c.output, () => deployLocked(c, options));
}

async function deployLocked(c, { logger = console.log, apiKey, preserveSecret = false, requireExisting = false, signal,
  wrangler = runWrangler, sessionReader = getCloudflareSession, remoteReader = readRemote } = {}) {
  await assertNoPendingTransaction(c.output);
  const result = { status: 'preflight', url: null, accountId: null, secret: 'not started' };
  const key = c.provider === 'mock' ? null : apiKey || (!preserveSecret ? process.env.FALCO_PROVIDER_API_KEY : null);
  if (c.provider !== 'mock' && !preserveSecret && !key) throw new Error('Provide the API key in Studio or set FALCO_PROVIDER_API_KEY before deploying.');
  const session = await sessionReader(c, { signal, wrangler });
  c = { ...c, accountId: session.accountId };
  result.accountId = c.accountId;
  const exists = Boolean(await remoteReader(session, c.name));
  if (requireExisting && !exists) throw new Error('Managed update refused. The remote Worker no longer exists in the selected account.');
  if (exists && !c.force) throw new Error(`Remote Worker '${c.name}' already exists. Choose a different name or authorize a managed replacement.`);
  if (exists) await assertRemote(c, session, { remoteReader });
  else if (await deploymentLedger(c)) throw new Error('A previously tracked Worker is missing. Review Cloudflare before recreating it.');
  logger(exists ? 'Remote deployment matches the saved baseline' : 'Remote Worker name available');
  const configPath = path.join(c.output, 'wrangler.json');
  const config = JSON.parse(await fsp.readFile(configPath, 'utf8'));
  if (config.name !== c.name || (config.account_id && config.account_id !== session.accountId)) {
    throw new Error('Cloudflare account or Worker identity differs from the local project.');
  }
  config.account_id = session.accountId;
  await atomicJson(configPath, config);

  if (c.knowledgeMode === 'kv') {
    const { ensureKvNamespace, publishKv } = await import('./knowledge-kv.mjs');
    await ensureKvNamespace(c, { logger, wrangler, signal });
    if (!exists || c.publishChangedKv) await publishKv(c, { logger, wrangler, signal });
  }
  if (exists) await assertRemote(c, session, { remoteReader });
  else if (await remoteReader(session, c.name)) throw new Error('Worker name became occupied during deployment preflight.');
  signal?.throwIfAborted();
  const marker = 'Falco Factory ' + randomUUID();
  const published = await withDeploymentSecret(c, key, flags => wrangler(['deploy', '--config', 'wrangler.json', '--message', marker, ...flags],
    { cwd: c.output, accountId: c.accountId, authProfile: c.authProfile, signal }));
  if (published.code !== 0) {
    if (/register a workers\.dev subdomain/i.test(published.stdout + published.stderr)) {
      throw new Error('Register a workers.dev subdomain in Cloudflare, then retry from Factory.');
    }
    throw new Error('Wrangler deployment failed (exit ' + published.code + '). Review Cloudflare before retrying.');
  }
  result.status = 'deployed';
  try { result.url = await actualWorkerUrl(c, session, published.stdout + '\n' + published.stderr); }
  catch (error) { result.urlError = error.message; }
  const versionId = published.stdout.match(/Current Version ID:\s*([a-f0-9-]{36})/i)?.[1];
  try {
    if (!uuidPattern.test(versionId ?? '')) throw new Error('Wrangler did not report a Worker version ID.');
    await trackExpectedDeployment(c, session, remote => remote.detail.versions.length === 1 &&
      remote.detail.versions[0].id === versionId && remote.detail.versions[0].percentage === 100, { remoteReader });
  } catch (error) {
    return { ...result, status: 'unconfirmed_deployment', remoteError: error.message };
  }
  logger('Deployment and active version recorded');
  result.secret = c.provider === 'mock' ? 'not required' : key ? 'configured' : 'preserved (not changed)';
  logger(`Secrets: ${result.secret}`);
  return result;
}
