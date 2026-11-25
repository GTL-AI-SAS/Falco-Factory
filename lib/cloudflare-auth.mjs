import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { rawWrangler } from './wrangler-process.mjs';
import { cfGet } from './cloudflare-api.mjs';
import { atomicJson, withProjectLock } from './project-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUTH_HOME = path.join(os.homedir(), '.falco-factory');
const PROFILE = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$/;
export function validateAuthProfile(value = '') {
  if (typeof value !== 'string' || (value && (!PROFILE.test(value) || ['default', 'staging', '__proto__', 'constructor', 'prototype'].includes(value.toLowerCase())))) {
    throw new Error('Profile name must use 1–64 letters, digits, hyphens or underscores; default and staging are reserved.');
  }
  return value;
}
export function assertProfileEnvironment(profile, env = process.env) {
  let headerOverride = false;
  if (profile && env.CLOUDFLARE_API_HEADERS) {
    try { headerOverride = Object.keys(JSON.parse(env.CLOUDFLARE_API_HEADERS)).some(key => /^(authorization|x-auth-key|x-auth-email|cookie)$/i.test(key)); }
    catch { headerOverride = true; }
  }
  if (profile && (headerOverride || env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN || env.CLOUDFLARE_API_KEY || env.CF_API_KEY || env.CLOUDFLARE_EMAIL || env.CF_EMAIL)) {
    throw new Error('Environment credentials override Wrangler profiles. Remove CLOUDFLARE_API_TOKEN, API key/email, CF_* aliases, or authentication headers in CLOUDFLARE_API_HEADERS from the Studio launcher environment and restart Studio, or explicitly select Legacy default to use the environment token.');
  }
}
function profileEnvironment(env, authProfile) {
  const clean = { ...env, CLOUDFLARE_AUTH_USE_KEYRING: 'true' };
  delete clean.CLOUDFLARE_AUTH_PROFILE;
  delete clean.CLOUDFLARE_ACCOUNT_ID;
  delete clean.CF_ACCOUNT_ID;
  if (authProfile) clean.CLOUDFLARE_AUTH_PROFILE = authProfile;
  return clean;
}
async function assertNoFileCredentials(cwd) {
  const entries = await fs.readdir(cwd, { withFileTypes: true });
  for (const entry of entries.filter(x => /^\.env(?:\.|$)|^\.dev\.vars(?:\.|$)/.test(x.name))) {
    if (!entry.isFile()) throw new Error('Authentication environment files must be regular files.');
    const file = path.join(cwd, entry.name);
    if ((await fs.stat(file)).size > 1000000) throw new Error('Authentication environment file exceeds the inspection limit.');
    if (/^\s*(?:export\s+)?(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN|CLOUDFLARE_API_KEY|CF_API_KEY|CLOUDFLARE_EMAIL|CF_EMAIL|CLOUDFLARE_AUTH_PROFILE|CLOUDFLARE_API_HEADERS)\s*=/m.test(await fs.readFile(file, 'utf8'))) {
      throw new Error('Environment credentials in a project .env or .dev.vars file can override the selected profile. Remove those Cloudflare authentication settings before using named connections.');
    }
  }
}
/** The only adapter for Wrangler's experimental profiles. No credential files are read here. */
export function parseAuthProfiles(output) {
  const clean = String(output).replace(/\x1b\[[0-9;]*m/g, '');
  if (/No profiles found\./.test(clean)) return [];
  const rows = clean.split(/\r?\n/).filter(line => !/│\s*Profile\s*│\s*Bound Directories/.test(line)).map(line => line.match(/^\s*│\s*([a-zA-Z0-9_-]+)\s*│/)).filter(Boolean);
  if (!/│\s*Profile\s*│\s*Bound Directories/.test(clean)) throw new Error('Wrangler profile listing format changed. Factory requires Wrangler 4.166.0.');
  return [...new Set(rows.map(row => row[1]).filter(name => !['default','staging'].includes(name.toLowerCase())))].map(validateAuthProfile);
}
export async function runWrangler(args, options = {}) {
  const { authProfile = '', env = process.env, processRunner = rawWrangler } = options;
  validateAuthProfile(authProfile);
  assertProfileEnvironment(authProfile, env);
  if (authProfile && ['auth','whoami','login','logout'].includes(args[0])) throw new Error('Authentication inspection requires a bound Factory context.');
  if (authProfile) await assertNoFileCredentials(options.cwd || ROOT);
  const inspect = ['auth','whoami','login','logout'].includes(args[0]) || args[0]?.startsWith('--');
  return processRunner(inspect ? args : [...args, '--profile', authProfile || 'default'], {
    ...options, env: authProfile ? profileEnvironment(env, authProfile) : { ...env, CLOUDFLARE_AUTH_PROFILE: 'default' }
  });
}
export async function listAuthProfiles({ wrangler = rawWrangler, env = process.env, signal } = {}) {
  const result = await wrangler(['auth', 'list'], { cwd: ROOT, env, signal });
  if (result.code !== 0) throw new Error('Wrangler profiles unavailable. Check the bundled Wrangler installation.');
  return parseAuthProfiles(result.stdout);
}
async function directory(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(dir)).isDirectory()) throw new Error('Authentication context must be a regular directory.');
  return dir;
}
async function registryLock(authHome, work) {
  for (let attempt = 0; ; attempt++) {
    try { return await withProjectLock(path.join(authHome, 'registry'), work); }
    catch (error) {
      if (!/^This project is locked\./.test(error.message) || attempt >= 2400) throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}
export async function bindAuthProfile(authProfile, { authHome = AUTH_HOME, wrangler = rawWrangler, env = process.env, signal } = {}) {
  validateAuthProfile(authProfile);
  if (!authProfile) throw new Error('Choose a named profile.');
  assertProfileEnvironment(authProfile, env);
  const cwd = await directory(path.join(authHome, 'contexts', authProfile));
  await registryLock(authHome, async () => {
    if (!(await listAuthProfiles({ wrangler, env, signal })).includes(authProfile)) throw new Error('Wrangler profile unavailable. Reauthenticate the connection or restore its original profile.');
    const result = await wrangler(['auth','activate',authProfile,cwd], { cwd, env: profileEnvironment(env), signal });
    if (result.code !== 0) throw new Error('Could not establish the selected Wrangler profile context.');
  });
  return cwd;
}
async function profileRunner(authProfile, { wrangler = runWrangler, env = process.env, signal, authHome = AUTH_HOME } = {}) {
  validateAuthProfile(authProfile);
  assertProfileEnvironment(authProfile, env);
  if (!authProfile) return (args, options = {}) => wrangler(args, { ...options, env });
  const raw = wrangler === runWrangler ? rawWrangler : wrangler;
  const cwd = await bindAuthProfile(authProfile, { authHome, wrangler: raw, env, signal });
  // Pin the native environment selector too: deletion of a directory binding
  // between child invocations must never resolve to the global default.
  return (args, options = {}) => raw(args, { ...options, cwd, env: profileEnvironment(env, authProfile) });
}
function jsonFromWrangler(result, command, authProfile = '') {
  if (result.code !== 0) throw new Error(authProfile ? 'Connection authentication is unavailable. Reauthenticate this connection in Studio, or check network access and OS credential storage before retrying.'
    : `${command} failed. Run 'npx wrangler login' or check CLOUDFLARE_API_TOKEN and permissions.`);
  try { return JSON.parse(result.stdout.trim()); } catch { throw new Error(`${command} returned non-JSON output. Update Wrangler and retry.`); }
}
export function selectAccount(who, requested) {
  if (requested) {
    if (typeof requested !== 'string' || !/^[a-f0-9]{32}$/i.test(requested)) throw new Error('Account ID must be 32 hexadecimal characters.');
    return requested;
  }
  // Wrangler's whoami --json outputs accounts; extra shapes are tolerated but not inferred ambiguously.
  const entries = Array.isArray(who.accounts) ? who.accounts : Array.isArray(who.memberships) ? who.memberships : [];
  const ids = [...new Set(entries.map(a => a?.id || a?.account_id || a?.account?.id).filter(x => /^[a-f0-9]{32}$/i.test(x)))];
  if (ids.length === 1) return ids[0];
  throw new Error('Account selection is ambiguous. Pass --account-id <32-char-id> or set CLOUDFLARE_ACCOUNT_ID. Find it in Cloudflare dashboard > Workers & Pages > Account ID.');
}

export async function getCloudflareAuthDiagnostics({ authProfile = '', authHome = AUTH_HOME, env = process.env, wrangler = runWrangler, ...options } = {}) {
  let result;
  try {
    const bound = await profileRunner(authProfile, { authHome, env, wrangler, signal: options.signal });
    result = await inspectAuth({ ...options, env: authProfile ? profileEnvironment(env) : env, wrangler: bound });
    if (authProfile && result.connected && (!result.secureStorage || result.authMethod !== 'oauth')) {
      result.factoryCompatible = false;
      result.status = 'secure-storage-unavailable';
      result.recommendation = 'Reauthenticate this connection to verify encrypted OS storage. Factory blocks named-profile operations until secure storage is confirmed.';
    }
    if (authProfile && result.selectedAccount && !result.accounts.some(a => a.id.toLowerCase() === result.selectedAccount.toLowerCase())) {
      result.factoryCompatible = false;
      result.status = 'account-access-denied';
      result.recommendation = 'This account is not accessible through the selected profile. Select an account listed for this connection or reauthenticate with access to it.';
    }
  } catch (error) {
    result = await inspectAuth({ wrangler: async () => ({ code: 1 }), env });
    result.status = /Environment credentials/.test(error.message) ? 'environment-override'
      : /profile unavailable/.test(error.message) ? 'profile-unavailable' : 'authentication-failed';
    result.recommendation = result.status === 'environment-override' || result.status === 'profile-unavailable' ? error.message
      : 'Could not inspect this connection. Retry after closing other authentication operations. Check Wrangler 4.166.0 and OS credential storage.';
  }
  result.authProfile = authProfile;
  if (result.permissions.workersRead.httpStatus === 401) {
    result.connected = false; result.factoryCompatible = false; result.status = 'authentication-expired';
  }
  result.status ??= !result.connected ? 'authentication-expired'
    : result.permissions.workersRead.status === 'failed' ? 'account-access-denied' : 'connected';
  if (authProfile && !result.connected && ['authentication-expired','authentication-failed'].includes(result.status)) result.recommendation = 'Authentication expired, failed, or unavailable. Check connectivity, then reauthenticate this connection in Studio and verify again.';
  if (!authProfile && (env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN)) result.recommendation += ' Environment API Token takes precedence over all OAuth profiles.';
  return result;
}

/** Factory owns friendly names and verification timestamps only. Wrangler owns every credential. */
export function createConnectionManager({ root = ROOT, authHome = AUTH_HOME, wrangler = rawWrangler, env = process.env,
  diagnostics = getCloudflareAuthDiagnostics } = {}) {
  const metadataFile = path.join(root, '.falco-connections.json');
  const settings = { authHome, wrangler, env };
  const read = async () => {
    const data = await fs.readFile(metadataFile, 'utf8').then(JSON.parse, error => {
      if (error.code === 'ENOENT') return { version: 1, connections: {} };
      throw error;
    });
    if (data.version !== 1 || !data.connections || Array.isArray(data.connections)) throw new Error('Connection metadata is invalid. Restore its backup before editing connections.');
    return data;
  };
  const update = async (profile, changes, verified = false) => registryLock(authHome, async () => {
    if (verified && profile && !(await listAuthProfiles(settings)).includes(profile)) return;
    const data = await read();
    if (changes === null) delete data.connections[profile];
    else data.connections[profile] = { ...data.connections[profile], ...changes };
    await atomicJson(metadataFile, data);
  });
  const verify = async (authProfile, accountId = '', signal) => {
    validateAuthProfile(authProfile);
    const result = await diagnostics({ ...settings, authProfile, accountId, signal });
    if (result.connected && result.factoryCompatible && (authProfile ? result.secureStorage : true)) {
      await update(authProfile, { lastVerifiedAt: result.checkedAt }, true);
    }
    return result;
  };
  return {
    async list() {
      const [names, data] = await Promise.all([listAuthProfiles(settings), read()]);
      const all = [...new Set([...names, ...Object.keys(data.connections).filter(Boolean)])];
      return [{ authProfile: '', name: 'Legacy default', available: true, ...data.connections[''] }, ...all.map(authProfile => ({
        authProfile, name: data.connections[authProfile]?.name || authProfile, available: names.includes(authProfile),
        lastVerifiedAt: data.connections[authProfile]?.lastVerifiedAt || null,
        defaultAccountId: data.connections[authProfile]?.defaultAccountId || ''
      }))];
    },
    verify,
    async save({ authProfile, name, defaultAccountId }) {
      validateAuthProfile(authProfile);
      if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\u0000-\u001f]/.test(name)) throw new Error('Enter a connection name using 1–80 characters.');
      if (defaultAccountId) {
        selectAccount({}, defaultAccountId);
        const status = await verify(authProfile, defaultAccountId);
        if (!status.factoryCompatible || !status.accounts.some(a => a.id === defaultAccountId)) throw new Error('The default account could not be verified for this connection.');
      }
      await update(authProfile, { name: name.trim(), ...(defaultAccountId === undefined ? {} : { defaultAccountId }) });
    },
    async authenticate({ authProfile, name, signal }) {
      validateAuthProfile(authProfile);
      assertProfileEnvironment(authProfile || 'default-oauth', env);
      await directory(authHome);
      return withProjectLock(path.join(authHome, 'oauth'), async () => {
        if (name) await this.save({ authProfile, name });
        const cwd = await directory(path.join(authHome, 'contexts', authProfile || 'legacy'));
        let result;
        try {
          result = await wrangler(authProfile ? ['auth','create',authProfile] : ['login','--use-keyring'], {
            cwd, signal, timeoutMs: 600000, env: profileEnvironment(env)
          });
        } catch {
          throw new Error(signal?.aborted ? 'Authentication cancelled. Verify the connection before retrying; the browser may already have completed authorization.'
            : 'Authentication did not finish. Check OS credential storage and browser access, then retry. Close any other Wrangler login flow first.');
        }
        if (result.code !== 0) throw new Error('Authentication failed. Ensure Windows Credential Manager is available, allow the browser authorization and localhost callback, then retry. Plaintext fallback is disabled.');
        const status = await verify(authProfile, '', signal);
        if (!status.connected || !status.secureStorage || !status.factoryCompatible) throw new Error('Secure storage unavailable or authentication could not be verified. Reauthenticate after checking Windows Credential Manager. Plaintext fallback is blocked.');
        return status;
      });
    },
    async delete(authProfile) {
      validateAuthProfile(authProfile);
      if (!authProfile) throw new Error('The legacy default cannot be deleted from Connection Manager.');
      assertProfileEnvironment(authProfile, env);
      await withProjectLock(path.join(authHome, 'oauth'), async () => {
        await registryLock(authHome, async () => {
          const result = await wrangler(['auth','delete',authProfile], { cwd: ROOT, env: profileEnvironment(env) });
          if (result.code !== 0) throw new Error('Wrangler could not delete this profile. Refresh connections and retry.');
        });
        await update(authProfile, null);
      });
    }
  };
}
export async function getCloudflareSession(c = {}, { signal, wrangler = runWrangler, env = process.env, authHome = AUTH_HOME } = {}) {
  const authProfile = validateAuthProfile(c.authProfile ?? '');
  wrangler = await profileRunner(authProfile, { signal, wrangler, env, authHome });
  const who = jsonFromWrangler(await wrangler(['whoami', '--json'], { signal }), 'wrangler whoami', authProfile);
  const accountId = selectAccount(who, c.accountId);
  if (authProfile && !c.accountId) throw new Error('Select an explicit Cloudflare account for this connection.');
  const accounts = accountEntries(who);
  if (accounts.length && !accounts.some(x => x.id.toLowerCase() === accountId.toLowerCase())) throw new Error('Account not accessible through this profile. Choose an account listed for the selected connection.');
  if (authProfile && !accounts.some(x => x.id.toLowerCase() === accountId.toLowerCase())) throw new Error('Account access could not be verified for the selected profile. No fallback is allowed.');
  const credentials = jsonFromWrangler(await wrangler(['auth','token','--json'], { signal }), 'wrangler auth token', authProfile);
  if (!['oauth','api_token'].includes(credentials.type) || !credentials.token) throw new Error('Use wrangler login or CLOUDFLARE_API_TOKEN (global API keys are not supported by Factory).');
  if (authProfile) {
    if (credentials.type !== 'oauth') throw new Error('The selected profile resolved to an environment credential. Operation blocked.');
    const human = await wrangler(['whoami'], { signal });
    const storage = classifyCredentialStorage('oauth', human.code === 0 ? human.stdout + '\n' + human.stderr : '', env);
    if (!secureStorage(storage)) throw new Error('Secure storage unavailable or unverified. Reauthenticate this connection; Windows Credential Manager must be available. Plaintext fallback is blocked.');
  }
  // Token remains in process memory only. Never print or persist it.
  return { accountId, token: credentials.token, ...(authProfile ? { authProfile } : {}) };
}
const secureStorage = storage => process.platform === 'win32' ? storage === 'windows-credential-manager'
  : ['windows-credential-manager','os-keychain-encrypted'].includes(storage);
