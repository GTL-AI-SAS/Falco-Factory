import fs from 'node:fs/promises';
import path from 'node:path';
import { cfGet, getCloudflareSession } from './deploy.mjs';
import { readRemote, saveRemote } from './remote-state.mjs';
import { readProject, readProjectAt, makeSnapshot, MANAGED } from './projects.mjs';
import { applyProjectFiles, withProjectLock, assertNoPendingTransaction } from './project-files.mjs';
import { readCloudflareOriginsBindings } from './origins.mjs';
import { readCloudflareActionBindings } from './worker-actions.mjs';
import { checkKnowledge, verifiedKnowledge, KV_BINDING, KV_KEY } from './knowledge-kv.mjs';

const pretty = value => JSON.stringify(value, null, 2) + '\n';
const publicVars = ['BUSINESS_NAME', 'PROVIDER', 'MODEL', 'MOCK_REPLY', 'KNOWLEDGE_MODE',
  'ALLOWED_ORIGIN', 'ALLOWED_ORIGINS', 'CLIENT_ACTIONS_JSON', 'FALCO_TELEMETRY', 'FALCO_BUDGET'];

// Decode literals only. Downloaded Worker code is never imported or evaluated.
function literalText(literal) {
  const quote = literal[0];
  if (literal.at(-1) !== quote) throw new Error('Invalid business knowledge literal.');
  let text = '';
  for (let i = 1; i < literal.length - 1; i++) {
    let char = literal[i];
    if (char !== '\\') { text += char; continue; }
    char = literal[++i];
    const escapes = { n:'\n', r:'\r', t:'\t', b:'\b', f:'\f', v:'\v', '\\':'\\', '"':'"', "'":"'" };
    if (Object.hasOwn(escapes, char)) text += escapes[char];
    else if (char === 'x' || char === 'u') {
      if (char === 'u' && literal[i + 1] === '{') {
        const escaped = literal.slice(i + 1).match(/^\{([a-f0-9]{1,6})\}/i);
        const point = escaped && parseInt(escaped[1], 16);
        if (!escaped || point > 0x10ffff) throw new Error('Unsupported business knowledge encoding.');
        text += String.fromCodePoint(point); i += escaped[0].length;
        continue;
      }
      const length = char === 'x' ? 2 : 4;
      const hex = literal.slice(i + 1, i + 1 + length);
      if (hex.length !== length || !/^[a-f0-9]+$/i.test(hex)) throw new Error('Unsupported business knowledge encoding.');
      text += String.fromCharCode(parseInt(hex, 16)); i += length;
    } else throw new Error('Unsupported business knowledge escape.');
  }
  return text;
}

export function embeddedKnowledge(modules) {
  const values = {};
  for (const source of modules) {
    const code = source.replace(/"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|`(?:[^`\\]|\\[\s\S])*`|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
      token => token[0] === '"' || token[0] === "'" ? token : token.replace(/[^\r\n]/g, ' '));
    // Only the recognizable Factory context declarations are recoverable. Refuse
    // minified/renamed/custom expressions instead of inventing empty knowledge.
    const declarations = code.matchAll(/^(?:export )?(?:const|let|var) (businessInstructions|faqText) = ("(?:[^"\\\r\n]|\\[^\r\n])*"|'(?:[^'\\\r\n]|\\[^\r\n])*');\r?$/gm);
    for (const [, name, literal] of declarations) {
      if (Object.hasOwn(values, name)) throw new Error('Ambiguous deployed business knowledge.');
      values[name] = literalText(literal);
    }
  }
  if (!Object.hasOwn(values, 'businessInstructions') || !Object.hasOwn(values, 'faqText')) {
    throw new Error('Cannot recover exact knowledge from this deployed Worker. Link its original Factory source; no local settings were replaced.');
  }
  return { faq: values.faqText, instructions: values.businessInstructions };
}

async function cloudflareRead(session, endpoint, fetcher) {
  const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${session.accountId}${endpoint}`, {
    headers: { Authorization: 'Bearer ' + session.token }, signal: AbortSignal.timeout(15000), redirect: 'error'
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Cannot load deployed Worker content (Cloudflare HTTP ${response.status}). Local settings were kept.`);
  }
  return response;
}

