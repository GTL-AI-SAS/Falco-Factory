import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizeConfig, DEFAULT_MODELS } from './args.mjs';
import { generate } from './generate.mjs';
import { deploy, runWrangler, getCloudflareSession, remoteWorkerExists, cfGet } from './deploy.mjs';
import { createFrontendKit } from './frontend-kit.mjs';
import { getDeployedOrigins } from './worker-origins.mjs';
import { getDeployedClientActions } from './worker-actions.mjs';
import { prepareActionUpgrade, applyClientActions } from './action-updates.mjs';
import { planRuntimeUpgrade, applyRuntimeUpgrade } from './runtime-upgrades.mjs';
import { normalizeClientActions, GALLINAS_ACTIONS } from './client-actions.mjs';
import { prepareCorsUpgrade, applyOriginChanges } from './origin-updates.mjs';
import { readProject, listProjects, previewChanges, makeSnapshot, listVersions, readVersion, asGenerateConfig, importLocalProject, writeKnowledge } from './projects.mjs';
import { smoke } from './smoke.mjs';
import { discoverCloudflareWorkers, mergeRemoteWithLocal } from './cloudflare-workers.mjs';
import { loadExistingFalco, deleteCloudflareFalco } from './worker-lifecycle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI_DIR = path.join(ROOT, 'ui');
const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export function configFromForm(form, { root = ROOT, deployRequested = false } = {}) {
  if (!form || typeof form !== 'object' || Array.isArray(form)) throw new Error('Invalid configuration.');
  const name = typeof form.name === 'string' ? form.name.trim() : '';
  const business = typeof form.business === 'string' ? form.business.trim() : '';
  const outputFolder = typeof form.outputFolder === 'string' && form.outputFolder.trim() ? form.outputFolder.trim() : name;
  if (!/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(outputFolder)) throw new Error('Output folder must use 3–63 lowercase letters, digits or hyphens.');
  const provider = typeof form.provider === 'string' ? form.provider : 'mock';
  const opts = {
    name, business, provider, origins: form.origins ?? form.origin ?? 'http://localhost:3000',
    output: path.join('.generated', outputFolder),
    ...(form.model ? { model: form.model } : {}),
    ...(form.accountId ? { 'account-id': form.accountId } : {}),
    ...(form.mockReply ? { 'mock-reply': form.mockReply } : {}),
    ...(form.rateLimit !== undefined && form.rateLimit !== '' ? { 'rate-limit': String(form.rateLimit) } : {}),
    ...(deployRequested ? { deploy: true } : {}),
  };
  const c = normalizeConfig(opts, root);
  for (const [key, max] of [['faq', 24000], ['instructions', 12000]]) {
    const content = form[key] ?? '';
    if (typeof content !== 'string' || content.includes('\0')) throw new Error(`${key} must be valid text.`);
    if (Buffer.byteLength(content, 'utf8') > max) throw new Error(`${key} exceeds ${Math.round(max / 1000)} KB.`);
    c[key] = content;
  }
  c.actions = normalizeClientActions(form.actions ?? []);
  if (form.force === true) {
    if (form.confirmName !== c.name) throw new Error('To replace an existing Worker, type its exact name in the confirmation field.');
    c.force = true;
  } else c.force = false;
  return c;
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin',
  });
  res.end(body);
}
async function receiveJson(req) {
  const length = Number(req.headers['content-length'] ?? 0);
  if (length > 70000) { const e = new Error('Request too large (70 KB maximum).'); e.httpStatus = 413; throw e; }
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    const e = new Error('Expected Content-Type: application/json.'); e.httpStatus = 415; throw e;
  }
  const chunks = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 70000) { const e = new Error('Request too large (70 KB maximum).'); e.httpStatus = 413; throw e; }
    chunks.push(part);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const e = new Error('Malformed JSON request.'); e.httpStatus = 400; throw e; }
}
function safeJob(job) {
  const { id, status, mode, business, name, output, events, url, chatUrl, secretStatus, error, partial, verification, createdAt, backupId, operation } = job;
  return { id, status, mode, business, name, output, events, url, chatUrl, secretStatus, error, partial, verification, createdAt, backupId, operation };
}
function validWorkerUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/i.test(u.hostname) && u.pathname === '/';
  } catch { return false; }
}
function emit(job, stage, message) {
  job.events.push({ stage, message, at: new Date().toISOString() });
  if (job.events.length > 60) job.events.shift();
}

