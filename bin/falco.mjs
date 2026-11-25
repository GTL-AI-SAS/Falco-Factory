#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs/promises';
import { parseArgs, normalizeConfig, VERSION, WRANGLER_VERSION } from '../lib/args.mjs';
import { generate } from '../lib/generate.mjs';
import { deploy, runWrangler, getCloudflareSession, getCloudflareAuthDiagnostics } from '../lib/deploy.mjs';
import { smoke } from '../lib/smoke.mjs';
import { recoverRegeneration } from '../lib/project-files.mjs';
import { readProjectAt } from '../lib/projects.mjs';
import { assertRemote, saveRemote } from '../lib/remote-state.mjs';

const aborter = new AbortController();
process.once('SIGINT', () => aborter.abort());
process.once('SIGTERM', () => aborter.abort());

function usage() {
  console.log(`FALCO FACTORY v${VERSION}\n\n` +
`Generate: npm run falco:new -- --name falco-gallinas --business "Gallinas y Valientes" --provider mock --origin http://localhost:3000 --faq ./examples/gallinas/faq.md --deploy\n\n` +
`Options: --name --business --provider mock|openai|gemini --model --origin --origins --faq --instructions --actions ./examples/gallinas/actions.json --knowledge-mode embedded|kv --output --deploy --dry-run --force --account-id --auth-profile --rate-limit --rate-namespace --mock-reply --clear-faq --clear-instructions --check-provider --observability\n` +
`Smoke:    npm run falco:smoke -- --url https://my-worker.example.workers.dev --chat [--business "Name"]\n` +
`Auth:     npm run falco:auth:status | npm run falco:auth:secure\n\n` +
`--dry-run previews and does not write files. --force backs up the same project before regeneration. Remote updates require a matching deployment baseline.\nDoctor: falco doctor [--cloud]\nRecover interrupted regeneration: falco recover <absolute-project-path> <backup-id>\n`);
}
function printReport(c, result, smokeResult) {
  console.log('\n=== FALCO FACTORY ===');
  console.log(`Business: ${c.business}\nWorker: ${c.name}\nProvider: ${c.provider} (${c.model})`);
  console.log(`Knowledge mode: ${c.knowledgeMode}\nProject generated: ${c.output}`);
  console.log(`Deployment: ${result.status}`);
  console.log(`Secrets: ${result.secret}`);
  if (result.url) {
    console.log(`Worker URL: ${result.url}\nChat URL: ${result.url}/chat`);
  }
  if (smokeResult) console.log(`Health check: OK${smokeResult.chat ? '\nChat check: OK' : ''}`);
  if (result.remoteError) console.error(`Cloudflare: ${result.remoteError}`);
  if (result.urlError) console.error(`URL: ${result.urlError}`);
  if (result.secretError) console.error(`NEXT ACTION: ${result.secretError}`);
}
function printAuthDiagnostics(d) {
  console.log('\n=== CLOUDFLARE AUTHENTICATION ===');
  console.log(`Connected: ${d.connected ? 'yes' : 'no'}`);
  console.log(`Authentication: ${d.authMethodLabel || 'Unknown'}`);
  console.log(`Credential storage: ${d.credentialStorageLabel || 'Unknown'}`);
  console.log(`Factory-compatible: ${d.factoryCompatible ? 'yes' : 'no'}`);
  console.log(`Accounts visible: ${d.accounts?.length ?? 0}`);
  if (d.selectedAccount) console.log(`Selected account: ${d.selectedAccount.slice(0, 6)}…${d.selectedAccount.slice(-4)}`);
  console.log(`Workers list permission: ${d.permissions?.workersRead?.label || 'Not checked'}`);
  console.log(`Deploy permission: ${d.permissions?.deployWrite?.label || 'Not tested'}`);
  console.log(`KV write permission: ${d.permissions?.kvWrite?.label || 'Not tested'}`);
  if (d.recommendation) console.log(`Next step: ${d.recommendation}`);
  console.log('No credential values were displayed or persisted by this diagnostic.\n');
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') return usage();
  if (command === 'doctor') {
    if (rest.length > 1 || (rest.length && rest[0] !== '--cloud')) throw new Error('Usage: falco doctor [--cloud]');
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 12)) throw new Error('Node.js 22.12.0 or newer is required by Wrangler 4.166.0.');
    const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const lock = JSON.parse(await fs.readFile(new URL('../package-lock.json', import.meta.url), 'utf8').catch(() => 'null'));
    const installed = await runWrangler(['--version']);
    if (pkg.devDependencies.wrangler !== WRANGLER_VERSION || lock?.packages?.['']?.devDependencies?.wrangler !== WRANGLER_VERSION || installed.code !== 0 || !installed.stdout.includes(WRANGLER_VERSION)) {
      throw new Error(`Wrangler installation or lockfile differs from package.json. Expected ${WRANGLER_VERSION}; run npm install.`);
    }
    console.log(`Falco ${VERSION} · Node ${process.versions.node} · Wrangler ${WRANGLER_VERSION}`);
    if (rest.length) {
      const diagnostics = await getCloudflareAuthDiagnostics({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID });
      printAuthDiagnostics(diagnostics);
      if (!diagnostics.connected || !diagnostics.factoryCompatible) process.exitCode = 1;
    }
    return;
  }
  if (command === 'auth') {
    if (rest.length !== 1 || !['status', 'secure'].includes(rest[0])) throw new Error('Usage: falco auth status|secure');
    if (rest[0] === 'status') {
      const diagnostics = await getCloudflareAuthDiagnostics({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID });
      printAuthDiagnostics(diagnostics);
      if (!diagnostics.connected || !diagnostics.factoryCompatible) process.exitCode = 1;
      return;
    }
    if (process.env.CLOUDFLARE_API_TOKEN) {
      console.log('CLOUDFLARE_API_TOKEN is set in this process. Wrangler keyring protects OAuth credentials only; it does not encrypt this environment variable. Keep using the API Token and secure its source separately, or remove it from this shell before switching to OAuth.');
      return;
    }
    if (process.env.CLOUDFLARE_API_KEY || process.env.CLOUDFLARE_EMAIL) {
      throw new Error('Global API Key/email environment variables are unsupported. Remove them from this shell and use Wrangler OAuth or a scoped API Token.');
    }
    const before = await getCloudflareAuthDiagnostics({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID });
    if (before.connected && before.authMethod === 'api_token') {
      printAuthDiagnostics(before);
      console.log('Keyring setup skipped: Wrangler OS-keyring storage protects OAuth credentials, not API-token environment variables.');
      return;
    }
    if (before.connected && before.authMethod === 'api_key') {
      printAuthDiagnostics(before);
      throw new Error('Global API Key/email authentication is unsupported. Switch to Wrangler OAuth or a scoped API Token first.');
    }
    if (before.connected && before.secureStorage) {
      console.log('Wrangler OAuth credentials are already protected by the OS keychain.');
      printAuthDiagnostics(before);
      return;
    }
    console.log('Starting the official Wrangler OAuth login with OS keychain storage.');
    console.log('On Windows, Wrangler stores the encryption key in Windows Credential Manager.');
    console.log('If a legacy plaintext OAuth file exists, Wrangler migrates it during this flow.');
    await runWrangler(['login', '--use-keyring'], { stdio: 'inherit', signal: aborter.signal, timeoutMs: 600000, env: { ...process.env, CLOUDFLARE_AUTH_USE_KEYRING: 'true' } });
    const after = await getCloudflareAuthDiagnostics({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID });
    printAuthDiagnostics(after);
    if (!after.connected || after.authMethod !== 'oauth' || !after.secureStorage) {
      throw new Error('Wrangler login completed, but encrypted OS-keychain storage could not be verified. Do not assume credentials are protected; inspect `wrangler whoami` and retry.');
    }
    console.log('Secure Wrangler OAuth authentication verified.');
    return;
  }
  if (command === 'recover') {
    if (rest.length !== 2 || !path.isAbsolute(rest[0])) throw new Error('Usage: falco recover <absolute-project-path> <backup-id>');
    await readProjectAt(rest[0]).catch(async () => {
      const marker = JSON.parse(await fs.readFile(path.join(rest[0], '.falco-generated.json'), 'utf8'));
      if (marker.generator !== 'falco-factory') throw new Error('Output is not a Falco project.');
    });
    await recoverRegeneration(rest[0], rest[1]);
    console.log('Local regeneration transaction recovered.');
    return;
  }
  if (command === 'smoke') {
    const flags = {};
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      if (flag === '--chat') flags.chat = true;
      else if (['--url','--business','--origin'].includes(flag)) flags[flag.slice(2)] = rest[++i];
      else throw new Error(`Invalid smoke option ${flag}`);
    }
    if (!flags.url) throw new Error('smoke requires --url');
    const result = await smoke(flags.url, flags);
    console.log('Health: OK', JSON.stringify(result.health));
    if (result.chat) console.log('Chat: OK', JSON.stringify(result.chat));
    return;
  }
  if (command !== 'new') throw new Error(`Unknown command '${command}'`);
  const opts = parseArgs(rest);
  if (opts.help) return usage();
  let c = normalizeConfig(opts);
  console.log(`FALCO FACTORY v${VERSION}\nWorker: ${c.name}\nBusiness: ${c.business}\nProvider: ${c.provider}\nOrigin: ${c.origin}`);
  if (c.force && !c.dryRun) {
    const preview = await generate({ ...c, dryRun: true });
    if (preview.diff) {
      console.log('Regeneration plan:', JSON.stringify({ files: preview.diff.files, settings: preview.diff.settings,
        faq: preview.diff.faq.changed, instructions: preview.diff.instructions.changed,
        origins: preview.diff.originsChanged, actions: preview.diff.actionsChanged }));
    }
  }
  const generated = await generate(c);
  c = generated.config;
  if (generated.backupId) console.log('Regeneration backup: ' + generated.backupId);
  if (c.dryRun) {
    console.log(`DRY RUN — no file writes or cloud changes\nOutput: ${c.output}\nRemote deploy requested: no\nFiles: ${generated.files.join(', ')}`);
    if (generated.diff) console.log('Diff:', JSON.stringify(generated.diff, null, 2));
    return;
  }
  console.log(`Knowledge mode: ${c.knowledgeMode}\nProject generated: ${c.output}`);
  if (!c.deploy) {
    console.log('No remote changes made. Add --deploy when ready.');
    return;
  }
  let result;
  try { result = await deploy(c, { preserveSecret: generated.exists && !process.env.FALCO_PROVIDER_API_KEY, signal: aborter.signal }); }
  catch (e) {
    console.error(`Deployment NOT completed: ${e.message}`);
    console.error(`Generated files remain at ${c.output}`);
    process.exitCode = 1;
    return;
  }
  let checked = null;
  if (result.url && result.status === 'deployed') {
    try {
      checked = await smoke(result.url, { business: c.business, origins: c.origins, chat: c.provider === 'mock' || c.checkProvider });
      if (checked.verification.chat && checked.verification.cors) {
        const current = { ...c, accountId: result.accountId };
        const state = await assertRemote(current, await getCloudflareSession(current));
        await saveRemote(current, { detail: state.current, fingerprint: state.fingerprint }, { verified: true });
        console.log('Readiness: READY');
      } else console.log('Readiness: provider check pending. Use smoke --chat to authorize one real request.');
    }
    catch (e) { console.error(`Verification FAILED: ${e.message}`); process.exitCode = 1; }
  } else process.exitCode = 1;
  printReport(c, result, checked);
  if (result.status !== 'deployed' || !checked) process.exitCode = 1;
}
main().catch(e => { console.error(`Falco Factory: ${e.message}`); process.exitCode = 1; });
