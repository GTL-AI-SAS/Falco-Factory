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
  assert.throws(() => configFromForm({ ...baseline, faq: 'x'.repeat(24001) }), /faq exceeds/);
});

test('replacement requires typed exact worker name', () => {
  assert.throws(() => configFromForm({ ...baseline, force: true, confirmName: 'wrong' }), /type its exact name/);
  assert.equal(configFromForm({ ...baseline, force: true, confirmName: baseline.name }).force, true);
});

test('studio serves the frontend and blocks cross-origin mutation or requests missing token', async t => {
  const env = await withServer(t);
  const html = await (await fetch(env.url)).text();
  assert.match(html, /Falco Factory Studio/);
  assert.match(html, /Generate & deploy/);
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
  assert.equal(before.body.files.length, 13);
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
