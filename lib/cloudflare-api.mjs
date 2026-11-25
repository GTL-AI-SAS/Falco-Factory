export async function cfGet(session, endpoint) {
  let response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${session.accountId}${endpoint}`, {
      headers: { Authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(15000), redirect: 'error'
    });
  } catch { throw new Error('Cloudflare API unavailable. Deployment stopped before changing remote resources.'); }
  if (response.status === 404) { await response.body?.cancel(); return { found: false }; }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Cloudflare API HTTP ${response.status}. Verify the selected connection and Account ID. HTTP 401 requires reauthentication; HTTP 403 requires account access and Workers Scripts permissions (KV endpoints require KV permissions). Operation stopped.`);
  }
  // The bare script URL is an existence probe (binary Worker script body).
  // Nested routes like /scripts/name/settings return JSON we need to parse.
  if (/^\/workers\/scripts\/[^/]+$/.test(endpoint)) { await response.body?.cancel(); return { found: true }; }
  try {
    const body = await response.json();
    if (!body.success) throw new Error('Cloudflare API returned an unsuccessful response.');
    return { found: true, result: body.result };
  } catch { throw new Error('Cloudflare returned an invalid JSON response for the requested resource.'); }
}
