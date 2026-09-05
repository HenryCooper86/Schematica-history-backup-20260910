import { anthropicProvider } from './anthropic.js';
import { openaiProvider } from './openai.js';
import { ollamaProvider } from './ollama.js';

export function makeProvider(settings, key, fetchImpl = globalThis.fetch) {
  const { provider, model, baseUrl, effort } = settings;
  if (provider === 'anthropic') return anthropicProvider({ baseUrl, apiKey: key, model, effort, fetchImpl });
  if (provider === 'openai') return openaiProvider({ baseUrl, apiKey: key, model, fetchImpl });
  if (provider === 'ollama') return ollamaProvider({ baseUrl, model, fetchImpl });
  throw new Error(`unknown provider "${provider}"`);
}

// Does this model call tools? Ask it to call one; a model that answers in
// text instead gets the single-shot mode.
export async function probeTools(provider) {
  const res = await provider.chat({
    system: ['You are a test harness. Call the ping tool now and say nothing else.'],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Call ping.' }] }],
    tools: [{ name: 'ping', description: 'Replies pong.', input_schema: { type: 'object', properties: {}, additionalProperties: false }, strict: true }],
  });
  return res.toolCalls.some((c) => c.name === 'ping');
}
