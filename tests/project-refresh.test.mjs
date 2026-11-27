import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeConfig } from '../lib/args.mjs';
import { generate } from '../lib/generate.mjs';
import { readProject, listVersions, readVersion } from '../lib/projects.mjs';
import { embeddedKnowledge, readDeployedProject, refreshProject } from '../lib/project-refresh.mjs';
import { inspectRemote } from '../lib/remote-state.mjs';
import { verifiedKnowledge } from '../lib/knowledge-kv.mjs';
import { createUiServer } from '../lib/ui-server.mjs';

const accountId = 'a'.repeat(32);
const name = 'falco-refresh-test';
const id = '11111111-1111-1111-1111-111111111111';
const remote = { fingerprint: 'live-fingerprint', detail: { deployment: id, versions: [{ id, percentage: 100 }] } };
const actions = [{ id: 'demo.open', description: 'Open a page', parameters: { option: { type: 'string', enum: ['01', '02'] } } }];
const knowledge = { faq: 'Current menu: café ☕, "quoted" prices.\nOpen Fridays.', instructions: 'Answer in Spanish.\nNever invent prices.' };
const session = { accountId, token: 'private-test-token' };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'falco-refresh-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = normalizeConfig({ name, business: 'Old business', provider: 'gemini', origin: 'https://old.example', 'account-id': accountId }, root);
  Object.assign(config, { faq: 'Starter FAQ', instructions: 'Starter instructions' });
  await generate(config);
  return { root, project: await readProject(root, name) };
}

function deployed(options = {}) {
  const vars = { BUSINESS_NAME: 'Live business', PROVIDER: 'gemini', MODEL: 'custom-live-model', KNOWLEDGE_MODE: 'embedded',
    MOCK_REPLY: 'Live mock reply', ALLOWED_ORIGIN: 'https://live.example', ALLOWED_ORIGINS: '["https://live.example"]',
    CLIENT_ACTIONS_JSON: JSON.stringify(actions), FALCO_TELEMETRY: 'false', ...options.vars };
  const settings = { observability: { enabled: false }, bindings: [
    ...Object.entries(vars).map(([name, text]) => ({ name, type: 'plain_text', text })),
    { name: 'GEMINI_API_KEY', type: 'secret_text', text: 'never-copy-a-secret' },
    { name: 'CHAT_RATE_LIMITER', type: 'ratelimit', namespace_id: '7654321', simple: { limit: 37, period: 60 } },
    ...(options.bindings ?? [])
  ] };
  const source = `// bundled Factory context\nvar businessInstructions = ${JSON.stringify(knowledge.instructions)};\nvar faqText = ${JSON.stringify(knowledge.faq)};\n`;
  const requests = [];
  const dependencies = {
    sessionProvider: async () => session,
    remoteReader: options.remoteReader ?? (async () => remote),
    get: async () => ({ found: true, result: settings }),
    fetcher: async (url, init) => {
      requests.push({ url, init });
      if (options.fetcher) return options.fetcher(url, init);
      const form = new FormData();
      form.set('index.js', new File([source], 'index.js', { type: 'application/javascript+module' }));
      return new Response(form);
    }
  };
  return { dependencies, requests, settings, reader: project => readDeployedProject(project, dependencies) };
}

test('recover exact bundled or unbundled literals without executing Worker code', () => {
  assert.deepEqual(embeddedKnowledge([`export const businessInstructions = "Be helpful.";\nexport const faqText = 'Caf\\xE9 \\'hours\\'\\nFriday';\nthrow Error('must never execute');`]),
    { instructions: 'Be helpful.', faq: "Café 'hours'\nFriday" });
  assert.throws(() => embeddedKnowledge(['var faqText = someFunction();']), /Cannot recover exact knowledge/);
  assert.deepEqual(embeddedKnowledge(['var businessInstructions = "Caf\\xE9 \\u{1F600} \\u2615";\nvar faqText = "";']),
    { instructions: 'Café 😀 ☕', faq: '' });
  assert.throws(() => embeddedKnowledge(['/*\nvar businessInstructions = "fake";\nvar faqText = "fake";\n*/']), /Cannot recover exact knowledge/);
  assert.throws(() => embeddedKnowledge(['const example = `\nvar businessInstructions = "fake";\nvar faqText = "fake";\n`;']), /Cannot recover exact knowledge/);
  assert.throws(() => embeddedKnowledge(['var businessInstructions = "a";\nvar faqText = "a";', 'var faqText = "b";']), /Ambiguous/);
});

