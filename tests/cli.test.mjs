import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseArgs, normalizeConfig } from '../lib/args.mjs';
import { buildConfig, generate } from '../lib/generate.mjs';
import { selectAccount } from '../lib/deploy.mjs';
import { VERSION, WRANGLER_VERSION } from '../lib/args.mjs';
import { smoke } from '../lib/smoke.mjs';

test('v1.8.0 retains the Wrangler release that supports OS keyring authentication',()=>{
  assert.equal(VERSION,'1.8.0');
  assert.equal(WRANGLER_VERSION,'4.166.0');
});

const flags = { name:'falco-demo', business:'Demo Business', provider:'mock', origin:'https://example.com' };

test('parses CLI flags and rejects unknown flags', () => {
  assert.deepEqual(parseArgs(['--name','falco-demo','--deploy','--provider=mock']), { name:'falco-demo', deploy:true, provider:'mock' });
  assert.throws(() => parseArgs(['--secret','oops']), /Unknown option/);
});
test('normalizes defaults and restricts HTTP origins', () => {
  const c = normalizeConfig(flags);
  assert.equal(c.model, 'mock-v1');
  assert.equal(c.origin, 'https://example.com');
  assert.equal(c.rateLimit, 10);
  assert.throws(() => normalizeConfig({ ...flags, origin: 'http://example.com' }), /HTTPS/);
  assert.throws(() => normalizeConfig({ ...flags, name: '../bad' }), /--name/);
  assert.throws(() => normalizeConfig({ ...flags, origin:'https://example.com/evil' }), /allowed origin/);
  assert.throws(() => normalizeConfig({ ...flags, 'dry-run': true, deploy: true }), /mutually exclusive/);
});
test('rendered Wrangler config has worker-specific rate namespace', () => {
  const a = buildConfig(normalizeConfig(flags));
  const b = buildConfig(normalizeConfig({ ...flags, name: 'falco-another' }));
  assert.notEqual(a.ratelimits[0].namespace_id, b.ratelimits[0].namespace_id);
  assert.equal(a.workers_dev, true);
  assert.equal(a.vars.PROVIDER, 'mock');
  assert.ok(!JSON.stringify(a).includes('API_KEY'));
});
test('generator produces independent Worker with all providers, rejects overwrites, --force safeguards', async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'falco-factory-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const config = normalizeConfig({ ...flags, output: path.join(tmp, 'falco-demo') });
  const first = await generate(config);
  assert.equal(first.written, true);
  const files = await fs.readdir(path.join(config.output, 'src/providers'));
  assert.deepEqual(files.sort(), ['gemini.mjs','index.mjs','mock.mjs','openai.mjs','shared.mjs']);
  const wrangler = JSON.parse(await fs.readFile(path.join(config.output,'wrangler.json')));
  assert.equal(wrangler.name, 'falco-demo');
  assert.equal(wrangler.vars.BUSINESS_NAME, 'Demo Business');
  await assert.rejects(generate(config), /directory exists/);
  const second = await generate({ ...config, force: true });
  assert.equal(second.written, true);
  const different = { ...config, name: 'falco-other', force:true };
  await assert.rejects(generate(different), /different Worker/);
  const wrong = path.join(tmp,'unmanaged');
  await fs.mkdir(wrong);
  await assert.rejects(generate({ ...config, output: wrong, force:true }), /non-Falco/);
});
test('dry-run does not create directory', async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'falco-dry-'));
  t.after(() => fs.rm(tmp, { recursive:true, force:true }));
  const c = normalizeConfig({ ...flags, output:path.join(tmp,'new'), 'dry-run':true });
  const result = await generate(c);
  assert.equal(result.written, false);
  await assert.rejects(fs.access(c.output), /ENOENT/);
});
test('account ambiguity is rejected explicitly', () => {
  const one = 'a'.repeat(32);
  const two = 'b'.repeat(32);
  assert.equal(selectAccount({ accounts: [{ id: one }] }), one);
  assert.throws(() => selectAccount({ accounts: [{ id: one }, { id: two }] }), /ambiguous/);
  assert.equal(selectAccount({ accounts: [{ id: one }, { id: two }] }, two), two);
});
test('smoke checks health and optional chat without an actual Worker', async () => {
  const calls = [];
  const fake = async (url, opts) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET' });
    return Response.json(url.pathname === '/chat' ? { reply:'Hello!' } : { status:'ok', service:'falco', business:'Demo Business' });
  };
  const result = await smoke('https://falco.example.workers.dev', { business:'Demo Business', chat:true, fetcher:fake });
  assert.equal(result.chat.reply,'Hello!');
  assert.deepEqual(calls.map(x => x.method), ['GET','POST']);
});


