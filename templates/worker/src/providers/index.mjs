import { mockProvider } from './mock.mjs';
import { openaiProvider } from './openai.mjs';
import { geminiProvider } from './gemini.mjs';
import { ProviderError } from './shared.mjs';
const ADAPTERS = { mock: mockProvider, openai: openaiProvider, gemini: geminiProvider };
export async function askProvider(context) {
  const fn = ADAPTERS[context.env.PROVIDER];
  if (!fn) throw new ProviderError('provider_not_supported', 503);
  return fn(context);
}
