import { ProviderError, postJson } from './shared.mjs';

export async function openaiProvider({ env, instructions, history, message, fetcher = fetch }) {
  if (!env.OPENAI_API_KEY) throw new ProviderError('provider_not_configured', 503);
  const data = await postJson('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env.MODEL, instructions, input: [
      ...history.map(({role, content}) => ({ role, content })),
      { role: 'user', content: message }
    ], max_output_tokens: 400, store: false })
  }, fetcher);
  const output = data?.output_text || data?.output?.flatMap(item => item.type === 'message' ? (item.content ?? []) : [])
    .filter(part => part.type === 'output_text').map(part => part.text).join('') || '';
  if (typeof output !== 'string' || !output.trim()) throw new ProviderError('provider_empty_response', 502);
  return output.trim();
}