test('smoke reports not-authorized and not-configured distinctly without making a provider request', async () => {
  const calls = [];
  const fake = async (url, options = {}) => {
    calls.push({ path: url.pathname, method: options.method ?? 'GET' });
    return Response.json({ status:'ok', service:'falco', business:'Demo Business' });
  };
  const configured = await smoke('https://falco.example.workers.dev', {
    business:'Demo Business', actionConfigured:true, fetcher:fake, attempts:1, pause:async()=>{}
  });
  assert.equal(configured.verification.chat, null);
  assert.equal(configured.verification.chatStatus, 'not_authorized');
  assert.equal(configured.verification.action, null);
  assert.equal(configured.verification.actionStatus, 'not_authorized');
  assert.deepEqual(calls.map(call => call.method), ['GET']);

  const noActions = await smoke('https://falco.example.workers.dev', {
    business:'Demo Business', fetcher:fake, attempts:1, pause:async()=>{}
  });
  assert.equal(noActions.verification.actionStatus, 'not_configured');
});

test('smoke action verification uses one chat request and never executes a website handler', async () => {
  const calls = [];
  const origin = 'https://site.example';
  const fake = async (url, options = {}) => {
    calls.push({ path:url.pathname, method:options.method ?? 'GET', body:options.body });
    if (url.pathname === '/health') return Response.json({ status:'ok', service:'falco', business:'Demo Business' });
    if (options.method === 'OPTIONS') {
      if (options.headers?.Origin === 'null') return new Response(null, { status:403 });
      return new Response(null, { status:204, headers:{
        'access-control-allow-origin':origin,
        'access-control-allow-methods':'POST, OPTIONS',
        'access-control-allow-headers':'content-type'
      }});
    }
    return Response.json({ reply:'Opening option 01', action:{ id:'demo.open', params:{ option:'01' } } }, {
      headers:{ 'access-control-allow-origin':origin }
    });
  };
  const result = await smoke('https://falco.example.workers.dev', {
    business:'Demo Business', origins:[origin], actionConfigured:true,
    action:{ id:'demo.open', params:{ option:'01' }, message:'Please open option 01.' },
    fetcher:fake, attempts:1, pause:async()=>{}
  });
  assert.equal(result.verification.chatStatus, 'pass');
  assert.equal(result.verification.actionStatus, 'pass');
  assert.equal(result.verification.actionId, 'demo.open');
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(JSON.parse(calls.find(call => call.method === 'POST').body).message, 'Please open option 01.');
});

test('smoke distinguishes a wrong action proposal from a healthy chat response', async () => {
  const origin = 'https://site.example';
  const fake = async (url, options = {}) => {
    if (url.pathname === '/health') return Response.json({ status:'ok', service:'falco' });
    if (options.method === 'OPTIONS') {
      if (options.headers?.Origin === 'null') return new Response(null, { status:403 });
      return new Response(null, { status:204, headers:{
        'access-control-allow-origin':origin,'access-control-allow-methods':'POST','access-control-allow-headers':'content-type'
      }});
    }
    return Response.json({ reply:'I can help', action:{ id:'demo.other', params:{} } }, { headers:{'access-control-allow-origin':origin} });
  };
  await assert.rejects(smoke('https://falco.example.workers.dev', {
    origins:[origin], actionConfigured:true,
    action:{ id:'demo.open', params:{option:'01'}, message:'Please open option 01.' },
    fetcher:fake, attempts:1, pause:async()=>{}
  }), error => {
    assert.equal(error.verification.chatStatus, 'pass');
    assert.equal(error.verification.actionStatus, 'failed');
    assert.equal(error.verification.chat, true);
    assert.equal(error.verification.action, false);
    return /expected action/.test(error.message);
  });
});


test('smoke marks Client Action proposal checks unsupported on Mock without treating the action as unconfigured', async () => {
  const fake = async (url, options = {}) => {
    if (url.pathname === '/health') return Response.json({ status:'ok', service:'falco' });
    if (options.method === 'OPTIONS') {
      if (options.headers?.Origin === 'null') return new Response(null, { status:403 });
      return new Response(null, { status:204, headers:{
        'access-control-allow-origin':'https://site.example',
        'access-control-allow-methods':'POST',
        'access-control-allow-headers':'content-type'
      }});
    }
    return Response.json({ reply:'Mock reply' }, { headers:{'access-control-allow-origin':'https://site.example'} });
  };
  const result = await smoke('https://falco.example.workers.dev', {
    origins:['https://site.example'], chat:true, actionConfigured:true, actionSupported:false,
    fetcher:fake, attempts:1, pause:async()=>{}
  });
  assert.equal(result.verification.chatStatus, 'pass');
  assert.equal(result.verification.actionStatus, 'unsupported_provider');
});
