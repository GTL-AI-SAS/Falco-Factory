import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createUiServer } from '../../lib/ui-server.mjs';
import { createConnectionManager, getCloudflareSession, getCloudflareAuthDiagnostics } from '../../lib/cloudflare-auth.mjs';
import { readProject } from '../../lib/projects.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(),'falco-connections-browser-'));
const authHome = path.join(root,'auth'), A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32);
const profiles = new Set(['team-a','team-b']), bindings = new Map(), calls = [], requests = [], responses = [], errors = [];
const accounts = p => p === 'team-a' ? [{ id:A,name:'Production' },{ id:B,name:'Development' }]
  : [{ id:p === 'team-b' ? B : p === 'client-c' ? C : A,name:p }];
const ok = value => ({ code:0,stdout:typeof value === 'string' ? value : JSON.stringify(value),stderr:'' });
const wrangler = async (args, options = {}) => {
  calls.push({ args, options }); const profile = bindings.get(options.cwd) || 'default';
  if (args[1] === 'list') return ok('│ Profile │ Bound Directories │\n' + ['default',...profiles].map(p => `│ ${p} │ - │`).join('\n'));
  if (args[1] === 'activate') { bindings.set(args[3],args[2]); return ok('Bound'); }
  if (args[1] === 'create') { profiles.add(args[2]); return ok('Authorized'); }
  if (args[1] === 'delete') { profiles.delete(args[2]); return ok('Deleted'); }
  if (args[0] === 'whoami') return args.includes('--json') ? ok({ email:profile+'@example.com',accounts:accounts(profile) }) : ok('Encrypted file (profile.enc) with key in Windows Credential Manager');
  if (args[1] === 'token') return ok({ type:'oauth',token:'SECRET_CF_'+profile });
  throw new Error('Unexpected fixture command');
};
const diagnostics = opts => getCloudflareAuthDiagnostics({ ...opts,wrangler,authHome,env:{},cloudflareGet:async () => ({found:true,result:[]}) });
const manager = createConnectionManager({ root,authHome,wrangler,env:{},diagnostics });
const app = createUiServer({ root,port:0,runner:{ connections:manager,authDiagnostics:diagnostics,
  session: p => getCloudflareSession(p,{wrangler,authHome,env:{}}),
  cloudWorkers: async input => { requests.push(input); return {accountId:input.accountId || A,workers:[{name:'falco-'+(input.authProfile || 'default')}]}; },
  remoteReader: async () => null,
  workerEndpoint: async p => `https://${p.name}.demo.workers.dev/chat`,
  readDeployedProject: async () => { throw new Error('This local project has not been deployed.'); }
} });
const url = await app.listen();
const browser = await chromium.launch({ ...(process.env.FALCO_CHROMIUM ? {executablePath:process.env.FALCO_CHROMIUM} : {}),headless:true });
try {
  const page = await browser.newPage({reducedMotion:'reduce'});
  page.setDefaultTimeout(15000);
  page.on('pageerror',e => errors.push(e.message));
  page.on('response',r => { if (new URL(r.url()).pathname.startsWith('/api/')) void r.text().then(text => responses.push(text)).catch(() => {}); });
  await page.goto(url); await page.waitForSelector('#studioApp:not([inert])');
  await page.locator('#authDiagnosticsPanel').evaluate(el => {el.open=true;});
  await page.locator('#openConnections').click();
  await page.waitForFunction(() => document.querySelectorAll('.connection-card').length === 3);
  const teamA = page.locator('.connection-card').filter({has:page.getByRole('heading',{name:'team-a',exact:true})});
  await teamA.getByText('Production',{exact:false}).waitFor();
  assert.match(await teamA.innerText(),/Windows Credential Manager/);
  assert.doesNotMatch(await teamA.innerText(),new RegExp(A));
  await page.locator('#addConnection').click(); await page.locator('#connectionName').fill('Client C');
  assert.equal(await page.locator('#connectionProfile').inputValue(),'client-c');
  await page.locator('#authenticateConnection').click();
  await page.waitForFunction(() => document.querySelector('#connectionNotice').textContent.includes('verified with secure'));
  assert.ok(calls.some(c => c.args.join(' ') === 'auth create client-c'));
  await page.locator('#closeConnections').click();
  await page.locator('#createAuthProfile').selectOption('team-a');
  await page.waitForFunction(() => document.querySelector('#createAccountSelect').options.length === 3);
  assert.equal(await page.locator('#accountId').inputValue(),'','multiple accounts require an explicit selection');
  await page.locator('#createAccountSelect').selectOption(A);
  await page.locator('#business').fill('Profile Browser'); await page.locator('#name').fill('falco-profile-browser');
  await page.locator('#generateBtn').click();
  await page.waitForFunction(() => document.querySelector('#consoleBody').textContent.includes('Files generated successfully'));
  const p = await readProject(root,'falco-profile-browser'); assert.equal(p.authProfile,'team-a'); assert.equal(p.accountId,A);
  await page.locator('#sidebarManage').click(); await page.locator('#remoteAuthProfile').selectOption('team-b');
  await page.waitForFunction(() => document.querySelector('#remoteWorkerList').textContent.includes('falco-team-b'));
  assert.ok(requests.some(r => r.authProfile === 'team-b' && r.accountId === B));
  await page.locator('#manageProject').selectOption(p.folder);
  await page.waitForFunction(() => document.querySelector('#managedConnection').textContent === 'team-a');
  await page.locator('#projectConnectionEditor').evaluate(el => {el.open=true;});
  await page.locator('#managedAuthProfile').selectOption('client-c');
  await page.waitForFunction(() => document.querySelector('#managedConnectionAccount').value === 'c'.repeat(32));
  // Account changes remain guarded; switching profiles on the same account can save directly.
  await page.locator('#managedAuthProfile').selectOption('');
  await page.waitForFunction(() => document.querySelector('#managedConnectionAccount').value === 'a'.repeat(32));
  await page.locator('#saveProjectConnection').click();
  await page.waitForFunction(() => document.querySelector('#projectConnectionStatus').textContent.includes('Local assignment saved'));
  assert.equal((await readProject(root,p.folder)).authProfile,'');
  await page.locator('#openConnections').click();
  const client = page.locator('.connection-card').filter({has:page.getByRole('heading',{name:'Client C',exact:true})});
  const priorOperation = await page.evaluate(async () => (await (await fetch('/api/connections/operation')).json()).operation.id);
  await client.getByRole('button',{name:'Reauthenticate',exact:true}).click();
  await page.waitForFunction(async priorId => {
    const { operation } = await (await fetch('/api/connections/operation')).json();
    return operation.id !== priorId && operation.status === 'connected';
  }, priorOperation);
  await page.waitForFunction(() => document.querySelector('#connectionProgress').hidden);
  assert.equal(calls.filter(c => c.args.join(' ') === 'auth create client-c').length,2);
  assert.ok(calls.filter(c => c.args[1] === 'create').every(c => c.options.env.CLOUDFLARE_AUTH_USE_KEYRING === 'true'));
  assert.ok(!responses.some(r => r.includes('SECRET_CF_'))); assert.deepEqual(errors,[]);
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  console.log('Connection browser E2E passed: OAuth job, accounts, project persistence, remote routing, reassignment, reauthentication, token exclusion and mobile layout.');
} finally { await browser.close(); await app.close(); await fs.rm(root,{recursive:true,force:true}); }
