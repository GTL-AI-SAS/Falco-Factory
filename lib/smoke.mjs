export async function smoke(url, { business, expectedRuntime, chat = false, origin, fetcher = fetch, attempts = 5, pause = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const base = new URL(url);
  if (base.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(base.hostname)) throw new Error('Smoke URL must be HTTPS (or local HTTP)');
  const headers = origin ? { Origin: origin } : {};
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetcher(new URL('/health', base), { headers, signal: AbortSignal.timeout(8000) });
      const body = await res.json();
      if (res.ok && body.status === 'ok' && body.service === 'falco' && (!business || body.business === business) && (!expectedRuntime || body.runtimeVersion === expectedRuntime)) {
        if (!chat) return { health: body, chat: null };
        const chatRes = await fetcher(new URL('/chat', base), {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'Hola, ¿qué ofrecen?', history: [] }), signal: AbortSignal.timeout(15000)
        });
        const chatBody = await chatRes.json();
        if (!chatRes.ok || !chatBody.reply || typeof chatBody.reply !== 'string') throw new Error(`Chat check returned HTTP ${chatRes.status} (${chatBody.error || 'invalid reply'})`);
        return { health: body, chat: chatBody };
      }
      throw new Error(`Health check returned HTTP ${res.status} or unexpected business/service${expectedRuntime ? '/runtime version (expected '+expectedRuntime+', got '+(body.runtimeVersion || 'unknown')+')' : ''}`);
    } catch (e) { lastErr = e; if (i + 1 < attempts) await pause(1200 * (i + 1)); }
  }
  throw new Error(`Health/chat verification failed: ${lastErr?.message || 'unknown error'}`);
}
