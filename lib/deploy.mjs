import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { atomicJson, withProjectLock, assertNoPendingTransaction } from './project-files.mjs';
import { assertRemote, deploymentLedger, readRemote, trackExpectedDeployment, uuidPattern } from './remote-state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

export function runWrangler(args, { cwd = ROOT, stdio = 'capture', input, accountId,
  signal, timeoutMs = Number(process.env.FALCO_WRANGLER_TIMEOUT_MS ?? 120000) } = {}) {
  if (!fs.existsSync(WRANGLER)) throw new Error('Wrangler not installed. Run npm install in the Falco Factory directory.');
  return runProcess(process.execPath, [WRANGLER, ...args], { cwd, interactive: stdio === 'inherit', input, signal, timeoutMs,
    env: { ...process.env, ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}), WRANGLER_SEND_METRICS: 'false' } });
}

export function runProcess(command, args, { cwd, env, interactive = false, input, signal, timeoutMs = 120000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('Wrangler timeout must be 1–600000 ms.');
  const recovery = reason => new Error(reason + ' Check the Worker’s remote state before retrying the operation.');
  if (signal?.aborted) return Promise.reject(recovery('Wrangler cancelled.'));
  return new Promise((resolve, reject) => {
    const separateGroup = process.platform !== 'win32' && !interactive;
    const child = spawn(command, args, { cwd, env, shell: false, detached: separateGroup, windowsHide: !interactive,
      stdio: interactive ? 'inherit' : [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, stopped, forceTimer;
    const kill = force => {
      if (!child.pid) return;
      try {
        if (separateGroup) process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
        else if (process.platform === 'win32') {
          const flags = ['/PID', String(child.pid), '/T'];
          if (force) flags.push('/F');
          const killer = spawn('taskkill.exe', flags, { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => child.kill());
        } else child.kill(force ? 'SIGKILL' : 'SIGTERM');
      } catch (error) { if (error.code !== 'ESRCH') child.kill(); }
    };
    const stop = message => {
      if (stopped) return;
      stopped = recovery(message);
      kill(false);
      forceTimer = setTimeout(() => {
        kill(true);
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, 1500);
    };
    const abort = () => stop('Wrangler cancelled.');
    const timer = setTimeout(() => stop('Wrangler exceeded its time limit.'), timeoutMs);
    const finish = (code, error) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signal?.removeEventListener('abort', abort);
      if (stopped || error) reject(stopped ?? error);
      else if (interactive && code !== 0) reject(new Error('Wrangler exited with code ' + code));
      else resolve({ code, stdout, stderr });
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    for (const [stream, isError] of [[child.stdout, false], [child.stderr, true]]) {
      stream?.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 250000) return stop('Wrangler output exceeded its safe limit.');
        if (isError) stderr += chunk;
        else stdout += chunk;
      });
    }
    child.on('error', error => finish(null, error));
    child.on('close', code => {
      if (!stopped) finish(code);
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (input !== undefined && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(`${input}\n`);
    }
  });
}
function jsonFromWrangler(result, command) {
  if (result.code !== 0) throw new Error(`${command} failed. Run 'npx wrangler login' or check CLOUDFLARE_API_TOKEN and permissions.`);
  try { return JSON.parse(result.stdout.trim()); } catch { throw new Error(`${command} returned non-JSON output. Update Wrangler and retry.`); }
}
export function selectAccount(who, requested) {
  if (requested) return requested;
  // Wrangler's whoami --json outputs accounts; extra shapes are tolerated but not inferred ambiguously.
  const entries = Array.isArray(who.accounts) ? who.accounts : Array.isArray(who.memberships) ? who.memberships : [];
  const ids = [...new Set(entries.map(a => a?.id || a?.account_id || a?.account?.id).filter(x => /^[a-f0-9]{32}$/i.test(x)))];
  if (ids.length === 1) return ids[0];
  throw new Error('Account selection is ambiguous. Pass --account-id <32-char-id> or set CLOUDFLARE_ACCOUNT_ID. Find it in Cloudflare dashboard > Workers & Pages > Account ID.');
}
export async function getCloudflareSession(c, { signal, wrangler = runWrangler } = {}) {
  const who = jsonFromWrangler(await wrangler(['whoami', '--json'], { signal }), 'wrangler whoami');
  const accountId = selectAccount(who, c.accountId);
  const credentials = jsonFromWrangler(await wrangler(['auth','token','--json'], { signal }), 'wrangler auth token');
  if (!['oauth','api_token'].includes(credentials.type) || !credentials.token) throw new Error('Use wrangler login or CLOUDFLARE_API_TOKEN (global API keys are not supported by Factory).');
  // Token remains in process memory only. Never print or persist it.
  return { accountId, token: credentials.token };
}

/** Classify Wrangler's storage report without returning its raw text or any credential. */
export function classifyCredentialStorage(authType, report = '', env = process.env) {
  const text = String(report || '');
  if (authType === 'api_token') return env.CLOUDFLARE_API_TOKEN ? 'environment-variable' : 'api-token-source';
  if (authType === 'api_key') return 'environment-variable';
  if (authType !== 'oauth') return 'unknown';
  if (/encrypted file/i.test(text) && /windows credential manager/i.test(text)) return 'windows-credential-manager';
  if (/encrypted file/i.test(text) && /(macos keychain|keychain|libsecret|credential manager)/i.test(text)) return 'os-keychain-encrypted';
  if (/default\.toml|plaintext toml|credentials are stored in:.*\.toml/i.test(text)) return 'plaintext-config-file';
  return 'unknown';
}

const AUTH_LABELS = Object.freeze({
  oauth: 'Wrangler OAuth', api_token: 'Cloudflare API Token', api_key: 'Global API Key (unsupported)', unknown: 'Unknown authentication'
});
const STORAGE_LABELS = Object.freeze({
  'windows-credential-manager': 'Encrypted credentials · Windows Credential Manager',
  'os-keychain-encrypted': 'Encrypted credentials · OS keychain',
  'plaintext-config-file': 'Plaintext Wrangler config file',
  'environment-variable': 'Environment variable (outside Wrangler keyring)',
  'api-token-source': 'API token source not identified',
  unknown: 'Could not determine credential storage'
});

/** Safe, read-only account diagnostics. Tokens and raw Wrangler output never leave this process. */
export async function getCloudflareAuthDiagnostics({ accountId, signal, wrangler = runWrangler,
  env = process.env, cloudflareGet = cfGet } = {}) {
  const failed = (message = 'Cloudflare authentication is not available.') => ({
    connected: false, factoryCompatible: false, authMethod: 'unknown', authMethodLabel: AUTH_LABELS.unknown,
    credentialStorage: 'unknown', credentialStorageLabel: STORAGE_LABELS.unknown, secureStorage: false,
    accounts: [], selectedAccount: '', permissions: {
      workersRead: { status: 'not_checked', label: 'Not checked' },
      deployWrite: { status: 'not_tested', label: 'Not tested; diagnostics do not deploy' },
      kvWrite: { status: 'not_tested', label: 'Not tested; diagnostics do not change KV' }
    }, recommendation: message, checkedAt: new Date().toISOString()
  });
  let who;
  try { who = jsonFromWrangler(await wrangler(['whoami', '--json'], { signal }), 'wrangler whoami'); }
  catch { return failed('Run the secure Wrangler login command, then refresh diagnostics.'); }
  const raw = Array.isArray(who.accounts) ? who.accounts : Array.isArray(who.memberships) ? who.memberships : [];
  const accounts = raw.map(x => ({
    id: x?.id || x?.account_id || x?.account?.id || '',
    name: typeof (x?.name || x?.account?.name) === 'string' ? (x.name || x.account.name).slice(0, 100) : 'Cloudflare account'
  })).filter(x => /^[a-f0-9]{32}$/i.test(x.id)).filter((x, i, all) => all.findIndex(y => y.id === x.id) === i).slice(0, 20);

  let credentials;
  try { credentials = jsonFromWrangler(await wrangler(['auth', 'token', '--json'], { signal }), 'wrangler auth token'); }
  catch { return { ...failed('Wrangler is authenticated, but its active credential type could not be inspected.'), accounts }; }
  const authType = ['oauth', 'api_token', 'api_key'].includes(credentials.type) ? credentials.type : 'unknown';
  if (['oauth', 'api_token'].includes(authType) && (typeof credentials.token !== 'string' || !credentials.token)) {
    return { ...failed('Wrangler returned an empty authentication credential.'), accounts };
  }
  // Wrangler's human-readable whoami includes the credential-storage location. Never return it verbatim.
  let whoText = '';
  try {
    const human = await wrangler(['whoami'], { signal });
    if (human.code === 0) whoText = `${human.stdout || ''}\n${human.stderr || ''}`;
  } catch { /* JSON identity remains sufficient; storage will be reported as unknown. */ }
  const credentialStorage = classifyCredentialStorage(authType, whoText, env);
  const selectedAccount = accountId || env.CLOUDFLARE_ACCOUNT_ID || (accounts.length === 1 ? accounts[0].id : '');
  const permissions = {
    workersRead: { status: 'not_checked', label: selectedAccount ? 'Not checked' : 'Select an account to test read access' },
    deployWrite: { status: 'not_tested', label: 'Not tested; no deployment was attempted' },
    kvWrite: { status: 'not_tested', label: 'Not tested; no KV resource was changed' }
  };
  if (selectedAccount && /^[a-f0-9]{32}$/i.test(selectedAccount) && credentials.token && ['oauth', 'api_token'].includes(authType)) {
    try {
      const listed = await cloudflareGet({ accountId: selectedAccount, token: credentials.token }, '/workers/scripts');
      permissions.workersRead = listed?.found
        ? { status: 'passed', label: 'Worker list read access confirmed' }
        : { status: 'failed', label: 'Worker list endpoint was not available' };
    } catch (error) {
      const match = String(error?.message || '').match(/HTTP (\d{3})/);
      permissions.workersRead = { status: 'failed', label: match ? `Worker list read access denied or unavailable (HTTP ${match[1]})` : 'Worker list read access could not be verified' };
    }
  }
  const storageSecure = ['windows-credential-manager', 'os-keychain-encrypted'].includes(credentialStorage);
  let recommendation = 'Authentication diagnostics completed. Deployment and KV write permissions are checked only when those operations are requested.';
  if (authType === 'oauth' && !storageSecure) recommendation = 'OAuth is active, but encrypted keychain storage was not confirmed. Run npm.cmd run falco:auth:secure in PowerShell.';
  if (authType === 'api_token') recommendation = 'An API Token is active. Wrangler keyring protects OAuth credentials only; secure the environment variable separately if you use this method.';
  if (authType === 'api_key') recommendation = 'Global API Key/email authentication is not supported by Falco Factory. Use Wrangler OAuth or a scoped API Token.';
  if (permissions.workersRead.status === 'failed') recommendation += ' Check the token’s Workers Scripts read permission and selected account.';
  return {
    connected: true, factoryCompatible: ['oauth', 'api_token'].includes(authType), authMethod: authType,
    authMethodLabel: AUTH_LABELS[authType], credentialStorage, credentialStorageLabel: STORAGE_LABELS[credentialStorage],
    secureStorage: storageSecure, accounts, selectedAccount: /^[a-f0-9]{32}$/i.test(selectedAccount) ? selectedAccount : '',
    permissions, recommendation, checkedAt: new Date().toISOString()
  };
}
export async function cfGet(session, endpoint) {
  let response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${session.accountId}${endpoint}`, {
      headers: { Authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(15000), redirect: 'error'
    });
  } catch { throw new Error('Cloudflare API unavailable. Deployment stopped before changing remote resources.'); }
  if (response.status === 404) { await response.body?.cancel(); return { found: false }; }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Cloudflare API HTTP ${response.status}. Verify account selection and Workers permissions. Deployment stopped.`);
  }
  // The bare script URL is an existence probe (binary Worker script body).
  // Nested routes like /scripts/name/settings return JSON we need to parse.
  if (/^\/workers\/scripts\/[^/]+$/.test(endpoint)) { await response.body?.cancel(); return { found: true }; }
  try {
    const body = await response.json();
    if (!body.success) throw new Error('Cloudflare API returned an unsuccessful response.');
    return { found: true, result: body.result };
  } catch { throw new Error('Cloudflare returned an invalid JSON response for the requested resource.'); }
}
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
    { cwd: c.output, accountId: c.accountId, signal }));
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
