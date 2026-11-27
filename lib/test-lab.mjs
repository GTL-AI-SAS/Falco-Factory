import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { readProject } from './projects.mjs';
import { atomicJson, withProjectLock, assertNoPendingTransaction } from './project-files.mjs';
import { getCloudflareSession } from './cloudflare-auth.mjs';
import { readRemote, uuidPattern } from './remote-state.mjs';
import { DEFAULT_MODELS } from './args.mjs';
import { validateAuthProfile } from './cloudflare-auth.mjs';
import { protectedDirectory, regularPath, prepareTestSource, createTestWorkspace } from './test-lab-workspace.mjs';
import { createPreviewAdapter, previewUrl } from './preview-deploy.mjs';
import { TEST_ACTIONS, templateFields } from './test-lab-templates.mjs';
import { createToyApi, redactLab } from './test-lab-api.mjs';
import { validateAction, validateActionResult, plain, requestIdValid } from '../templates/worker/src/action-contract.mjs';

const states = ['preparing','ready','ending','cleanup_required','emergency'];
const conflict = message => Object.assign(Error(message),{httpStatus:409});
const now = () => new Date().toISOString();
export function validateSession(record, base, id) {
  if (!plain(record) || record.schema !== 1 || record.id !== id || !uuidPattern.test(id) ||
      !/^falco-[a-z0-9-]{1,62}$/.test(record.workerName ?? '') || !/^[a-f0-9]{32}$/i.test(record.accountId ?? '') ||
      !/^[a-z0-9-]{3,63}$/.test(record.folder ?? '') || typeof record.authProfile !== 'string' ||
      record.previewName !== 'falco-test-' + id.replaceAll('-','').slice(0,12) ||
      !['gemini','openai'].includes(record.provider) || !/^[\w.:-]{2,100}$/.test(record.model ?? '') ||
      !states.includes(record.state) || record.workspace !== path.join(base,id) ||
      !record.production?.fingerprint || typeof record.production.fingerprint !== 'string' ||
      !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt)) ||
      typeof record.sourceRevision !== 'string' || !plain(record.checksums) ||
      Object.keys(record).some(key => /secret|token|apiKey/i.test(key))) throw Error('Session metadata is corrupt or its identity is inconsistent.');
  if (record.previewUrl) previewUrl(record.previewUrl,record.workerName);
  validateAuthProfile(record.authProfile);
  return record;
}

