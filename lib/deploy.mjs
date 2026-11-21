import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

export function runWrangler(args, { cwd = ROOT, stdio = 'capture', input } = {}) {
  if (!fs.existsSync(WRANGLER)) throw new Error('Wrangler not installed. Run npm install in the Falco Factory directory.');
  return new Promise((resolve, reject) => {
    const interactive = stdio === 'inherit';
    const child = spawn(process.execPath, [WRANGLER, ...args], { cwd, shell: false,
      stdio: interactive ? 'inherit' : [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
    if (interactive) {
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve({ code: 0, stdout: '', stderr: '' }) : reject(new Error(`Wrangler ${args[0]} exited with code ${code}`)));
      return;
    }
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b.toString(); if (stdout.length > 250000) child.kill(); });
    child.stderr.on('data', b => { stderr += b.toString(); if (stderr.length > 250000) child.kill(); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(`${input}\n`);
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
export async function getCloudflareSession(c) {
  const who = jsonFromWrangler(await runWrangler(['whoami', '--json']), 'wrangler whoami');
  const accountId = selectAccount(who, c.accountId);
  const credentials = jsonFromWrangler(await runWrangler(['auth','token','--json']), 'wrangler auth token');
  if (!['oauth','api_token'].includes(credentials.type) || !credentials.token) throw new Error('Use wrangler login or CLOUDFLARE_API_TOKEN (global API keys are not supported by Factory).');
  // Token remains in process memory only. Never print or persist it.
  return { accountId, token: credentials.token };
}
export async function cfGet(session, endpoint) {
  let response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${session.accountId}${endpoint}`, {
      headers: { Authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(15000)
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
export async function configureSecret(c, { apiKey } = {}) {
  if (c.provider === 'mock') return 'not required';
  const secretName = c.provider === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY';
  const existing = apiKey || process.env.FALCO_PROVIDER_API_KEY;
  if (existing) {
    const result = await runWrangler(['secret','put',secretName], { cwd: c.output, input: existing });
    if (result.code !== 0) throw new Error(`Secret upload failed. In ${c.output}, run: npx wrangler secret put ${secretName}`);
  } else if (process.stdin.isTTY && process.stdout.isTTY) {
    console.log(`\nEnter ${secretName} into Wrangler's secure prompt (the value is not stored by Factory).`);
    await runWrangler(['secret','put',secretName], { cwd: c.output, stdio: 'inherit' });
  } else {
    throw new Error(`Secret not configured. In ${c.output}, run: npx wrangler secret put ${secretName}. Or set FALCO_PROVIDER_API_KEY locally before deployment.`);
  }
  return 'configured';
}
export async function deploy(c, { logger = console.log, apiKey, preserveSecret = false, requireExisting = false } = {}) {
  const result = { status: 'preflight', url: null, accountId: null, secret: 'not started' };
  const session = await getCloudflareSession(c);
  result.accountId = session.accountId;
  logger('Authentication: OK');
  const exists = await remoteWorkerExists(session, c.name);
  if (requireExisting && !exists) throw new Error(`Managed update refused: remote Worker '${c.name}' does not exist in the selected Cloudflare account.`);
  if (exists && !c.force) throw new Error(`Remote Worker '${c.name}' already exists. Refusing replacement. Use a different --name or explicitly pass --force.`);
  logger(`Remote name: ${exists ? 'existing Worker (replacement authorized)' : 'available'}`);
  // Persist the explicit target account ID in the generated (non-secret) Wrangler config.
  // Standalone follow-up deployments and secret commands must target the same account.
  const configPath = path.join(c.output, 'wrangler.json');
  const config = JSON.parse(await fsp.readFile(configPath, 'utf8'));
  config.account_id = session.accountId;
  await fsp.writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
  // Ensure the correct account is selected even with multiple OAuth memberships.
  const previousAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  process.env.CLOUDFLARE_ACCOUNT_ID = session.accountId;
  try {
    const published = await runWrangler(['deploy', '--config', 'wrangler.json'], { cwd: c.output });
    if (published.code !== 0) {
      // Wrangler errors may contain tokens from arbitrary external systems; do not dump raw streams.
      const combined = `${published.stdout}\n${published.stderr}`;
      if (/register a workers\.dev subdomain|need to register a workers\.dev subdomain/i.test(combined)) {
        throw new Error('First-time Cloudflare setup: register a workers.dev subdomain. Open a terminal in the generated project and run npx wrangler deploy once to finish the interactive setup. Then return to Factory.');
      }
      throw new Error(`Wrangler deployment failed (exit ${published.code}). Run 'npx wrangler deploy' inside ${c.output} for diagnostic output.`);
    }
    result.status = 'deployed';
    try { result.url = await actualWorkerUrl(c, session, published.stdout + '\n' + published.stderr); }
    catch (err) { result.urlError = err.message; }
    logger('Deployment: OK');
    try {
      result.secret = preserveSecret && c.provider !== 'mock' ? 'preserved (not changed)' : await configureSecret(c, { apiKey });
      logger(`Secrets: ${result.secret}`);
    } catch (err) {
      result.status = 'deployed_without_secret';
      result.secretError = err.message;
      return result;
    }
    return result;
  } finally {
    if (previousAccountId === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = previousAccountId;
  }
}
