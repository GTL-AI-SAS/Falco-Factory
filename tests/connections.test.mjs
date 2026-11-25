import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createConnectionManager, bindAuthProfile, getCloudflareSession, getCloudflareAuthDiagnostics,
  listAuthProfiles, parseAuthProfiles, runWrangler, validateAuthProfile } from '../lib/cloudflare-auth.mjs';
import { runProcess, deploy } from '../lib/deploy.mjs';
import { discoverCloudflareWorkers, mergeRemoteWithLocal } from '../lib/cloudflare-workers.mjs';
import { deleteCloudflareFalco } from '../lib/worker-lifecycle.mjs';
import { getDeployedOrigins } from '../lib/worker-origins.mjs';
import { getDeployedClientActions } from '../lib/worker-actions.mjs';
import { ensureKvNamespace, publishKv, verifiedKnowledge } from '../lib/knowledge-kv.mjs';
import { assignProjectConnection } from '../lib/project-connection.mjs';
import { normalizeConfig } from '../lib/args.mjs';
import { generate } from '../lib/generate.mjs';
import { readProject, asGenerateConfig, importLocalProject } from '../lib/projects.mjs';
import { createUiServer, configFromForm } from '../lib/ui-server.mjs';
import { persistedJob } from '../lib/operation-history.mjs';
import { saveRemote } from '../lib/remote-state.mjs';
import { stageDeployment, publishVersion, replaceProviderSecret } from '../lib/management.mjs';

const A = 'a'.repeat(32), B = 'b'.repeat(32), KV = 'c'.repeat(32);
const version = '11111111-1111-1111-1111-111111111111';
const remote = { fingerprint: 'remote', detail: { deployment: version, versions: [{ id: version, percentage: 100 }] } };
const table = profiles => '│ Profile │ Bound Directories │\n' + ['default', ...profiles].map(p => `│ ${p} │ - │`).join('\n');
const ok = data => ({ code: 0, stdout: typeof data === 'string' ? data : JSON.stringify(data), stderr: '' });
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'falco-connections-'));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
function fixture({ profiles = ['team-a','team-b'], secure = true } = {}) {
  const names = new Set(profiles), bindings = new Map(), calls = [];
  const wrangler = async (args, options = {}) => {
    calls.push({ args, options });
    const profile = options.env?.CLOUDFLARE_AUTH_PROFILE || bindings.get(options.cwd) || 'default';
    if (args[0] === 'auth' && args[1] === 'list') return ok(table([...names]));
    if (args[0] === 'auth' && args[1] === 'activate') { assert.ok(names.has(args[2])); bindings.set(args[3], args[2]); return ok('Bound'); }
    if (args[0] === 'auth' && args[1] === 'create') { names.add(args[2]); return ok('Created'); }
    if (args[0] === 'auth' && args[1] === 'delete') { names.delete(args[2]); return ok('Deleted'); }
    if (args[0] === 'whoami' && args.includes('--json')) return ok({ email: profile + '@example.com', accounts: [{ id: profile === 'team-b' ? B : A, name: profile }] });
    if (args[0] === 'whoami') return ok(secure ? 'Encrypted file (profile.enc) with key in Windows Credential Manager' : 'Credentials are stored in: profile.toml');
    if (args[0] === 'auth' && args[1] === 'token') return ok({ type: 'oauth', token: 'SECRET_FOR_' + profile });
    throw new Error('Unexpected command: ' + args[0]);
  };
  return { wrangler, names, bindings, calls };
}
async function project(root, name, authProfile = '', accountId = A, knowledgeMode = 'embedded') {
  const config = normalizeConfig({ name, business: 'Connection test', 'account-id': accountId,
    'auth-profile': authProfile, 'knowledge-mode': knowledgeMode }, root);
  config.faq = 'Public FAQ'; config.instructions = 'Public instructions'; await generate(config);
  return readProject(root, name);
}

