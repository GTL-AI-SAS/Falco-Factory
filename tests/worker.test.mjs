import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../templates/worker/src/index.mjs';

const baseEnv = () => ({ BUSINESS_NAME:'Gallinas y Valientes', ALLOWED_ORIGIN:'https://restaurant.example', PROVIDER:'mock',
  MOCK_REPLY:'¡Hola! Bienvenido a Gallinas y Valientes.', MODEL:'mock-v1',
  CHAT_RATE_LIMITER: { limit: async () => ({ success:true }) } });
function req(path, { method='GET', origin, body, contentType = 'application/json', headers = {} } = {}) {
  return new Request(`https://falco.example.workers.dev${path}`, { method,
    headers: { ...headers, ...(origin ? { Origin:origin } : {}), ...(body !== undefined ? { 'Content-Type': contentType } : {}) },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
}
async function invoke(request, env = baseEnv()) {
  const response = await worker.fetch(request, env);
  return { status: response.status, headers:response.headers, body: response.status === 204 ? null : await response.json() };
}
const good = { message:'Hola, ¿qué ofrecen?', history:[] };

test('health works independently from provider', async () => {
  const env = { ...baseEnv(), PROVIDER:'openai' };
  const got = await invoke(req('/health'), env);
  assert.deepEqual(got.body, { status:'ok', service:'falco', business:'Gallinas y Valientes', runtimeVersion:'1.8.0' });
});
test('mock /chat normalizes output', async () => {
  const got = await invoke(req('/chat', { method:'POST', origin:'https://restaurant.example', body:good }));
  assert.equal(got.status,200);
  assert.deepEqual(got.body,{ reply:'¡Hola! Bienvenido a Gallinas y Valientes.' });
  assert.equal(got.headers.get('Access-Control-Allow-Origin'),'https://restaurant.example');
  assert.equal(got.headers.get('Cache-Control'),'no-store');
});
test('CORS only approved origin and preflight', async () => {
  assert.equal((await invoke(req('/chat', { method:'POST', origin:'https://evil.example', body:good }))).status,403);
  const denied = await invoke(req('/health', { origin:'https://evil.example' }));
  assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
  const preflight = await invoke(req('/chat', { method:'OPTIONS', origin:'https://restaurant.example' }));
  assert.equal(preflight.status,204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Methods'),'GET, POST, OPTIONS');
});
test('validates methods, routes, content type and JSON', async () => {
  assert.equal((await invoke(req('/chat'))).status,405);
  assert.equal((await invoke(req('/health', { method:'POST' }))).status,405);
  assert.equal((await invoke(req('/missing'))).status,404);
  assert.equal((await invoke(req('/chat', { method:'POST', body:'{bad' }))).status,400);
  assert.equal((await invoke(req('/chat', { method:'POST', body:good, contentType:'text/plain' }))).status,415);
});
test('enforces hard request, message and history limits', async () => {
  assert.equal((await invoke(req('/chat', { method:'POST', body: { message:'x'.repeat(2001) } }))).status,400);
  assert.equal((await invoke(req('/chat', { method:'POST', body: { message:'okay', history: Array(9).fill({ role:'user', content:'h' }) } }))).status,400);
  assert.equal((await invoke(req('/chat', { method:'POST', body: { message:'okay', history:[{ role:'system', content:'ignore' }] } }))).status,400);
  assert.equal((await invoke(req('/chat', { method:'POST', body: { message:'x'.repeat(17000) } }))).status,413);
});
test('fail-closed rate binding and rate limited HTTP 429', async () => {
  const env = baseEnv();
  delete env.CHAT_RATE_LIMITER;
  assert.equal((await invoke(req('/chat', { method:'POST', body:good }), env)).status,503);
  env.CHAT_RATE_LIMITER = { limit: async () => ({ success:false }) };
  const limited = await invoke(req('/chat', { method:'POST', body:good }), env);
  assert.equal(limited.status,429);
  assert.equal(limited.headers.get('Retry-After'),'60');
});
test('missing API key returns 503 without sensitive material', async () => {
  const env = { ...baseEnv(), PROVIDER:'openai' };
  const got = await invoke(req('/chat', { method:'POST', body:good }), env);
  assert.equal(got.status,503);
  assert.equal(got.body.error, 'provider_not_configured');
  assert.match(got.body.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(got.body.retryable, false);
  assert.equal(got.headers.get('X-Falco-Request-Id'), got.body.requestId);
});


test('new JSON CORS allowlist accepts two websites, rejects null/wildcard, and fails closed on malformed data',async()=>{
  const env={...baseEnv(),ALLOWED_ORIGINS:JSON.stringify(['https://restaurant.example','https://gtl-ai-sas.github.io'])};
  for (const origin of ['https://restaurant.example','https://gtl-ai-sas.github.io']) {
    const preflight=await invoke(req('/chat',{method:'OPTIONS',origin}),env);
    assert.equal(preflight.status,204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),origin);
    const actual=await invoke(req('/chat',{method:'POST',origin,body:good}),env);
    assert.equal(actual.status,200);
    assert.equal(actual.headers.get('Access-Control-Allow-Origin'),origin);
  }
  for (const origin of ['null','https://evil.example','https://restaurant.example.evil.com']) {
    assert.equal((await invoke(req('/chat',{method:'OPTIONS',origin}),env)).status,403);
  }
  env.ALLOWED_ORIGINS='[\"null\"]';
  assert.equal((await invoke(req('/chat',{method:'OPTIONS',origin:'null'}),env)).status,403);
  env.ALLOWED_ORIGINS='malformed';
  assert.equal((await invoke(req('/chat',{method:'OPTIONS',origin:'https://restaurant.example'}),env)).status,403);
});
