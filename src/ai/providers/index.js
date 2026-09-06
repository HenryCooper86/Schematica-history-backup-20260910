import { PROVIDERS } from '../settings.js';
import { anthropicProvider } from './anthropic.js';
import { openaiProvider } from './openai.js';
import { ollamaProvider } from './ollama.js';

// A provider is a vendor entry in PROVIDERS; its `adapter` names the wire
// format, so several vendors share one adapter (Z.AI, Kimi, and OpenRouter
// all speak chat completions; Ollama Cloud speaks the Ollama API with a key,
// through the relay in relay/).
export function makeProvider(settings, key, fetchImpl = globalThis.fetch) {
  const { provider, model, baseUrl, effort } = settings;
  const entry = Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider] : null;
  const adapter = entry?.adapter;
  // A provider that needs no key never gets one on the wire.
  const apiKey = entry?.needsKey ? key : '';
  if (adapter === 'anthropic') return anthropicProvider({ baseUrl, apiKey, model, effort, fetchImpl });
  if (adapter === 'openai') return openaiProvider({ baseUrl, apiKey, model, fetchImpl });
  if (adapter === 'ollama') return ollamaProvider({ baseUrl, apiKey, model, fetchImpl });
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
