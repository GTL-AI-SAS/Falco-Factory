const positive = (number, max) => Number.isSafeInteger(number) && number >= 1 && number <= max;

export function budgetConfig(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['day','month','breakerSeconds','maintenance','turnstile','turnstileHostname'].includes(key)) ||
      !positive(value.day, 1_000_000) || !positive(value.month, 10_000_000) || value.day > value.month ||
      !positive(value.breakerSeconds, 3600) || typeof value.maintenance !== 'boolean' ||
      typeof value.turnstile !== 'boolean' || (value.turnstile && !/^[a-z0-9.-]{1,253}$/i.test(value.turnstileHostname ?? ''))) {
    throw new Error('Budget requires valid daily and monthly calls, a circuit breaker duration and explicit maintenance / Turnstile settings.');
  }
  return { day: value.day, month: value.month, breakerSeconds: value.breakerSeconds,
    maintenance: value.maintenance, turnstile: value.turnstile, turnstileHostname: value.turnstile ? value.turnstileHostname.toLowerCase() : '' };
}

const empty = () => ({ calls: 0, ok: 0, failures: 0, quota: 0, inputTokens: 0, outputTokens: 0, meteredCalls: 0, kvReads: 0, latencyMs: 0 });
const counter = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const periods = date => [date.slice(0, 10), date.slice(0, 7)];

export class FalcoBudget {
  constructor(state) { this.storage = state.storage; }

  async reserve(raw, today = new Date().toISOString()) {
    const limits = budgetConfig(raw);
    return this.storage.transaction(async transaction => {
      const breaker = await transaction.get('breaker') ?? 0;
      if (breaker > Date.parse(today)) return { allowed: false, reason: 'provider_circuit_open', retryAfter: Math.ceil((breaker - Date.parse(today)) / 1000) };
      const keys = periods(today);
      const [daily, monthly] = await Promise.all(keys.map(key => transaction.get(key).then(value => value ?? empty())));
      if (daily.calls >= limits.day || monthly.calls >= limits.month) return { allowed: false, reason: 'budget_exhausted' };
      daily.calls++; monthly.calls++;
      await transaction.put({ [keys[0]]: daily, [keys[1]]: monthly });
      if (!await transaction.get('retention')) await transaction.put('retention', today.slice(0, 7));
      return { allowed: true, period: today };
    });
  }

  async record({ period, status, timing, usage, kvReads, breakerSeconds }) {
    return this.storage.transaction(async transaction => {
      const updates = {};
      for (const key of periods(period)) {
        const metrics = await transaction.get(key) ?? empty();
        metrics[status === 'ok' ? 'ok' : 'failures']++;
        if (status === 'provider_rate_limited') metrics.quota++;
        if (usage) {
          metrics.meteredCalls++;
          metrics.inputTokens += counter(usage.input);
          metrics.outputTokens += counter(usage.output);
        }
        metrics.kvReads += counter(kvReads);
        metrics.latencyMs += counter(timing);
        updates[key] = metrics;
      }
      if (status === 'provider_rate_limited') updates.breaker = Date.now() + breakerSeconds * 1000;
      const month = new Date().toISOString().slice(0, 7);
      if (await transaction.get('retention') !== month) {
        const cutoff = new Date();
        cutoff.setUTCMonth(cutoff.getUTCMonth() - 11, 1);
        const oldest = cutoff.toISOString().slice(0, 7);
        const past = await transaction.list({ end: oldest, limit: 1000 });
        const keys = [...past.keys()].filter(key => /^\d{4}-\d{2}(-\d{2})?$/.test(key));
        if (keys.length) await transaction.delete(keys);
        updates.retention = month;
      }
      await transaction.put(updates);
    });
  }

  async summary() {
    const now = new Date().toISOString();
    const [day, month, breakerUntil] = await Promise.all([...periods(now), 'breaker'].map(key => this.storage.get(key)));
    return { day: day ?? empty(), month: month ?? empty(), breakerUntil: breakerUntil ?? null, date: now.slice(0, 10) };
  }
}

export function budgetStub(env) {
  return env.FALCO_BUDGET_DO?.getByName('worker');
}

export async function botVerified(request, env, config, token) {
  if (!config?.turnstile) return true;
  if (!env.FALCO_TURNSTILE_SECRET || typeof token !== 'string' || !token || token.length > 2048) return false;
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', signal: AbortSignal.timeout(4000), headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: env.FALCO_TURNSTILE_SECRET, response: token, remoteip: request.headers.get('CF-Connecting-IP') || undefined })
    });
    const result = await response.json();
    return response.ok && result.success === true && result.hostname === config.turnstileHostname && result.action === 'falco_chat';
  } catch { return false; }
}

export async function canReadUsage(request, env) {
  const key = env.FALCO_OPS_KEY;
  const header = request.headers.get('Authorization');
  if (typeof key !== 'string' || key.length < 32 || !header?.startsWith('Bearer ') || header.length > 1100) return false;
  const encode = value => new TextEncoder().encode(value);
  const [received, expected] = await Promise.all([header.slice(7), key].map(value => crypto.subtle.digest('SHA-256', encode(value))));
  if (typeof crypto.subtle.timingSafeEqual === 'function') return crypto.subtle.timingSafeEqual(received, expected);
  const a = new Uint8Array(received);
  const b = new Uint8Array(expected);
  return a.reduce((difference, value, index) => difference | (value ^ b[index]), 0) === 0;
}

export function providerUsage(record, provider, report) {
  const input = provider === 'gemini' ? record?.usageMetadata?.promptTokenCount : record?.usage?.input_tokens;
  const output = provider === 'gemini' ? ((record?.usageMetadata?.candidatesTokenCount ?? 0) + (record?.usageMetadata?.thoughtsTokenCount ?? 0)) : record?.usage?.output_tokens;
  if (Number.isSafeInteger(input) && Number.isSafeInteger(output) && input >= 0 && output >= 0) report?.({ input, output });
}
