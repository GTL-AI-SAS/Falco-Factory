import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseArgs, normalizeConfig } from '../lib/args.mjs';
import { buildConfig, generate } from '../lib/generate.mjs';
import { selectAccount } from '../lib/deploy.mjs';
import { smoke } from '../lib/smoke.mjs';

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
