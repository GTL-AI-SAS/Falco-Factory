/**
 * Falco transport — framework-independent, no DOM or styling.
 * Contract: POST {message, history:[{role,content}]} => {reply:string}.
 * Only an HTTPS Worker /chat URL belongs here. Never put AI API keys in browser code.
 * A UI may be completely replaced without changing this file.
 */
export class FalcoError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'FalcoError';
    this.code = code;
    this.status = status;
  }
}

const FRIENDLY = {
  rate_limited: 'Too many messages right now. Please try again shortly.',
  origin_not_allowed: 'This website is not authorized to use the assistant.',
  invalid_chat_payload: 'That message could not be sent. Please try a shorter message.',
  internal_error: 'The assistant is temporarily unavailable.',
  provider_unavailable: 'The assistant is temporarily unavailable.',
  provider_timeout: 'The assistant took too long to respond.',
  timeout: 'The assistant took too long to respond.',
  network_error: 'Could not connect to the assistant. Check your connection.',
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
        throw new FalcoError(code, FRIENDLY[code] || `Assistant request failed (HTTP ${response.status}).`, response.status);
      }
      if (!data || typeof data.reply !== 'string' || !data.reply.trim()) {
        throw new FalcoError('invalid_response', 'The assistant returned an empty reply.', response.status);
      }
      const reply = data.reply.slice(0, 4000);
      // Record only successful turns. Truncating the replies is required by the Worker history contract.
      history.push({ role: 'user', content: message.slice(0, 1000) },
                   { role: 'assistant', content: reply.slice(0, 1000) });
      if (history.length > maxHistory) history.splice(0, history.length - maxHistory);
      return { reply };
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