test('official profile list adapter enumerates multiple profiles and fails closed on schema drift', () => {
  assert.deepEqual(parseAuthProfiles(table(['team-a','Personal_2'])), ['team-a','Personal_2']);
  assert.deepEqual(parseAuthProfiles('No profiles found. Run `wrangler login` to get started.'), []);
  assert.throws(() => parseAuthProfiles('{"profiles":[]}'), /format changed/);
  for (const value of ['../secret','C:\\temp','--profile','default','staging','__proto__',null]) {
    assert.throws(() => validateAuthProfile(value));
  }
});

test('connection create, reauthenticate, bind, list and delete use official commands and only save non-secret metadata', async t => {
  const root = await temporary(t), authHome = path.join(root, 'auth'); const f = fixture();
  const manager = createConnectionManager({ root, authHome, wrangler: f.wrangler, env: {},
    diagnostics: options => getCloudflareAuthDiagnostics({ ...options, cloudflareGet: async () => ({ found: true, result: [] }) }) });
  await manager.authenticate({ authProfile: 'team-a', name: 'Production' });
  await manager.authenticate({ authProfile: 'team-a', name: 'Production' });
  const items = await manager.list(); assert.equal(items.find(x => x.authProfile === 'team-a').name, 'Production');
  assert.equal(f.calls.filter(c => c.args.join(' ') === 'auth create team-a').length, 2);
  assert.ok(f.calls.filter(c => c.args[1] === 'create').every(c => c.options.env.CLOUDFLARE_AUTH_USE_KEYRING === 'true'));
  await manager.delete('team-a');
  assert.ok(!f.names.has('team-a')); assert.ok(f.names.has('team-b'));
  assert.ok(!f.calls.some(c => ['logout','delete'].includes(c.args[0])));
  const metadata = await fs.readFile(path.join(root, '.falco-connections.json'), 'utf8');
  assert.doesNotMatch(metadata, /SECRET_FOR_|token|refresh_token|access_token/);
});

test('simultaneous profile sessions inspect whoami and auth token from different stable bound directories', async t => {
  const root = await temporary(t), f = fixture(), options = { authHome: root, env: { CLOUDFLARE_AUTH_PROFILE: 'wrong-profile' }, wrangler: f.wrangler };
  const [a, b] = await Promise.all([
    getCloudflareSession({ accountId: A, authProfile: 'team-a' }, options),
    getCloudflareSession({ accountId: B, authProfile: 'team-b' }, options)
  ]);
  assert.equal(a.token, 'SECRET_FOR_team-a'); assert.equal(b.token, 'SECRET_FOR_team-b');
  for (const call of f.calls.filter(c => c.args[0] === 'whoami' || c.args[1] === 'token')) {
    assert.ok(!call.args.includes('--profile')); assert.ok(call.options.cwd.startsWith(path.join(root, 'contexts')));
    assert.equal(call.options.env.CLOUDFLARE_AUTH_USE_KEYRING, 'true'); assert.ok(['team-a','team-b'].includes(call.options.env.CLOUDFLARE_AUTH_PROFILE));
  }
  assert.notEqual(f.calls.find(c => c.args[2] === 'team-a').args[3], f.calls.find(c => c.args[2] === 'team-b').args[3]);
});

test('profile mismatch, missing profile, missing explicit account and insecure storage fail without a default fallback', async t => {
  const root = await temporary(t), f = fixture(), options = { authHome: root, env: {}, wrangler: f.wrangler };
  await assert.rejects(getCloudflareSession({ accountId: B, authProfile: 'team-a' }, options), /not accessible/);
  await assert.rejects(getCloudflareSession({ accountId: A, authProfile: 'missing' }, options), /profile unavailable/);
  await assert.rejects(getCloudflareSession({ authProfile: 'team-a' }, options), /explicit/);
  const plain = fixture({ secure: false });
  await assert.rejects(getCloudflareSession({ accountId: A, authProfile: 'team-a' }, { ...options, wrangler: plain.wrangler }), /Secure storage/);
  assert.ok(!f.calls.some(c => c.args.includes('logout') || c.args.includes('login')));
});

