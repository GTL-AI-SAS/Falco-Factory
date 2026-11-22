import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCredentialStorage, getCloudflareAuthDiagnostics } from '../lib/deploy.mjs';

const ACCOUNT = 'a'.repeat(32);
const TOKEN = 'DO_NOT_RETURN_OR_LOG_THIS_TOKEN';

function wranglerFixture({ authType = 'oauth', report = 'Credentials are stored in: Encrypted file (default.enc) with key in Windows Credential Manager (service=wrangler, account=default)', accounts = [{ id: ACCOUNT, name: 'GTL AI' }] } = {}) {
  return async args => {
    if (args[0] === 'whoami' && args.includes('--json')) return { code: 0, stdout: JSON.stringify({ accounts }), stderr: '' };
    if (args[0] === 'auth') return { code: 0, stdout: JSON.stringify({ type: authType, token: TOKEN }), stderr: '' };
    if (args[0] === 'whoami') return { code: 0, stdout: report, stderr: '' };
    throw new Error('Unexpected Wrangler command in test');
  };
}

test('classifies Windows Credential Manager and encrypted OS keychains without exposing paths', () => {
  assert.equal(classifyCredentialStorage('oauth', 'Encrypted file (default.enc) with key in Windows Credential Manager'), 'windows-credential-manager');
  assert.equal(classifyCredentialStorage('oauth', 'Encrypted file (default.enc) with key in macOS Keychain'), 'os-keychain-encrypted');
  assert.equal(classifyCredentialStorage('oauth', 'Credentials are stored in: C:\\Users\\test\\.wrangler\\config\\default.toml'), 'plaintext-config-file');
  assert.equal(classifyCredentialStorage('api_token', '', { CLOUDFLARE_API_TOKEN: 'hidden' }), 'environment-variable');
});

test('auth diagnostics verifies account read access and never returns a Wrangler token or raw whoami report', async () => {
  let testedSession, testedEndpoint;
  const result = await getCloudflareAuthDiagnostics({
    wrangler: wranglerFixture(),
    cloudflareGet: async (session, endpoint) => { testedSession = session; testedEndpoint = endpoint; return { found: true, result: [] }; }
  });
  assert.equal(result.connected, true);
  assert.equal(result.factoryCompatible, true);
  assert.equal(result.authMethod, 'oauth');
  assert.equal(result.credentialStorage, 'windows-credential-manager');
  assert.equal(result.secureStorage, true);
  assert.equal(result.permissions.workersRead.status, 'passed');
  assert.equal(result.permissions.deployWrite.status, 'not_tested');
  assert.equal(result.permissions.kvWrite.status, 'not_tested');
  assert.equal(testedEndpoint, '/workers/scripts');
  assert.deepEqual(testedSession, { accountId: ACCOUNT, token: TOKEN });
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  assert.ok(!JSON.stringify(result).includes('default.enc'));
});

test('plaintext OAuth storage is reported as a warning and gets a safe next step', async () => {
  const result = await getCloudflareAuthDiagnostics({
    wrangler: wranglerFixture({ report: 'Credentials are stored in: C:\\Users\\owner\\.config\\.wrangler\\config\\default.toml' }),
    cloudflareGet: async () => ({ found: true, result: [] })
  });
  assert.equal(result.credentialStorage, 'plaintext-config-file');
  assert.equal(result.secureStorage, false);
  assert.match(result.recommendation, /falco:auth:secure/);
});

test('API token diagnostics explain that Wrangler keyring does not protect environment variables', async () => {
  const result = await getCloudflareAuthDiagnostics({
    wrangler: wranglerFixture({ authType: 'api_token', report: 'API Token authentication' }),
    env: { CLOUDFLARE_API_TOKEN: TOKEN },
    cloudflareGet: async () => ({ found: true, result: [] })
  });
  assert.equal(result.authMethod, 'api_token');
  assert.equal(result.credentialStorage, 'environment-variable');
  assert.equal(result.secureStorage, false);
  assert.match(result.recommendation, /environment variable/i);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('ambiguous accounts do not trigger an account-wide permission probe', async () => {
  let probes = 0;
  const result = await getCloudflareAuthDiagnostics({
    wrangler: wranglerFixture({ accounts: [{ id: ACCOUNT, name: 'One' }, { id: 'b'.repeat(32), name: 'Two' }] }),
    cloudflareGet: async () => { probes++; return { found: true, result: [] }; }
  });
  assert.equal(result.accounts.length, 2);
  assert.equal(result.selectedAccount, '');
  assert.equal(result.permissions.workersRead.status, 'not_checked');
  assert.equal(probes, 0);
});

test('unauthenticated Wrangler returns a safe disconnected state', async () => {
  const result = await getCloudflareAuthDiagnostics({ wrangler: async () => ({ code: 1, stdout: '', stderr: 'secret-looking raw error' }) });
  assert.equal(result.connected, false);
  assert.equal(result.recommendation, 'Run the secure Wrangler login command, then refresh diagnostics.');
  assert.ok(!JSON.stringify(result).includes('secret-looking'));
});
