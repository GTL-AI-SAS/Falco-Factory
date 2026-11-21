export class ProviderError extends Error {
  constructor(code, status = 502) { super(code); this.code = code; this.status = status; }
}
export async function postJson(url, opts, fetcher = fetch) {
  let response;
  try {
    response = await fetcher(url, { ...opts, signal: AbortSignal.timeout(12000) });
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new ProviderError(timeout ? 'provider_timeout' : 'provider_unavailable', timeout ? 504 : 502);
  }
  if (!response.ok) {
    // Never forward provider error bodies: they may contain sensitive details.
    throw new ProviderError(response.status === 429 ? 'provider_rate_limited' : 'provider_error', response.status === 429 ? 503 : 502);
  }
  try { return await response.json(); } catch { throw new ProviderError('provider_invalid_response', 502); }
}