test('inspection remains pinned if bindings disappear, and inherited default account IDs do not contaminate a named connection', async t => {
  const root = await temporary(t), f = fixture();
  const wrangler = async (args, options) => {
    const result = await f.wrangler(args,options);
    if (args[0] === 'whoami') f.bindings.clear();
    return result;
  };
  const session = await getCloudflareSession({authProfile:'team-b',accountId:B},{authHome:root,wrangler,env:{CLOUDFLARE_ACCOUNT_ID:A}});
  assert.equal(session.token,'SECRET_FOR_team-b');
  const status = await getCloudflareAuthDiagnostics({authProfile:'team-b',authHome:root,wrangler,env:{CLOUDFLARE_ACCOUNT_ID:A},cloudflareGet:async () => ({found:true,result:[]})});
  assert.equal(status.selectedAccount,B); assert.equal(status.status,'connected');
});

test('credential deletion cannot race authentication in another Factory process context', async t => {
  const root = await temporary(t), f = fixture(); let start, finish;
  const started = new Promise(resolve => {start=resolve;}), gate = new Promise(resolve => {finish=resolve;});
  const wrangler = async (args,options) => { if (args[1] === 'create') {start();await gate;} return f.wrangler(args,options); };
  const settings = {root,authHome:path.join(root,'auth'),wrangler,env:{},diagnostics:options => getCloudflareAuthDiagnostics({...options,cloudflareGet:async () => ({found:true,result:[]})})};
  const first = createConnectionManager(settings), second = createConnectionManager(settings);
  const authentication = first.authenticate({authProfile:'team-a',name:'A'}); await started;
  try { await assert.rejects(second.delete('team-a'),/locked/); assert.ok(f.names.has('team-a')); }
  finally {finish();await authentication;}
});

test('environment API Token precedence blocks named profiles while legacy API Token sessions remain supported', async t => {
  const root = await temporary(t), f = fixture();
  for (const key of ['CLOUDFLARE_API_TOKEN','CF_API_TOKEN','CLOUDFLARE_API_KEY','CF_API_KEY']) {
    await assert.rejects(getCloudflareSession({ accountId: A, authProfile: 'team-a' }, { authHome: root, wrangler: f.wrangler, env: { [key]: 'PRIVATE_ENV_TOKEN' } }), /override/);
  }
  assert.equal(f.calls.length, 0);
  await assert.rejects(getCloudflareSession({accountId:A,authProfile:'team-a'}, {authHome:root,wrangler:f.wrangler,env:{CLOUDFLARE_API_HEADERS:JSON.stringify({Authorization:'Bearer PRIVATE'})}}), /override/);
  const legacy = await getCloudflareSession({ accountId: A }, { env: { CLOUDFLARE_API_TOKEN: 'legacy' }, wrangler: async args =>
    args[0] === 'whoami' ? ok({ accounts: [{ id: A }] }) : ok({ type: 'api_token', token: 'legacy' }) });
  assert.deepEqual(legacy, { accountId: A, token: 'legacy' });
});

test('named diagnostics are safe and account mismatch does not probe an unrelated account', async t => {
  const root = await temporary(t), f = fixture(); let probes = 0;
  const status = await getCloudflareAuthDiagnostics({ accountId: B, authProfile: 'team-a', authHome: root, env: {}, wrangler: f.wrangler,
    cloudflareGet: async () => { probes++; return { found: true }; } });
  assert.equal(status.status, 'account-access-denied'); assert.equal(status.factoryCompatible, false); assert.equal(probes, 0);
  assert.equal(status.permissions.deployWrite.status, 'not_tested'); assert.equal(status.permissions.kvWrite.status, 'not_tested');
  assert.doesNotMatch(JSON.stringify(status), /SECRET_FOR_|profile\.enc/);
  const overridden = await getCloudflareAuthDiagnostics({ authProfile: 'team-a', authHome: root, env: { CLOUDFLARE_API_TOKEN: 'PRIVATE' }, wrangler: f.wrangler });
  assert.equal(overridden.status, 'environment-override'); assert.doesNotMatch(JSON.stringify(overridden), /PRIVATE/);
});

