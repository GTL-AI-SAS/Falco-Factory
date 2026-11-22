import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig } from '../lib/args.mjs';
import { generate } from '../lib/generate.mjs';
import { deploy, runProcess } from '../lib/deploy.mjs';
import { readProject } from '../lib/projects.mjs';
import { inspectRemote, saveRemote } from '../lib/remote-state.mjs';
import { smoke } from '../lib/smoke.mjs';
import { createUiServer } from '../lib/ui-server.mjs';
import { persistedJob } from '../lib/operation-history.mjs';
import { FalcoBudget } from '../templates/worker/src/operations.mjs';
import worker from '../templates/worker/src/index.mjs';
import { publishKv, verifiedKnowledge } from '../lib/knowledge-kv.mjs';

const accountId = 'a'.repeat(32);
const origin = 'https://site.example';
const config = { name: 'falco-roadmap', business: 'Roadmap Restaurant', provider: 'mock', origin, 'account-id': accountId };
const one = '11111111-1111-1111-1111-111111111111';
const two = '22222222-2222-2222-2222-222222222222';
const three = '33333333-3333-3333-3333-333333333333';

async function fixture(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'falco-roadmap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = normalizeConfig({ ...config, ...extra }, root);
  Object.assign(project, { faq: 'Current hours: 18:00–22:00.', instructions: 'Reply in the visitor’s language.' });
  await generate(project);
  return { root, project };
}

test('forced regeneration preserves omitted knowledge/settings, previews changes, and backs up original bytes', async t => {
  const { root, project } = await fixture(t, { provider: 'gemini', model: 'another-gemini-model', 'rate-limit': '32' });
  const custom = path.join(project.output, 'notes.txt');
  await fs.writeFile(custom, 'local notes');
  const original = await fs.readFile(path.join(project.output, 'wrangler.json'));
  const input = normalizeConfig({ name: config.name, business: 'New Business', force: true }, root);
  const preview = await generate({ ...input, dryRun: true });
  assert.equal(preview.config.faq, project.faq);
  assert.equal(preview.config.provider, 'gemini');
  assert.deepEqual(await fs.readFile(path.join(project.output, 'wrangler.json')), original);
  const result = await generate(input);
  const restored = await readProject(root, config.name);
  assert.equal(restored.model, 'another-gemini-model');
  assert.equal(restored.faq, project.faq);
  assert.equal(restored.instructions, project.instructions);
  assert.equal(restored.rateLimit, 32);
  assert.equal(restored.accountId, accountId);
  assert.equal(await fs.readFile(custom, 'utf8'), 'local notes');
  assert.deepEqual(await fs.readFile(path.join(project.output, '.falco-history', result.backupId + '.before-regenerate', 'wrangler.json')), original);
  const empty = path.join(root, 'empty.md');
  await fs.writeFile(empty, '');
  await assert.rejects(generate(normalizeConfig({ ...config, force: true, faq: empty }, root)), /clear-faq/);
  await generate(normalizeConfig({ ...config, force: true, 'clear-faq': true }, root));
  assert.equal((await readProject(root, config.name)).faq, '');
});

test('drift blocks an existing Worker before Wrangler runs, including config-only drift', async t => {
  const { project } = await fixture(t);
  const prior = { fingerprint: 'before', detail: { deployment: one, versions: [{ id: one, percentage: 100 }], settings: 'a' } };
  await saveRemote(project, prior);
  const latest = { fingerprint: 'after', detail: { ...prior.detail, settings: 'b' } };
  const session = { accountId, token: 'never-logged' };
  const remoteReader = async () => latest;
  assert.deepEqual((await inspectRemote(project, session, { remoteReader })).fields, ['settings']);
  let commands = 0;
  await assert.rejects(deploy({ ...project, force: true }, {
    sessionReader: async () => session, remoteReader, wrangler: async () => { commands++; },
  }), /Remote drift/);
  assert.equal(commands, 0);
});

test('deployment baseline tracks the reported active version only', async t => {
  const { project } = await fixture(t);
  const session = { accountId, token: 'never-logged' };
  const url = 'https://falco-roadmap.test.workers.dev';
  let active = null;
  const result = await deploy(project, {
    sessionReader: async () => session, remoteReader: async () => active,
    wrangler: async args => {
      assert.equal(args[0], 'deploy');
      active = { fingerprint: 'live', detail: { deployment: three, versions: [{ id: two, percentage: 100 }] } };
      return { code: 0, stdout: url + '\nCurrent Version ID: ' + two, stderr: '' };
    },
    logger: () => {},
  });
  assert.equal(result.status, 'deployed');
  assert.equal((await inspectRemote(project, session, { remoteReader: async () => active })).status, 'clean');
});

test('provider smoke makes one billable request even if the live provider fails', async () => {
  let posts = 0;
  await assert.rejects(smoke('https://falco.test.workers.dev', { chat: true, fetcher: async (url, options) => {
    if (url.pathname === '/health') return Response.json({ service: 'falco', status: 'ok' });
    assert.equal(options.method, 'POST');
    posts++;
    return Response.json({ error: 'provider_rate_limited', message: ' private upstream value ' }, { status: 503 });
  } }), error => error.verification.health && error.verification.chat === false && !error.message.includes('private'));
  assert.equal(posts, 1);
});

