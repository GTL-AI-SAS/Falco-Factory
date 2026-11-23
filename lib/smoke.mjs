import { validateOrigin } from './origins.mjs';

function safeBase(url) {
  const base = new URL(url);
  const local = ['localhost', '127.0.0.1'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !(local && base.protocol === 'http:')) || base.username || base.password || base.search || base.hash) {
    throw new Error('Smoke URL must be HTTPS (or local HTTP) without credentials, query, or fragment.');
  }
  return base;
}

function initialVerification({ origins, chat, action, actionConfigured, actionSupported, knowledgeRevision }) {
  const requestAuthorized = chat === true || Boolean(action);
  return {
    health: null,
    cors: origins.length ? null : null,
    chat: null,
    action: null,
    knowledge: null,
    healthStatus: 'pending',
    corsStatus: origins.length ? 'pending' : 'not_configured',
    chatStatus: requestAuthorized ? 'pending' : 'not_authorized',
    actionStatus: action ? 'pending' : !actionConfigured ? 'not_configured' : !actionSupported ? 'unsupported_provider' : 'not_authorized',
    knowledgeStatus: knowledgeRevision ? 'pending' : 'not_configured',
    ...(action ? { actionId: action.id } : {})
  };
}

export async function smoke(url, { business, expectedRuntime, chat = false, origin, origins = origin ? [origin] : [],
  action, actionConfigured = false, actionSupported = true, knowledgeRevision, headers: additionalHeaders = {}, fetcher = fetch, attempts = 5,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const base = safeBase(url);
  const corsOrigins = [...new Set(origins)].map(value => validateOrigin(value));
  const configuredAction = actionConfigured || Boolean(action);
  const verification = initialVerification({ origins: corsOrigins, chat, action, actionConfigured: configuredAction, actionSupported, knowledgeRevision });
  const get = (route, options = {}) => fetcher(new URL(route, base), {
    ...options, redirect: 'error', signal: AbortSignal.timeout(options.method === 'POST' ? 15000 : 8000),
    headers: { ...additionalHeaders, ...options.headers }
  });
  let health, lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await get('/health');
      const body = await response.json();
      if (!response.ok || body.status !== 'ok' || body.service !== 'falco' || (business && body.business !== business) ||
          (expectedRuntime && body.runtimeVersion !== expectedRuntime)) throw new Error(`Unexpected /health response (HTTP ${response.status}).`);
      health = body;
      verification.health = true;
      verification.healthStatus = 'pass';
      break;
    } catch (error) {
      lastError = error;
      if (i + 1 < attempts) await pause(1200 * (i + 1));
    }
  }
  if (!health) {
    verification.health = false;
    verification.healthStatus = 'failed';
    verification.corsStatus = corsOrigins.length ? 'skipped' : 'not_configured';
    verification.chatStatus = 'skipped';
    verification.actionStatus = configuredAction ? 'skipped' : 'not_configured';
    verification.knowledgeStatus = knowledgeRevision ? 'skipped' : 'not_configured';
    throw Object.assign(new Error('Health check failed: ' + lastError?.message), { verification });
  }
  try {
    for (const allowed of corsOrigins) {
      const preflight = await get('/chat', { method: 'OPTIONS', headers: {
        Origin: allowed, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type'
      } });
      if (preflight.status !== 204 || preflight.headers.get('access-control-allow-origin') !== allowed ||
        !preflight.headers.get('access-control-allow-methods')?.split(',').some(method => method.trim() === 'POST') ||
        !preflight.headers.get('access-control-allow-headers')?.toLowerCase().split(',').some(header => header.trim() === 'content-type')) {
        throw new Error(`CORS preflight failed for ${allowed} (HTTP ${preflight.status}).`);
      }
    }
    if (corsOrigins.length) {
      const deny = await get('/chat', { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST' } });
      if (deny.status !== 403 || deny.headers.has('access-control-allow-origin')) throw new Error('CORS denial check failed.');
      verification.cors = true;
      verification.corsStatus = 'pass';
    }
  } catch (error) {
    if (verification.corsStatus === 'pending') {
      verification.cors = false;
      verification.corsStatus = 'failed';
    }
    if (verification.chatStatus === 'pending') verification.chatStatus = 'skipped';
    if (verification.actionStatus === 'pending') verification.actionStatus = 'skipped';
    if (verification.knowledgeStatus === 'pending') verification.knowledgeStatus = 'skipped';
    throw Object.assign(error, { verification });
  }

  if (knowledgeRevision) {
    try {
      const response = await get('/knowledge-status');
      const body = await response.json();
      if (!response.ok || body.revision !== knowledgeRevision) throw new Error('The expected KV revision is still propagating or unavailable.');
      verification.knowledge = true;
      verification.knowledgeStatus = 'pass';
    } catch (error) {
      verification.knowledge = false;
      verification.knowledgeStatus = 'failed';
      if (verification.chatStatus === 'pending') verification.chatStatus = 'skipped';
      if (verification.actionStatus === 'pending') verification.actionStatus = 'skipped';
      throw Object.assign(error, { verification });
    }
  }

  // An action proposal test is itself one /chat request and also validates the chat contract.
  // No website handler is executed; the test only inspects the JSON proposal returned by Falco.
  if (!chat && !action) return { health, chat: null, verification };

  let requestAttempted = false;
  try {
    const chatOrigin = origin ?? corsOrigins[0];
    verification.chat = false;
    if (action) verification.action = false;
    requestAttempted = true;
    const response = await get('/chat', { method: 'POST', headers: {
      'Content-Type': 'application/json', ...(chatOrigin ? { Origin: chatOrigin } : {})
    }, body: JSON.stringify({ message: action?.message ?? 'Hola. Responde con un saludo breve sin ejecutar ninguna acción.', history: [] }) });
    const body = await response.json();
    if (!response.ok || typeof body?.reply !== 'string' || !body.reply.trim()) {
      const code = /^[a-z_]{2,48}$/.test(body?.error ?? '') ? ' ' + body.error : '';
      throw new Error(`Chat check failed (HTTP ${response.status}${code}).`);
    }
    if (chatOrigin && response.headers.get('access-control-allow-origin') !== chatOrigin) throw new Error('CORS header missing on the chat response.');
    verification.chat = true;
    verification.chatStatus = 'pass';
    if (action) {
      verification.action = body.action?.id === action.id &&
        JSON.stringify(Object.entries(body.action?.params ?? {}).sort()) === JSON.stringify(Object.entries(action.params ?? {}).sort());
      verification.actionStatus = verification.action ? 'pass' : 'failed';
      if (!verification.action) throw new Error(`Chat reply succeeded, but the expected action "${action.id}" was not proposed.`);
    }
    return { health, chat: body, verification };
  } catch (error) {
    if (requestAttempted) {
      if (verification.chatStatus === 'pending') verification.chatStatus = 'failed';
      if (action && verification.actionStatus === 'pending') verification.actionStatus = 'failed';
    } else {
      if (verification.chatStatus === 'pending') verification.chatStatus = 'skipped';
      if (verification.actionStatus === 'pending') verification.actionStatus = 'skipped';
    }
    throw Object.assign(error, { verification });
  }
}
