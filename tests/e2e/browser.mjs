import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { once } from 'node:events';
import { createUiServer } from '../../lib/ui-server.mjs';
import { normalizeConfig } from '../../lib/args.mjs';
import { generate } from '../../lib/generate.mjs';

const toolRoot = new URL('../../', import.meta.url);
const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'falco-browser-'));
const name = 'falco-browser';
const status = 'https://falco-browser.demo.workers.dev';
const accountId = 'a'.repeat(32);
const versionId = '11111111-1111-1111-1111-111111111111';
const remote = { fingerprint: 'browser-live', detail: { deployment: versionId, versions: [{ id: versionId, percentage: 100 }] } };
let deployedConfig;
const chatRequests = [];
let chatShouldFail = false;
const noCost = async config => { deployedConfig = config; return { status:'deployed', url:status, secret:'not required' }; };
const studio = createUiServer({ root: projectRoot, port: 0, runner: {
  managedPreflight: async () => {},
  authDiagnostics: async () => ({ connected: true, factoryCompatible: true, accounts: [{ id: accountId, name: 'Browser account' }], selectedAccount: accountId }),
  session: async () => ({ accountId, token: 'browser-test' }),
  remoteReader: async () => remote,
  cloudWorkers: async () => ({ accountId, workers: [{ name }, { name: 'falco-remote-chat' }] }),
  workerEndpoint: async worker => `https://${worker.name}.demo.workers.dev/chat`,
  chatFetch: async (url, options) => { chatRequests.push({ url, options }); return chatShouldFail
    ? Response.json({ error: 'provider_rate_limited', message: 'Provider quota reached.' }, { status: 503 })
    : Response.json({ reply: 'Existing Falco chat works.', action: { id: 'demo.open', params: {} } }); },
  readDeployedProject: async () => ({ vars: { BUSINESS_NAME: deployedConfig.business, PROVIDER: deployedConfig.provider,
    MODEL: deployedConfig.model, MOCK_REPLY: deployedConfig.mockReply }, origins: deployedConfig.origins,
    actions: deployedConfig.actions, knowledgeMode: 'embedded', knowledge: deployedConfig,
    settings: { bindings: [] }, remote }),
  deploy: noCost,
  smoke: async () => ({ health: true, chat: true, verification: { chat:true, health:true, cors:true } })
} });
const config = normalizeConfig({ name, business:'Browser Studio', origin:'https://browser.example', 'account-id': accountId }, projectRoot);
config.faq = 'Friday: 18:00–22:00.';
await generate(config);
deployedConfig = { ...config, faq: 'Live knowledge from Cloudflare.', instructions: 'Keep the live instructions.',
  actions: [{ id: 'demo.open', description: 'Open a live page', parameters: {} }] };
const ui = await studio.listen();

