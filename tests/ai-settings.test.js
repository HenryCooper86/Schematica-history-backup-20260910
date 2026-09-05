import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettings, PROVIDERS, estimateCost, keyStorageKey, SETTINGS_KEY } from '../src/ai/settings.js';

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

test('defaults come from the provider table and merge with what is stored', () => {
  const s = createSettings(fakeStorage());
  assert.deepEqual(s.get(), { provider: 'anthropic', model: 'claude-opus-5', baseUrl: 'https://api.anthropic.com', effort: 'medium', remember: false, tools: null });
  s.set({ provider: 'ollama', model: 'llama3.1' });
  assert.equal(s.get().baseUrl, PROVIDERS.ollama.baseUrl, 'base url follows the provider until set');
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
  s.set({ provider: 'ollama' });
  assert.equal(s.configured(), false, 'ollama needs a model');
  s.set({ model: 'llama3.1' });
  assert.equal(s.configured(), true, 'and no key');
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
