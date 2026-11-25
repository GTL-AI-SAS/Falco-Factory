/** Read PUBLIC action manifest from deployed Cloudflare Worker settings. */
import { getCloudflareSession, cfGet } from './deploy.mjs';
import { normalizeClientActions } from './client-actions.mjs';
export function readCloudflareActionBindings(settings) {
  const bindings = settings?.bindings;
  if (!Array.isArray(bindings)) throw Error('Cloudflare did not return Worker bindings. Action export refused.');
  const binding = bindings.find(b => b?.name === 'CLIENT_ACTIONS_JSON' && b?.type === 'plain_text');
  if (!binding) return []; // Legacy Worker from v1.0: no client actions enabled.
  return normalizeClientActions(binding.text ?? binding.value);
}
export async function getDeployedClientActions({ accountId, name, authProfile, sessionProvider = getCloudflareSession, cloudflareGet = cfGet }) {
  const session = await sessionProvider({ accountId, ...(authProfile ? { authProfile } : {}) });
  if (session.accountId.toLowerCase() !== accountId.toLowerCase()) throw Error('Cloudflare account mismatch.');
  const response = await cloudflareGet(session, `/workers/scripts/${encodeURIComponent(name)}/settings`);
  if (!response?.found) throw Error('Cannot verify deployed client actions for frontend export.');
  return readCloudflareActionBindings(response.result);
}