test('recover esbuild static multiline templates with exact escapes and no interpolation', () => {
  const instructions = '  var businessInstructions = "Be helpful.";\n';
  const faq = 'const faqText = `First line\r\nSecond line\rThird line\nEscaped \\`code\\`, \\${price}, \\u{1F600} and \\xE9.\nJoined\\\r\nline`; // bundled context\n';
  assert.deepEqual(embeddedKnowledge([instructions + faq]), {
    instructions:'Be helpful.',faq:'First line\nSecond line\nThird line\nEscaped `code`, ${price}, 😀 and é.\nJoinedline'
  });
  assert.deepEqual(embeddedKnowledge(['export const businessInstructions = ``;\nexport const faqText = `FAQ`;']), {instructions:'',faq:'FAQ'});
  for (const source of [
    'var faqText = `FAQ ${someFunction()}`;',
    'var faqText = `FAQ` + someFunction();',
    'var faqText = String.raw`FAQ`;',
    'const example = `\nvar faqText = "fake";\n`;',
    'const example = "var faqText = \\"fake\\";";',
    '/*\nvar faqText = `fake`;\n*/'
  ]) assert.throws(() => embeddedKnowledge([instructions + source]), /Cannot recover exact knowledge/);
  assert.throws(() => embeddedKnowledge([instructions + 'var faqText = `First`;\nvar faqText = "Second";']), /Ambiguous/);
});