function accountEntries(who) {
  const raw = Array.isArray(who.accounts) ? who.accounts : Array.isArray(who.memberships) ? who.memberships : [];
  return raw.map(x => ({ id: x?.id || x?.account_id || x?.account?.id || '',
    name: String(x?.name || x?.account?.name || 'Cloudflare account').slice(0, 100) }))
    .filter(x => /^[a-f0-9]{32}$/i.test(x.id)).filter((x, i, all) => all.findIndex(y => y.id === x.id) === i);
}

/** Classify Wrangler's storage report without returning its raw text or any credential. */
export function classifyCredentialStorage(authType, report = '', env = process.env) {
  const text = String(report || '');
  if (authType === 'api_token') return env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN ? 'environment-variable' : 'api-token-source';
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
async function inspectAuth({ accountId, signal, wrangler = runWrangler,
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
  try {
    const identity = await wrangler(['whoami', '--json'], { signal });
    if (identity.code !== 0 && /(?:keyring|keychain|credential manager).*(?:unavailable|failed|cannot|not available|could not)|(?:cannot|failed|unable).*key(?:ring|chain)/i.test(String(identity.stderr) + String(identity.stdout))) {
      return { ...failed('Secure OS credential storage is unavailable. Check Windows Credential Manager and reauthenticate the connection. Plaintext fallback is blocked.'), status: 'secure-storage-unavailable' };
    }
    if (identity.code !== 0) return { ...failed('Run the secure Wrangler login command, then refresh diagnostics.'),
      status: /expired|invalid_grant|not logged|not authenticated/i.test(String(identity.stderr) + String(identity.stdout)) ? 'authentication-expired' : 'authentication-failed' };
    who = jsonFromWrangler(identity, 'wrangler whoami');
  }
  catch { return failed('Run the secure Wrangler login command, then refresh diagnostics.'); }
  const raw = Array.isArray(who.accounts) ? who.accounts : Array.isArray(who.memberships) ? who.memberships : [];
  const accounts = raw.map(x => ({
    id: x?.id || x?.account_id || x?.account?.id || '',
    name: typeof (x?.name || x?.account?.name) === 'string' ? (x.name || x.account.name).slice(0, 100) : 'Cloudflare account'
  })).filter(x => /^[a-f0-9]{32}$/i.test(x.id)).filter((x, i, all) => all.findIndex(y => y.id === x.id) === i);

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
  const accountMismatch = selectedAccount && accounts.length && !accounts.some(a => a.id.toLowerCase() === selectedAccount.toLowerCase());
  if (accountMismatch) permissions.workersRead = { status: 'failed', label: 'Selected Account ID is not accessible through this identity. Choose a listed account.' };
  if (!accountMismatch && selectedAccount && /^[a-f0-9]{32}$/i.test(selectedAccount) && credentials.token && ['oauth', 'api_token'].includes(authType)) {
    try {
      const listed = await cloudflareGet({ accountId: selectedAccount, token: credentials.token }, '/workers/scripts');
      permissions.workersRead = listed?.found
        ? { status: 'passed', label: 'Worker list read access confirmed' }
        : { status: 'failed', label: 'Worker list endpoint was not available' };
    } catch (error) {
      const match = String(error?.message || '').match(/HTTP (\d{3})/);
      permissions.workersRead = { status: 'failed', ...(match ? { httpStatus: Number(match[1]) } : {}), label: match?.[1] === '403'
        ? 'HTTP 403: this account is visible, but Workers Scripts read permission was denied. Reauthorize the account and Workers permissions.'
        : match?.[1] === '401' ? 'HTTP 401: credentials expired or invalid. Reauthenticate this connection.'
        : match ? `Worker list read access denied or unavailable (HTTP ${match[1]})` : 'Worker list read access could not be verified' };
    }
  }
  const storageSecure = secureStorage(credentialStorage);
  let recommendation = 'Authentication diagnostics completed. Deployment and KV write permissions are checked only when those operations are requested.';
  if (authType === 'oauth' && !storageSecure) recommendation = 'OAuth is active, but encrypted keychain storage was not confirmed. Run npm.cmd run falco:auth:secure in PowerShell.';
  if (authType === 'api_token') recommendation = 'An API Token is active. Wrangler keyring protects OAuth credentials only; secure the environment variable separately if you use this method.';
  if (authType === 'api_key') recommendation = 'Global API Key/email authentication is not supported by Falco Factory. Use Wrangler OAuth or a scoped API Token.';
  if (permissions.workersRead.status === 'failed') recommendation += ' Check the token’s Workers Scripts read permission and selected account.';
  return {
    connected: true, factoryCompatible: !accountMismatch && ['oauth', 'api_token'].includes(authType), authMethod: authType,
    identity: typeof who.email === 'string' ? who.email.slice(0, 200) : '',
    authMethodLabel: AUTH_LABELS[authType], credentialStorage, credentialStorageLabel: STORAGE_LABELS[credentialStorage],
    secureStorage: storageSecure, accounts, selectedAccount: /^[a-f0-9]{32}$/i.test(selectedAccount) ? selectedAccount : '',
    permissions, recommendation, checkedAt: new Date().toISOString()
  };
}
