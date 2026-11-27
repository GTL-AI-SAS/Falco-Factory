/** Worker Previews only. No production deploy/version/delete commands belong here. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runWrangler } from './cloudflare-auth.mjs';
import { cfGet } from './cloudflare-api.mjs';

export const previewEndpoint = manifest => `/workers/workers/${encodeURIComponent(manifest.workerName)}/previews/${encodeURIComponent(manifest.previewName)}`;
const routingUnavailable = () => new Error('Cloudflare Preview URLs are disabled for this Worker. Test Lab requires the Worker-level Preview URL setting to be enabled first. Factory will not change production routing or redeploy the Worker automatically.');
export function previewUrl(raw, workerName) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !/^(?:[a-z0-9-]+\.)+workers\.dev$/i.test(url.hostname) ||
      url.hostname.split('.')[0] === workerName || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw Error('Invalid Worker Preview URL. No guessed URLs are accepted.');
  }
  return url.origin;
}
export function parsePreview(output, manifest) {
  let body;
  try { body = JSON.parse(output); } catch { throw Error('Wrangler returned invalid Preview JSON.'); }
  if (body?.preview?.name !== manifest.previewName || !body.preview?.id) throw Error('Wrangler did not return the expected Preview identity. Cleanup will use the exact session Preview name.');
  if (!body.deployment?.id) throw Error('Wrangler did not return a Preview deployment ID.');
  if (!Array.isArray(body.preview.urls) || !body.preview.urls.length) throw Error('Cloudflare created a Preview deployment without an active Preview URL. Check the Worker-level Preview URL setting. Factory will attempt cleanup; no URL will be guessed and production will not be redeployed.');
  return { previewId:body.preview.id, deploymentId:body.deployment.id,
    previewUrl:previewUrl(body.preview.urls[0], manifest.workerName) };
}

export function createPreviewAdapter({ wrangler = runWrangler, get = cfGet, env = process.env } = {}) {
  async function command(manifest, args, signal) {
    let result;
    const diagnostic = path.join(manifest.workspace, 'wrangler.log');
    try {
      result = await wrangler(['preview', ...args, '--name', manifest.previewName, '--worker-name', manifest.workerName,
        '--config', path.join(manifest.workspace, 'worker/wrangler.json')], {
        cwd:path.join(manifest.workspace, 'worker'), accountId:manifest.accountId, authProfile:manifest.authProfile,
        signal, timeoutMs:120000,
        env:{ ...env, WRANGLER_WRITE_LOGS:'false', WRANGLER_LOG_PATH:diagnostic }
      });
    } catch { throw Error('Preview command interrupted or unavailable. Review session cleanup before retrying.'); }
    finally {await fs.rm(diagnostic,{force:true});}
    // Raw process output is private, including errors. Never put it in jobs/history.
    if (result.code !== 0) throw Error('Cloudflare Preview command failed. Verify the connection, account permissions and Preview support.');
    return result.stdout;
  }
  return {
    async routing(manifest, session) {
      const result = await get(session, `/workers/scripts/${encodeURIComponent(manifest.workerName)}/subdomain`);
      if (!result.found || typeof result.result?.previews_enabled !== 'boolean') throw Error('Could not verify the Worker-level Preview URL setting. No Preview was created.');
      if (!result.result.previews_enabled) throw routingUnavailable();
    },
    async assertAvailable(manifest, session) {
      if ((await get(session,previewEndpoint(manifest))).found) throw Error('The unique Preview name already exists. Refusing to reuse or modify it.');
    },
    async create(manifest, signal) {
      return parsePreview(await command(manifest, ['--ignore-base-config','--json'], signal), manifest);
    },
    async secrets(manifest, token, apiKey, signal) {
      const name = manifest.provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY';
      const file = path.join(manifest.workspace, randomUUID() + '.secrets.json');
      try {
        await fs.writeFile(file, JSON.stringify({ FALCO_TEST_TOKEN:token, [name]:apiKey }), {flag:'wx',mode:0o600});
        await command(manifest, ['secret','bulk',file], signal);
      } finally { await fs.rm(file, {force:true}); }
      let listed;
      try { listed = JSON.parse(await command(manifest, ['secret','list','--json'], signal)); }
      catch { throw Error('Could not verify Preview secret names.'); }
      const expected = ['FALCO_TEST_TOKEN', name].sort();
      if (!Array.isArray(listed) || JSON.stringify(listed.map(item => item.name).sort()) !== JSON.stringify(expected)) {
        throw Error('Preview secret allowlist mismatch. Session refused.');
      }
    },
    async verify(manifest, session) {
      const [resource, latest] = await Promise.all([get(session, previewEndpoint(manifest)), get(session, previewEndpoint(manifest) + '/deployments/latest')]);
      if (!resource.found || resource.result?.name !== manifest.previewName || resource.result?.id !== manifest.previewId ||
          !resource.result?.urls?.some(url => previewUrl(url, manifest.workerName) === manifest.previewUrl) || !latest.found || !latest.result?.id) {
        throw Error('Preview identity or latest deployment could not be verified.');
      }
      return latest.result.id;
    },
    async remove(manifest, session) {
      // REST 404 is the authoritative absence check. A CLI failure with a live Preview remains cleanup_required.
      const before = await get(session, previewEndpoint(manifest));
      if (!before.found) return;
      if (before.result?.name !== manifest.previewName || (manifest.previewId && before.result.id !== manifest.previewId)) {
        throw Object.assign(Error('Session Preview identity mismatch. Manual integrity review is required.'), {emergency:true});
      }
      await command(manifest, ['delete','--skip-confirmation']);
      const after = await get(session, previewEndpoint(manifest));
      if (after.found) throw Error('Preview deletion is not confirmed. Retry cleanup.');
    }
  };
}
