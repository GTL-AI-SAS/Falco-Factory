import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from './project-files.mjs';

const rootDir = root => path.join(root, '.falco-operations');
const safeId = /^[a-f0-9-]{36}$/;
const safeName = /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/;
const safeStatus = new Set(['queued','working','generated','deployed','updated','restored','partial','failed','cancelled','interrupted','ready','checked']);
const safeOperation = /^(?:[a-z-]{2,30})$/;
const projectUrl = value => /^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\/?$/i.test(value ?? '') ? value : null;

export function persistedJob(job) {
  if (!safeId.test(job.id) || !safeName.test(job.name)) throw new Error('Invalid operation record.');
  const verificationStatuses = new Set(['pass','failed','skipped','not_configured','not_authorized','unsupported_provider','pending']);
  const verification = Object.fromEntries(Object.entries(job.verification ?? {}).filter(([key, value]) => {
    if (['health','cors','chat','action','knowledge'].includes(key)) return [null,true,false].includes(value);
    if (['healthStatus','corsStatus','chatStatus','actionStatus','knowledgeStatus'].includes(key)) return verificationStatuses.has(value);
    if (key === 'actionId') return typeof value === 'string' && /^[a-z][a-z0-9_.-]{2,48}$/.test(value);
    return false;
  }));
  // Persist only typed metadata. Raw events, replies, error text and credentials are session-only.
  const events = (job.events ?? []).filter(event => safeOperation.test(event.stage)).slice(-60).map(({ stage, at }) => ({ stage, at, message: stage }));
  const reason = [
    ['remote_drift', /remote drift|remote baseline|remote state.*retry/i],
    ['provider_error', /provider_|provider check/i],
    ['kv_revision', /KV revision|KV publish|KV read/i],
    ['process_timeout', /time limit|timeout/i],
    ['cors_failed', /CORS .*failed/i],
    ['health_failed', /health check failed/i],
    ['cancelled', /cancelled|aborted/i]
  ].find(([, pattern]) => pattern.test(job.error ?? ''))?.[0] ?? null;
  return { id: job.id, name: job.name, mode: safeOperation.test(job.mode) ? job.mode : null,
    authProfile: typeof job.authProfile === 'string' && /^(?:[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63})?$/.test(job.authProfile) ? job.authProfile : '',
    accountId: /^[a-f0-9]{32}$/i.test(job.accountId ?? '') ? job.accountId : null,
    operation: safeOperation.test(job.operation) ? job.operation : null,
    status: safeStatus.has(job.status) ? job.status : 'interrupted', createdAt: job.createdAt, events, verification,
    url: projectUrl(job.url), backupId: safeId.test(job.backupId ?? '') ? job.backupId : null,
    reason, elapsedMs: Math.max(0, Date.now() - Date.parse(job.createdAt)),
    error: (job.status === 'partial' || job.status === 'failed') ? 'Check the saved verification and live Cloudflare state before retrying.' : null };
}

export async function recordOperation(root, job) {
  const record = persistedJob(job);
  const dir = path.join(rootDir(root), record.name);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await atomicJson(path.join(dir, record.id + '.json'), record);
  const files = await fs.readdir(dir, { withFileTypes: true });
  const ordered = await Promise.all(files.filter(file => file.isFile() && safeId.test(file.name.slice(0, -5)))
    .map(async file => ({ file: file.name, time: (await fs.stat(path.join(dir, file.name))).mtimeMs })));
  ordered.sort((a, b) => b.time - a.time);
  await Promise.all(ordered.slice(50).map(({ file }) => fs.rm(path.join(dir, file), { force: true })));
}

async function readHistory(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const records = await Promise.all(entries.filter(file => file.isFile() && file.name.endsWith('.json')).map(async file => {
    try {
      const job = JSON.parse(await fs.readFile(path.join(dir, file.name), 'utf8'));
      if (!safeId.test(job.id) || !safeName.test(job.name)) return null;
      if (job.status === 'queued' || job.status === 'working') job.status = 'interrupted';
      return job;
    } catch { return null; }
  }));
  return records.filter(Boolean);
}

export async function operations(root, name) {
  const dir = rootDir(root);
  if (name && !safeName.test(name)) throw new Error('Invalid Worker name.');
  const records = name ? await readHistory(path.join(dir, name)) : (await Promise.all(
    (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory() && safeName.test(entry.name))
      .map(entry => readHistory(path.join(dir, entry.name))))).flat();
  return records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, name ? 50 : 200);
}
