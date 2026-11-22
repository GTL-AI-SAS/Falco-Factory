import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicJson } from './project-files.mjs';
import { sha256 } from './runtime-manifest.mjs';
import { runWrangler, getCloudflareSession } from './deploy.mjs';

export const KV_BINDING = 'FALCO_KNOWLEDGE';
export const KV_KEY = 'knowledge:active';
export const MAX_FAQ_BYTES = 96000;
export const MAX_INSTRUCTIONS_BYTES = 24000;
export const limitsForMode = mode => mode === 'kv' ? { faq:MAX_FAQ_BYTES, instructions:MAX_INSTRUCTIONS_BYTES } : { faq:24000, instructions:12000 };

export function validateMode(mode) {
  if (!['embedded','kv'].includes(mode)) throw new Error('Knowledge mode must be embedded or kv.');
  return mode;
}
export function checkKnowledge(mode, { faq, instructions }) {
  const limits = limitsForMode(validateMode(mode));
  for (const [name, limit] of Object.entries(limits)) {
    const value = name === 'faq' ? faq : instructions;
    if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value,'utf8') > limit)
      throw new Error(`${name} must be UTF-8 text under ${limit / 1000} KB in ${mode} mode.`);
  }
}
export function knowledgePayload({ faq, instructions }) {
  checkKnowledge('kv', { faq, instructions });
  return { version:1, instructions, faq };
}
function getBinding(config) {
  const bindings=config.kv_namespaces ?? [];
  if (!Array.isArray(bindings)) throw new Error('Invalid Wrangler KV configuration.');
  const matches=bindings.filter(x=>x?.binding===KV_BINDING);
  if (matches.length > 1) throw new Error('Duplicate FALCO_KNOWLEDGE bindings.');
  if (!matches.length) return null;
  if (!/^[a-f0-9]{32}$/i.test(matches[0].id||'')) throw new Error('Invalid KV namespace identifier.');
  return matches[0].id;
}
export function namespaceId(config) { return getBinding(config); }
export function parseCreatedNamespace(text) {
  const found=String(text).match(/\"id\"\s*:\s*\"([a-f0-9]{32})\"/i);
  if (!found) throw new Error('KV namespace created, but Wrangler did not return a valid ID. Check Cloudflare KV dashboard before retrying to avoid an orphan namespace.');
  return found[1];
}
/** Idempotent binding provisioning. Never delete namespaces on failed deploy. */
export async function ensureKvNamespace(project, { wrangler = runWrangler, logger = () => {}, signal } = {}) {
  const file=path.join(project.output,'wrangler.json');
  const config=JSON.parse(await fs.readFile(file,'utf8'));
  if (config.name!==project.name) throw new Error('KV operation refused: Worker name mismatch.');
  const existing=getBinding(config);
  if (existing) return existing;
  const result=await wrangler(['kv','namespace','create',KV_BINDING,'--config','wrangler.json'],{cwd:project.output,accountId:config.account_id ?? project.accountId, signal});
  if (result.code!==0) throw new Error('KV namespace creation failed. Check Wrangler authentication and KV write permissions.');
  const id=parseCreatedNamespace(result.stdout+'\n'+result.stderr);
  // Wrangler may have modified the JSON automatically; reread to avoid overwriting it.
  const latest=JSON.parse(await fs.readFile(file,'utf8'));
  if (latest.name!==project.name) throw new Error('Worker name changed during KV provisioning.');
  const bound=getBinding(latest);
  if (bound && bound!==id) throw new Error('Wrangler created a KV namespace but a different namespace is already bound. Review manually.');
  if (!bound) latest.kv_namespaces=[...(latest.kv_namespaces||[]),{binding:KV_BINDING,id}];
  await atomicJson(file,latest);
  logger('KV namespace created and bound (one namespace per Worker).');
  return id;
}
const revisionPattern = /^[a-f0-9]{64}$/;
const revisionKey = revision => 'knowledge:revision:' + revision;

export function verifiedKnowledge(value, expected) {
  if (value?.version !== 1) throw new Error('Invalid KV knowledge format.');
  const payload = knowledgePayload(value);
  const revision = sha256(JSON.stringify(payload));
  if ((value.revision && value.revision !== revision) || (expected && expected !== revision)) throw new Error('KV revision hash mismatch.');
  return { ...payload, revision };
}

async function kvConnection(project, { wrangler = runWrangler, signal, fetcher = fetch } = {}) {
  const config = JSON.parse(await fs.readFile(path.join(project.output,'wrangler.json'), 'utf8'));
  if (config.name !== project.name || (project.accountId && config.account_id && project.accountId !== config.account_id)) throw new Error('KV operation target changed.');
  const id = getBinding(config);
  if (!id) throw new Error('KV namespace not bound. Provision it before publishing knowledge.');
  const run = (command, args) => wrangler(['kv','key',command,...args,'--namespace-id',id,'--remote','--config','wrangler.json'],
    { cwd: project.output, accountId: config.account_id ?? project.accountId, signal });
  let session;
  async function read(key) {
    let raw;
    if (wrangler === runWrangler) {
      session ??= await getCloudflareSession({ accountId: config.account_id ?? project.accountId }, { signal });
      const url = `https://api.cloudflare.com/client/v4/accounts/${session.accountId}/storage/kv/namespaces/${id}/values/${encodeURIComponent(key)}`;
      const timeout = AbortSignal.timeout(15000);
      const response = await fetcher(url, { headers: { Authorization: 'Bearer ' + session.token },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
      if (response.status === 404) {
        const failure = await response.json().catch(() => ({}));
        if (failure.errors?.some(error => error.code === 10009 || /(?:key|value).*(?:not found|does not exist)/i.test(error.message ?? ''))) return null;
        throw new Error('Cloudflare could not find the KV resource.');
      }
      if (!response.ok) throw new Error('Cloudflare KV read failed (HTTP ' + response.status + ').');
      raw = await response.text();
    } else {
      const result = await run('get', [key, '--text']);
      if (result.code === 0 && result.stdout.trim() === 'Value not found') return null;
      if (result.code !== 0) throw new Error('Cloudflare KV read failed.');
      raw = result.stdout;
    }
    try { return verifiedKnowledge(JSON.parse(raw)); }
    catch { throw new Error('Cloudflare returned unreadable or inconsistent knowledge. Operation stopped.'); }
  }
  return { id, run, read };
}

export async function kvStatus(project, options) {
  const kv = await kvConnection(project, options);
  const [active, list] = await Promise.all([kv.read(KV_KEY), kv.run('list', ['--prefix', 'knowledge:revision:'])]);
  if (list.code !== 0) throw new Error('Cloudflare KV revision list failed.');
  const keys = JSON.parse(list.stdout);
  if (!Array.isArray(keys)) throw new Error('Cloudflare KV revision list was invalid.');
  return { active: active?.revision ?? null, revisions: keys.map(key => ({
    revision: key.name?.slice('knowledge:revision:'.length),
    publishedAt: typeof key.metadata?.publishedAt === 'string' ? key.metadata.publishedAt : null
  })).filter(key => revisionPattern.test(key.revision ?? '')).sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '')).slice(0, 100) };
}

/** Both keys carry an envelope readable by v1.3. One edge read always gets a complete revision. */
export async function publishKv(project, options = {}) {
  const { logger = () => {}, expectedActive, revision: rollbackRevision,
    pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = options;
  const kv = await kvConnection(project, options);
  if (rollbackRevision && !revisionPattern.test(rollbackRevision)) throw new Error('Invalid KV revision.');
  const payload = rollbackRevision ? await kv.read(revisionKey(rollbackRevision)) : verifiedKnowledge(knowledgePayload(project));
  if (!payload || (rollbackRevision && payload.revision !== rollbackRevision)) throw new Error('The selected KV revision is unavailable.');
  const active = await kv.read(KV_KEY);
  const baselineFile = path.join(project.output, '.falco-kv-state.json');
  const baseline = await fs.readFile(baselineFile, 'utf8').then(JSON.parse, error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (baseline && (baseline.namespaceId !== kv.id || baseline.name !== project.name)) throw new Error('Local KV baseline refers to another Worker or namespace.');
  const expected = expectedActive !== undefined ? expectedActive : baseline?.revision;
  if (expected !== undefined && (active?.revision ?? null) !== expected) throw new Error('The active KV revision changed. Refresh remote revision history before writing.');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'falco-kv-'));
  const file = path.join(dir, 'knowledge.json');
  try {
    const write = async (key, data, metadata = []) => {
      await fs.writeFile(file, JSON.stringify(data), { mode: 0o600 });
      const result = await kv.run('put', [key, '--path', file, ...metadata]);
      if (result.code !== 0) throw new Error('Cloudflare KV write failed. Review the active revision before retrying.');
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt) await pause(attempt * 500);
        if ((await kv.read(key))?.revision === data.revision) return;
      }
      throw new Error('Cloudflare KV accepted a write, but the revision could not be read back yet. Allow for propagation before retrying.');
    };
    const archive = async data => {
      const key = revisionKey(data.revision);
      const existing = await kv.read(key);
      if (!existing) await write(key, data, ['--metadata', JSON.stringify({ publishedAt: new Date().toISOString() })]);
      else if (existing.revision !== data.revision) throw new Error('Existing immutable KV revision has a conflicting hash.');
    };
    if (active) await archive(active);
    await archive(payload);
    if ((await kv.read(KV_KEY))?.revision !== active?.revision) throw new Error('The active KV revision changed during publication. Refresh and retry.');
    if (active?.revision !== payload.revision) await write(KV_KEY, payload);
    await atomicJson(baselineFile, { schema: 1, name: project.name, namespaceId: kv.id, revision: payload.revision });
    logger('KV revision verified through the management API. Edge propagation may still be in progress.');
    return { namespaceId: kv.id, key: KV_KEY, revision: payload.revision, bytes: Buffer.byteLength(JSON.stringify(payload)), ...(rollbackRevision ? { knowledge: payload } : {}) };
  } finally { await fs.rm(dir, { recursive:true, force:true }); }
}
export async function saveLocalKv(project, { faq, instructions }) {
  checkKnowledge('kv',{faq,instructions});
  await atomicJson(path.join(project.output,'.falco-knowledge.json'),knowledgePayload({faq,instructions}));
}
