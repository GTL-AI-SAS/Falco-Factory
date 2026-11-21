/** Falco v1.2: stable, safe diagnostics. NEVER log upstream bodies, prompts or credentials. */
export const PROVIDER_MESSAGES = Object.freeze({
  provider_not_configured: 'El proveedor de IA no está configurado. Revisa el secreto de Cloudflare.',
  provider_not_supported: 'El proveedor de IA configurado no es compatible.',
  provider_invalid_request: 'El proveedor rechazó la solicitud. Revisa el modelo y las opciones de generación.',
  provider_auth_failed: 'El proveedor rechazó las credenciales. Comprueba el secreto y los permisos de la API.',
  provider_model_not_found: 'El modelo configurado no existe o no está disponible para este proyecto.',
  provider_rate_limited: 'Se alcanzó un límite o una cuota del proveedor. Comprueba las cuotas del proyecto.',
  provider_upstream_unavailable: 'El proveedor de IA está temporalmente indisponible.',
  provider_unavailable: 'No se pudo establecer conexión con el proveedor de IA.',
  provider_timeout: 'El proveedor de IA tardó demasiado en responder.',
  provider_invalid_response: 'El proveedor devolvió un formato de respuesta no válido.',
  provider_empty_response: 'El proveedor devolvió una respuesta vacía.',
  provider_output_truncated: 'El proveedor alcanzó el límite de salida antes de completar la respuesta.',
  provider_blocked: 'El proveedor no pudo generar una respuesta para esta solicitud.',
  provider_error: 'El proveedor de IA rechazó la solicitud.',
});
const RETRYABLE = new Set(['provider_rate_limited','provider_upstream_unavailable','provider_unavailable','provider_timeout']);
export class ProviderError extends Error {
  constructor(code, status = 502, { upstreamStatus = null, retryAfter = null, reason = null } = {}) {
    super(code);
    this.name = 'ProviderError';
    this.code = Object.hasOwn(PROVIDER_MESSAGES, code) ? code : 'provider_error';
    this.status = status;
    this.upstreamStatus = Number.isInteger(upstreamStatus) && upstreamStatus >= 100 && upstreamStatus <= 599 ? upstreamStatus : null;
    this.retryAfter = Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 120 ? retryAfter : null;
    // Only a closed, known reason code is ever retained; never copy upstream text here.
    this.reason = ['max_tokens','safety','malformed_json','missing_reply','missing_candidate'].includes(reason) ? reason : null;
    this.retryable = RETRYABLE.has(this.code);
  }
}
function mapUpstreamStatus(status, headers) {
  const rawRetry = headers?.get?.('retry-after') || '';
  const retryAfter = /^\d{1,3}$/.test(rawRetry) ? Math.min(120, Math.max(1, Number(rawRetry))) : null;
  if (status === 400 || status === 422) return new ProviderError('provider_invalid_request',502,{upstreamStatus:status});
  if (status === 401 || status === 403) return new ProviderError('provider_auth_failed',503,{upstreamStatus:status});
  if (status === 404) return new ProviderError('provider_model_not_found',502,{upstreamStatus:status});
  if (status === 408 || status === 504) return new ProviderError('provider_timeout',504,{upstreamStatus:status});
  if (status === 429) return new ProviderError('provider_rate_limited',503,{upstreamStatus:status,retryAfter});
  if (status >= 500) return new ProviderError('provider_upstream_unavailable',503,{upstreamStatus:status,retryAfter});
  return new ProviderError('provider_error',502,{upstreamStatus:status});
}
export function providerFailurePayload(err, requestId) {
  const payload = { error: err.code, message: PROVIDER_MESSAGES[err.code], requestId, retryable: err.retryable };
  if (err.upstreamStatus) payload.providerStatus = err.upstreamStatus;
  if (err.retryAfter) payload.retryAfterSeconds = err.retryAfter;
  return payload;
}
/**
 * Single network attempt. No automatic retries: protecting free-tier quotas is preferable to
 * silently repeating (and potentially billing) an AI call. Caller handles final diagnostics.
 */
export async function postJson(url, opts, fetcher = fetch, { timeoutMs = 12000 } = {}) {
  let response;
  try {
    response = await fetcher(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new ProviderError(timeout ? 'provider_timeout' : 'provider_unavailable', timeout ? 504 : 502);
  }
  if (!response.ok) {
    // Never consume or forward provider errors: responses can contain prompts, keys or PII.
    try { await response.body?.cancel?.(); } catch { /* irrelevant */ }
    throw mapUpstreamStatus(response.status, response.headers);
  }
  try {
    return await response.json();
  } catch {
    throw new ProviderError('provider_invalid_response',502,{reason:'malformed_json'});
  }
}
/** Gemini / OpenAI may return HTTP 200 but an unusable completion. */
export function assertUsableOutput(output, { finishReason = null } = {}) {
  if (finishReason === 'MAX_TOKENS') throw new ProviderError('provider_output_truncated',502,{reason:'max_tokens'});
  if (['SAFETY','PROHIBITED_CONTENT','BLOCKLIST','SPII','RECITATION'].includes(finishReason))
    throw new ProviderError('provider_blocked',422,{reason:'safety'});
  if (typeof output !== 'string' || !output.trim()) throw new ProviderError('provider_empty_response',502,{reason:'missing_reply'});
  return output.trim();
}
