import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeConfig } from '../lib/args.mjs';
import { generate } from '../lib/generate.mjs';

test('two independently generated Workers serve distinct businesses and mock responses', async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'falco-integration-'));
  t.after(() => fs.rm(tmp, { recursive:true, force:true }));
  for (const [name, business] of [['falco-alpha', 'Alpha Bakery'], ['falco-beta', 'Beta Studio']]) {
    const c = normalizeConfig({ name, business, output:path.join(tmp,name), provider:'mock', origin:'http://localhost:3000' });
    await generate(c);
    const mod = await import(pathToFileURL(path.join(c.output,'src/index.mjs')).href);
    const cfg = JSON.parse(await fs.readFile(path.join(c.output,'wrangler.json')));
    const env = { ...cfg.vars, CHAT_RATE_LIMITER: { limit: async () => ({ success:true }) } };
    const health = await mod.default.fetch(new Request('http://localhost:8787/health'), env);
    assert.equal((await health.json()).business, business);
    const chat = await mod.default.fetch(new Request('http://localhost:8787/chat', {
      method:'POST', headers:{ 'content-type':'application/json', 'origin':'http://localhost:3000' },
      body: JSON.stringify({ message:'Hello', history:[] })
    }),env);
    assert.match((await chat.json()).reply, new RegExp(business));
  }
});

test('long FAQ stays outside 5KB Wrangler var limit and is safely quoted as source text', async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'falco-faq-'));
  t.after(() => fs.rm(tmp, { recursive:true, force:true }));
  const faq = 'Special characters: ` ${process.env.PRIVATE} </script> " \u2028\n' + 'Restaurant information.\n'.repeat(500);
  await fs.writeFile(path.join(tmp,'faq.md'), faq);
  const c = normalizeConfig({ name:'falco-faq-test', business:'FAQ Test', faq:'faq.md', output:'project' }, tmp);
  await generate(c);
  const business = await import(pathToFileURL(path.join(c.output,'src/business-context.mjs')).href);
  assert.equal(business.faqText,faq);
  const conf = JSON.parse(await fs.readFile(path.join(c.output,'wrangler.json')));
  assert.equal(conf.vars.FAQ_TEXT, undefined);
  assert.ok(!JSON.stringify(conf).includes('process.env.PRIVATE'));
});