test('secure-storage backend failures are distinct from expired authentication and never return raw output', async () => {
  const result = await getCloudflareAuthDiagnostics({ wrangler:async () => ({code:1,stdout:'',stderr:'OS keychain backend unavailable; SECRET_DETAIL'}),env:{} });
  assert.equal(result.status,'secure-storage-unavailable'); assert.equal(result.connected,false);
  assert.doesNotMatch(JSON.stringify(result),/SECRET_DETAIL/);
});

test('named project forms require an explicitly selected account even when the launcher inherits a default account', () => {
  assert.throws(() => configFromForm({name:'falco-explicit',business:'Explicit account',authProfile:'team-a'}), /explicit/);
});

test('reauthentication preserves the user-defined default account', async t => {
  const root = await temporary(t), f = fixture(), authHome = path.join(root,'auth');
  const manager = createConnectionManager({ root,authHome,wrangler:f.wrangler,env:{},diagnostics: options =>
    getCloudflareAuthDiagnostics({...options,cloudflareGet:async () => ({found:true,result:[]})}) });
  await manager.save({authProfile:'team-a',name:'Team A',defaultAccountId:A});
  await manager.authenticate({authProfile:'team-a',name:'Team A'});
  assert.equal((await manager.list()).find(c => c.authProfile === 'team-a').defaultAccountId,A);
});

test('production process adapter uses explicit profile argv, per-child keyring environment and refuses project environment overrides', async t => {
  const cwd = await temporary(t), calls = [], env = { CLOUDFLARE_AUTH_PROFILE: 'wrong', CLOUDFLARE_AUTH_USE_KEYRING: 'false' };
  const processRunner = async (args, options) => { calls.push({ args, options }); return ok(''); };
  await Promise.all(['team-a','team-b'].map(authProfile => runWrangler(['deploy'], { cwd, authProfile, env, processRunner })));
  assert.deepEqual(calls.map(c => c.args).sort((a,b) => a[2].localeCompare(b[2])), [['deploy','--profile','team-a'], ['deploy','--profile','team-b']]);
  assert.ok(calls.every(c => c.options.env.CLOUDFLARE_AUTH_USE_KEYRING === 'true'));
  assert.equal(env.CLOUDFLARE_AUTH_USE_KEYRING, 'false');
  await runWrangler(['whoami','--json'], { cwd, env, processRunner });
  assert.equal(calls.at(-1).options.env.CLOUDFLARE_AUTH_PROFILE, 'default'); assert.ok(!calls.at(-1).args.includes('--profile'));
  await fs.writeFile(path.join(cwd, '.env'), 'CLOUDFLARE_API_TOKEN=FILE_SECRET');
  await assert.rejects(runWrangler(['deploy'], { cwd, authProfile: 'team-a', env: {}, processRunner }), /override/);
});

test('real child processes keep profile contexts and credentials isolated concurrently', async t => {
  const root = await temporary(t), script = path.join(root, 'fixture.mjs');
  await fs.writeFile(script, `import fs from 'node:fs/promises';
    const a=process.argv.slice(2); const out=x=>console.log(typeof x==='string'?x:JSON.stringify(x));
    if(a[0]==='auth'&&a[1]==='list')out(${JSON.stringify(table(['team-a','team-b']))});
    else if(a[1]==='activate'){await fs.writeFile('.fixture-profile',a[2]);out('bound');}
    else{const p=await fs.readFile('.fixture-profile','utf8');
      if(a[0]==='whoami'&&a.includes('--json'))out({accounts:[{id:(p==='team-a'?'a':'b').repeat(32)}]});
      else if(a[0]==='whoami')out('Encrypted file (profile.enc) with key in Windows Credential Manager');
      else out({type:'oauth',token:'child-secret-'+p});}`);
  const wrangler = (args, options) => runProcess(process.execPath, [script, ...args], { ...options, env: { ...process.env, ...options.env } });
  const sessions = await Promise.all(['team-a','team-b'].map((authProfile, i) => getCloudflareSession({ authProfile, accountId: i ? B : A }, { authHome: path.join(root, 'auth'), wrangler, env: {} })));
  assert.deepEqual(sessions.map(s => s.token), ['child-secret-team-a','child-secret-team-b']);
});

