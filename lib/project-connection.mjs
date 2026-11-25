import fs from 'node:fs/promises';
import path from 'node:path';
import { getCloudflareSession, validateAuthProfile } from './cloudflare-auth.mjs';
import { readProject } from './projects.mjs';
import { assertRemote, deploymentLedger, readRemote } from './remote-state.mjs';
import { withProjectLock, assertNoPendingTransaction, applyProjectFiles } from './project-files.mjs';

/** A local target change never deploys, deletes, or transfers a remote resource. */
export async function assignProjectConnection(root, folder, input, { sessionProvider = getCloudflareSession,
  remoteReader = readRemote } = {}) {
  const initial = await readProject(root, folder);
  return withProjectLock(initial.output, async () => {
    await assertNoPendingTransaction(initial.output);
    const project = await readProject(root, folder);
    if (input.revision !== project.revision) throw new Error('Project changed. Reload before changing its connection.');
    const authProfile = validateAuthProfile(input.authProfile ?? '');
    if (!/^[a-f0-9]{32}$/i.test(input.accountId ?? '')) throw new Error('Choose an explicit Cloudflare account.');
    const next = { ...project, authProfile, accountId: input.accountId.toLowerCase() };
    const session = await sessionProvider(next);
    if (session.accountId.toLowerCase() !== next.accountId) throw new Error('Account mismatch. Connection change blocked.');
    const changingAccount = Boolean(project.accountId && project.accountId.toLowerCase() !== next.accountId);
    const ledger = await deploymentLedger(project);
    if (changingAccount) {
      if (input.confirmName !== project.name || input.acknowledge !== 'RETARGET') throw new Error('Changing accounts requires the exact Worker name and RETARGET. The original deployment and KV data remain in the old account.');
      if (ledger) await assertRemote(project, await sessionProvider(project), { remoteReader });
      if (await remoteReader(session, next.name)) throw new Error('A Worker with this name already exists in the destination account. Connection change blocked to prevent confusing two deployments.');
    } else if (ledger) await assertRemote(next, session, { remoteReader });
    const marker = JSON.parse(await fs.readFile(path.join(project.output, '.falco-generated.json'), 'utf8'));
    if (authProfile) marker.authProfile = authProfile;
    else delete marker.authProfile;
    const config = JSON.parse(await fs.readFile(path.join(project.output, 'wrangler.json'), 'utf8'));
    config.account_id = next.accountId;
    if (changingAccount) {
      // Account-specific third-party resources need an explicit migration outside this flow.
      if (config.d1_databases?.length || config.r2_buckets?.length || config.services?.length ||
          config.kv_namespaces?.some(x => x.binding !== 'FALCO_KNOWLEDGE')) {
        throw new Error('This project has additional account-specific bindings. Clone it and configure those resources in the destination account before deploying.');
      }
      if (config.kv_namespaces) config.kv_namespaces = config.kv_namespaces.filter(x => x.binding !== 'FALCO_KNOWLEDGE');
    }
    const pretty = value => JSON.stringify(value, null, 2) + '\n';
    const files = new Map([['.falco-generated.json', pretty(marker)], ['wrangler.json', pretty(config)]]);
    if (changingAccount) for (const file of ['.falco-deployments.json','.falco-kv-state.json','.falco-staged.json']) files.set(file, 'null\n');
    await applyProjectFiles(project.output, files, { reason: 'before-regenerate' });
    return readProject(root, folder);
  });
}
