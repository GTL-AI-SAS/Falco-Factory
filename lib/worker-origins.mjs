/** Query the *deployed* Cloudflare Worker bindings; never trust stale local metadata. */
import { getCloudflareSession, cfGet } from './deploy.mjs';
import { readCloudflareOriginsBindings } from './origins.mjs';
export async function getDeployedOrigins({ accountId, name, authProfile, sessionProvider = getCloudflareSession, cloudflareGet = cfGet }) {
  const session = await sessionProvider({ accountId, ...(authProfile ? { authProfile } : {}) });
  if (session.accountId.toLowerCase() !== accountId.toLowerCase()) throw new Error('Cloudflare account mismatch.');
  const result = await cloudflareGet(session, `/workers/scripts/${encodeURIComponent(name)}/settings`);
  if (!result?.found) throw new Error('Cannot read deployed Worker settings from Cloudflare. Export refused. Check Workers Scripts Read permissions.');
  return readCloudflareOriginsBindings(result.result);
}