test('project generation, reload, regeneration, and import preserve profile metadata without extending Wrangler schema', async t => {
  const root = await temporary(t), p = await project(root, 'falco-profile', 'team-a');
  assert.equal(p.authProfile, 'team-a'); assert.equal(p.accountId, A);
  const config = JSON.parse(await fs.readFile(path.join(p.output,'wrangler.json'), 'utf8'));
  assert.equal(config.authProfile, undefined);
  await generate(asGenerateConfig(root, p)); assert.equal((await readProject(root, p.folder)).authProfile, 'team-a');
  await assert.rejects(generate({ ...asGenerateConfig(root,p),authProfile:'team-b' }), /cannot change a project connection/);
  const otherRoot = await temporary(t);
  const imported = await importLocalProject(otherRoot, p.output, { expectedAccountId: A, expectedName: p.name });
  assert.equal(imported.authProfile, 'team-a');
});

test('changing a connection verifies the new identity and preserves account; retargeting refuses an occupied account', async t => {
  const root = await temporary(t), p = await project(root, 'falco-retarget', 'team-a'); let calls = [];
  const sessionProvider = async c => { calls.push(c); return { accountId: c.accountId, authProfile: c.authProfile, token: 'PRIVATE' }; };
  let next = await assignProjectConnection(root, p.folder, { revision: p.revision, authProfile: 'team-b', accountId: A }, { sessionProvider });
  assert.equal(next.authProfile, 'team-b'); assert.equal(next.accountId, A); assert.equal(calls[0].authProfile, 'team-b');
  const input = { revision: next.revision, authProfile: 'team-b', accountId: B, confirmName: p.name, acknowledge: 'RETARGET' };
  await assert.rejects(assignProjectConnection(root, p.folder, input, { sessionProvider, remoteReader: async () => remote }), /already exists/);
  assert.equal((await readProject(root, p.folder)).accountId, A);
  next = await assignProjectConnection(root, p.folder, input, { sessionProvider, remoteReader: async () => null });
  assert.equal(next.accountId, B); assert.equal(next.authProfile, 'team-b');
  assert.doesNotMatch(await fs.readFile(path.join(next.output,'.falco-generated.json'),'utf8'), /PRIVATE|token/);
});

test('deployments and KV provisioning route project A and project B independently', async t => {
  const root = await temporary(t), projects = await Promise.all([project(root,'falco-routing-a','team-a',A), project(root,'falco-routing-b','team-b',B)]);
  const calls = [], deployed = new Set();
  await Promise.all(projects.map(p => deploy(p, {
    sessionReader: async c => ({ accountId: c.accountId, token: c.authProfile }),
    remoteReader: async (session, name) => deployed.has(name) ? remote : null,
    wrangler: async (args, options) => { calls.push({ args, options }); deployed.add(path.basename(options.cwd)); return ok(`https://${path.basename(options.cwd)}.demo.workers.dev\nCurrent Version ID: ${version}`); }
  })));
  assert.deepEqual(new Set(calls.map(c => c.options.authProfile)), new Set(['team-a','team-b']));
  for (const p of projects) {
    await ensureKvNamespace(p, { wrangler: async (args, options) => { assert.equal(options.authProfile, p.authProfile); assert.equal(options.accountId, p.accountId); return ok({ id: KV }); } });
  }
});

