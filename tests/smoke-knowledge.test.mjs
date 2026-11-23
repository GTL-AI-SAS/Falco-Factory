import test from 'node:test';
import assert from 'node:assert/strict';
import { smoke } from '../lib/smoke.mjs';

const origin = 'https://site.example';
const revision = 'a'.repeat(64);
function fixture({ knowledge = Response.json({ mode: 'kv', revision }), healthStatus = 200, corsStatus = 204 } = {}) {
  const calls = [];
  return { calls, fetcher: async (url, options) => {
    calls.push({ path: url.pathname, method: options.method || 'GET' });
    if (url.pathname === '/health') return Response.json({ status: 'ok', service: 'falco' }, { status: healthStatus });
    if (options.method === 'OPTIONS') {
      if (options.headers.Origin === 'null') return new Response(null, { status: 403 });
      return new Response(null, { status: corsStatus, headers: {
        'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type'
      } });
    }
    if (url.pathname === '/knowledge-status') return knowledge;
    throw Error('This test must not make a provider request.');
  } };
}

test('smoke records successful KV revision verification without a provider request', async () => {
  const e = fixture();
  const result = await smoke('https://falco.test.workers.dev', { origins: [origin], knowledgeRevision: revision, fetcher: e.fetcher, attempts: 1 });
  assert.equal(result.verification.knowledge, true);
  assert.equal(result.verification.knowledgeStatus, 'pass');
  assert.equal(result.verification.cors, true);
  assert.equal(result.verification.chatStatus, 'not_authorized');
  assert.equal(e.calls.filter(call => call.method === 'POST').length, 0);
});

test('smoke reports failed knowledge checks separately from passed CORS and skips authorized chat', async () => {
  for (const knowledge of [Response.json({ revision: 'b'.repeat(64) }), Response.json({ error: 'knowledge_unavailable' }, { status: 503 }), new Response('invalid JSON')]) {
    const e = fixture({ knowledge });
    await assert.rejects(smoke('https://falco.test.workers.dev', { origins: [origin], chat: true, knowledgeRevision: revision, fetcher: e.fetcher, attempts: 1 }), error => {
      assert.equal(error.verification.knowledge, false);
      assert.equal(error.verification.knowledgeStatus, 'failed');
      assert.equal(error.verification.corsStatus, 'pass');
      assert.equal(error.verification.chatStatus, 'skipped');
      return true;
    });
    assert.equal(e.calls.filter(call => call.method === 'POST').length, 0);
  }
});

test('knowledge checks are skipped after preflight failure and absent when no revision is requested', async () => {
  for (const failure of [{ healthStatus: 503 }, { corsStatus: 403 }]) {
    const e = fixture(failure);
    await assert.rejects(smoke('https://falco.test.workers.dev', { origins: [origin], knowledgeRevision: revision, fetcher: e.fetcher, attempts: 1 }), error => {
      assert.equal(error.verification.knowledge, null);
      assert.equal(error.verification.knowledgeStatus, 'skipped');
      return true;
    });
    assert.equal(e.calls.some(call => call.path === '/knowledge-status'), false);
  }
  const e = fixture();
  const result = await smoke('https://falco.test.workers.dev', { fetcher: e.fetcher, attempts: 1 });
  assert.equal(result.verification.knowledge, null);
  assert.equal(result.verification.knowledgeStatus, 'not_configured');
  assert.equal(e.calls.some(call => call.path === '/knowledge-status'), false);
});