export function createUiServer({ root = ROOT, port = 4317, runner = {}, host = '127.0.0.1' } = {}) {
  // Bind to loopback only; never expose Cloudflare credentials or the secret input on a LAN.
  if (host !== '127.0.0.1') throw new Error('Falco Studio must bind to 127.0.0.1 only.');
  const secretToken = randomBytes(32).toString('hex');
  const jobs = new Map();
  let activeJob = null;
  let activeCloudMutation = false;
  const generateProject = runner.generate || generate;
  const deployProject = runner.deploy || deploy;
  const smokeProject = runner.smoke || smoke;
  const cloudWorkers = runner.cloudWorkers || discoverCloudflareWorkers;
  const autoLoadWorker = runner.autoLoadWorker || loadExistingFalco;
  const removeCloudflareWorker = runner.removeCloudflareWorker || deleteCloudflareFalco;
  const getWorkerFrontendEndpoint = runner.workerEndpoint || (async ({ accountId, name }) => {
    const session = await getCloudflareSession({ accountId });
    const response = await cfGet(session, '/workers/subdomain');
    const subdomain = response?.result?.subdomain;
    if (!response.found || !/^[a-z0-9-]+$/i.test(subdomain || '')) throw new Error('The account has no registered workers.dev subdomain. Set it up in Cloudflare first.');
    return `https://${name}.${subdomain}.workers.dev/chat`;
  });
  const remoteOrigins = runner.remoteOrigins || getDeployedOrigins;
  const remoteActions = runner.remoteActions || getDeployedClientActions;
  const managedPreflight = runner.managedPreflight || (async p => {
    if (!p.accountId) throw new Error('This project has no saved Cloudflare Account ID. Deploy it with a selected account before managing it.');
    const session = await getCloudflareSession({ accountId: p.accountId });
    if (session.accountId !== p.accountId || !(await remoteWorkerExists(session, p.name))) {
      throw new Error(`Worker '${p.name}' was not found in its saved Cloudflare account. No local files were changed.`);
    }
  });

  async function finishDeployment(job, c, result) {
    job.url = result.url && validWorkerUrl(result.url) ? result.url : null;
    job.chatUrl = job.url ? `${job.url}/chat` : null;
    job.secretStatus = result.secret;
    job.partial = result.status !== 'deployed';
    if (result.secretError) emit(job, 'warning', result.secretError);
    if (result.urlError) emit(job, 'warning', result.urlError);
    if (!job.url || result.status !== 'deployed') {
      job.status = 'partial';
      job.error = !job.url ? 'Deployment may have succeeded, but its URL could not be confirmed.' : 'Worker deployed but provider secret setup is incomplete.';
      emit(job, 'warning', job.error);
      return;
    }
    emit(job, 'verify', 'Verifying live GET /health' + (c.provider === 'mock' ? ' and mock POST /chat' : ''));
    try {
      const checked = await smokeProject(job.url, { business: c.business, chat: c.provider === 'mock',
        ...(['upgrade-runtime'].includes(job.operation) || job.operation === undefined ? { expectedRuntime:'1.2.0' } : {}) });
      job.verification = { health: Boolean(checked?.health), chat: Boolean(checked?.chat) };
      job.status = ['update','upgrade-runtime'].includes(job.operation) ? 'updated' : job.operation === 'restore' ? 'restored' : 'deployed';
      emit(job, 'done', job.operation === 'upgrade-runtime' ? 'Runtime upgraded and /health verified. Existing Worker URL, knowledge, origins and API secret preserved.' : job.operation === 'update' ? 'Knowledge / origins / client actions updated and /health verified. Existing secret preserved.' : job.operation === 'restore' ? 'Previous knowledge restored and /health verified.' : 'Deployment and live health verification successful');
    } catch (err) {
      job.status = 'partial'; job.partial = true;
      job.error = `Worker deployment may be live at ${job.url}, but verification failed: ${err.message}`;
      emit(job, 'warning', job.error);
    }
  }

  async function startManagedJob(job, payload) {
    let changedLocal = false;
    try {
      job.status = 'working';
      const current = await readProject(root, payload.folder);
      if (payload.revision !== current.revision) throw new Error('This Worker changed since it was loaded. Reload it before saving. Nothing was overwritten.');
      let changes;
      if (job.operation === 'restore') {
        const old = await readVersion(current, payload.versionId);
        changes = { faq: old.config.faq, instructions: old.config.instructions, origins: old.config.origins ?? [old.config.origin], actions: old.config.actions ?? [] };
      } else changes = { faq: payload.faq, instructions: payload.instructions, origins: payload.origins, actions: payload.actions };
      const isRuntimeUpgrade = job.operation === 'upgrade-runtime';
      const preview = isRuntimeUpgrade ? null : previewChanges(current, changes);
      if (!isRuntimeUpgrade && !preview.changed) throw new Error('No knowledge, origin or action changes to deploy.');
      const runtimePlan = isRuntimeUpgrade ? await planRuntimeUpgrade(current) : null;
      // A redeploy is also allowed when local files are current: it repairs an earlier partial cloud deploy.
      if (!current.accountId) throw new Error('The project has no saved account ID. Cannot safely update the remote Worker.');
      emit(job, 'preflight', `Checking that ${current.name} still exists in the saved Cloudflare account`);
      await managedPreflight(current);
      const latest = await readProject(root, payload.folder);
      if (latest.revision !== current.revision) throw new Error('Local files changed during Cloudflare preflight. Reload the project.');
      const actionUpgrade = !isRuntimeUpgrade && preview.actionsChanged ? await prepareActionUpgrade(current, preview.actions) : { upgrade:false };
      // A v1.1 runtime replacement already contains modern CORS handling.
      const corsUpgrade = !isRuntimeUpgrade && preview.originsChanged && !actionUpgrade.upgrade ? await prepareCorsUpgrade(current) : { changed:false };
      const backup = await makeSnapshot(current, job.operation === 'restore' ? 'before_restore' : isRuntimeUpgrade ? 'before_runtime_upgrade' : 'before_update');
      job.backupId = backup.id;
      emit(job, 'backup', `Local backup saved (${backup.id.slice(0, 8)}). You can restore it from Version history.`);
      const config = asGenerateConfig(root, current, changes);
      if (isRuntimeUpgrade) {
        changedLocal = true;
        const applied = await applyRuntimeUpgrade(current, runtimePlan, backup.id);
        emit(job, 'generate', applied.upgraded ? `Runtime diagnostics upgraded: ${applied.files.join(', ')}. Original source preserved under .falco-history.` : 'Local runtime already at v1.2; redeploying to verify Cloudflare state.');
      }
      if (!isRuntimeUpgrade && (preview.faq.changed || preview.instructions.changed)) {
        await writeKnowledge(current, changes);
        changedLocal = true;
      }
      if (!isRuntimeUpgrade && preview.actionsChanged) {
        changedLocal = true;
        await applyClientActions(current, preview.actions, actionUpgrade, backup.id);
        emit(job, 'generate', actionUpgrade.upgrade ? 'Legacy Worker runtime migrated to Client Actions v1.1 (original source backed up).' : 'Client action catalog updated; no privileged permissions added.');
      }
      if (!isRuntimeUpgrade && preview.originsChanged) {
        // This operation may write the Worker source before updating wrangler.json.
        // Treat any failure during it as partial, not as an unchanged local project.
        changedLocal = true;
        await applyOriginChanges(current, preview.origins, corsUpgrade, backup.id);
      }
      if (!isRuntimeUpgrade) emit(job, 'generate', preview.originsChanged
        ? 'CORS allowlist updated in Wrangler and compatibility code. Provider and secrets left untouched.'
        : 'Business knowledge module updated. Worker code, provider and settings left untouched.');
      const result = await deployProject(config, {
        preserveSecret: true, requireExisting: true,
        logger: message => emit(job, 'cloudflare', String(message).slice(0, 200)),
      });
      await finishDeployment(job, config, result);
    } catch (err) {
      job.status = changedLocal ? 'partial' : 'failed';
      job.partial = changedLocal;
      job.error = String(err.message || 'Unexpected failure') + (changedLocal ? ' Local files were updated; the previous configuration is available in Version history. Check Cloudflare before retrying.' : '');
      emit(job, changedLocal ? 'warning' : 'error', job.error);
    } finally {
      if (activeJob === job.id) activeJob = null;
    }
  }

  async function startJob(job, c, apiKey) {
    try {
      job.status = 'working';
      emit(job, 'prepare', 'Validating configuration and local project directory');
      const generated = await generateProject(c);
      emit(job, 'generate', `Generated ${generated.files?.length ?? 12} managed project files`);
      if (job.mode === 'generate') {
        job.status = 'generated';
        emit(job, 'done', 'Files generated successfully. Cloudflare was not changed.');
        return;
      }
      emit(job, 'cloudflare', 'Checking Cloudflare authentication and remote name');
      const result = await deployProject(c, {
        logger: message => emit(job, 'cloudflare', String(message).slice(0, 200)),
        apiKey,
      });
      await finishDeployment(job, c, result);
    } catch (err) {
      job.status = 'failed';
      job.error = err.message || 'Unexpected failure';
      emit(job, 'error', job.error);
    } finally {
      if (activeJob === job.id) activeJob = null;
    }
  }

  const server = http.createServer(async (req, res) => {
    const authority = req.headers.host || '';
    const listenPort = server.address()?.port || port;
    if (authority !== `127.0.0.1:${listenPort}` && authority !== `localhost:${listenPort}`) {
      json(res, 403, { error: 'Host not allowed. Use the local Falco Studio address.' }); return;
    }
    const u = new URL(req.url, `http://127.0.0.1:${listenPort}`);
    const route = u.pathname;
    if (req.method === 'POST') {
      const validOrigin = !req.headers.origin || [`http://127.0.0.1:${listenPort}`, `http://localhost:${listenPort}`].includes(req.headers.origin);
      if (!validOrigin || req.headers['x-falco-local-token'] !== secretToken) {
        json(res, 403, { error: 'Local request rejected. Reload Falco Studio and retry.' }); return;
      }
    }
    try {
      if (req.method === 'GET' && route === '/api/bootstrap') {
        json(res, 200, { token: secretToken, defaultModels: DEFAULT_MODELS, port: listenPort }); return;
      }
      if (req.method === 'GET' && route === '/api/cloudflare') {
        try {
          const who = await runWrangler(['whoami', '--json']);
          if (who.code !== 0) throw new Error('Cloudflare is not authenticated. Run npx.cmd wrangler login in a terminal.');
          const data = JSON.parse(who.stdout);
          const raw = Array.isArray(data.accounts) ? data.accounts : Array.isArray(data.memberships) ? data.memberships : [];
          const accounts = raw.map(x => ({ id: x.id || x.account_id || x.account?.id || '', name: x.name || x.account?.name || 'Cloudflare account' }))
            .filter(x => /^[a-f0-9]{32}$/i.test(x.id)).slice(0, 20);
          json(res, 200, { connected: true, accounts, selectedAccount: process.env.CLOUDFLARE_ACCOUNT_ID || '' });
        } catch (err) { json(res, 200, { connected: false, error: err.message.slice(0, 200), accounts: [] }); }
        return;
      }
      if (req.method === 'GET' && route === '/api/projects') {
        json(res, 200, { projects: await listProjects(root) }); return;
      }
      if (req.method === 'GET' && route === '/api/cloudflare/workers') {
        // Read-only Cloudflare discovery. Only public Worker metadata crosses to the UI.
        const accountId = u.searchParams.get('accountId') || '';
        if (accountId && !/^[a-f0-9]{32}$/i.test(accountId)) {
          json(res, 400, { error: 'Account ID must be 32 hexadecimal characters.' }); return;
        }
        const discovered = await cloudWorkers({ accountId });
        if (!/^[a-f0-9]{32}$/i.test(discovered.accountId || '') || !Array.isArray(discovered.workers)) {
          throw new Error('Cloudflare Worker discovery returned invalid data.');
        }
        const local = await listProjects(root);
        json(res, 200, { accountId: discovered.accountId,
          workers: mergeRemoteWithLocal(discovered.workers, local, discovered.accountId),
          checkedAt: new Date().toISOString() });
        return;
      }
      if (req.method === 'POST' && route === '/api/cloudflare/workers/load') {
        if (activeJob || activeCloudMutation) { json(res, 409, { error: 'Finish the ongoing Cloudflare operation first.' }); return; }
        const input = await receiveJson(req);
        if (!/^[a-f0-9]{32}$/i.test(input.accountId || '') || !/^falco-[a-z0-9-]{1,62}$/.test(input.name || '')) {
          json(res, 400, { error: 'Select a valid Falco Worker and Cloudflare account.' }); return;
        }
        const result = await autoLoadWorker({ root, accountId: input.accountId, name: input.name, discover: cloudWorkers });
        json(res, result.status === 'loaded' ? 200 : 409, result.status === 'loaded' ? result : { ...result, error: result.message });
        return;
      }
      if (req.method === 'POST' && route === '/api/frontend-kit/export') {
        // Export is read-only: no deployment, no secret access and no remote mutations.
        const input = await receiveJson(req);
        const accountId = input?.accountId;
        const name = input?.name;
        if (!/^[a-f0-9]{32}$/i.test(accountId || '') || !/^falco-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name || '') || name.length > 63) {
          json(res, 400, { error: 'Select a valid deployed Falco Worker and Cloudflare account.' }); return;
        }
        const found = await cloudWorkers({ accountId });
        if (found.accountId?.toLowerCase() !== accountId.toLowerCase() || !found.workers?.some(w => w.name === name)) {
          json(res, 404, { error: 'Selected Worker is not present in that Cloudflare account. Refresh Workers.' }); return;
        }
        const endpoint = await getWorkerFrontendEndpoint({ accountId, name });
        const allowedOrigins = await remoteOrigins({ accountId, name });
        const actions = await remoteActions({ accountId, name });
        const kit = await createFrontendKit({ name, endpoint, allowedOrigins, actions });
        res.writeHead(200, { 'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${kit.filename}"`,
          'Content-Length': kit.bytes.length, 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
          'Referrer-Policy': 'no-referrer' });
        res.end(kit.bytes); return;
      }
      if (req.method === 'POST' && route === '/api/cloudflare/workers/delete') {
        if (activeJob || activeCloudMutation) { json(res, 409, { error: 'Cannot delete a Worker during another operation.' }); return; }
        const input = await receiveJson(req);
        if (!/^[a-f0-9]{32}$/i.test(input.accountId || '') || !/^falco-[a-z0-9-]{1,62}$/.test(input.name || '')) {
          json(res, 400, { error: 'Select a valid Falco Worker and Cloudflare account.' }); return;
        }
        if (input.confirmation !== input.name || input.acknowledge !== 'DELETE') {
          json(res, 400, { error: 'Deletion requires typing the exact Worker name and confirming DELETE.' }); return;
        }
        // Lock before the async live preflight to prevent deployment/deletion races.
        activeCloudMutation = true;
        try {
          const inventory = await cloudWorkers({ accountId: input.accountId });
          if (inventory.accountId?.toLowerCase() !== input.accountId.toLowerCase() ||
              !inventory.workers.some(w => w.name === input.name)) {
            json(res, 404, { error: 'Worker was not found in the selected account. Refresh the list; nothing was deleted.' }); return;
          }
          const result = await removeCloudflareWorker({ accountId: input.accountId, name: input.name });
          json(res, 200, result);
        } finally { activeCloudMutation = false; }
        return;
      }
      if (req.method === 'POST' && route === '/api/projects/import') {
        if (activeJob) { json(res, 409, { error: 'Finish the ongoing deployment before importing another project.' }); return; }
        const input = await receiveJson(req);
        const p = await importLocalProject(root, input.sourcePath, {
          expectedName: input.expectedWorker || '', expectedAccountId: input.expectedAccountId || ''
        });
        json(res, 201, { project: { name: p.name, folder: p.folder, business: p.business, provider: p.provider } }); return;
      }
      const projectGet = route.match(/^\/api\/projects\/([a-z0-9-]+)$/);
      if (req.method === 'GET' && projectGet) {
        const p = await readProject(root, projectGet[1]);
        json(res, 200, { project: p }); return;
      }
      const runtimeStatus = route.match(/^\/api\/projects\/([a-z0-9-]+)\/runtime-status$/);
      if (req.method === 'GET' && runtimeStatus) {
        const project = await readProject(root, runtimeStatus[1]);
        try {
          const plan = await planRuntimeUpgrade(project);
          json(res, 200, { state: plan.needed ? 'upgrade_available' : 'current', files:plan.changes.map(x=>x.file) });
        } catch {
          json(res, 200, { state:'manual_review', files:[], message:'Runtime source differs from the official v1.1 or v1.2 templates. Automatic upgrade disabled.' });
        }
        return;
      }
      const projectVersions = route.match(/^\/api\/projects\/([a-z0-9-]+)\/versions$/);
      if (req.method === 'GET' && projectVersions) {
        const p = await readProject(root, projectVersions[1]);
        json(res, 200, { versions: await listVersions(p) }); return;
      }
      const projectPreview = route.match(/^\/api\/projects\/([a-z0-9-]+)\/preview-update$/);
      if (req.method === 'POST' && projectPreview) {
        const p = await readProject(root, projectPreview[1]);
        const data = await receiveJson(req);
        if (data.revision !== p.revision) { json(res, 409, { error: 'Project changed on disk. Reload before editing.' }); return; }
        json(res, 200, { diff: previewChanges(p, data), revision: p.revision }); return;
      }
      if (req.method === 'GET' && route === '/api/example/gallinas') {
        const base = path.join(root, 'examples/gallinas');
        const [faq, instructions] = await Promise.all([fs.readFile(path.join(base, 'faq.md'), 'utf8'), fs.readFile(path.join(base, 'instructions.md'), 'utf8')]);
        json(res, 200, { business: 'Gallinas y Valientes', name: 'falco-gallinas-studio', provider: 'mock', origin: 'http://localhost:3000', origins: ['http://localhost:3000'], faq, instructions, actions: GALLINAS_ACTIONS });
        return;
      }
      if (req.method === 'POST' && route === '/api/preview') {
        const data = await receiveJson(req);
        const c = configFromForm(data, { root });
        const result = await generateProject({ ...c, dryRun: true, force: true });
        json(res, 200, { valid: true, name: c.name, business: c.business, output: c.output, files: result.files, localExists: Boolean(result.exists), forceRequired: Boolean(result.exists) && !c.force, provider: c.provider, origin: c.origin, origins: c.origins, actions: c.actions });
        return;
      }
      if (req.method === 'POST' && route === '/api/jobs') {
        if (activeJob || activeCloudMutation) { json(res, 409, { error: 'Another Cloudflare operation is running. Finish it first.' }); return; }
        const data = await receiveJson(req);
        if (data.mode === 'update' || data.mode === 'restore' || data.mode === 'upgrade-runtime') {
          const p = await readProject(root, data.folder);
          if (data.revision !== p.revision) { json(res, 409, { error: 'Project changed on disk. Reload before editing.' }); return; }
          if (data.mode === 'update') {
            const diff = previewChanges(p, data);
            if (!diff.changed) { json(res, 409, { error: 'No changes found. Edit instructions, FAQ, origins or client actions before saving.' }); return; }
          } else if (data.mode === 'restore') await readVersion(p, data.versionId);
          else { await planRuntimeUpgrade(p); /* Current source may require cloud redeploy after partial failure. */ }
          const job = { id: randomUUID(), operation: data.mode, mode: 'deploy', status: 'queued',
            name: p.name, business: p.business, output: p.output, events: [], url: null, chatUrl: null,
            secretStatus: null, error: null, partial: false, verification: null, backupId: null,
            createdAt: new Date().toISOString() };
          jobs.set(job.id, job);
          while (jobs.size > 20) jobs.delete(jobs.keys().next().value);
          activeJob = job.id;
          json(res, 202, { job: safeJob(job) });
          void startManagedJob(job, { folder: p.folder, revision: p.revision,
            ...(data.mode === 'update' ? { faq: data.faq, instructions: data.instructions, origins: data.origins, actions: data.actions } : data.mode === 'restore' ? { versionId: data.versionId } : {}) });
          return;
        }
        const mode = data.mode === 'deploy' ? 'deploy' : data.mode === 'generate' ? 'generate' : null;
        if (!mode) throw new Error('Choose generate or deploy.');
        if (activeJob || activeCloudMutation) { json(res, 409, { error: 'Another Cloudflare operation is running. Finish it first.' }); return; }
        const c = configFromForm(data, { root, deployRequested: mode === 'deploy' });
        let apiKey;
        if (mode === 'deploy' && c.provider !== 'mock') {
          apiKey = typeof data.apiKey === 'string' ? data.apiKey.trim() : '';
          if (!apiKey && !process.env.FALCO_PROVIDER_API_KEY) throw new Error('Enter the provider API key to deploy, or supply FALCO_PROVIDER_API_KEY to the local Studio process. Key is sent only to Wrangler secret put.');
          if (apiKey.length > 1024 || /[\r\n]/.test(apiKey)) throw new Error('Invalid provider API key format.');
        }
        const job = { id: randomUUID(), mode, status: 'queued', name: c.name, business: c.business,
          output: c.output, events: [], url: null, chatUrl: null, secretStatus: null, error: null,
          partial: false, verification: null, createdAt: new Date().toISOString() };
        jobs.set(job.id, job);
        while (jobs.size > 20) jobs.delete(jobs.keys().next().value);
        activeJob = job.id;
        json(res, 202, { job: safeJob(job) });
        // No key is retained in the job object, logs, generated files, or browser storage.
        void startJob(job, c, apiKey);
        return;
      }
      const jobGet = route.match(/^\/api\/jobs\/([0-9a-f-]{36})$/);
      if (req.method === 'GET' && jobGet) {
        const job = jobs.get(jobGet[1]);
        if (!job) { json(res, 404, { error: 'Job not found (Studio sessions are local and temporary).' }); return; }
        json(res, 200, { job: safeJob(job) }); return;
      }
      const chatPost = route.match(/^\/api\/jobs\/([0-9a-f-]{36})\/chat$/);
      if (req.method === 'POST' && chatPost) {
        const job = jobs.get(chatPost[1]);
        if (!job?.url || !validWorkerUrl(job.url)) { json(res, 404, { error: 'No deployed Worker URL available for this job.' }); return; }
        const request = await receiveJson(req);
        if (typeof request.message !== 'string' || request.message.trim().length < 1 || request.message.length > 2000) throw new Error('Enter a chat message of 1–2,000 characters.');
        const response = await fetch(`${job.url}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: request.message, history: [] }), signal: AbortSignal.timeout(16000) });
        const body = await response.json().catch(() => ({ error: 'invalid_response' }));
        if (!response.ok) {
          const code = typeof body.error === 'string' && /^[a-z_]{2,48}$/.test(body.error) ? body.error : 'worker_error';
          const diagnosticId = typeof body.requestId === 'string' && /^[0-9a-f-]{36}$/i.test(body.requestId) ? body.requestId : null;
          const providerStatus = Number.isInteger(body.providerStatus) ? body.providerStatus : null;
          const explanation = typeof body.message === 'string' && body.message.length < 200 ? body.message : 'Revisa los diagnósticos del Worker.';
          json(res, response.status, { error: `${explanation} (código: ${code}; HTTP ${response.status}${providerStatus ? '; proveedor HTTP '+providerStatus : ''}${diagnosticId ? '; diagnóstico: '+diagnosticId : ''})`, code, requestId:diagnosticId, providerStatus }); return;
        }
        json(res, 200, { reply: String(body.reply || '').slice(0, 4000), ...(body.action ? { action: body.action } : {}) }); return;
      }
      if (req.method === 'GET' && (route === '/' || route === '/app.js' || route === '/styles.css')) {
        const file = route === '/' ? 'index.html' : route.slice(1);
        const content = await fs.readFile(path.join(UI_DIR, file));
        res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8',
          'Content-Length': content.byteLength, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': CONTENT_SECURITY_POLICY, 'Referrer-Policy': 'no-referrer' });
        res.end(content); return;
      }
      json(res, 404, { error: 'Not found' });
    } catch (err) {
      json(res, err.httpStatus || 400, { error: String(err.message || 'Unexpected error').slice(0, 700) });
    }
  });
  return { server, jobs, listen: () => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(`http://${host}:${server.address().port}`); });
  }), close: () => new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve())) };
}