test('Worker listing, deletion, frontend bindings, and KV publishing use the exact profile and account', async t => {
  const root = await temporary(t), p = await project(root,'falco-kv-routing','team-b',B,'kv'); const seen = [];
  const sessionProvider = async c => { seen.push(c); return { accountId: c.accountId, token: 'PRIVATE' }; };
  await discoverCloudflareWorkers({ accountId: B, authProfile: 'team-b', sessionProvider, cloudflareGet: async () => ({ found: true, result: [{ id: p.name }] }) });
  await deleteCloudflareFalco({ accountId: B, name: p.name, authProfile: 'team-b', sessionProvider, cloudflareGet: async () => ({ found: true }), cloudflareFetch: async () => Response.json({ success: true }) });
  const get = async () => ({ found: true, result: { bindings: [{ name: 'ALLOWED_ORIGIN',type:'plain_text',text:'https://example.com' }] } });
  await getDeployedOrigins({ accountId: B, name: p.name, authProfile: 'team-b', sessionProvider, cloudflareGet: get });
  await getDeployedClientActions({ accountId: B, name: p.name, authProfile: 'team-b', sessionProvider, cloudflareGet: get });
  assert.ok(seen.every(c => c.accountId === B && c.authProfile === 'team-b'));
  const configFile = path.join(p.output, 'wrangler.json'), config = JSON.parse(await fs.readFile(configFile,'utf8'));
  config.kv_namespaces = [{ binding: 'FALCO_KNOWLEDGE', id: KV }]; await fs.writeFile(configFile, JSON.stringify(config));
  const values = new Map();
  await publishKv(p, { pause: async () => {}, wrangler: async (args, options) => {
    assert.equal(options.authProfile, 'team-b'); assert.equal(options.accountId, B);
    const key = args[3];
    if (args[2] === 'get') return ok(values.has(key) ? JSON.stringify(values.get(key)) : 'Value not found');
    if (args[2] === 'put') values.set(key, verifiedKnowledge(JSON.parse(await fs.readFile(args[args.indexOf('--path') + 1], 'utf8'))));
    return ok('');
  } });
  assert.ok(values.has('knowledge:active'));
  const rows = mergeRemoteWithLocal([{ name: p.name }], [p], B, 'team-a'); assert.equal(rows[0].editable, false);
});

async function server(t, runner = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'falco-connection-server-')), app = createUiServer({ root, port: 0, runner }); const url = await app.listen();
  t.after(async () => { await app.close(); await fs.rm(root, { recursive:true,force:true }); }); const boot = await (await fetch(url + '/api/bootstrap')).json();
  const post = async (route, data, authenticated = true) => {
    const r = await fetch(url + route, { method:'POST', headers: { 'Content-Type':'application/json', ...(authenticated ? { 'X-Falco-Local-Token': boot.token } : {}) }, body: JSON.stringify(data) });
    return { status: r.status, data: await r.json() };
  };
  return { root, app, url, post };
}

test('Studio authenticates asynchronously, rejects unauthenticated operations, supports cancellation, and never returns raw credential output', async t => {
  let started = false, cancelled = false;
  const e = await server(t, { connections: { list: async () => [], authenticate: async ({ signal }) => {
    started = true; await new Promise(resolve => signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }));
    throw new Error('RAW_ACCESS_TOKEN_DO_NOT_RETURN');
  } } });
  assert.equal((await e.post('/api/connections/authenticate',{ authProfile:'team-a', name:'A' }, false)).status,403);
  assert.equal((await e.post('/api/connections/authenticate',{ authProfile:'../arbitrary-path' })).status,400);
  const start = await e.post('/api/connections/authenticate',{ authProfile:'team-a',name:'A' });
  assert.equal(start.status,202); assert.equal(started,true);
  assert.equal((await e.post('/api/connections/authenticate',{ authProfile:'team-b' })).status,409);
  await e.post('/api/connections/cancel',{}); assert.equal(cancelled,true);
  const status = await (await fetch(e.url + '/api/connections/operation')).json();
  assert.equal(status.operation.status,'cancelled'); assert.doesNotMatch(JSON.stringify(status),/RAW_ACCESS_TOKEN/);
});

