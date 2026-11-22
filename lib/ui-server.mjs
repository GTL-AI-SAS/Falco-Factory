import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkKnowledge, publishKv, kvStatus } from './knowledge-kv.mjs';
import { planKvMigration, migrateToKv } from './kv-migration.mjs';
import { normalizeConfig, DEFAULT_MODELS, VERSION } from './args.mjs';
import { generate } from './generate.mjs';
import { deploy, runWrangler, getCloudflareSession, getCloudflareAuthDiagnostics, cfGet, actualWorkerUrl } from './deploy.mjs';
import { createFrontendKit } from './frontend-kit.mjs';
import { getDeployedOrigins } from './worker-origins.mjs';
import { getDeployedClientActions } from './worker-actions.mjs';
import { prepareActionUpgrade, applyClientActions } from './action-updates.mjs';
import { planRuntimeUpgrade, applyRuntimeUpgrade } from './runtime-upgrades.mjs';
import { planProviderSharedRepair, applyProviderSharedRepair } from './provider-runtime-compat.mjs';
import { normalizeClientActions, GALLINAS_ACTIONS } from './client-actions.mjs';
import { prepareCorsUpgrade, applyOriginChanges } from './origin-updates.mjs';
import { readProject, listProjects, previewChanges, makeSnapshot, listVersions, readVersion, asGenerateConfig, importLocalProject, writeKnowledge } from './projects.mjs';
import { smoke } from './smoke.mjs';
import { buildActionTest } from './verification.mjs';
import { RUNTIME_VERSION } from './runtime-manifest.mjs';
import { assertRemote, inspectRemote, saveRemote, deploymentLedger } from './remote-state.mjs';
import { recordOperation, operations } from './operation-history.mjs';
import { withProjectLock, assertNoPendingTransaction } from './project-files.mjs';
import { architecture, compileSections, exportProject, publishVersion, replaceProviderSecret, restoreProposal, saveSections, settingsProposal, stageDeployment, updateSettings, verifyCustomDomain } from './management.mjs';
import { createActionController } from '../frontend-kit-template/actions/action-controller.js';
import { verticals } from './verticals.mjs';
import { testProvider } from './provider-check.mjs';
import { discoverCloudflareWorkers, mergeRemoteWithLocal } from './cloudflare-workers.mjs';
import { loadExistingFalco, deleteCloudflareFalco } from './worker-lifecycle.mjs';
import { refreshProject } from './project-refresh.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI_DIR = path.join(ROOT, 'ui');
const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const STUDIO_ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'application/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/inter.woff2', ['inter.woff2', 'font/woff2']],
  ['/space-grotesk.woff2', ['space-grotesk.woff2', 'font/woff2']],
]);

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
  if (form.knowledgeMode !== undefined) opts['knowledge-mode'] = form.knowledgeMode;
  const c = normalizeConfig(opts, root);
  // Strictly validate both user input size and the requested storage tier.
  checkKnowledge(c.knowledgeMode,{faq:form.faq ?? '',instructions:form.instructions ?? ''});
  for (const [key, max] of [['faq', c.knowledgeMode==='kv'?96000:24000], ['instructions', c.knowledgeMode==='kv'?24000:12000]]) {
    const content = form[key] ?? '';
    if (typeof content !== 'string' || content.includes('\0')) throw new Error(`${key} must be valid text.`);
    if (Buffer.byteLength(content, 'utf8') > max) throw new Error(`${key} exceeds ${Math.round(max / 1000)} KB.`);
    c[key] = content;
  }
  c.actions = normalizeClientActions(form.actions ?? []);
  c.source = 'studio';
  c.specified = c.specified.filter(key => !['provider','origins'].includes(key));
  for (const key of ['provider','origins','actions','faq','instructions','observability']) {
    if (form[key] !== undefined || (key === 'origins' && form.origin !== undefined)) c.specified.push(key);
  }
  c.clearFaq = form.clearFaq === true;
  c.clearInstructions = form.clearInstructions === true;
  if ((c.clearFaq || c.clearInstructions) && (form.clearKnowledge !== 'CLEAR' || form.confirmName !== c.name || form.force !== true)) {
    throw new Error('Clearing knowledge requires confirming the Worker name and CLEAR.');
  }
  if ((c.clearFaq && c.faq.trim()) || (c.clearInstructions && c.instructions.trim())) throw new Error('Clear confirmations require empty input.');
  c.checkAction = form.checkAction === true;
  c.actionMessage = typeof form.actionMessage === 'string' ? form.actionMessage.trim() : '';
  if (c.checkAction) {
    if (c.provider === 'mock') throw new Error('Client Action proposal checks require Gemini or OpenAI; Mock only returns its fixed reply.');
    buildActionTest(c.actions, c.actionMessage);
  }
  c.checkProvider = form.checkProvider === true;
  c.observability = form.observability === true;
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
  if (length > 400000) { const e = new Error('Request too large (400 KB maximum).'); e.httpStatus = 413; throw e; }
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    const e = new Error('Expected Content-Type: application/json.'); e.httpStatus = 415; throw e;
  }
  const chunks = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 400000) { const e = new Error('Request too large (400 KB maximum).'); e.httpStatus = 413; throw e; }
    chunks.push(part);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const e = new Error('Malformed JSON request.'); e.httpStatus = 400; throw e; }
}
function safeJob(job) {
  const { id, status, mode, business, name, output, events, url, chatUrl, secretStatus, error, partial, verification, createdAt, backupId, operation, readiness, stagedVersion, drift } = job;
  return { id, status, mode, business, name, output, events, url: url ?? null, chatUrl: chatUrl ?? null, secretStatus: secretStatus ?? null, error: error ?? null, partial: partial ?? false, verification: verification ?? null, createdAt, backupId: backupId ?? null, operation, readiness, stagedVersion, drift };
}
function sendZip(res, filename, bytes) {
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(bytes);
}

function validWorkerUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/i.test(u.hostname) && u.pathname === '/' && !u.username && !u.password && !u.search && !u.hash;
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
  let runningOperation = null;
  let activeCloudMutation = false;
  const generateProject = runner.generate || generate;
  const deployProject = runner.deploy || deploy;
  const publishKnowledge = runner.publishKv || publishKv;
  const migrateKnowledge = runner.migrateToKv || migrateToKv;
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
  const sessionFor = runner.session || getCloudflareSession;
  const remoteOptions = runner.remoteReader ? { remoteReader: runner.remoteReader } : {};
  const managedPreflight = runner.managedPreflight || (async (project, signal) => {
    if (!project.accountId) throw new Error('Save the Cloudflare account before managing this Worker.');
    const session = await sessionFor(project, { signal });
    return assertRemote(project, session, remoteOptions);
  });
  const providerTest = runner.testProvider || testProvider;
  const managedOperations = new Set(['update','restore','restore-config','upgrade-runtime','enable-kv','publish-kv','kv-rollback',
    'settings','replace-secret','check-provider','stage','promote','rollback']);
  const mustConfirmName = new Set(['restore-config','settings','replace-secret','kv-rollback','stage','promote','rollback']);
  const workspaceMutation = async work => {
    if (activeJob || activeCloudMutation) throw Object.assign(new Error('Finish the current Factory operation first.'), { httpStatus: 409 });
    activeCloudMutation = true;
    try { return await work(); } finally { activeCloudMutation = false; }
  };
  function startTrackedJob(job) {
    const control = new AbortController();
    cancellation.set(job.id, control);
    jobs.set(job.id, job);
    while (jobs.size > 20) jobs.delete(jobs.keys().next().value);
    activeJob = job.id;
    return control.signal;
  }

  const cancellation = new Map();

  async function storeJob(job) {
    try { await recordOperation(root, job); }
    catch { emit(job, 'warning', 'Operation history could not be saved. Check permissions and free space.'); }
  }

  async function closeJob(job) {
    cancellation.delete(job.id);
    if (activeJob === job.id) activeJob = null;
    await storeJob(job);
  }

  async function finishDeployment(job, c, result) {
    job.url = result.url && validWorkerUrl(result.url) ? result.url : null;
    job.chatUrl = job.url ? job.url + '/chat' : null;
    job.secretStatus = result.secret;
    if (result.urlError) emit(job, 'warning', result.urlError);
    if (result.remoteError) emit(job, 'warning', result.remoteError);
    if (result.secretError) emit(job, 'warning', 'Provider secret configuration is incomplete. ' + result.secretError);
    if (!job.url || result.status !== 'deployed') {
      job.status = 'partial'; job.partial = true;
      job.error = result.remoteError || result.secretError || 'Could not verify the live Worker or its URL. Review Cloudflare before retrying.';
      emit(job, 'warning', job.error);
      return;
    }
    const action = c.checkAction ? buildActionTest(c.actions, c.actionMessage) : undefined;
    const chat = c.provider === 'mock' || c.checkProvider || Boolean(action);
    const actionConfigured = Array.isArray(c.actions) && c.actions.length > 0;
    emit(job, 'verify', 'Checking health and CORS' + (chat ? (action ? ' and one Client Action proposal' : ' and one /chat request') : '. Provider checks not authorized; no AI request will be made.'));
    try {
      const checked = await smokeProject(job.url, { business: c.business, origins: c.origins, chat, action, actionConfigured, actionSupported: c.provider !== 'mock',
        ...((['upgrade-runtime','enable-kv'].includes(job.operation) || job.operation === undefined) ? { expectedRuntime: RUNTIME_VERSION } : {}) });
      job.verification = checked.verification ?? { health: Boolean(checked.health), chat: checked.chat ? true : null, cors: null };
      job.readiness = job.verification.health && job.verification.cors && job.verification.chat &&
        job.verification.action !== false ? 'ready' : 'verification incomplete';
      if (job.readiness === 'ready' && !runner.deploy) {
        const project = { ...c, accountId: result.accountId ?? c.accountId };
        let session = await sessionFor(project);
        const state = await assertRemote(project, session, remoteOptions);
        await saveRemote(project, { detail: state.current, fingerprint: state.fingerprint }, { verified: true });
      }
      job.status = ['restore', 'restore-config'].includes(job.operation) ? 'restored' : job.operation ? 'updated' : 'deployed';
      emit(job, 'done', job.readiness === 'ready'
        ? 'Health, CORS and authorized live checks passed.'
        : 'Cloudflare accepted the deployment. Review each verification status; some checks may be untested or unauthorized.');
    } catch (error) {
      job.status = 'partial'; job.partial = true; job.verification = error.verification;
      job.readiness = 'verification incomplete';
      job.error = 'The Worker may be live, but verification failed. ' + error.message;
      emit(job, 'warning', job.error);
    }
  }

  async function startManagedJob(job, payload, signal) {
    let changed = false;
    try {
      job.status = 'working';
      const current = await readProject(root, payload.folder);
      const operation = job.operation;
      if (payload.revision !== current.revision) throw new Error('This project changed since it was loaded. Reload it before saving.');
      if (['promote', 'rollback'].includes(operation)) {
        changed = true;
        const result = await publishVersion(current, { operation, versionId: payload.versionId, checkProvider: payload.checkProvider, signal });
        job.url = result.url; job.chatUrl = result.url + '/chat'; job.verification = result.verification;
        job.status = 'updated';
        emit(job, 'done', 'Cloudflare version active. KV data was managed independently.');
        return;
      }
      await withProjectLock(current.output, async () => {
        await assertNoPendingTransaction(current.output);
        const latest = await readProject(root, current.folder);
        if (latest.revision !== current.revision) throw new Error('Local files changed during preflight. Reload the project.');
        if (operation === 'check-provider') {
          const session = await sessionFor(current, { signal });
          const url = await actualWorkerUrl(current, session, '');
          const action = payload.checkAction === true ? buildActionTest(current.actions, payload.actionMessage) : undefined;
          const check = await smokeProject(url, { business: current.business, origins: current.origins,
            chat: payload.checkProvider === true || Boolean(action), action, actionConfigured: current.actions.length > 0, actionSupported: current.provider !== 'mock' });
          job.url = url; job.chatUrl = url + '/chat'; job.verification = check.verification; job.status = 'checked';
          if (check.verification?.health && check.verification?.cors && check.verification?.chat && check.verification?.action !== false) job.readiness = 'ready';
          const state = await inspectRemote(current, session, remoteOptions);
          if (state.status === 'clean' && check.verification?.chat && check.verification?.cors) {
            await saveRemote(current, { detail: state.current, fingerprint: state.fingerprint }, { verified: true });
          }
          return;
        }

        emit(job, 'preflight', 'Comparing Cloudflare deployment, bindings and settings with the saved baseline');
        await managedPreflight(current, signal);
        signal.throwIfAborted();
        const restore = ['restore', 'restore-config'].includes(operation);
        const settings = ['settings', 'replace-secret'].includes(operation);
        let changes = {};
        let preview;
        if (restore) {
          const proposal = restoreProposal(current, await readVersion(current, payload.versionId), operation === 'restore-config');
          changes = proposal.changes; preview = proposal.diff;
        } else if (operation === 'update' || (operation === 'stage' && payload.faq !== undefined)) {
          changes = payload.sections !== undefined ? { ...payload, ...compileSections(payload.sections) } : payload;
          preview = previewChanges(current, changes);
          if (payload.sections !== undefined || current.sections) {
            const knowledgeChanged = preview.faq.changed || preview.instructions.changed;
            if (payload.sections !== undefined || knowledgeChanged) changes = { ...changes, sections: payload.sections === undefined ? null : changes.sections };
          }
        } else if (operation === 'settings') changes = settingsProposal(current, payload);
        if ((await readProject(root, current.folder)).revision !== current.revision) throw new Error('Local files changed during Cloudflare preflight.');
        const config = { ...asGenerateConfig(root, current, changes),
          checkProvider: payload.checkProvider === true,
          checkAction: payload.checkAction === true,
          actionMessage: typeof payload.actionMessage === 'string' ? payload.actionMessage.trim() : '' };
        if (config.checkAction) {
          if (config.provider === 'mock') throw new Error('Client Action proposal checks require Gemini or OpenAI; Mock only returns its fixed reply.');
          buildActionTest(config.actions, config.actionMessage);
        }
        const key = payload.apiKey;
        if (key && config.provider !== 'mock' && payload.precheck === true) {
          emit(job, 'verify', 'Checking the replacement credential and model with one direct provider request');
          await providerTest({ provider: config.provider, model: config.model, apiKey: key, actionMode: config.actions.length > 0 });
        }
        if (operation === 'replace-secret') {
          changed = true;
          const result = await (runner.replaceSecret || replaceProviderSecret)(current, { apiKey: key, signal });
          await finishDeployment(job, config, result);
          return;
        }
        if (operation === 'stage' && current.knowledgeMode === 'kv' && (preview?.faq.changed || preview?.instructions.changed)) {
          throw new Error('Stage code and configuration independently of KV. Use the KV revision workflow for knowledge changes.');
        }
        if (operation === 'restore' && !preview.changed) {
          job.status = 'restored';
          emit(job, 'done', 'FAQ and instructions already match the selected snapshot.');
          return;
        }
        const runtimePlan = operation === 'upgrade-runtime' || ((settings || operation === 'restore-config') && config.budget) ? await planRuntimeUpgrade(current) : null;
        const kvPlan = operation === 'enable-kv' ? await planKvMigration(current) : null;
        const updateSettingsNeeded = operation === 'settings' || (operation === 'restore-config' && preview.settings.length > 0);
        const actionUpgrade = preview?.actionsChanged ? await prepareActionUpgrade(current, preview.actions) : { upgrade: false };
        const plannedRuntimeSources = actionUpgrade.upgrade ? {
          'src/index.mjs': actionUpgrade.newSource,
          'src/client-actions.mjs': await fs.readFile(path.join(ROOT, 'templates/worker/src/client-actions.mjs'), 'utf8')
        } : {};
        // Normal knowledge/config updates also validate provider-module compatibility.
        // This repairs recognized legacy shared.mjs files left behind by the old
        // Client Actions upgrade path, without replacing customized source.
        const providerRepairPlan = runtimePlan?.needed || ['publish-kv', 'kv-rollback'].includes(operation)
          ? { needed: false }
          : await planProviderSharedRepair(current, { plannedSources: plannedRuntimeSources });
        const corsUpgrade = preview?.originsChanged && !actionUpgrade.upgrade ? await prepareCorsUpgrade(current) : { changed: false };
        const backup = await makeSnapshot(current, 'before_' + operation.replaceAll('-', '_'));
        job.backupId = backup.id;
        emit(job, 'backup', 'Local snapshot saved (' + backup.id.slice(0, 8) + ')');
        if (runtimePlan?.needed) {
          changed = true;
          await applyRuntimeUpgrade(current, runtimePlan, backup.id);
        }
        if (providerRepairPlan?.needed) {
          changed = true;
          const repair = await applyProviderSharedRepair(current, providerRepairPlan, backup.id);
          emit(job, 'runtime', `Repaired ${repair.file}: added compatibility exports required by the current runtime`);
        }
        if (kvPlan) {
          changed = true;
          await migrateKnowledge(current, kvPlan, backup.id, { signal, logger: message => emit(job, 'kv', message) });
          config.knowledgeMode = 'kv';
        }
        if (preview?.faq.changed || preview?.instructions.changed) {
          changed = true;
          await writeKnowledge(current, changes);
        }
        if (Object.hasOwn(changes, 'sections')) {
          changed = true;
          await saveSections(current, changes.sections);
        }
        if (preview?.actionsChanged) {
          changed = true;
          await applyClientActions(current, preview.actions, actionUpgrade, backup.id);
        }
        if (preview?.originsChanged) {
          changed = true;
          await applyOriginChanges(current, preview.origins, corsUpgrade, backup.id);
        }
        if (updateSettingsNeeded) {
          changed = true;
          await updateSettings(current, config);
        }
        if (operation === 'stage') {
          const result = await stageDeployment(current, { config, signal, smokeCheck: smokeProject });
          job.stagedVersion = result.id; job.verification = result.verification; job.status = 'checked';
          emit(job, 'done', 'Version preview verified. Use Promote to send it live.');
          return;
        }
        const publishOnly = operation === 'kv-rollback' || (Boolean(preview) && !preview.originsChanged && !preview.actionsChanged && !updateSettingsNeeded);
        const publish = current.knowledgeMode === 'kv' && (['publish-kv','kv-rollback'].includes(operation) || preview?.faq.changed || preview?.instructions.changed);
        if (publish) {
          await managedPreflight(current, signal);
          changed = true;
          const publication = await publishKnowledge({ ...current, faq: config.faq, instructions: config.instructions }, {
            signal, logger: message => emit(job, 'kv', message),
            ...(operation === 'kv-rollback' ? { revision: payload.versionId, expectedActive: payload.expectedActive } : {})
          });
          if (operation === 'kv-rollback' && publication?.knowledge) {
            await writeKnowledge(current, publication.knowledge);
            await saveSections(current, null);
          }
          if (publishOnly) {
            const endpoint = await getWorkerFrontendEndpoint(current);
            job.url = new URL(endpoint).origin; job.chatUrl = endpoint;
            job.status = restore ? 'restored' : 'updated';
            job.secretStatus = 'preserved';
            if (publication?.revision) {
              try {
                const action = config.checkAction ? buildActionTest(config.actions, config.actionMessage) : undefined;
                const check = await smokeProject(job.url, { business: config.business, origins: config.origins,
                  chat: config.checkProvider || config.provider === 'mock' || Boolean(action), action,
                  actionConfigured: (config.actions ?? []).length > 0, actionSupported: config.provider !== 'mock', knowledgeRevision: publication.revision });
                job.verification = check.verification;
                job.readiness = check.verification?.health && check.verification?.cors && check.verification?.chat &&
                  check.verification?.action !== false ? 'ready' : 'verification incomplete';
              } catch (error) {
                job.verification = error.verification;
                job.status = 'partial'; job.partial = true;
                job.error = 'KV revision was verified by Cloudflare’s management API. ' + error.message;
                emit(job, 'warning', job.error);
                return;
              }
            }
            emit(job, 'done', 'KV knowledge published. Edge propagation may continue.');
            return;
          }
        }
        signal.throwIfAborted();
        changed = true;
        const result = await deployProject(config, { apiKey: key, preserveSecret: !key, requireExisting: true, projectLocked: true, signal,
          logger: message => emit(job, 'cloudflare', String(message).slice(0, 200)) });
        await finishDeployment(job, config, result);
      });
    } catch (error) {
      job.status = signal.aborted ? 'cancelled' : changed ? 'partial' : 'failed';
      job.partial = changed;
      job.verification ??= error.verification;
      job.error = String(error.message || 'Unexpected failure') + (changed ? ' Check live Cloudflare state and the saved snapshot before retrying.' : '');
      emit(job, changed ? 'warning' : 'error', job.error);
    } finally { await closeJob(job); }
  }

  async function startJob(job, c, apiKey, signal) {
    try {
      job.status = 'working';
      signal.throwIfAborted();
      emit(job, 'prepare', 'Validating configuration and local project directory');
      const generated = await generateProject(c);
      c = generated.config ?? c;
      job.backupId = generated.backupId ?? null;
      emit(job, 'generate', `Generated ${generated.files?.length ?? 12} managed project files`);
      if (job.mode === 'generate') {
        job.status = 'generated';
        emit(job, 'done', 'Files generated successfully. Cloudflare was not changed.');
        return;
      }
      emit(job, 'cloudflare', 'Checking Cloudflare authentication and remote name');
      signal.throwIfAborted();
      const result = await deployProject(c, {
        logger: message => emit(job, 'cloudflare', String(message).slice(0, 200)),
        apiKey, signal, preserveSecret: Boolean(generated.exists) && !apiKey && !process.env.FALCO_PROVIDER_API_KEY,
      });
      await finishDeployment(job, c, result);
    } catch (err) {
      job.status = signal.aborted ? 'cancelled' : 'failed';
      job.error = err.message || 'Unexpected failure';
      emit(job, 'error', job.error);
    } finally {
      await closeJob(job);
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
        json(res, 200, { token: secretToken, version: VERSION, defaultModels: DEFAULT_MODELS, port: listenPort }); return;
      }
      if (req.method === 'GET' && route === '/api/cloudflare') {
        const requestedAccount = u.searchParams.get('accountId') || '';
        if (requestedAccount && !/^[a-f0-9]{32}$/i.test(requestedAccount)) {
          json(res, 400, { connected: false, error: 'Account ID must be 32 hexadecimal characters.', accounts: [] }); return;
        }
        const diagnostics = await (runner.authDiagnostics || getCloudflareAuthDiagnostics)({
          accountId: requestedAccount || process.env.CLOUDFLARE_ACCOUNT_ID || undefined
        });
        // The diagnostics object is explicitly allowlisted and never contains Wrangler's token or raw output.
        json(res, 200, diagnostics);
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
        let endpoint;
        if (input.customDomain) {
          const session = await sessionFor({ accountId });
          endpoint = await verifyCustomDomain({ name }, input.customDomain, session) + '/chat';
        } else endpoint = await getWorkerFrontendEndpoint({ accountId, name });
        const allowedOrigins = await remoteOrigins({ accountId, name });
        const actions = await remoteActions({ accountId, name });
        if (input.siteOrigin || input.customDomain) {
          if (input.siteOrigin && !allowedOrigins.includes(input.siteOrigin)) throw new Error('The website origin is not in the deployed Worker allowlist.');
          await smokeProject(new URL(endpoint).origin, { origins: input.siteOrigin ? [input.siteOrigin] : allowedOrigins, chat: false });
        }
        const kit = await createFrontendKit({ name, endpoint, allowedOrigins, actions, privacy: input.privacy });
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
      const projectRefresh = route.match(/^\/api\/projects\/([a-z0-9-]+)\/refresh$/);
      if (req.method === 'POST' && projectRefresh) {
        const project = await workspaceMutation(() => refreshProject(root, projectRefresh[1], {
          ...(runner.readDeployedProject ? { reader: runner.readDeployedProject } : {})
        }));
        json(res, 200, { project }); return;
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
        json(res, 200, { diff: previewChanges(p, data.sections === undefined ? data : { ...data, ...compileSections(data.sections) }), revision: p.revision }); return;
      }
      const projectTool = route.match(/^\/api\/projects\/([a-z0-9-]+)\/(restore-preview|remote-state|remote-baseline|kv-revisions|architecture|backup|usage|clone|staged|live-endpoint)$/);
      if (projectTool) {
        const [, folder, tool] = projectTool;
        const project = await readProject(root, folder);
        if (tool === 'live-endpoint' && req.method === 'GET') {
          if (!project.accountId) throw new Error('Select the Cloudflare account before opening the deployed Worker.');
          const endpoint = await getWorkerFrontendEndpoint(project);
          if (!validWorkerUrl(new URL(endpoint).origin) || new URL(endpoint).pathname !== '/chat') throw new Error('Unable to verify the deployed Worker URL.');
          json(res, 200, { endpoint }); return;
        }
        if (tool === 'architecture' && req.method === 'GET') { json(res, 200, architecture(project)); return; }
        if (tool === 'backup' && req.method === 'GET') { sendZip(res, project.name + '-backup.zip', await exportProject(project)); return; }
        if (tool === 'staged' && req.method === 'GET') {
          const staged = await fs.readFile(path.join(project.output, '.falco-staged.json'), 'utf8').then(JSON.parse, error => {
            if (error.code !== 'ENOENT') throw error;
            return null;
          });
          json(res, 200, { staged }); return;
        }
        if (tool === 'restore-preview' && req.method === 'POST') {
          const data = await receiveJson(req);
          if (data.revision !== project.revision) throw new Error('Project changed. Reload before restoring.');
          const snapshot = await readVersion(project, data.versionId);
          const { diff } = restoreProposal(project, snapshot, data.full === true);
          json(res, 200, { diff, revision: project.revision }); return;
        }
        if (tool === 'remote-state' && req.method === 'GET') {
          if (!project.accountId) throw new Error('Project has no selected Cloudflare account.');
          json(res, 200, await inspectRemote(project, await sessionFor(project), remoteOptions)); return;
        }
        if (tool === 'remote-baseline' && req.method === 'POST') {
          const data = await receiveJson(req);
          if (data.confirmName !== project.name || data.acknowledge !== 'BASELINE') throw new Error('Confirm the exact Worker and BASELINE.');
          const state = await workspaceMutation(() => withProjectLock(project.output, async () => {
            if (!project.accountId || (await readProject(root, folder)).revision !== data.revision) throw new Error('Project changed. Reload and review the remote state again.');
            const remote = await inspectRemote(project, await sessionFor(project), remoteOptions);
            if (!remote.current || remote.fingerprint !== data.fingerprint) throw new Error('Cloudflare changed since review. Review the remote state again.');
            if (remote.current.versions.length !== 1 || remote.current.versions[0].percentage !== 100) {
              throw new Error('Finish the active Cloudflare traffic split before accepting a Factory baseline.');
            }
            if (remote.status !== 'clean') await saveRemote(project, { detail: remote.current, fingerprint: remote.fingerprint }, { fromFactory: false });
            return { status: 'clean', current: remote.current };
          }));
          json(res, 200, state); return;
        }
        if (tool === 'kv-revisions' && req.method === 'GET') {
          if (project.knowledgeMode !== 'kv') throw new Error('This Worker uses Embedded knowledge.');
          json(res, 200, await kvStatus(project)); return;
        }
        if (tool === 'usage' && req.method === 'POST') {
          const data = await receiveJson(req);
          if (typeof data.key !== 'string' || data.key.length < 32 || data.key.length > 1024 || /[\r\n]/.test(data.key)) throw new Error('Enter the Worker operations key.');
          const endpoint = await getWorkerFrontendEndpoint(project);
          const url = new URL(endpoint).origin;
          if (!validWorkerUrl(url)) throw new Error('Unable to verify Worker operations URL.');
          const response = await fetch(url + '/operations', { headers: { Authorization: 'Bearer ' + data.key },
            signal: AbortSignal.timeout(10000), redirect: 'error' });
          if (!response.ok) throw new Error('Worker usage unavailable (HTTP ' + response.status + '). Check the budget deployment and operations key.');
          json(res, 200, await response.json()); return;
        }
        if (tool === 'clone' && req.method === 'POST') {
          const data = await receiveJson(req);
          if (data.name === project.name) throw new Error('The clone must have a distinct Worker name.');
          const output = await workspaceMutation(async () => {
            const config = normalizeConfig({ name: data.name, business: data.business, origins: data.origins ?? project.origins,
              provider: project.provider, model: project.model, 'knowledge-mode': project.knowledgeMode,
              'rate-limit': String(project.rateLimit), 'mock-reply': project.mockReply }, root);
            Object.assign(config, { accountId: null, faq: project.faq, instructions: project.instructions,
              actions: project.actions, budget: project.budget, observability: project.observability, sections: project.sections });
            return generateProject(config);
          });
          json(res, 201, { name: data.name, output: output.config.output }); return;
        }
      }
      if (req.method === 'POST' && route === '/api/actions/validate') {
        const input = await receiveJson(req);
        const actions = normalizeClientActions(input.actions);
        let simulation = null;
        if (input.simulate && actions.length) {
          const action = { id: actions[0].id, params: Object.fromEntries(Object.entries(actions[0].parameters).map(([name, parameter]) => [name, parameter.enum[0]])) };
          const missingHandler = await createActionController(actions).dispatch(action);
          const withLocalHandler = await createActionController(actions, { [action.id]: () => true }).dispatch(action);
          simulation = { action, missingHandler, withLocalHandler };
        }
        json(res, 200, { actions, simulation }); return;
      }
      if (req.method === 'GET' && route === '/api/verticals') { json(res, 200, { verticals }); return; }
      if (req.method === 'GET' && route === '/api/operations') {
        json(res, 200, { operations: await operations(root, u.searchParams.get('name')) }); return;
      }
      if (req.method === 'POST' && route === '/api/provider-check') {
        const data = await receiveJson(req);
        if (data.authorize !== true) throw new Error('Confirm one bounded provider request.');
        const checked = await workspaceMutation(() => providerTest(data));
        json(res, 200, checked); return;
      }
      if (req.method === 'GET' && route === '/api/example/gallinas') {
        const base = path.join(root, 'examples/gallinas');
        const [faq, instructions] = await Promise.all([fs.readFile(path.join(base, 'faq.md'), 'utf8'), fs.readFile(path.join(base, 'instructions.md'), 'utf8')]);
        json(res, 200, { business: 'Gallinas y Valientes', name: 'falco-gallinas-studio', provider: 'mock', origin: 'http://localhost:3000', origins: ['http://localhost:3000'], knowledgeMode:'embedded', faq, instructions, actions: GALLINAS_ACTIONS });
        return;
      }
      if (req.method === 'POST' && route === '/api/preview') {
        const data = await receiveJson(req);
        const c = configFromForm(data, { root });
        if (data.sections !== undefined) Object.assign(c, compileSections(data.sections));
        const result = await generateProject({ ...c, dryRun: true, force: true });
        const effective = result.config ?? c;
        json(res, 200, { valid: true, name: c.name, business: c.business, output: c.output, files: result.files, localExists: Boolean(result.exists), forceRequired: Boolean(result.exists) && !c.force, provider: effective.provider, origin: effective.origin, origins: effective.origins, actions: effective.actions, knowledgeMode: effective.knowledgeMode, diff: result.diff });
        return;
      }
      if (req.method === 'POST' && route === '/api/jobs') {
        const data = await receiveJson(req);
        const selected = await workspaceMutation(async () => {
          if (managedOperations.has(data.mode)) {
            const project = await readProject(root, data.folder);
            if (data.revision !== project.revision) throw Object.assign(new Error('Project changed on disk. Reload before editing.'), { httpStatus: 409 });
            if (mustConfirmName.has(data.mode) && data.confirmName !== project.name) throw new Error('Type the exact Worker name to confirm.');
            if (data.mode === 'update') {
              const changes = data.sections === undefined ? data : { ...data, ...compileSections(data.sections) };
              const diff = previewChanges(project, changes);
              const sectionsChanged = data.sections !== undefined && JSON.stringify(changes.sections) !== JSON.stringify(project.sections);
              if (!diff.changed && !sectionsChanged) throw Object.assign(new Error('No changes found.'), { httpStatus: 409 });
            }
            if (['restore','restore-config'].includes(data.mode)) {
              restoreProposal(project, await readVersion(project, data.versionId), data.mode === 'restore-config');
              if (data.mode === 'restore-config' && data.acknowledge !== 'RESTORE CONFIG') throw new Error('Confirm RESTORE CONFIG after reviewing the configuration diff.');
            }
            if (data.mode === 'upgrade-runtime') await planRuntimeUpgrade(project);
            if (data.mode === 'enable-kv') await planKvMigration(project);
            if (['publish-kv','kv-rollback'].includes(data.mode) && project.knowledgeMode !== 'kv') throw new Error('This Worker uses Embedded knowledge.');
            if (data.mode === 'kv-rollback' && !Object.hasOwn(data,'expectedActive')) throw new Error('Review the active KV revision before rollback.');
            if (data.checkAction === true) {
              const actionProvider = data.mode === 'settings' ? settingsProposal(project, data).provider : project.provider;
              if (actionProvider === 'mock') throw new Error('Client Action proposal checks require Gemini or OpenAI; Mock only returns its fixed reply.');
              buildActionTest(project.actions, data.actionMessage);
            }
            if (data.mode === 'check-provider' && data.checkProvider !== true && data.checkAction !== true && project.provider !== 'mock') {
              throw new Error('Authorize one real provider request before running a live check.');
            }
            if (data.mode === 'settings' || data.mode === 'replace-secret') {
              const changes = data.mode === 'settings' ? settingsProposal(project, data) : project;
              if (data.mode === 'replace-secret' && changes.provider === 'mock') throw new Error('Mock uses no provider secret.');
              if (changes.provider !== 'mock' && (data.mode === 'replace-secret' || changes.provider !== project.provider || data.apiKey) && (!data.apiKey || data.precheck !== true)) {
                throw new Error('A replacement key and explicit provider preflight are required.');
              }
              if (changes.provider !== 'mock' && changes.model !== project.model && !data.apiKey && data.checkProvider !== true) {
                throw new Error('Changing the model with the saved credential requires authorizing one live provider request.');
              }
            }
            if (data.apiKey && !['settings','replace-secret'].includes(data.mode)) throw new Error('A provider key is not accepted for this operation.');
            const job = { id: randomUUID(), operation: data.mode, mode: 'deploy', status: 'queued',
              name: project.name, business: project.business, output: project.output, events: [], createdAt: new Date().toISOString() };
            return { job, start: signal => startManagedJob(job, data, signal), signal: startTrackedJob(job) };
          }
          const mode = data.mode === 'deploy' ? 'deploy' : data.mode === 'generate' ? 'generate' : null;
          if (!mode) throw new Error('Choose generate or deploy.');
          const c = configFromForm(data, { root, deployRequested: mode === 'deploy' });
          if (data.sections !== undefined) Object.assign(c, compileSections(data.sections));
          const apiKey = typeof data.apiKey === 'string' ? data.apiKey.trim() : '';
          if (mode === 'deploy' && c.provider !== 'mock' && !apiKey && !process.env.FALCO_PROVIDER_API_KEY) throw new Error('Enter the provider API key or set FALCO_PROVIDER_API_KEY.');
          if (apiKey.length > 1024 || /[\r\n\0]/.test(apiKey)) throw new Error('Invalid provider API key format.');
          const job = { id: randomUUID(), mode, status: 'queued', name: c.name, business: c.business, output: c.output, events: [], createdAt: new Date().toISOString() };
          return { job, start: signal => startJob(job, c, apiKey, signal), signal: startTrackedJob(job) };
        });
        await storeJob(selected.job);
        json(res, 202, { job: safeJob(selected.job) });
        const work = selected.start(selected.signal);
        runningOperation = work;
        void work.finally(() => { if (runningOperation === work) runningOperation = null; });
        return;
      }
      const jobGet = route.match(/^\/api\/jobs\/([0-9a-f-]{36})$/);
      if (req.method === 'GET' && jobGet) {
        const job = jobs.get(jobGet[1]) ?? (await operations(root, u.searchParams.get('name'))).find(record => record.id === jobGet[1]);
        if (!job) { json(res, 404, { error: 'Operation not found.' }); return; }
        json(res, 200, { job: safeJob(job) }); return;
      }
      const jobCancel = route.match(/^\/api\/jobs\/([0-9a-f-]{36})\/cancel$/);
      if (req.method === 'POST' && jobCancel) {
        const active = cancellation.get(jobCancel[1]);
        if (!active) { json(res, 409, { error: 'This operation already finished.' }); return; }
        active.abort();
        json(res, 202, { cancellationRequested: true }); return;
      }
      const chatPost = route.match(/^\/api\/jobs\/([0-9a-f-]{36})\/chat$/);
      const workerChat = route === '/api/cloudflare/workers/chat';
      if (req.method === 'POST' && (chatPost || workerChat)) {
        const request = await receiveJson(req);
        if (typeof request.message !== 'string' || request.message.trim().length < 1 || request.message.length > 2000) throw new Error('Enter a chat message of 1–2,000 characters.');
        let endpoint;
        if (workerChat) {
          if (!/^[a-f0-9]{32}$/i.test(request.accountId || '') || !/^falco-[a-z0-9-]{1,62}$/.test(request.name || '')) throw new Error('Select a valid Falco Worker and Cloudflare account.');
          const inventory = await cloudWorkers({ accountId: request.accountId });
          if (inventory.accountId.toLowerCase() !== request.accountId.toLowerCase() || !inventory.workers.some(worker => worker.name === request.name)) {
            json(res, 404, { error: 'Worker not found in the selected Cloudflare account. Refresh Workers.' }); return;
          }
          endpoint = await getWorkerFrontendEndpoint({ accountId: request.accountId, name: request.name });
          if (!validWorkerUrl(new URL(endpoint).origin) || new URL(endpoint).pathname !== '/chat') throw new Error('Unable to verify the deployed Worker chat URL.');
        } else {
          const job = jobs.get(chatPost[1]);
          if (!job?.url || !validWorkerUrl(job.url)) { json(res, 404, { error: 'No deployed Worker URL available for this job.' }); return; }
          endpoint = `${job.url}/chat`;
        }
        const response = await (runner.chatFetch || fetch)(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: request.message, history: [] }), redirect: 'error', signal: AbortSignal.timeout(16000) });
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
      if (req.method === 'GET' && STUDIO_ASSETS.has(route)) {
        const [file, type] = STUDIO_ASSETS.get(route);
        const content = await fs.readFile(path.join(UI_DIR, file));
        res.writeHead(200, { 'Content-Type': type,
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
  }), close: async () => {
    for (const control of cancellation.values()) control.abort();
    await Promise.all([runningOperation, new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))]);
  } };
}