test('remote refresh accepts multipart esbuild template output and preserves its exact FAQ', async t => {
  const {root} = await fixture(t);
  const live = deployed({fetcher:async () => {
    const form = new FormData();
    const faq = knowledge.faq.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${');
    form.set('index.js',new File([`var businessInstructions = ${JSON.stringify(knowledge.instructions)};\nvar faqText = \`${faq}\`;\n`],'index.js'));
    form.set('index.js.map',new File([JSON.stringify({sourcesContent:['export const faqText = "stale";']})],'index.js.map'));
    return new Response(form);
  }});
  const loaded = await refreshProject(root,name,{reader:live.reader});
  assert.equal(loaded.faq,knowledge.faq);
  assert.equal(loaded.instructions,knowledge.instructions);
});

test('load replaces stale settings, actions and embedded knowledge together and keeps a recoverable backup', async t => {
  const { root, project } = await fixture(t);
  const live = deployed();
  const source = await fs.readFile(path.join(project.output, 'src/index.mjs'));
  const loaded = await refreshProject(root, name, { reader: live.reader });
  assert.equal(loaded.business, 'Live business');
  assert.equal(loaded.model, 'custom-live-model');
  assert.equal(loaded.rateLimit, 37);
  assert.deepEqual(loaded.actions, actions);
  assert.deepEqual(loaded.origins, ['https://live.example']);
  assert.equal(loaded.faq, knowledge.faq);
  assert.equal(loaded.instructions, knowledge.instructions);
  assert.deepEqual(await fs.readFile(path.join(project.output, 'src/index.mjs')), source);
  assert.equal((await inspectRemote(loaded, session, { remoteReader: async () => remote })).status, 'clean');
  const versions = await listVersions(loaded);
  const backup = await readVersion(loaded, versions[0].id);
  assert.equal(backup.config.faq, project.faq);
  assert.deepEqual(backup.config.actions, []);
  assert.ok(!(await fs.readFile(path.join(project.output, 'wrangler.json'), 'utf8')).includes('never-copy-a-secret'));
  await refreshProject(root, name, { reader: live.reader });
  assert.equal((await listVersions(loaded)).length, versions.length, 'reloading identical live state does not reset or create extra snapshots');
  assert.ok(live.requests.every(({ init }) => !init.method || init.method === 'GET'));
});

test('KV load reads active knowledge from the deployed namespace and records its revision', async t => {
  const { root } = await fixture(t);
  const namespaceId = 'b'.repeat(32);
  const payload = verifiedKnowledge({ version: 1, ...knowledge });
  const live = deployed({ vars: { KNOWLEDGE_MODE: 'kv' }, bindings: [{ name: 'FALCO_KNOWLEDGE', type: 'kv_namespace', namespace_id: namespaceId }],
    fetcher: async url => { assert.ok(url.includes('/' + namespaceId + '/values/knowledge%3Aactive')); return Response.json(payload); } });
  const loaded = await refreshProject(root, name, { reader: live.reader });
  assert.equal(loaded.knowledgeMode, 'kv');
  assert.equal(loaded.kvNamespaceId, namespaceId);
  assert.equal(loaded.faq, knowledge.faq);
  const baseline = JSON.parse(await fs.readFile(path.join(loaded.output, '.falco-kv-state.json')));
  assert.equal(baseline.revision, payload.revision);
});

test('unreadable content, invalid settings and concurrent remote changes preserve the original local project', async t => {
  const { root, project } = await fixture(t);
  let calls = 0;
  for (const live of [
    deployed({ fetcher: async () => new Response('not a Factory context') }),
    deployed({ vars: { PROVIDER: 'invalid-provider' } }),
    deployed({ remoteReader: async () => ++calls === 1 ? remote : { ...remote, fingerprint: 'changed' } }),
    deployed({ vars: { KNOWLEDGE_MODE: 'kv' }, bindings: [{ name: 'FALCO_KNOWLEDGE', type: 'kv_namespace', namespace_id: 'b'.repeat(32) }], fetcher: async () => Response.json({ version: 1, ...knowledge, revision: 'bad' }) })
  ]) {
    await assert.rejects(refreshProject(root, name, { reader: live.reader }));
    assert.equal((await readProject(root, name)).revision, project.revision);
    assert.equal((await listVersions(project)).length, 0);
  }
});

test('Studio refresh then action-only update and reload preserve deployed knowledge and settings', async t => {
  const { root } = await fixture(t);
  const live = deployed();
  let currentReader = live.reader;
  let published;
  const server = createUiServer({ root, port: 0, runner: {
    readDeployedProject: project => currentReader(project), managedPreflight: async () => {},
    deploy: async config => { published = config; return { status: 'deployed', url: 'https://falco-refresh-test.example.workers.dev', secret: 'preserved' }; },
    smoke: async () => ({ verification: { health: true, cors: true } })
  } });
  const base = await server.listen();
  t.after(() => server.close());
  const token = (await (await fetch(base + '/api/bootstrap')).json()).token;
  const post = (route, data) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Falco-Local-Token': token }, body: JSON.stringify(data) });
  assert.equal((await fetch(base + '/api/projects/' + name + '/refresh', { method: 'POST' })).status, 403);
  let response = await post('/api/projects/' + name + '/refresh', {});
  assert.equal(response.status, 200);
  const { project } = await response.json();
  const changedActions = [{ ...actions[0], description: 'Open the selected live page' }];
  response = await post('/api/jobs', { mode: 'update', folder: name, revision: project.revision,
    faq: project.faq, instructions: project.instructions, origins: project.origins, actions: changedActions });
  assert.equal(response.status, 202);
  const { job } = await response.json();
  let completed;
  for (let i = 0; i < 100; i++) {
    completed = (await (await fetch(base + '/api/jobs/' + job.id)).json()).job;
    if (['failed', 'partial', 'updated'].includes(completed.status)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(completed.status, 'updated', completed.error);
  assert.equal(published.faq, knowledge.faq);
  assert.equal(published.instructions, knowledge.instructions);
  assert.equal(published.model, 'custom-live-model');
  assert.deepEqual(published.actions, changedActions);
  currentReader = deployed({ vars: { CLIENT_ACTIONS_JSON: JSON.stringify(changedActions) } }).reader;
  response = await post('/api/projects/' + name + '/refresh', {});
  assert.equal(response.status, 200);
  const reloaded = (await response.json()).project;
  assert.deepEqual(reloaded.actions, changedActions);
  assert.equal(reloaded.faq, knowledge.faq);
  assert.equal(reloaded.model, published.model);
});
