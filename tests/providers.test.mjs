import test from 'node:test';
import assert from 'node:assert/strict';
import { openaiProvider } from '../templates/worker/src/providers/openai.mjs';
import { geminiProvider } from '../templates/worker/src/providers/gemini.mjs';
import { ProviderError } from '../templates/worker/src/providers/shared.mjs';

const context = { instructions:'Business FAQ text', history:[{role:'user',content:'Hi'},{role:'assistant',content:'Hello'}], message:'Open today?' };
test('OpenAI Responses API request and output normalization', async () => {
  const result = await openaiProvider({ ...context, env:{OPENAI_API_KEY:'test-key', MODEL:'gpt-5.4-mini'},
    fetcher: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const body = JSON.parse(options.body);
      assert.equal(body.store, false);
      assert.equal(body.max_output_tokens, 400);
      assert.equal(body.instructions, 'Business FAQ text');
      assert.equal(body.input.at(-1).content, 'Open today?');
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      return Response.json({ output:[{ type:'message', content:[{ type:'output_text', text:'Yes, we are.' }] }] });
    } });
  assert.equal(result, 'Yes, we are.');
});
test('Gemini REST payload and output normalization', async () => {
  const result = await geminiProvider({ ...context, env:{GEMINI_API_KEY:'test-key',MODEL:'gemini-3.5-flash-lite'},
    fetcher: async (url, options) => {
      assert.match(url,/gemini-3.5-flash-lite:generateContent/);
      assert.equal(options.headers['x-goog-api-key'],'test-key');
      const body = JSON.parse(options.body);
      assert.deepEqual(body.contents.map(x => x.role), ['user','model','user']);
      assert.equal(body.systemInstruction.parts[0].text, 'Business FAQ text');
      return Response.json({ candidates:[{ content:{parts:[{text:'Sí, '},{text:'claro.'}] } }] });
    } });
  assert.equal(result,'Sí, claro.');
});
test('Provider error body never escapes and 429 is normalized', async () => {
  await assert.rejects(openaiProvider({ ...context, env:{OPENAI_API_KEY:'PRIVATE',MODEL:'gpt-5.4-mini'},
    fetcher: async () => new Response('Sensitive upstream details', { status:429 }) }),
    e => e instanceof ProviderError && e.code === 'provider_rate_limited' && e.status === 503 && !e.message.includes('Sensitive'));
});
test('Provider empty response becomes a controlled error', async () => {
  await assert.rejects(geminiProvider({ ...context, env:{GEMINI_API_KEY:'PRIVATE',MODEL:'gemini-3.5-flash-lite'},
    fetcher: async () => Response.json({ candidates:[] }) }), /provider_empty_response/);
});
