import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createUiServer, configFromForm } from '../lib/ui-server.mjs';

const baseline = { name: 'falco-ui-test', business: 'UI Test Business', provider: 'mock', origin: 'http://localhost:3000', faq: 'Opening hours: 9 to 5', instructions: 'Only answer documented facts.' };

async function withServer(t, options = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'falco-ui-test-'));
  const app = createUiServer({ port: 0, root: tmp, ...options });
  const url = await app.listen();
  const bootstrap = await (await fetch(`${url}/api/bootstrap`)).json();
  t.after(async () => { await app.close(); await fs.rm(tmp, { recursive: true, force: true }); });
  return { tmp, app, url, token: bootstrap.token,
    async post(route, data, extraHeaders = {}) {
      const resp = await fetch(`${url}${route}`, { method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-Falco-Local-Token': bootstrap.token, Origin: url, ...extraHeaders,
      }, body: JSON.stringify(data) });
      return { code: resp.status, body: await resp.json() };
    } };
}
async function waitForJob(env, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${env.url}/api/jobs/${id}`);
    const data = await response.json();
    if (['failed', 'partial', 'deployed', 'generated'].includes(data.job.status)) return data.job;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Job did not finish');
}

test('form validation: accepts plain business instructions; rejects path traversal and oversized FAQ', () => {
  const good = configFromForm({ ...baseline, outputFolder: 'falco-unique', faq: 'x'.repeat(1500) });
  assert.ok(good.output.endsWith(path.join('.generated', 'falco-unique')));
  assert.equal(good.instructions, baseline.instructions);
  assert.throws(() => configFromForm({ ...baseline, outputFolder: '../../secret' }), /Output folder/);
  assert.throws(() => configFromForm({ ...baseline, faq: 'x'.repeat(24001) }), /faq (?:exceeds|must be)/);
});

test('replacement requires typed exact worker name', () => {
  assert.throws(() => configFromForm({ ...baseline, force: true, confirmName: 'wrong' }), /type its exact name/);
  assert.equal(configFromForm({ ...baseline, force: true, confirmName: baseline.name }).force, true);
});

test('existing Worker chat works without a deployment job or local source and uses the selected account', async t => {
  const accountId = 'a'.repeat(32);
  let called;
  const env = await withServer(t, { runner: {
    cloudWorkers: async input => { assert.equal(input.accountId, accountId); return { accountId, workers: [{ name: baseline.name }] }; },
    workerEndpoint: async input => { assert.deepEqual(input, { accountId, name: baseline.name }); return 'https://falco-ui-test.demo.workers.dev/chat'; },
    chatFetch: async (endpoint, options) => { called = { endpoint, options }; return Response.json({ reply: 'Hello from the existing Falco', action: { id: 'demo.open', params: {} } }); },
    deploy: async () => { throw new Error('Chat must not deploy'); }
  } });
  const result = await env.post('/api/cloudflare/workers/chat', { accountId, name: baseline.name, message: 'Hola' });
  assert.equal(result.code, 200);
  assert.equal(result.body.reply, 'Hello from the existing Falco');
  assert.equal(result.body.action.id, 'demo.open');
  assert.equal(called.endpoint, 'https://falco-ui-test.demo.workers.dev/chat');
  assert.deepEqual(JSON.parse(called.options.body), { message: 'Hola', history: [] });
  assert.equal(called.options.headers.Authorization, undefined, 'Cloudflare management credentials are not sent to chat');
  assert.equal(env.app.jobs.size, 0);
  assert.deepEqual(await fs.readdir(env.tmp), []);
});

test('existing Worker chat rejects invalid targets and messages and preserves Worker diagnostics', async t => {
  const accountId = 'a'.repeat(32);
  let requests = 0;
  const env = await withServer(t, { runner: {
    cloudWorkers: async () => ({ accountId, workers: [{ name: baseline.name }] }),
    workerEndpoint: async () => 'https://falco-ui-test.demo.workers.dev/chat',
    chatFetch: async () => { requests++; return Response.json({ error: 'provider_rate_limited', message: 'Provider quota reached.', providerStatus: 429 }, { status: 503 }); }
  } });
  const payload = { accountId, name: baseline.name, message: 'Hola' };
  for (const invalid of [{ accountId: 'bad' }, { name: '../../other' }, { message: '' }, { message: 'a'.repeat(2001) }]) {
    assert.equal((await env.post('/api/cloudflare/workers/chat', { ...payload, ...invalid })).code, 400);
  }
  assert.equal((await env.post('/api/cloudflare/workers/chat', { ...payload, name: 'falco-missing' })).code, 404);
  assert.equal((await env.post('/api/cloudflare/workers/chat', { ...payload, accountId: 'b'.repeat(32) })).code, 404);
  assert.equal((await env.post('/api/cloudflare/workers/chat', payload, { 'X-Falco-Local-Token': 'bad' })).code, 403);
  assert.equal(requests, 0);
  const failed = await env.post('/api/cloudflare/workers/chat', payload);
  assert.equal(failed.code, 503);
  assert.equal(failed.body.code, 'provider_rate_limited');
  assert.match(failed.body.error, /Provider quota reached/);
  assert.equal(requests, 1);
});

test('studio serves the frontend and blocks cross-origin mutation or requests missing token', async t => {
  const env = await withServer(t);
  const html = await (await fetch(env.url)).text();
  assert.match(html, /Falco Factory Studio/);
  assert.match(html, /Generate & deploy/);
  assert.match(html, /Authentication &amp; permissions/);
  assert.match(html, /copyAuthSecureCommand/);
  assert.match(html, /createActionCheck/);
  assert.match(html, /manageActionCheck/);
  const noToken = await fetch(`${env.url}/api/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: env.url }, body: '{}' });
  assert.equal(noToken.status, 403);
  const evilOrigin = await env.post('/api/preview', baseline, { Origin: 'https://evil.example' });
  assert.equal(evilOrigin.code, 403);
  const badHostCode = await new Promise((resolve, reject) => {
    http.get(env.url + '/api/bootstrap', { headers: { Host: 'somewhere.example:1234' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(badHostCode, 403);
});

test('preview leaves disk unchanged and generation writes complete project', async t => {
  const env = await withServer(t);
  const before = await env.post('/api/preview', baseline);
  assert.equal(before.code, 200);
  assert.equal(before.body.localExists, false);
  assert.ok(before.body.files.includes('package-lock.json'));
  assert.ok(before.body.files.includes('.falco-runtime.json'));
  await assert.rejects(fs.stat(path.join(env.tmp, '.generated')));
  const started = await env.post('/api/jobs', { ...baseline, mode: 'generate' });
  assert.equal(started.code, 202);
  const job = await waitForJob(env, started.body.job.id);
  assert.equal(job.status, 'generated');
  assert.equal(job.url, null);
  const context = await fs.readFile(path.join(env.tmp, '.generated', baseline.name, 'src/business-context.mjs'), 'utf8');
  assert.match(context, /Opening hours: 9 to 5/);
  const after = await env.post('/api/preview', baseline);
  assert.equal(after.body.localExists, true);
  assert.equal(after.body.forceRequired, true);
});

test('default mode never overwrites existing generated project', async t => {
  const env = await withServer(t);
  let started = await env.post('/api/jobs', { ...baseline, mode: 'generate' });
  assert.equal((await waitForJob(env, started.body.job.id)).status, 'generated');
  started = await env.post('/api/jobs', { ...baseline, mode: 'generate' });
  const second = await waitForJob(env, started.body.job.id);
  assert.equal(second.status, 'failed');
  assert.match(second.error, /Project directory exists/);
  started = await env.post('/api/jobs', { ...baseline, force: true, confirmName: baseline.name, mode: 'generate' });
  assert.equal((await waitForJob(env, started.body.job.id)).status, 'generated');
});

test('UI deploy supplies key to Wrangler adapter without including it in job or generated files', async t => {
  let capturedKey = '';
  const env = await withServer(t, { runner: {
    deploy: async (c, options) => { capturedKey = options.apiKey; options.logger('Authentication: OK'); return { status: 'deployed', url: 'https://falco-ui-ai.gtl-ai.workers.dev', secret: 'configured' }; },
    smoke: async () => ({ health: { status: 'ok' }, chat: null }),
  } });
  const key = 'secret-UNIT-TEST-ONLY-do-not-persist';
  const request = { ...baseline, name: 'falco-ui-ai', provider: 'openai', model: 'gpt-5.4-mini', apiKey: key, mode: 'deploy' };
  const started = await env.post('/api/jobs', request);
  assert.equal(started.code, 202);
  assert.ok(!JSON.stringify(started.body).includes(key));
  const job = await waitForJob(env, started.body.job.id);
  assert.equal(job.status, 'deployed');
  assert.equal(job.verification.health, true);
  assert.equal(capturedKey, key);
  assert.ok(!JSON.stringify(job).includes(key));
  const generated = await fs.readFile(path.join(env.tmp, '.generated', request.name, 'wrangler.json'), 'utf8');
  assert.ok(!generated.includes(key));
});

test('paid provider deployment requires key, but preview and generate-only do not', async t => {
  const env = await withServer(t);
  const d = { ...baseline, provider: 'gemini', model: 'gemini-2.5-flash' };
  assert.equal((await env.post('/api/preview', d)).code, 200);
  const blocked = await env.post('/api/jobs', { ...d, mode: 'deploy' });
  assert.equal(blocked.code, 400);
  assert.match(blocked.body.error, /provider API key/);
  const generated = await env.post('/api/jobs', { ...d, mode: 'generate' });
  assert.equal((await waitForJob(env, generated.body.job.id)).status, 'generated');
});

test('deployment partial failure reports status correctly; no false success', async t => {
  const env = await withServer(t, { runner: {
    deploy: async () => ({ status: 'deployed_without_secret', url: 'https://falco-ui-test.gtl-ai.workers.dev', secret: 'not configured', secretError: 'Secure secret configuration is incomplete.' }),
  } });
  const started = await env.post('/api/jobs', { ...baseline, mode: 'deploy' });
  const job = await waitForJob(env, started.body.job.id);
  assert.equal(job.status, 'partial');
  assert.equal(job.partial, true);
  assert.match(job.events.map(e => e.message).join(' '), /secret configuration is incomplete/);
});


test('action verification configuration requires an existing action and an explicit test message', () => {
  const action = [{ id:'demo.open', description:'Open one of the demo options when requested.', parameters:{ option:{ type:'string', enum:['01','02','03'] } } }];
  const config = configFromForm({ ...baseline, provider:'gemini', actions:action, checkAction:true, actionMessage:'Please open option 01.' });
  assert.equal(config.checkAction, true);
  assert.equal(config.actionMessage, 'Please open option 01.');
  assert.throws(() => configFromForm({ ...baseline, provider:'gemini', checkAction:true, actionMessage:'Please open option 01.' }), /configure at least one action/);
  assert.throws(() => configFromForm({ ...baseline, provider:'gemini', actions:action, checkAction:true, actionMessage:'' }), /test message/);
  assert.throws(() => configFromForm({ ...baseline, actions:action, checkAction:true, actionMessage:'Please open option 01.' }), /require Gemini or OpenAI/);
});

test('action verification after deployment is opt-in and uses one request to check chat plus proposal', async t => {
  let captured;
  const action = [{ id:'demo.open', description:'Open one of the demo options when requested.', parameters:{ option:{ type:'string', enum:['01','02','03'] } } }];
  const env = await withServer(t, { runner: {
    deploy: async () => ({ status:'deployed', url:'https://falco-ui-ai.gtl-ai.workers.dev', secret:'preserved (not changed)' }),
    smoke: async (url, options) => {
      captured = { url, options };
      return { health:{status:'ok'}, chat:{reply:'Opening option 01'}, verification:{
        health:true,cors:true,chat:true,action:true,actionId:'demo.open',
        healthStatus:'pass',corsStatus:'pass',chatStatus:'pass',actionStatus:'pass'
      }};
    }
  }});
  const request = { ...baseline, name:'falco-ui-ai', provider:'gemini', model:'gemini-2.5-flash',
    apiKey:'test-provider-key', actions:action, checkAction:true, actionMessage:'Please open option 01.', mode:'deploy' };
  const started = await env.post('/api/jobs', request);
  assert.equal(started.code, 202);
  const job = await waitForJob(env, started.body.job.id);
  assert.equal(job.status, 'deployed');
  assert.equal(job.readiness, 'ready');
  assert.equal(captured.options.chat, true);
  assert.equal(captured.options.action.id, 'demo.open');
  assert.deepEqual(captured.options.action.params, { option:'01' });
  assert.equal(captured.options.action.message, 'Please open option 01.');
});

test('Studio explains untested provider and action checks with explicit statuses', async t => {
  const env = await withServer(t, { runner: {
    deploy: async () => ({ status:'deployed', url:'https://falco-ui-ai.gtl-ai.workers.dev', secret:'preserved (not changed)' }),
    smoke: async () => ({ health:{status:'ok'}, chat:null, verification:{
      health:true,cors:true,chat:null,action:null,
      healthStatus:'pass',corsStatus:'pass',chatStatus:'not_authorized',actionStatus:'not_configured'
    }})
  }});
  const request = { ...baseline, name:'falco-ui-ai', provider:'gemini', model:'gemini-2.5-flash',
    apiKey:'test-provider-key', mode:'deploy' };
  const started = await env.post('/api/jobs', request);
  const job = await waitForJob(env, started.body.job.id);
  assert.equal(job.verification.chatStatus, 'not_authorized');
  assert.equal(job.verification.actionStatus, 'not_configured');
  assert.equal(job.readiness, 'verification incomplete');
});
