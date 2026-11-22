import { randomUUID } from 'node:crypto';
import { askProvider } from '../templates/worker/src/providers/index.mjs';
import { askActionProvider } from '../templates/worker/src/client-actions.mjs';

export async function testProvider({ provider, model, apiKey, actionMode = false }) {
  if (!['mock','openai','gemini'].includes(provider) || typeof model !== 'string' || !/^[\w.:-]{2,100}$/.test(model)) throw new Error('Invalid provider or model.');
  if (provider !== 'mock' && (typeof apiKey !== 'string' || !apiKey || apiKey.length > 1024 || /[\r\n\0]/.test(apiKey))) throw new Error('Provide a valid API key to run a real provider check.');
  const env = { PROVIDER: provider, MODEL: model, BUSINESS_NAME: 'Falco provider check',
    ...(provider === 'gemini' ? { GEMINI_API_KEY: apiKey } : { OPENAI_API_KEY: apiKey }) };
  const context = { env, history: [], instructions: 'Respond with a short greeting and do not propose any action.', message: 'Hello.' };
  let usage;
  context.report = value => { usage = value; };
  try {
    if (actionMode) await askActionProvider({ ...context, actions: [{ id: 'demo.check', description: 'Run a harmless test action', parameters: {} }] });
    else await askProvider(context);
    return { provider, model, ok: true, actionMode, usage: usage ?? null };
  } catch (error) {
    const code = /^[a-z_]{1,48}$/.test(error.code ?? '') ? error.code : 'provider_connection_failed';
    throw new Error('Provider check failed (' + code + '). Diagnostic ID ' + randomUUID().slice(0, 8) + '.');
  }
}