test('Studio deletion requires an up-to-date assigned-project warning and never removes local projects or remote resources', async t => {
  const deleted = []; const e = await server(t, { connections: { list: async () => [], delete: async p => deleted.push(p) } });
  const p = await project(e.root,'falco-delete-profile','team-a');
  const input = { authProfile:'team-a',confirmation:'team-a',acknowledge:'DELETE CONNECTION',projects:[] };
  assert.equal((await e.post('/api/connections/delete',input)).status,400); assert.equal(deleted.length,0);
  input.projects = [p.name]; assert.equal((await e.post('/api/connections/delete',input)).status,200);
  assert.deepEqual(deleted,['team-a']); assert.equal((await readProject(e.root,p.folder)).authProfile,'team-a');
});

test('reauthentication reports account access lost by assigned projects and retains their assignments', async t => {
  const e = await server(t,{connections:{authenticate:async () => ({accounts:[{id:B,name:'Different account'}]})}});
  const p = await project(e.root,'falco-access-lost','team-a',A);
  assert.equal((await e.post('/api/connections/authenticate',{authProfile:'team-a'})).status,202);
  let operation;
  for (let i=0;i<100;i++) {
    ({operation}=await (await fetch(e.url+'/api/connections/operation')).json());
    if (operation.status !== 'working') break;
    await new Promise(resolve => setTimeout(resolve,5));
  }
  assert.equal(operation.status,'connected'); assert.match(operation.message,/Account access is missing for: falco-access-lost/);
  const retained = await readProject(e.root,p.folder);assert.equal(retained.authProfile,'team-a');assert.equal(retained.accountId,A);
});

test('Studio carries the remote connection through discovery, frontend export, chat lookup and deletion', async t => {
  const seen = [], target = {accountId:B,authProfile:'team-b',name:'falco-remote-profile'};
  const check = input => { assert.equal(input.authProfile,target.authProfile);assert.equal(input.accountId,B);seen.push(input); };
  const e = await server(t,{ cloudWorkers:async input => {check(input);return {accountId:B,workers:[{name:target.name}]};},
    workerEndpoint:async input => {check(input);return `https://${input.name}.demo.workers.dev/chat`;},
    remoteOrigins:async input => {check(input);return ['https://example.com'];},remoteActions:async input => {check(input);return [];},
    chatFetch:async () => Response.json({reply:'Hello'}),removeCloudflareWorker:async input => {check(input);return {deleted:true,...target};} });
  const inventory = await (await fetch(e.url+`/api/cloudflare/workers?accountId=${B}&authProfile=team-b`)).json();
  assert.equal(inventory.workers[0].authProfile,'team-b');
  assert.equal((await e.post('/api/cloudflare/workers/chat',{...target,message:'Hello'})).status,200);
  const boot = await (await fetch(e.url+'/api/bootstrap')).json();
  const kit = await fetch(e.url+'/api/frontend-kit/export',{method:'POST',headers:{'Content-Type':'application/json','X-Falco-Local-Token':boot.token},body:JSON.stringify({...target,privacy:{url:'https://example.com/privacy',notice:'Data is processed by this assistant.'}})});
  assert.equal(kit.status,200); await kit.arrayBuffer();
  assert.equal((await e.post('/api/cloudflare/workers/delete',{...target,confirmation:target.name,acknowledge:'DELETE'})).status,200);
  assert.ok(seen.length >= 8);
});