test('process timeout and cancellation reject with a recovery message', async () => {
  const code = 'setInterval(() => {}, 1000)';
  await assert.rejects(runProcess(process.execPath, ['-e',code], { timeoutMs: 30 }), /time limit.*remote state/);
  const controller = new AbortController();
  const cancelled = runProcess(process.execPath, ['-e',code], { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, /cancelled.*remote state/);
});


test('operation history preserves safe verification statuses and action ID but excludes prompts and arbitrary fields', () => {
  const record = persistedJob({
    id:'12345678-1234-1234-1234-123456789abc', name:'falco-history-test', mode:'deploy', operation:'update',
    status:'deployed', createdAt:new Date().toISOString(),
    verification:{
      health:true,cors:true,chat:true,action:null,
      healthStatus:'pass',corsStatus:'pass',chatStatus:'pass',actionStatus:'not_authorized',
      actionId:'demo.open',actionMessage:'private prompt',rawProviderResponse:'sensitive'
    },
    events:[],url:'https://falco-history.gtl-ai.workers.dev'
  });
  assert.equal(record.verification.chatStatus,'pass');
  assert.equal(record.verification.actionStatus,'not_authorized');
  assert.equal(record.verification.actionId,'demo.open');
  assert.equal(Object.hasOwn(record.verification,'actionMessage'),false);
  assert.equal(Object.hasOwn(record.verification,'rawProviderResponse'),false);
});

test('operation history survives restart and excludes user input and credentials', async t => {
  const { root } = await fixture(t);
  const server = createUiServer({ root, port: 0, runner: { managedPreflight: async () => { throw new Error('private-test-key'); } } });
  const url = await server.listen();
  const token = (await (await fetch(url+'/api/bootstrap')).json()).token;
  const project = await readProject(root, config.name);
  const response = await fetch(url+'/api/jobs', { method: 'POST', headers: {
    'content-type': 'application/json', 'x-falco-local-token': token
  }, body: JSON.stringify({ mode:'update', folder: project.folder, revision: project.revision, faq: 'private-instructions', instructions: '' }) });
  assert.equal(response.status, 202);
  let history;
  for (let attempt = 0; attempt < 50; attempt++) {
    history = await (await fetch(url+'/api/operations?name='+config.name)).json();
    if (history.operations[0]?.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await server.close();
  const restarted = createUiServer({ root, port: 0 });
  const newUrl = await restarted.listen();
  t.after(() => restarted.close());
  const old = await (await fetch(newUrl+'/api/operations?name='+config.name)).json();
  assert.equal(old.operations[0].status, 'failed');
  assert.doesNotMatch(JSON.stringify(old), /private-test-key|private-instructions/);
});

test('daily and monthly reservations serialize concurrent calls and quota events open a breaker', async () => {
  const values = new Map();
  let chain = Promise.resolve();
  const storage = {
    async get(key) { return structuredClone(values.get(key)); },
    async put(data, value) {
      for (const [key, item] of (typeof data === 'string' ? [[data, value]] : Object.entries(data))) values.set(key, structuredClone(item));
    },
    transaction(work) {
      const next = chain.then(() => work(storage));
      chain = next.catch(() => {});
      return next;
    }
  };
  const meter = new FalcoBudget({ storage });
  const limits = { day: 3, month: 3, breakerSeconds: 60, turnstile: false, maintenance: false };
  const reservations = await Promise.all(Array.from({ length: 20 }, () => meter.reserve(limits)));
  assert.equal(reservations.filter(x => x.allowed).length, 3);
  await meter.record({ period: reservations[0].period, status:'provider_rate_limited', timing: 100, kvReads:1, breakerSeconds:60 });
  assert.equal((await meter.reserve(limits)).reason, 'provider_circuit_open');
  const report = await meter.summary();
  assert.equal(report.month.quota, 1);
  assert.equal(report.day.kvReads, 1);
});

test('health fails when the action catalog is invalid without exposing the configuration', async () => {
  const response = await worker.fetch(new Request('https://falco.test.workers.dev/health'), { CLIENT_ACTIONS_JSON: '{secret-invalid-content' });
  assert.equal(response.status, 503);
  const data = await response.json();
  assert.equal(data.error, 'invalid_action_configuration');
  assert.doesNotMatch(JSON.stringify(data), /secret-invalid-content/);
});

test('KV migration retains the legacy active revision for controlled rollback', async t => {
  const { project } = await fixture(t, { 'knowledge-mode': 'kv' });
  const file = path.join(project.output, 'wrangler.json');
  const settings = JSON.parse(await fs.readFile(file, 'utf8'));
  settings.kv_namespaces = [{ binding: 'FALCO_KNOWLEDGE', id: 'b'.repeat(32) }];
  await fs.writeFile(file, JSON.stringify(settings));
  const old = { version: 1, faq: 'old', instructions: '' };
  const entries = new Map([['knowledge:active', JSON.stringify(old)]]);
  const wrangler = async ([, , command, key, ...args]) => {
    if (command === 'get') return { code: 0, stdout: entries.get(key) ?? 'Value not found' };
    entries.set(key, await fs.readFile(args[args.indexOf('--path')+1], 'utf8'));
    return { code: 0, stdout: '' };
  };
  const published = await publishKv(project, { wrangler });
  const revision = verifiedKnowledge(old).revision;
  await assert.rejects(publishKv(project, { wrangler, revision, expectedActive: revision }), /active KV revision changed/);
  await publishKv(project, { wrangler, revision, expectedActive: published.revision });
  assert.equal(JSON.parse(entries.get('knowledge:active')).faq, old.faq);
});