export async function readDeployedProject(project, { sessionProvider = getCloudflareSession, get = cfGet,
  remoteReader = readRemote, fetcher = fetch } = {}) {
  const session = await sessionProvider(project);
  if (session.accountId.toLowerCase() !== project.accountId.toLowerCase()) throw new Error('Cloudflare account mismatch.');
  const before = await remoteReader(session, project.name);
  if (!before || before.detail.versions.length !== 1 || before.detail.versions[0].percentage !== 100) {
    throw new Error('Select a Worker with one fully active Cloudflare version before loading its configuration.');
  }
  const result = await get(session, `/workers/scripts/${encodeURIComponent(project.name)}/settings`);
  if (!result.found || !Array.isArray(result.result?.bindings)) throw new Error('Cannot load deployed Worker settings.');
  const settings = result.result;
  const vars = {};
  for (const name of publicVars) {
    const bindings = settings.bindings.filter(binding => binding.name === name);
    if (bindings.length > 1 || (bindings.length && bindings[0].type !== 'plain_text')) throw new Error('Invalid deployed Factory binding: ' + name);
    if (bindings.length) vars[name] = bindings[0].text ?? bindings[0].value;
  }
  if (!vars.BUSINESS_NAME || !vars.PROVIDER || !vars.MODEL) throw new Error('Deployed Worker has incomplete Factory settings.');
  const origins = readCloudflareOriginsBindings(settings);
  const actions = readCloudflareActionBindings(settings);
  const mode = vars.KNOWLEDGE_MODE ?? 'embedded';
  let knowledge, namespaceId;
  if (mode === 'kv') {
    const bindings = settings.bindings.filter(binding => binding.name === KV_BINDING);
    namespaceId = bindings[0]?.namespace_id;
    if (bindings.length !== 1 || bindings[0].type !== 'kv_namespace' || !/^[a-f0-9]{32}$/i.test(namespaceId ?? '')) throw new Error('Invalid deployed knowledge namespace.');
    const response = await cloudflareRead(session, `/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(KV_KEY)}`, fetcher);
    knowledge = verifiedKnowledge(await response.json());
  } else if (mode === 'embedded') {
    const response = await cloudflareRead(session, `/workers/scripts/${encodeURIComponent(project.name)}/content/v2`, fetcher);
    let modules;
    if (response.headers.get('content-type')?.startsWith('multipart/')) {
      const form = await response.formData();
      modules = await Promise.all([...form.values()].map(value => typeof value === 'string' ? value : value.text()));
    } else modules = [await response.text()];
    knowledge = embeddedKnowledge(modules);
  } else throw new Error('Invalid deployed knowledge mode.');
  checkKnowledge(mode, knowledge);
  const after = await remoteReader(session, project.name);
  if (after?.fingerprint !== before.fingerprint) throw new Error('Cloudflare changed while loading. Reload the Worker. Local settings were kept.');
  return { vars, origins, actions, knowledgeMode: mode, knowledge, namespaceId, settings, remote: after };
}

export async function refreshProject(root, folder, { reader = readDeployedProject } = {}) {
  const initial = await readProject(root, folder);
  return withProjectLock(initial.output, async () => {
    await assertNoPendingTransaction(initial.output);
    const project = await readProject(root, folder);
    if (!project.accountId) throw new Error('Select the Cloudflare account before loading deployed settings.');
    const live = await reader(project);
    if ((await readProject(root, folder)).revision !== project.revision) throw new Error('Local project changed while loading. Reload it.');
    const config = JSON.parse(await fs.readFile(path.join(project.output, 'wrangler.json'), 'utf8'));
    for (const name of publicVars) delete config.vars[name];
    Object.assign(config.vars, live.vars, { KNOWLEDGE_MODE: live.knowledgeMode,
      ALLOWED_ORIGIN: live.origins[0], ALLOWED_ORIGINS: JSON.stringify(live.origins), CLIENT_ACTIONS_JSON: JSON.stringify(live.actions) });
    config.observability = live.settings.observability ?? { enabled: false };
    const rate = live.settings.bindings.find(binding => binding.name === 'CHAT_RATE_LIMITER');
    if (rate) {
      if (rate.type !== 'ratelimit' || !rate.simple || !rate.namespace_id) throw new Error('Invalid deployed rate limiter.');
      config.ratelimits = [...(config.ratelimits ?? []).filter(binding => binding.name !== 'CHAT_RATE_LIMITER'),
        { name: rate.name, namespace_id: rate.namespace_id, simple: rate.simple }];
    }
    config.kv_namespaces = (config.kv_namespaces ?? []).filter(binding => binding.binding !== KV_BINDING);
    const files = new Map([['wrangler.json', pretty(config)]]);
    if (live.knowledgeMode === 'kv') {
      config.kv_namespaces.push({ binding: KV_BINDING, id: live.namespaceId });
      files.set('wrangler.json', pretty(config));
      files.set('.falco-knowledge.json', pretty({ version: 1, faq: live.knowledge.faq, instructions: live.knowledge.instructions }));
      files.set('.falco-kv-state.json', pretty({ schema: 1, name: project.name, namespaceId: live.namespaceId, revision: live.knowledge.revision }));
    } else {
      files.set('src/business-context.mjs', '// Public, non-secret business text bundled by Falco Factory.\n' +
        `export const businessInstructions = ${JSON.stringify(live.knowledge.instructions)};\nexport const faqText = ${JSON.stringify(live.knowledge.faq)};\n`);
    }
    if (project.sections && (project.faq !== live.knowledge.faq || project.instructions !== live.knowledge.instructions)) files.set('.falco-sections.json', 'null\n');
    // Validate the complete proposed project before replacing any local files.
    const staging = await fs.mkdtemp(path.join(path.dirname(project.output), '.falco-refresh-'));
    try {
      for (const file of MANAGED) {
        await fs.mkdir(path.dirname(path.join(staging, file)), { recursive: true });
        await fs.copyFile(path.join(project.output, file), path.join(staging, file));
      }
      if (project.sections) await fs.writeFile(path.join(staging, '.falco-sections.json'), pretty(project.sections));
      for (const [file, data] of files) await fs.writeFile(path.join(staging, file), data);
      await readProjectAt(staging, project.folder);
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
    const changed = new Map();
    for (const [file, data] of files) {
      const prior = await fs.readFile(path.join(project.output, file), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (prior !== data) changed.set(file, data);
    }
    if (changed.size) {
      const snapshot = await makeSnapshot(project, 'before_remote_refresh');
      await applyProjectFiles(project.output, changed, { reason: 'before-remote-refresh', snapshot });
    }
    await saveRemote(project, live.remote, { fromFactory: false });
    return readProject(root, folder);
  });
}