test('Studio permits simultaneous different-project deployments and blocks duplicate targets', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const seen = []; const e = await server(t, { session: async c => ({ accountId:c.accountId }), generate: async c => ({ config:c,files:[] }),
    deploy: async c => { seen.push(c); await gate; return { status:'deployed', url:`https://${c.name}.demo.workers.dev`,secret:'not required' }; },
    smoke: async () => ({ verification:{health:true,cors:true,chat:true} }) });
  const payload = (suffix, authProfile, accountId) => ({ mode:'deploy',name:'falco-concurrent-'+suffix,business:'Concurrent',provider:'mock',authProfile,accountId });
  const a = await e.post('/api/jobs',payload('a','team-a',A)), b = await e.post('/api/jobs',payload('b','team-b',B));
  assert.equal(a.status,202); assert.equal(b.status,202); assert.equal(seen.length,2);
  assert.equal((await e.post('/api/jobs',payload('a','team-a',A))).status,409);
  release();
});

test('persisted operation history excludes authentication tokens and records no raw events', () => {
  const saved = persistedJob({ id:version,name:'falco-test',mode:'deploy',status:'failed',createdAt:new Date().toISOString(),token:'PRIVATE',error:'PRIVATE',events:[{stage:'error',message:'PRIVATE',at:new Date().toISOString()}] });
  assert.doesNotMatch(JSON.stringify(saved),/PRIVATE|token/);
});

test('version upload, promotion, rollback, and secret rotation preserve the project profile through every child and API session', async t => {
  const root = await temporary(t), original = await project(root,'falco-version-profile','team-b',B);
  const p = { ...original, provider:'gemini' }, nextVersion = '22222222-2222-2222-2222-222222222222';
  let live = structuredClone(remote); const children = [], sessions = [];
  await saveRemote(p, live, { verified:true });
  const sessionProvider = async c => { sessions.push(c); return { accountId:c.accountId, authProfile:c.authProfile, token:'PRIVATE' }; };
  const remoteReader = async s => { assert.equal(s.authProfile,'team-b'); assert.equal(s.accountId,B); return live; };
  const cloudflareGet = async (s, endpoint) => { assert.equal(s.authProfile,'team-b'); return { found:true, result: endpoint.endsWith('/versions') ? { items:[{id:live.detail.versions[0].id}] } : { previews_enabled:true } }; };
  const wrangler = async (args, options) => {
    children.push({ args, options }); assert.equal(options.authProfile,'team-b'); assert.equal(options.accountId,B);
    if (args[1] === 'upload') return ok(`Worker Version ID: ${nextVersion}\nVersion Preview URL: https://${nextVersion.slice(0,8)}-${p.name}.demo.workers.dev`);
    if (args[1] === 'secret') { assert.equal(options.input,'provider-secret'); return ok(`Created version ${version} with secret`); }
    const id = args[0] === 'rollback' ? args[1] : args[2].split('@')[0];
    live = { fingerprint:id, detail:{ ...remote.detail,versions:[{id,percentage:100}] }, message:args[args.indexOf('--message') + 1] };
    return ok(`https://${p.name}.demo.workers.dev`);
  };
  const smokeCheck = async () => ({ chat:true,verification:{health:true,cors:true,chat:true} });
  const options = { sessionProvider, remoteReader, cloudflareGet, wrangler, smokeCheck };
  await stageDeployment(p, { ...options, config:{...p,checkProvider:true} });
  await publishVersion(p, { ...options, operation:'promote', versionId:nextVersion });
  await publishVersion(p, { ...options, operation:'rollback', versionId:version });
  await replaceProviderSecret(p, { ...options, apiKey:'provider-secret' });
  assert.ok(sessions.every(s => s.authProfile === 'team-b' && s.accountId === B));
  assert.ok(children.some(c => c.args[0] === 'rollback')); assert.ok(children.some(c => c.args[1] === 'secret'));
  const ledger = await fs.readFile(path.join(p.output,'.falco-deployments.json'),'utf8'); assert.doesNotMatch(ledger,/PRIVATE|provider-secret/);
});
