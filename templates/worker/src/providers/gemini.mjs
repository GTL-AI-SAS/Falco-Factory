import { ProviderError, postJson, assertUsableOutput } from './shared.mjs';

export async function geminiProvider({ env, instructions, history, message, fetcher = fetch }) {
  if (!env.GEMINI_API_KEY) throw new ProviderError('provider_not_configured', 503);
  const contents = [...history.map(({role, content}) => ({ role: role === 'assistant' ? 'model' : 'user', parts: [{ text: content }] })),
    { role: 'user', parts: [{ text: message }] }];
  // Gemini's REST conversation history must alternate user/model; merge adjacent turns.
  const normalized = [];
  for (const current of contents) {
    if (normalized.at(-1)?.role === current.role) normalized.at(-1).parts.push(...current.parts);
    else normalized.push(current);
  }
  const data = await postJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.MODEL)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: instructions }] }, contents: normalized,
      generationConfig: { maxOutputTokens: 512, temperature: 0.4 } })
  }, fetcher);
  const output = data?.candidates?.[0]?.content?.parts?.filter(p => typeof p.text === 'string').map(p => p.text).join('') || '';
  return assertUsableOutput(output, { finishReason: data?.candidates?.[0]?.finishReason });
}