export function createTestLab({ root, sessionReader = getCloudflareSession, remoteReader = readRemote,
  preview = createPreviewAdapter(), fetcher = fetch, env = process.env } = {}) {
  const home = path.join(root,'.falco-test-lab'), base = path.join(home,'sessions');
  const sessions = new Map(), privateState = new Map(), ending = new Set();
  let emergencies = [], loading, starting = false;
  const publicSession = m => ({ id:m.id, workerName:m.workerName, folder:m.folder, accountId:m.accountId, authProfile:m.authProfile,
    previewName:m.previewName, previewUrl:m.previewUrl, provider:m.provider, model:m.model, state:m.state,
    createdAt:m.createdAt, updatedAt:m.updatedAt, health:m.health ?? 'unchecked', reason:m.reason ?? '',
    ...(m.state === 'ready' ? {actions:TEST_ACTIONS} : {}) });
  async function directories() { await protectedDirectory(root,'.falco-test-lab'); await protectedDirectory(home,'sessions'); }
  async function persist(m) {
    await regularPath(root,path.relative(root,base),true);
    await regularPath(base,m.id,true);
    const file = path.join(m.workspace,'session.json');
    const exists = await fs.lstat(file).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
    if (exists) await regularPath(base,path.join(m.id,'session.json'));
    m.updatedAt = now();
    await atomicJson(file,m);
  }
  async function emergency(reason, m = {}) {
    const item = {reason,workerName:m.workerName ?? 'Unknown Worker',accountId:m.accountId ?? 'Unknown account',
      sessionId:m.id ?? null,previewName:m.previewName ?? null,createdAt:now(),
      action:'Stop production operations. Review the active deployment and settings in Cloudflare against your trusted baseline. Clean up any Preview separately. After manual integrity review, stop Studio and archive the emergency record in .falco-test-lab/emergencies.json; Studio never repairs production.'};
    if (!emergencies.some(e => e.reason === reason && e.workerName === item.workerName)) emergencies.push(item);
    if (m.id && sessions.has(m.id)) { m.state = 'emergency'; m.reason = reason; }
    try {
      await directories();
      const file = await fs.lstat(path.join(home,'emergencies.json')).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
      if (file) await regularPath(home,'emergencies.json');
      await atomicJson(path.join(home,'emergencies.json'),emergencies);
      if (m.id && sessions.has(m.id)) await persist(m);
    } catch {
      // Unsafe paths are never followed. Their uncertain state is detected again on startup.
      item.action += ' Emergency persistence failed; inspect filesystem permissions and symlinks before restarting.';
    }
    return item;
  }
  async function initialize() {
    if (loading) return loading;
    loading = (async () => {
      const found = await fs.lstat(home).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
      if (!found) return;
      try {
        await regularPath(root,'.falco-test-lab',true);
        const file = await fs.lstat(path.join(home,'emergencies.json')).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
        if (file) {
          await regularPath(home,'emergencies.json');
          const saved = JSON.parse(await fs.readFile(path.join(home,'emergencies.json'),'utf8'));
          if (!Array.isArray(saved) || saved.some(e => !plain(e) || typeof e.reason !== 'string' || typeof e.action !== 'string')) throw Error('Invalid emergency state.');
          emergencies = saved;
        }
        const entries = await fs.readdir(base,{withFileTypes:true}).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e));
        if (entries.length > 100) throw Error('Session recovery limit exceeded.');
        for (const entry of entries) {
          if (!uuidPattern.test(entry.name)) throw Error('Unrecognized session workspace.');
          await regularPath(base,entry.name,true);
          await regularPath(base,path.join(entry.name,'session.json'));
          const m = validateSession(JSON.parse(await fs.readFile(path.join(base,entry.name,'session.json'),'utf8')),base,entry.name);
          for (const temporary of await fs.readdir(m.workspace)) {
            if (/^[a-f0-9-]{36}\.secrets\.json$/.test(temporary) || temporary === 'wrangler.log') {
              await regularPath(base,path.join(m.id,temporary));
              await fs.rm(path.join(m.workspace,temporary));
            }
          }
          sessions.set(m.id,m);
          // No credentials survive restart. Recovery can only delete the orphaned Preview.
          if (m.state !== 'emergency') {
            m.state = 'cleanup_required'; m.reason = 'Studio stopped before confirmed cleanup. Delete this orphaned Preview before starting another test.';
            await persist(m);
          }
        }
      } catch {
        // Do not follow, rewrite or delete uncertain paths during recovery.
        emergencies.push({reason:'Unrecoverable Test Lab metadata or unsafe filesystem path.',workerName:'Unknown Worker',accountId:'Unknown account',
          action:'Stop Studio. Inspect .falco-test-lab, recover the exact Worker/account/Preview identities from trusted records, and remove orphaned Previews manually. Production must be reviewed before clearing this state.'});
      }
    })();
    return loading;
  }
  async function scan(project, fields = project) {
    const contaminated = templateFields(fields);
    if (contaminated.length) await emergency('Test Lab template marker found in production fields: ' + contaminated.join(', '),{...project,workerName:project.name});
    return contaminated.length === 0;
  }
  function blocked() { return starting || sessions.size > 0 || emergencies.length > 0; }
  function assertIdle() { if (blocked()) throw conflict('An active Test Lab, unfinished cleanup or emergency review blocks this operation.'); }
  async function cloudSession(m, signal) {
    const session = await sessionReader({accountId:m.accountId,authProfile:m.authProfile},{signal});
    if (session.accountId?.toLowerCase() !== m.accountId.toLowerCase() || (session.authProfile ?? '') !== m.authProfile) {
      await emergency('Session identity/account mismatch.',m);
      throw Error('EMERGENCY MODE: Cloudflare session identity mismatch.');
    }
    return session;
  }
  async function integrity(m, session) {
    const current = await remoteReader(session,m.workerName);
    if (!current || current.fingerprint !== m.production.fingerprint) {
      await emergency('Production deployment or settings changed unexpectedly during Test Lab.',m);
      throw Error('EMERGENCY MODE: Production fingerprint changed. Review Cloudflare manually.');
    }
  }
  async function validPersisted(m) {
    try {
      await regularPath(root,path.relative(root,base),true);
      await regularPath(base,path.join(m.id,'session.json'));
      const saved = validateSession(JSON.parse(await fs.readFile(path.join(m.workspace,'session.json'),'utf8')),base,m.id);
      if (['workerName','accountId','authProfile','previewName','previewId','workspace','folder'].some(key => saved[key] !== m[key])) throw Error('Identity changed.');
      if (JSON.stringify(saved.production) !== JSON.stringify(m.production)) throw Error('Baseline changed.');
      if (m.previewAttempted) {
        await regularPath(base,path.join(m.id,'worker/wrangler.json'));
        const config = JSON.parse(await fs.readFile(path.join(m.workspace,'worker/wrangler.json'),'utf8'));
        if (config.name !== m.workerName || config.account_id !== m.accountId || config.main !== 'src/test-lab-entry.mjs' ||
            Object.keys(config).some(key => !['name','account_id','main','compatibility_date','compatibility_flags','previews'].includes(key))) throw Error('Preview config identity changed.');
      }
      return saved;
    } catch {
      await emergency('Session metadata corruption or identity mismatch. Cleanup requires manual review.',m);
      throw Error('EMERGENCY MODE: Session metadata could not be validated.');
    }
  }
  async function remove(m, session) {
    await validPersisted(m);
    await preview.remove(m,session);
    m.previewDeleted = true;
    await persist(m);
    await integrity(m,session);
    await removeLocal(m);
  }
  async function removeLocal(m) {
    // Revalidate all descendants before recursive removal; never traverse a symlink.
    async function check(dir) {
      await regularPath(base,path.relative(base,dir),true);
      for (const item of await fs.readdir(dir,{withFileTypes:true})) {
        const target = path.join(dir,item.name);
        await regularPath(base,path.relative(base,target),item.isDirectory());
        if (item.isDirectory()) await check(target);
      }
    }
    try {await regularPath(root,path.relative(root,base),true);await check(m.workspace);}
    catch {throw Object.assign(Error('Unsafe session workspace. Manual security review is required before local cleanup.'),{emergency:true});}
    await fs.rm(m.workspace,{recursive:true});
    privateState.delete(m.id); sessions.delete(m.id);
  }
  async function requestPreview(m, state, route, payload, signal) {
    const started = Date.now();
    let response, body;
    try {
      response = await fetcher(new URL(route,m.previewUrl).href, {method:payload ? 'POST' : 'GET',
        headers:{Authorization:'Bearer ' + state.token,...(payload ? {'Content-Type':'application/json'} : {})},
        ...(payload ? {body:JSON.stringify(payload)} : {}), redirect:'error',
        signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000)});
      // Bound upstream bodies before parsing. No arbitrary response headers are forwarded.
      const reader = response.body.getReader(); let text = '', size = 0;
      try {
        const decoder = new TextDecoder();
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength; if (size > 32000) { await reader.cancel(); throw Error('Response too large.'); }
          text += decoder.decode(part.value,{stream:true});
        }
        body = JSON.parse(text);
      } finally { reader.releaseLock(); }
    } catch { throw Error('Authenticated Preview request failed or timed out.'); }
    if (!response.ok) throw Error('Preview request failed (HTTP ' + response.status + '). Review provider access, quota and Preview logs.');
    const metadata = {provider:m.provider,model:m.model,latencyMs:Date.now()-started,
      requestId:requestIdValid(response.headers.get('x-falco-request-id')) ? response.headers.get('x-falco-request-id') : null};
    if (route === '/health') {
      if (body.status !== 'ok' || body.service !== 'falco' || body.business !== 'Falco Test Lab') throw Error('Preview health contract failed.');
      return {status:'ok'};
    }
    if (typeof body.reply !== 'string' || !body.reply.trim() || body.reply.length > 4000 ||
        (body.action && (!validateAction(body.action,TEST_ACTIONS) || !requestIdValid(body.actionRequestId)))) throw Error('Preview chat contract failed.');
    return redactLab({reply:body.reply,...(body.action ? {action:validateAction(body.action,TEST_ACTIONS),actionRequestId:body.actionRequestId} : {}),metadata},state.secrets);
  }
  async function start(input, {signal,logger = () => {}} = {}) {
    await initialize(); assertIdle(); starting = true;
    let m, session;
    try {
      if (!plain(input) || !/^[a-z0-9-]{3,63}$/.test(input.folder ?? '')) throw Error('Select a managed project.');
      await regularPath(root,path.join('.generated',input.folder),true);
      const project = await readProject(root,input.folder);
      return await withProjectLock(project.output,async () => {
        if (project.name === 'falco-test-lab') throw Error('The legacy falco-test-lab Worker is excluded from Test Lab.');
        if (!/^[a-f0-9]{32}$/i.test(project.accountId) || input.revision !== project.revision) throw Error('Reload the verified Worker and account before starting Test Lab.');
        if (!await scan(project)) throw Error('EMERGENCY MODE: Test templates found in managed content.');
        await assertNoPendingTransaction(project.output);
        const provider = input.provider ?? project.provider;
        if (!['gemini','openai'].includes(provider)) throw Error('Choose Gemini or OpenAI for real action proposals.');
        const model = input.model ?? (provider === project.provider ? project.model : DEFAULT_MODELS[provider]);
        if (!/^[\w.:-]{2,100}$/.test(model ?? '')) throw Error('Invalid provider model.');
        const apiKey = env.FALCO_TEST_LAB_API_KEY || input.apiKey;
        if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 1024 || /[\r\n\0]/.test(apiKey)) throw Error('Provide a dedicated Test Lab API key or FALCO_TEST_LAB_API_KEY.');
        logger('preflight','Checking the selected source and production fingerprint.');
        const prepared = await prepareTestSource(project);
        const id = randomUUID();
        const identity = {accountId:project.accountId,authProfile:project.authProfile ?? '',workerName:project.name};
        session = await cloudSession(identity,signal);
        const production = await remoteReader(session,project.name);
        if (!production || production.detail?.versions?.length !== 1 || production.detail.versions[0].percentage !== 100) throw Error('A verified existing Worker with one fully active production version is required.');
        await preview.routing(identity,session);
        await directories();
        const workspace = await protectedDirectory(base,id);
        m = {schema:1,id,...identity,folder:project.folder,previewName:'falco-test-' + id.replaceAll('-','').slice(0,12),
          previewUrl:null,provider,model,createdAt:now(),updatedAt:now(),state:'preparing',production:{detail:production.detail,fingerprint:production.fingerprint},
          sourceRevision:project.revision,checksums:prepared.checksums,workspace};
        sessions.set(id,m); await persist(m);
        const token = randomBytes(32).toString('hex');
        const state = {token,secrets:[token,apiKey],busy:false,control:null,toy:createToyApi(workspace,{secrets:[token,apiKey]})};
        privateState.set(id,state);
        await createTestWorkspace(workspace,project,provider,model,prepared);
        await preview.assertAvailable(m,session);
        logger('cloudflare','Creating an isolated Worker Preview. Production is not deployed.');
        // Persist uncertainty BEFORE the remote call; crash recovery always attempts exact Preview cleanup.
        m.previewAttempted = true; await persist(m);
        Object.assign(m,await preview.create(m,signal)); await persist(m);
        await preview.secrets(m,token,apiKey,signal);
        m.deploymentId = await preview.verify(m,session);
        await integrity(m,session);
        logger('verify','Verifying authenticated health and one real provider request.');
        await requestPreview(m,state,'/health',null,signal);
        await requestPreview(m,state,'/chat',{message:'Identify yourself briefly as Falco Test Lab.',history:[],actionProtocol:2},signal);
        await integrity(m,session);
        m.state = 'ready'; m.health = 'verified'; await persist(m);
        return publicSession(m);
      });
    } catch (error) {
      if (m) {
        const wasEmergency = m.state === 'emergency';
        try {
          if (m.previewAttempted) await remove(m,session ?? await cloudSession(m));
          else await removeLocal(m);
        } catch (cleanupError) {
          if (cleanupError.emergency) await emergency(cleanupError.message,m);
          if (m.state !== 'emergency') { m.state = 'cleanup_required'; m.reason = 'Preview creation failed and cleanup is unconfirmed. Retry cleanup.'; await persist(m); }
        }
        if (wasEmergency) throw Error('EMERGENCY MODE: Production integrity requires manual review.');
      }
      // Validation errors are local and never include subprocess/upstream content.
      throw error;
    } finally { starting = false; }
  }
  function get(id) {
    if (!uuidPattern.test(id ?? '')) throw Error('Invalid session ID.');
    const m = sessions.get(id); if (!m) throw Object.assign(Error('Test Lab session not found.'),{httpStatus:404});
    return m;
  }
  async function live(id, work) {
    await initialize(); const m = get(id), state = privateState.get(id);
    if (m.state !== 'ready' || ending.has(id) || !state || emergencies.length) throw conflict('Session is unavailable. Review emergency state or retry cleanup.');
    if (state.busy) throw conflict('Wait for the current Test Lab request.');
    state.busy = true; state.control = new AbortController();
    const promise = (async () => { await validPersisted(m); return work(m,state,state.control.signal); })();
    state.pending = promise;
    try { return await promise; } finally {state.busy=false;state.control=null;state.pending=null;}
  }
  async function chat(id,input) {
    return live(id,async (m,state,signal) => {
      if (!plain(input) || Object.keys(input).some(k => !['message','history','actionResult'].includes(k)) ||
          typeof input.message !== 'string' || !input.message.trim() || input.message.length > 2000 ||
          (input.history !== undefined && (!Array.isArray(input.history) || input.history.length > 8 || input.history.some(h =>
            !plain(h) || !['user','assistant'].includes(h.role) || typeof h.content !== 'string' || !h.content.trim() || h.content.length > 1000))) ||
          (input.actionResult !== undefined && !validateActionResult(input.actionResult,TEST_ACTIONS))) throw Error('Invalid Test Lab chat request.');
      return requestPreview(m,state,'/chat',{message:input.message,history:input.history ?? [],actionProtocol:2,
        ...(input.actionResult ? {actionResult:validateActionResult(input.actionResult,TEST_ACTIONS)} : {})},signal);
    });
  }
  async function end(id,{logger = () => {}} = {}) {
    await initialize(); const m = get(id), state = privateState.get(id);
    if (['preparing','ending'].includes(m.state) || ending.has(id)) throw conflict('Session creation or cleanup is already running.');
    ending.add(id);
    try {
      await validPersisted(m);
      m.state = 'ending'; await persist(m);
      state?.control?.abort(); await state?.pending?.catch(() => {});
      try {
        const session = await cloudSession(m);
        logger('cloudflare','Deleting only the exact session Preview and confirming its absence.');
        await withProjectLock(path.join(root,'.generated',m.folder),() => remove(m,session),{testLab:true});
        logger('verify','Preview cleanup confirmed; production fingerprint unchanged.');
        return {ended:true};
      } catch (error) {
        if (error.emergency) await emergency(error.message,m);
        if (m.state !== 'emergency') {m.state='cleanup_required';m.reason='Preview deletion or production verification is unconfirmed. Keep this workspace and retry cleanup.';await persist(m);}
        throw error;
      }
    } finally {ending.delete(id);}
  }
  return { initialize, start, end, chat, scan, emergency, assertIdle, get busy() {return blocked();},
    async checkRouting(project) {
      await initialize();
      const identity = {workerName:project.name,accountId:project.accountId,authProfile:project.authProfile ?? ''};
      return preview.routing(identity,await cloudSession(identity));
    },
    async status() {await initialize();return {sessions:[...sessions.values()].map(publicSession),emergencies,hasEnvironmentKey:Boolean(env.FALCO_TEST_LAB_API_KEY)};},
    async state(id) {await initialize();return publicSession(get(id));},
    async inspector(id) {
      await initialize(); const m = get(id);
      if (privateState.has(id)) return privateState.get(id).toy.records();
      const file = path.join(m.workspace,'api-calls.jsonl');
      if (!await fs.lstat(file).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e))) return [];
      await regularPath(base,path.join(id,'api-calls.jsonl'));
      if ((await fs.stat(file)).size > 4000000) throw Error('Inspector log exceeds its safe recovery limit.');
      return redactLab((await fs.readFile(file,'utf8')).trim().split('\n').filter(Boolean).slice(-200).map(line => JSON.parse(line)));
    },
    async toy(id,input) {return live(id,async (m,state) => state.toy.request(input));}
  };
}
