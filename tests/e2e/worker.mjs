import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { normalizeConfig } from '../../lib/args.mjs';
import { generate } from '../../lib/generate.mjs';
import { runWrangler } from '../../lib/deploy.mjs';
import { verifiedKnowledge } from '../../lib/knowledge-kv.mjs';
import { smoke } from '../../lib/smoke.mjs';

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'falco-workerd-'));
const origin = 'https://falco-staging.example';
const opsKey = 'local-operations-test-key-for-falco';
const c = normalizeConfig({ name:'falco-workerd', business:'Workerd example', provider:'gemini', 'knowledge-mode':'kv', origin }, root);
c.budget = { day:1, month:2, breakerSeconds:60, maintenance:false, turnstile:false };
const knowledge = verifiedKnowledge({ version:1, faq:'Friday from 19:00.', instructions:'' });
let runtime;
try {
  await generate(c);
  const configFile = path.join(c.output, 'wrangler.json');
  const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
  config.kv_namespaces = [{ binding:'FALCO_KNOWLEDGE', id:'0'.repeat(32) }];
  await fs.writeFile(configFile, JSON.stringify(config));
  const outdir = path.join(root, 'bundle');
  const result = await runWrangler(['deploy','--dry-run','--outdir',outdir], { cwd:c.output });
  assert.equal(result.code, 0, 'Wrangler could not bundle the generated project.');
  runtime = new Miniflare(convertV4MiniflareOptions({
    modules:true, modulesRoot:outdir, scriptPath:path.join(outdir, 'entry.js'), compatibilityDate:config.compatibility_date,
    host:'127.0.0.1', port:0, cf:false,
    bindings:{ ...config.vars, FALCO_OPS_KEY:opsKey },
    durableObjects:{ FALCO_BUDGET_DO:{ className:'FalcoBudgetObject', useSQLite:true } },
    kvNamespaces:['FALCO_KNOWLEDGE'],
    ratelimits:Object.fromEntries(config.ratelimits.map(({ name, ...limit }) => [name, limit]))
  }));
  const kv = await runtime.getKVNamespace('FALCO_KNOWLEDGE');
  await kv.put('knowledge:active', JSON.stringify(knowledge));
  const url = (await runtime.ready).origin;
  const checked = await smoke(url, { business:c.business, origins:[origin], knowledgeRevision:knowledge.revision, attempts:1 });
  assert.equal(checked.verification.knowledge, true);
  const chat = () => fetch(url+'/chat', { method:'POST', headers:{ Origin:origin, 'Content-Type':'application/json' },
    body:JSON.stringify({ message:'Hello', history:[] }) });
  const responses = await Promise.all([chat(), chat()]);
  const outcomes = await Promise.all(responses.map(response => response.json().then(body => body.error)));
  assert.deepEqual(outcomes.sort(), ['budget_exhausted','provider_not_configured']);
  assert.equal((await fetch(url+'/operations')).status, 404);
  const usage = await (await fetch(url+'/operations', { headers:{ Authorization:'Bearer '+opsKey } })).json();
  assert.equal(usage.day.calls, 1);
  assert.equal(usage.day.kvReads, 1);
  console.log('Workerd E2E passed (Wrangler bundle, CORS, KV, concurrent budget and protected metrics).');
} finally {
  await runtime?.dispose();
  await fs.rm(root, { recursive:true, force:true });
}
