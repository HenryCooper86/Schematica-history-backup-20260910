// Provider settings and the key. Storage is injected (localStorage in the
// browser, a Map in tests) and every access is guarded: storage may be
// blocked. The key lives in memory unless "remember" is ticked, and never
// touches the document, autosave, share links, or exports.

export const PROVIDERS = {
  anthropic: { name: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5', needsKey: true },
  openai: { name: 'OpenAI-compatible', baseUrl: 'https://api.openai.com/v1', model: '', needsKey: true },
  ollama: { name: 'Ollama (local)', baseUrl: 'http://localhost:11434', model: '', needsKey: false },
};
export const EFFORTS = ['low', 'medium', 'high'];
export const SETTINGS_KEY = 'schematica.ai.settings';
export const THREAD_KEY = 'schematica.ai.thread';
export const keyStorageKey = (provider) => `schematica.ai.key.${provider}`;

// Dollars per million tokens. An estimate: the panel labels it as one.
export const PRICES = {
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export function estimateCost(model, usage) {
  const p = PRICES[model];
  if (!p) return null;
  return (usage.input * p.input + usage.output * p.output + usage.cacheRead * p.cacheRead + usage.cacheWrite * p.cacheWrite) / 1e6;
}

const DEFAULTS = { provider: 'anthropic', model: '', baseUrl: '', effort: 'medium', remember: false, tools: null };

export function createSettings(storage) {
  const read = (k) => { try { return storage.getItem(k); } catch { return null; } };
  const write = (k, v) => { try { storage.setItem(k, v); } catch { /* blocked storage: the session still works */ } };
  const remove = (k) => { try { storage.removeItem(k); } catch { /* same */ } };

  // Read on every call: a test may seed storage after the page loaded, and
  // another tab may have changed it.
  const readStored = () => { try { return JSON.parse(read(SETTINGS_KEY) || '{}') || {}; } catch { return {}; } };
  const memoryKeys = {};

  function get() {
    const s = { ...DEFAULTS, ...readStored() };
    const p = PROVIDERS[s.provider] || PROVIDERS.anthropic;
    if (!PROVIDERS[s.provider]) s.provider = 'anthropic';
    if (!s.model) s.model = p.model;
    if (!s.baseUrl) s.baseUrl = p.baseUrl;
    if (!EFFORTS.includes(s.effort)) s.effort = 'medium';
    return s;
  }

  function set(patch) {
    write(SETTINGS_KEY, JSON.stringify({ ...readStored(), ...patch }));
  }

  function getKey() {
    const provider = get().provider;
    if (memoryKeys[provider] !== undefined) return memoryKeys[provider];
    return get().remember ? (read(keyStorageKey(provider)) || '') : '';
  }

  function setKey(key, remember) {
    const provider = get().provider;
    memoryKeys[provider] = key;
    set({ remember: !!remember });
    if (remember && key) write(keyStorageKey(provider), key);
    else remove(keyStorageKey(provider));
  }

  function forgetKey() {
    const provider = get().provider;
    memoryKeys[provider] = '';
    remove(keyStorageKey(provider));
  }

  function configured() {
    const s = get();
    if (!s.model) return false;
    return !PROVIDERS[s.provider].needsKey || !!getKey();
  }

  return { get, set, getKey, setKey, forgetKey, configured };
}
