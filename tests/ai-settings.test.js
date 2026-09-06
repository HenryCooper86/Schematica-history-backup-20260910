import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettings, PROVIDERS, estimateCost, keyStorageKey, SETTINGS_KEY, RELAY } from '../src/ai/settings.js';

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

test('defaults come from the provider table and merge with what is stored', () => {
  const s = createSettings(fakeStorage());
  assert.deepEqual(s.get(), { provider: 'anthropic', model: 'claude-opus-5', baseUrl: 'https://api.anthropic.com', effort: 'medium', remember: false, tools: null });
  s.set({ provider: 'openrouter', model: 'anthropic/claude-sonnet-5' });
  assert.equal(s.get().baseUrl, PROVIDERS.openrouter.baseUrl, 'base url follows the provider until set');
  s.set({ baseUrl: 'http://box:11434' });
  assert.equal(s.get().baseUrl, 'http://box:11434');
  s.set({ provider: 'openai' });
  assert.equal(s.get().baseUrl, 'http://box:11434', 'an explicit base url is kept when the provider changes');
});

test('the key is stored only when remembered, and forgotten on request', () => {
  const st = fakeStorage();
  const s = createSettings(st);
  s.setKey('sk-1', false);
  assert.equal(s.getKey(), 'sk-1');
  assert.equal(st.getItem(keyStorageKey('anthropic')), null, 'not persisted');
  s.setKey('sk-2', true);
  assert.equal(st.getItem(keyStorageKey('anthropic')), 'sk-2');
  assert.equal(s.get().remember, true);
  s.setKey('sk-3', false);
  assert.equal(st.getItem(keyStorageKey('anthropic')), null, 'unticking removes the stored key');
  assert.equal(s.getKey(), 'sk-3');
  s.forgetKey();
  assert.equal(s.getKey(), '');
  const fresh = createSettings(st);
  assert.equal(fresh.getKey(), '', 'gone after a reload too');
});

test('configured means a model and, where needed, a key', () => {
  const s = createSettings(fakeStorage());
  assert.equal(s.configured(), false, 'no key yet');
  s.setKey('sk', false);
  assert.equal(s.configured(), true);
  s.set({ provider: 'openrouter' });
  assert.equal(s.configured(), false, 'OpenRouter has no default model');
  s.set({ model: 'anthropic/claude-sonnet-5' });
  assert.equal(s.configured(), false, 'keys are per provider: the Anthropic key does not carry over');
  s.setKey('or-key', false);
  assert.equal(s.configured(), true);
});

test('settings persist as JSON and survive a corrupt entry', () => {
  const st = fakeStorage();
  createSettings(st).set({ effort: 'high' });
  assert.equal(JSON.parse(st.getItem(SETTINGS_KEY)).effort, 'high');
  st.setItem(SETTINGS_KEY, '{nope');
  assert.equal(createSettings(st).get().effort, 'medium');
});

test('a browser with storage blocked still boots the assistant', () => {
  const s = createSettings(null);
  assert.equal(s.get().provider, 'anthropic');
  assert.equal(s.get().model, 'claude-opus-5');
  s.setKey('k', true);
  assert.equal(s.getKey(), 'k', 'the key lives in memory for the session');
  s.set({ effort: 'high' });
  s.forgetKey();
  assert.equal(s.getKey(), '');
  assert.equal(s.configured(), false);
});

test('cost estimates use the price table per million tokens', () => {
  const cost = estimateCost('claude-opus-5', { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 0 });
  assert.equal(cost, 5 + 2.5 + 1);
  assert.equal(estimateCost('mystery-model', { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }), null);
});

test('every provider names an adapter, a base url, a key rule, and suggested models', () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    assert.ok(['anthropic', 'openai', 'ollama'].includes(p.adapter), `${id} adapter`);
    assert.match(p.baseUrl, /^https?:\/\//, `${id} base url`);
    assert.equal(typeof p.needsKey, 'boolean', `${id} needsKey`);
    assert.ok(Array.isArray(p.models), `${id} models`);
    assert.equal(typeof p.name, 'string');
  }
  assert.deepEqual(Object.keys(PROVIDERS), ['anthropic', 'openai', 'openrouter', 'zai', 'kimi', 'ollamacloud']);
  assert.equal(PROVIDERS.zai.adapter, 'openai');
  assert.equal(PROVIDERS.zai.baseUrl, 'https://api.z.ai/api/paas/v4');
  assert.equal(PROVIDERS.zai.model, 'glm-5.3');
  assert.equal(PROVIDERS.kimi.baseUrl, `${RELAY}/api.moonshot.ai/v1`, 'api.moonshot.ai sends no CORS headers, so Kimi goes through the relay');
  assert.equal(PROVIDERS.kimi.model, 'kimi-k3');
  assert.equal(PROVIDERS.openrouter.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(PROVIDERS.ollamacloud.adapter, 'ollama');
  assert.equal(PROVIDERS.ollamacloud.baseUrl, `${RELAY}/ollama.com`, 'ollama.com sends no CORS headers, so the browser goes through the relay');
  assert.equal(PROVIDERS.ollamacloud.needsKey, true);
  assert.equal(PROVIDERS.ollamacloud.model, 'glm-5.3', 'ollama.com names cloud models without a :cloud tag');
  assert.match(RELAY, /^https:\/\//);
});

test('switching to a provider with a default model is configured once it has a key', () => {
  const s = createSettings(fakeStorage());
  s.set({ provider: 'kimi' });
  assert.equal(s.get().model, 'kimi-k3');
  assert.equal(s.get().baseUrl, `${RELAY}/api.moonshot.ai/v1`);
  assert.equal(s.configured(), false);
  s.setKey('sk-kimi', false);
  assert.equal(s.configured(), true);
  s.set({ provider: 'ollamacloud' });
  assert.equal(s.get().model, 'glm-5.3');
  assert.equal(s.configured(), false, 'the cloud needs its own key');
  s.setKey('ol-key', false);
  assert.equal(s.configured(), true);
});

// With site data blocked there is no storage at all; the panel must still let
// the user pick a provider and model for the session.
test('without storage, settings live in memory for the session', () => {
  const s = createSettings(null);
  assert.equal(s.get().provider, 'anthropic');
  s.set({ provider: 'ollamacloud', model: 'gpt-oss:120b' });
  assert.equal(s.get().provider, 'ollamacloud');
  assert.equal(s.get().model, 'gpt-oss:120b');
  assert.equal(s.get().baseUrl, `${RELAY}/ollama.com`);
  s.set({ effort: 'high' });
  assert.equal(s.get().effort, 'high');
  assert.equal(s.get().provider, 'ollamacloud', 'a later patch keeps earlier fields');
  assert.equal(s.configured(), false, 'the cloud needs a key');
  s.set({ provider: 'kimi' });
  s.setKey('k', true);
  assert.equal(s.getKey(), 'k');
  assert.equal(s.configured(), true);
});
