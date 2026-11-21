/**
 * Falco transport — framework-independent, no DOM or styling.
 * Contract: POST {message, history:[{role,content}]} => {reply:string}.
 * Only an HTTPS Worker /chat URL belongs here. Never put AI API keys in browser code.
 * A UI may be completely replaced without changing this file.
 */
/** Friendly diagnostics only. Upstream raw content and credentials never reach the browser. */
export class FalcoError extends Error {
  constructor(code, message, status = 0, { requestId = null, providerStatus = null, retryable = false, retryAfterSeconds = null } = {}) {
    super(message);
    this.name = 'FalcoError';
    this.code = code;
    this.status = status;
    this.requestId = typeof requestId === 'string' && /^[0-9a-f-]{36}$/i.test(requestId) ? requestId : null;
    this.providerStatus = Number.isInteger(providerStatus) && providerStatus >= 100 && providerStatus <= 599 ? providerStatus : null;
    this.retryable = retryable === true;
    this.retryAfterSeconds = Number.isInteger(retryAfterSeconds) && retryAfterSeconds > 0 && retryAfterSeconds <= 120 ? retryAfterSeconds : null;
  }
}

const FRIENDLY = {
  rate_limited: 'Demasiadas solicitudes. Inténtalo de nuevo en un momento.',
  origin_not_allowed: 'Este sitio web no está autorizado a utilizar Falco.',
  invalid_chat_payload: 'Mensaje no válido. Prueba con uno más corto.',
  internal_error: 'Falco no pudo procesar esta solicitud.',
  provider_invalid_request: 'Gemini o el proveedor rechazó la configuración. Contacta al administrador del sitio.',
  provider_auth_failed: 'La configuración de acceso al proveedor necesita revisión.',
  provider_model_not_found: 'El modelo de IA configurado no está disponible.',
  provider_rate_limited: 'La cuota o el límite de uso del proveedor se ha alcanzado.',
  provider_not_configured: 'Falta configurar la clave privada del proveedor en Cloudflare.',
  provider_upstream_unavailable: 'El proveedor de IA no está disponible por el momento.',
  provider_unavailable: 'No se pudo conectar con el proveedor de IA.',
  provider_timeout: 'La IA tardó demasiado en responder.',
  provider_invalid_response: 'La IA devolvió una respuesta incompatible.',
  provider_empty_response: 'La IA devolvió una respuesta vacía.',
  provider_output_truncated: 'La IA no alcanzó a completar su respuesta.',
  provider_blocked: 'La IA no pudo responder a esa solicitud.',
  provider_error: 'El proveedor de IA rechazó la solicitud.',
  timeout: 'La solicitud tardó demasiado.',
  network_error: 'No se pudo conectar con Falco. Revisa tu conexión y el dominio autorizado.',
};

export function createFalcoClient({ endpoint, timeoutMs = 16000, maxHistory = 8, fetchImpl = globalThis.fetch } = {}) {
  let url;
  try { url = new URL(endpoint); } catch { throw new FalcoError('configuration_error', 'Set a valid Worker /chat URL.'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) ||
      !url.pathname.endsWith('/chat') || url.username || url.password || url.search || url.hash) {
    throw new FalcoError('configuration_error', 'Use an HTTPS Worker /chat endpoint without credentials or query parameters.');
  }
  if (typeof fetchImpl !== 'function') throw new FalcoError('configuration_error', 'Fetch API is required.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new FalcoError('configuration_error', 'timeoutMs must be 1,000–60,000.');
  if (!Number.isInteger(maxHistory) || maxHistory < 0 || maxHistory > 8) throw new FalcoError('configuration_error', 'maxHistory must be 0–8.');
  const history = [];
  let pending = false;

  async function send(rawMessage, { signal } = {}) {
    if (pending) throw new FalcoError('busy', 'Wait for the current reply before sending another message.');
    const message = typeof rawMessage === 'string' ? rawMessage.trim() : '';
    if (!message || message.length > 2000) throw new FalcoError('invalid_message', 'Enter a message of 1–2,000 characters.');
    if (signal?.aborted) throw new FalcoError('cancelled', 'Request cancelled.');
    const aborter = new AbortController();
    const onAbort = () => aborter.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => aborter.abort(), timeoutMs);
    pending = true;
    try {
      const response = await fetchImpl(url.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The Worker requires each history entry <= 1,000 characters and at most 8 entries.
        body: JSON.stringify({ message, history: history.slice(-maxHistory || history.length).slice(0, maxHistory) }),
        signal: aborter.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
      const data = await response.json().catch(() => { throw new FalcoError('invalid_response', 'The assistant returned an invalid response.', response.status); });
      if (!response.ok) {
        const code = typeof data?.error === 'string' ? data.error : 'http_error';
        throw new FalcoError(code, FRIENDLY[code] || `Falco devolvió HTTP ${response.status}.`, response.status, {
          requestId: data?.requestId, providerStatus: data?.providerStatus,
          retryable: data?.retryable, retryAfterSeconds: data?.retryAfterSeconds,
        });
      }
      if (!data || typeof data.reply !== 'string' || !data.reply.trim()) {
        throw new FalcoError('invalid_response', 'The assistant returned an empty reply.', response.status);
      }
      const reply = data.reply.slice(0, 4000);
      // Record only successful turns. Truncating the replies is required by the Worker history contract.
      history.push({ role: 'user', content: message.slice(0, 1000) },
                   { role: 'assistant', content: reply.slice(0, 1000) });
      if (history.length > maxHistory) history.splice(0, history.length - maxHistory);
      // Do not execute actions in the transport. Leave authorization to the local controller.
      const action = data.action;
      return { reply, ...(action && typeof action === 'object' && !Array.isArray(action) ? { action } : {}) };
    } catch (err) {
      if (err instanceof FalcoError) throw err;
      if (aborter.signal.aborted) throw new FalcoError(signal?.aborted ? 'cancelled' : 'timeout', signal?.aborted ? 'Request cancelled.' : FRIENDLY.timeout);
      // Browser CORS failures are intentionally indistinguishable from network failures here.
      throw new FalcoError('network_error', FRIENDLY.network_error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      pending = false;
    }
  }
  return {
    send,
    reset() { if (pending) throw new FalcoError('busy', 'Wait for the current reply before resetting.'); history.length = 0; },
    getHistory() { return history.map(item => ({ ...item })); },
    get pending() { return pending; },
  };
}
