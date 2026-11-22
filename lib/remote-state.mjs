import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './runtime-manifest.mjs';
import { atomicJson } from './project-files.mjs';
import { cfGet } from './deploy.mjs';

export const uuidPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const hash = value => sha256(JSON.stringify(canonical(value)));

export async function readRemote(session, name, { get = cfGet } = {}) {
  const base = '/workers/scripts/' + encodeURIComponent(name);
  if (!(await get(session, base)).found) return null;
  const [deployments, settings, subdomain] = await Promise.all([
    get(session, base + '/deployments'), get(session, base + '/settings'), get(session, base + '/subdomain')
  ]);
  const live = deployments.result?.deployments?.[0];
  if (!deployments.found || !settings.found || !settings.result || !Array.isArray(settings.result.bindings) ||
      !subdomain.found || !subdomain.result || !uuidPattern.test(live?.id) || !live.versions?.length ||
      live.versions.some(version => !uuidPattern.test(version.version_id) || !Number.isFinite(version.percentage))) {
    throw new Error('Could not establish the active Cloudflare deployment and settings. Retry after confirming the Worker in Cloudflare.');
  }
  // Preserve only fingerprints. Settings may carry business content or credentials in plain-text bindings.
  const detail = {
    deployment: live.id,
    versions: live.versions.map(({ version_id, percentage }) => ({ id: version_id, percentage })),
    bindings: hash(settings.result.bindings.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))),
    settings: hash(Object.fromEntries(Object.entries(settings.result).filter(([key]) => key !== 'bindings'))),
    subdomain: hash(subdomain.result)
  };
  return { detail, fingerprint: hash(detail), message: live.annotations?.['workers/message'] };
}

export async function deploymentLedger(project) {
  const ledger = await fs.readFile(path.join(project.output, '.falco-deployments.json'), 'utf8')
    .then(JSON.parse, error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  if (ledger && (ledger.name !== project.name || ledger.accountId !== project.accountId)) {
    throw new Error('Cloudflare deployment history belongs to a different account or Worker.');
  }
  return ledger;
}

export async function saveRemote(project, remote, { verified = false, fromFactory = true, forgetVerified = false } = {}) {
  const prior = await deploymentLedger(project);
  const candidate = remote.detail.versions.length === 1 ? remote.detail.versions[0].id : null;
  const oldVerified = (prior?.verified ?? []).filter(entry => !forgetVerified || entry.id !== candidate);
  const recent = verified && candidate ? [{ id: candidate, checkedAt: new Date().toISOString() }, ...oldVerified.filter(x => x.id !== candidate)] : oldVerified;
  await atomicJson(path.join(project.output, '.falco-deployments.json'), {
    schema: 1, name: project.name, accountId: project.accountId,
    remote: { detail: remote.detail, fingerprint: remote.fingerprint },
    updatedAt: new Date().toISOString(), fromFactory, verified: recent.slice(0, 20)
  });
}

export async function inspectRemote(project, session, { remoteReader = readRemote } = {}) {
  const [ledger, remote] = await Promise.all([deploymentLedger(project), remoteReader(session, project.name)]);
  const baseline = ledger?.remote;
  const status = !remote ? 'missing' : !baseline ? 'untracked' : remote.fingerprint === baseline.fingerprint ? 'clean' : 'changed';
  const fields = status === 'changed' ? Object.keys(remote.detail).filter(key => hash(remote.detail[key]) !== hash(baseline.detail[key])) : [];
  return { status, fields, baseline: baseline?.detail, current: remote?.detail, fingerprint: remote?.fingerprint, verified: ledger?.verified ?? [] };
}

export async function assertRemote(project, session, dependencies) {
  const state = await inspectRemote(project, session, dependencies);
  if (state.status === 'clean' && state.current.versions.length === 1 && state.current.versions[0].percentage === 100) return state;
  if (state.status === 'clean') throw new Error('Finish the active Cloudflare traffic split before modifying the Worker through Factory.');
  const reason = state.status === 'changed' ? 'Remote drift detected (' + state.fields.join(', ') + ').'
    : state.status === 'untracked' ? 'This Worker has no recorded Factory baseline.' : 'The recorded remote Worker is missing.';
  throw new Error(reason + ' Review Cloudflare and use Manage Existing → Review remote state to confirm the current baseline before retrying.');
}

export async function trackExpectedDeployment(project, session, predicate, { remoteReader = readRemote, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await pause(attempt * 600);
    const remote = await remoteReader(session, project.name);
    if (remote && predicate(remote)) {
      await saveRemote(project, remote);
      return remote;
    }
  }
  throw new Error('Cloudflare may have applied the change, but Factory could not verify its active deployment ID. Inspect remote state before retrying.');
}