const testServer = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/') {
    response.writeHead(200, { 'Content-Type':'text/html' });
    response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
      <link rel="stylesheet" href="/widget/falco-widget.css"><div id="demo"></div>
      <script type="module">
      import {mountFalcoWidget} from '/widget/falco-widget.js';
      window.actions = 0;
      await mountFalcoWidget('#demo', {endpoint: location.origin + '/chat', privacy: {url:'https://privacy.example/policy',notice:'Demo notice'},
       actionHandlers: {'demo.navigate': async () => { window.actions++; return true; }}});
      </script>`);
    return;
  }
  if (url.pathname === '/chat' && request.method === 'POST') {
    const raw = Array.fromAsync(request).then(chunks => JSON.parse(Buffer.concat(chunks).toString()));
    const data = await raw;
    const id = data.message === 'Missing handler' ? 'demo.missing' : 'demo.navigate';
    response.writeHead(200, { 'Content-Type':'application/json' });
    response.end(JSON.stringify({ reply:'The action is completed', action: { id, params: {} } }));
    return;
  }
  const relative = url.pathname.slice(1);
  if (relative.includes("..") || !/^[a-z./-]+\.(?:html|js|css)$/.test(relative)) { response.writeHead(404); response.end(); return; }
  let data = await fs.readFile(new URL('frontend-kit-template/' + relative, toolRoot), 'utf8');
  if (relative === 'config/falco.config.js') data = data.replace('__FALCO_CONFIG__', '{}');
  if (relative === 'actions/actions.manifest.js') data = data.replace('__FALCO_ACTIONS__',
    JSON.stringify(['demo.navigate','demo.missing'].map(id => ({ id, description:'Test action', parameters:{} }))));
  const mime = relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : 'text/html';
  response.writeHead(200, { 'Content-Type':mime });
  response.end(data);
});
await new Promise(resolve => testServer.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ ...(process.env.FALCO_CHROMIUM ? { executablePath:process.env.FALCO_CHROMIUM } : {}), headless:true,
  args: process.platform === 'linux' ? ['--no-sandbox'] : [] });
try {
  const page = await browser.newPage({ viewport:{ width:375, height:660 }, reducedMotion:'reduce' });
  await page.addInitScript(() => {
    window.__soundStarts = 0;
    const NativeAudioContext = window.AudioContext;
    if (NativeAudioContext) window.AudioContext = class extends NativeAudioContext {
      createOscillator() {
        const oscillator = super.createOscillator();
        const start = oscillator.start.bind(oscillator);
        oscillator.start = (...args) => { window.__soundStarts++; return start(...args); };
        return oscillator;
      }
    };
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(ui);
  assert.equal(await page.title(), 'Falco Studio');
  await page.locator('.brand-logo').evaluate(image => image.decode());
  assert.equal(await page.locator('.brand-logo').getAttribute('alt'), 'FALCO');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--mint').trim()), '#68e2c3');
  assert.equal(await page.locator('link[rel="icon"][type="image/svg+xml"]').getAttribute('href'), '/assets/falco-app-icon.svg');
  assert.equal(await page.evaluate(() => window.__soundStarts), 0, 'page load does not autoplay audio');
  await page.locator('#toggleSidebar').click();
  await page.locator('#soundToggle').click();
  assert.equal(await page.locator('#soundToggle').getAttribute('aria-pressed'), 'false');
  await page.reload();
  assert.equal(await page.locator('#soundToggle').getAttribute('aria-pressed'), 'false', 'mute persists after reload');
  for (const id of ['buildSummaryPanel', 'assistantPreviewPanel', 'consoleCard']) {
    const panel = page.locator('#' + id);
    await panel.locator(':scope > summary').click();
    assert.equal(await panel.evaluate(element => element.open), false);
    assert.equal(await panel.locator(':scope > :not(summary)').first().isVisible(), false);
    await panel.locator(':scope > summary').focus();
    await page.keyboard.press('Enter');
    assert.equal(await panel.evaluate(element => element.open), true);
  }
  await page.locator('#applyVertical').click();
  await page.waitForFunction(() => document.querySelector('#faq').value.includes('Hours'));
  await page.locator('#useGallinasActions').click();
  await page.locator('#createVisualActions').click();
  await page.locator('#simulateActions').click();
  await page.getByText(/handler_missing/).waitFor();
  await page.locator('#closeActions').click();
  await page.locator('#manageNav').click();
  const existing = page.locator('.remote-worker-card').filter({ hasText: name });
  await existing.getByRole('button', { name: 'Test chat' }).click();
  assert.equal(await page.locator('#workerChatName').textContent(), name);
  await page.locator('#workerChatMessage').fill('Hola, Falco existente');
  await page.locator('#workerChatMessage').press('Enter');
  await page.locator('#workerChatReply').getByText(/Existing Falco chat works/).waitFor();
  assert.equal(studio.jobs.size, 0, 'chat is available before any deployment');
  assert.equal(chatRequests[0].url, status + '/chat');
  assert.match(await page.locator('#workerChatReply').textContent(), /preview only/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#workerChatDialog').evaluate(dialog => dialog.open), false);
  assert.equal(await page.evaluate(() => window.__soundStarts), 0, 'muted chat responses stay silent');
  await page.locator('#toggleSidebar').click();
  await page.locator('#soundToggle').click();
  await page.waitForFunction(() => window.__soundStarts > 0);
  assert.equal(await page.locator('#soundToggle').getAttribute('aria-pressed'), 'true');
  await page.locator('#toggleSidebar').click();
  await page.locator('.remote-worker-card').filter({ hasText: 'falco-remote-chat' }).getByRole('button', { name: 'Test chat' }).click();
  assert.equal(await page.locator('#workerChatReply').textContent(), '');
  assert.equal(await page.locator('#workerChatName').textContent(), 'falco-remote-chat');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#workerChatSend').click();
  await page.locator('#workerChatReply').getByText(/Existing Falco chat works/).waitFor();
  assert.equal(chatRequests[1].url, 'https://falco-remote-chat.demo.workers.dev/chat');
  assert.equal(studio.jobs.size, 0);
  const notesBeforeError = await page.evaluate(() => window.__soundStarts);
  chatShouldFail = true;
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#workerChatSend').click();
  await page.locator('#workerChatReply').getByText(/Provider quota reached/).waitFor();
  await page.waitForFunction(before => window.__soundStarts >= before + 3, notesBeforeError);
  chatShouldFail = false;
  await page.locator('#closeWorkerChat').click();
  const notesBeforeAccount = await page.evaluate(() => window.__soundStarts);
  await page.locator('#refreshCloudWorkers').click();
  await page.waitForFunction(before => window.__soundStarts >= before + 3, notesBeforeAccount);
  await page.locator('#manageProject').selectOption(name);
  await page.getByText('Browser Studio', { exact:true }).last().waitFor();
  await page.waitForFunction(() => document.querySelector('#manageFaq').value === 'Live knowledge from Cloudflare.');
  assert.equal(await page.locator('#manageInstructions').inputValue(), 'Keep the live instructions.');
  assert.equal(JSON.parse(await page.locator('#manageActions').inputValue())[0].description, 'Open a live page');
  await page.waitForFunction(() => document.querySelector('#remoteReview').textContent.includes('Status: clean'));
  await page.locator('#manageLiveUrl[href="' + status + '/health"]').waitFor();
  assert.equal(await page.locator('#manageLiveLinks').evaluate(panel => panel.parentElement.matches('.manage-aside')), true);
  assert.equal(await page.locator('#manageTestChat').evaluate(panel => panel.parentElement.matches('.manage-aside')), true);
  assert.equal(await page.locator('#manageConsole #manageTestChat, #manageConsole #manageLiveLinks').count(), 0);
  await page.locator('#manageTestMessage').fill('Testing the independent chat panel');
  await page.locator('#manageTestMessage').press('Enter');
  await page.locator('#manageTestReply').getByText(/Existing Falco chat works/).waitFor();
  assert.equal(studio.jobs.size, 0);
  for (const id of ['selectedWorkerPanel', 'localSnapshotsPanel', 'manageLiveLinks', 'manageTestChat']) {
    const panel = page.locator('#' + id);
    await panel.locator(':scope > summary').click();
    assert.equal(await panel.evaluate(element => element.open), false);
    assert.equal(await panel.locator(':scope > :not(summary)').first().isVisible(), false);
    await panel.locator(':scope > summary').click();
    assert.equal(await panel.evaluate(element => element.open), true);
  }
  assert.equal(await page.locator('#manageTestMessage').inputValue(), 'Testing the independent chat panel');
  assert.match(await page.locator('#manageTestReply').textContent(), /Existing Falco chat works/);
  await page.locator('#manageConsole > summary').click();
  assert.equal(await page.locator('#manageConsole').evaluate(panel => panel.open), false);
  assert.equal(await page.locator('#manageConsoleStatus').isVisible(), true);
  assert.equal(await page.locator('#manageConsoleBody').isVisible(), false);
  await page.locator('#manageActions').fill(JSON.stringify([{ id: 'demo.open', description: 'Open the selected live page', parameters: {} }]));
  const notesBeforeDeployment = await page.evaluate(() => window.__soundStarts);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#saveDeploy').click();
  await page.waitForFunction(() => document.querySelector('#manageConsole').open);
  await page.waitForFunction(() => /READY|UPDATED/.test(document.querySelector('#manageConsoleStatus').textContent));
  await page.waitForFunction(before => window.__soundStarts >= before + 4, notesBeforeDeployment);
  await page.waitForFunction(() => !document.querySelector('#manageEditorPanel').hidden && document.querySelector('#saveDeploy').disabled);
  assert.equal(await page.locator('#manageFaq').inputValue(), 'Live knowledge from Cloudflare.');
  assert.equal(await page.locator('#manageInstructions').inputValue(), 'Keep the live instructions.');
  assert.equal(JSON.parse(await page.locator('#manageActions').inputValue())[0].description, 'Open the selected live page');
  await page.locator('#manageFaq').fill('Saturday: 18:00–22:00.');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#saveDeploy').click();
  await page.waitForFunction(() => /READY|UPDATED/.test(document.querySelector('#manageConsoleStatus').textContent));
  await page.getByText('Restore knowledge', { exact:true }).first().waitFor();
  await page.getByText('Restore full configuration', { exact:true }).first().waitFor();
  await page.locator('#operationsPanel summary').click();
  await page.locator('#showHistory').click();
  await page.getByText(/update · updated/).first().waitFor();
  await page.evaluate(() => Promise.all([...document.images].map(image => image.decode())));
  assert.deepEqual(await page.evaluate(() => [...document.images].filter(image => !image.naturalWidth).map(image => image.src)), []);
  assert.deepEqual(errors, []);

  const home = 'http://127.0.0.1:' + testServer.address().port;
  await page.goto(home);
  const launcher = page.getByRole('button', { name:'Chat' });
  await launcher.focus();
  await page.keyboard.press('Enter');
  const input = page.getByRole('textbox', { name:'Your message' });
  assert.equal(await input.evaluate(node => node === document.activeElement), true);
  await page.getByText('Demo notice').waitFor();
  await input.fill('Navigation');
  await input.press('Enter');
  await page.getByText('Acción completada.', { exact:true }).waitFor();
  assert.equal(await page.evaluate(() => window.actions), 1);
  await input.fill('Missing handler');
  await input.press('Enter');
  await page.getByText('Esta página todavía no tiene conectada esa acción.').waitFor();
  assert.equal(await page.evaluate(() => window.actions), 1);
  await page.keyboard.press('Escape');
  assert.equal(await launcher.evaluate(node => node === document.activeElement), true);
  assert.equal(await page.locator('.falco__panel').isVisible(), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  const lifetimeStudio = createUiServer({ root: projectRoot, port: 0,
    exitOnBrowserClose: { closeDelayMs: 300, startupTimeoutMs: 10000 },
    runner: { cloudWorkers: async () => ({ accountId, workers: [] }), authDiagnostics: async () => ({ connected: false, accounts: [] }) }
  });
  try {
    const lifetimeUrl = await lifetimeStudio.listen();
    const tabs = await browser.newContext();
    const firstTab = await tabs.newPage();
    let connected = firstTab.waitForResponse(response => response.url().endsWith('/api/studio/session'));
    await firstTab.goto(lifetimeUrl);
    assert.equal((await connected).status(), 200);
    const secondTab = await tabs.newPage();
    connected = secondTab.waitForResponse(response => response.url().endsWith('/api/studio/session'));
    await secondTab.goto(lifetimeUrl);
    assert.equal((await connected).status(), 200);
    connected = firstTab.waitForResponse(response => response.url().endsWith('/api/studio/session'));
    await firstTab.reload();
    assert.equal((await connected).status(), 200);
    await firstTab.close();
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(lifetimeStudio.server.listening, true, 'another browser tab keeps Studio alive');
    const stopped = once(lifetimeStudio.server, 'close');
    await secondTab.close();
    await stopped;
    assert.equal(lifetimeStudio.server.listening, false, 'closing the last tab stops Studio');
    await tabs.close();
  } finally { await lifetimeStudio.close(); }
  console.log('Browser E2E passed (Studio, keyboard, mobile, action success/failure, privacy, tab lifecycle).');
} finally {
  await browser.close();
  await studio.close();
  await new Promise(resolve => testServer.close(resolve));
  await fs.rm(projectRoot, { recursive:true, force:true });
}
