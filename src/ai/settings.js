// Provider settings and the key. Storage is injected (localStorage in the
// browser, a Map in tests) and every access is guarded: storage may be
// blocked. The key lives in memory unless "remember" is ticked, and never
// touches the document, autosave, share links, or exports.

// Each provider names the adapter that speaks its wire format (`anthropic`,
// `openai` for every chat-completions endpoint, `ollama` for ollama.com's
// own API), its public base URL, whether a key is needed, a default
// model, and a few suggested model ids for the settings form. Endpoints and
// model names were taken from the vendors' documentation in September 2026;
// "List models" fetches the live catalogue where the endpoint offers one.
// ollama.com answers a CORS preflight with 405 and api.moonshot.ai sends no
// allow-origin header (both verified 2026-09-06), so no browser page can call
// them directly. Those two providers go through the relay in relay/: a small
// Cloudflare Worker that forwards the request, key included, and adds the
// headers. This is the deployment's own relay; the Base URL field takes any
// other (relay/README.md deploys one in two commands).
export const RELAY = 'https://schematica-relay.henrycooper86.workers.dev';

export const PROVIDERS = {
  anthropic: {
    name: 'Anthropic (Claude)', adapter: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5', needsKey: true,
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    help: 'Keys come from console.anthropic.com. Claude Opus 5 is the default; Sonnet 5 is cheaper, Haiku 4.5 runs without adaptive thinking.',
  },
  openai: {
    name: 'OpenAI-compatible', adapter: 'openai', baseUrl: 'https://api.openai.com/v1', model: '', needsKey: true,
    models: [],
    help: 'Any endpoint that speaks chat completions with function calling, a local Ollama at http://localhost:11434/v1 included (start it with OLLAMA_ORIGINS set to this site\'s origin). Set the base URL and pick a model; "List models" asks the endpoint.',
  },
  openrouter: {
    name: 'OpenRouter', adapter: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: '', needsKey: true,
    models: [],
    help: 'One key for hundreds of models; "List models" fetches the catalogue. Keys come from openrouter.ai/keys.',
  },
  zai: {
    name: 'Z.AI (GLM)', adapter: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-5.3', needsKey: true,
    models: ['glm-5.3', 'glm-4.6', 'glm-4.5', 'glm-4.5-Air'],
    help: 'Z.AI\'s GLM models over their OpenAI-compatible endpoint. Keys come from z.ai.',
  },
  kimi: {
    name: 'Kimi (Moonshot)', adapter: 'openai', baseUrl: `${RELAY}/api.moonshot.ai/v1`, model: 'kimi-k3', needsKey: true,
    models: ['kimi-k3', 'kimi-k2.6', 'kimi-k2.7-code'],
    help: 'Moonshot\'s Kimi models over their OpenAI-compatible endpoint, through the relay because api.moonshot.ai does not answer browser requests. Keys come from platform.kimi.ai.',
  },
  ollamacloud: {
    name: 'Ollama Cloud', adapter: 'ollama', baseUrl: `${RELAY}/ollama.com`, model: 'glm-5.3', needsKey: true,
    models: ['glm-5.3', 'glm-5.3-flash', 'kimi-k3', 'gpt-oss:120b', 'qwen3.5:397b', 'deepseek-v4-flash:0731', 'minimax-m3', 'gemma4:31b'],
    help: 'Hosted models at ollama.com; keys come from ollama.com/settings/keys. ollama.com does not answer browser requests, so calls go through the relay (a small Cloudflare Worker; run your own with relay/README.md and put its URL in Base URL). "List models" fetches the catalogue.',
  },
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
  // A browser with site data blocked throws on `window.localStorage` itself,
  // so the caller passes null; every access here tolerates that.
  const read = (k) => { try { return storage && storage.getItem(k); } catch { return null; } };
  const write = (k, v) => { try { storage && storage.setItem(k, v); } catch { /* blocked storage: the session still works */ } };
  const remove = (k) => { try { storage && storage.removeItem(k); } catch { /* same */ } };

  // Read on every call: a test may seed storage after the page loaded, and
  // another tab may have changed it. Without storage (site data blocked) the
  // patches live in `memory` for the session; with storage, `memory` stays
  // empty so a seeded value is never shadowed.
  let memory = {};
  const readStored = () => { try { return { ...(JSON.parse(read(SETTINGS_KEY) || '{}') || {}), ...memory }; } catch { return { ...memory }; } };
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
    const next = { ...readStored(), ...patch };
    let stored = false;
    try { if (storage) { storage.setItem(SETTINGS_KEY, JSON.stringify(next)); stored = true; } } catch { /* blocked or full */ }
    if (!stored) memory = next;
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
