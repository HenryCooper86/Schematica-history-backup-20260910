// The assistant panel: settings, a message thread, quick actions, and the
// composer. Task 8 fills in send(); this task builds the panel, the toggle,
// and the settings form with its key handling.
import { createSettings, PROVIDERS, EFFORTS } from '../ai/settings.js';
import { makeProvider, probeTools } from '../ai/providers/index.js';
import { listOpenAIModels } from '../ai/providers/openai.js';
import { listOllamaModels } from '../ai/providers/ollama.js';
import { panelHeader, bindCollapsible } from './collapsible.js';
import { escAttr, toast, onPress } from './press.js';

const PRIVACY = 'The board\'s text is sent to the provider you choose. Keys stay in this browser.';
const OLLAMA_HELP = 'For browser access, start Ollama with OLLAMA_ORIGINS including this site\'s origin (or "*").';

export function initAssistant({ store, tools, render, svg }) {
  const panel = document.getElementById('assistant');
  const btn = document.getElementById('btn-assistant');
  const settings = createSettings(localStorage);
  let settingsOpen = false;

  panel.innerHTML = panelHeader('Assistant', 'assistant')
    + '<div id="ai-meta"><span></span>'
    + '<button id="ai-new" class="ai-icon-btn" type="button" title="New thread">&#x21bb;</button>'
    + '<button id="ai-gear" class="ai-icon-btn" type="button" title="Settings" aria-label="Assistant settings">&#x2699;</button></div>'
    + '<form id="ai-settings" hidden>'
    + `<label>Provider<select id="ai-provider">${Object.entries(PROVIDERS).map(([id, p]) => `<option value="${id}">${escAttr(p.name)}</option>`).join('')}</select></label>`
    + '<label>Model<input id="ai-model" type="text" list="ai-models" spellcheck="false" autocomplete="off"><datalist id="ai-models"></datalist></label>'
    + '<label>Base URL<input id="ai-base" type="url" spellcheck="false" autocomplete="off"></label>'
    + '<label>API key<input id="ai-key" type="password" autocomplete="off" placeholder="paste your key"></label>'
    + '<label class="row"><input id="ai-remember" type="checkbox"> Remember the key on this device</label>'
    + `<label>Effort<select id="ai-effort">${EFFORTS.map((e) => `<option value="${e}">${e}</option>`).join('')}</select></label>`
    + `<div class="ai-note">${escAttr(PRIVACY)}</div><div class="ai-note" id="ai-help"></div>`
    + '<div class="ai-buttons"><button id="ai-save" type="submit">Save</button><button id="ai-test" type="button">Test</button>'
    + '<button id="ai-models-btn" type="button">List models</button><button id="ai-forget" type="button">Forget key</button></div>'
    + '</form>'
    + '<div id="ai-thread" role="log" aria-live="polite"></div>'
    + '<div id="ai-actions"><button type="button" data-act="build">Build from a brief</button>'
    + '<button type="button" data-act="fix">Fix checks</button><button type="button" data-act="fill">Fill in details</button></div>'
    + '<div id="ai-composer"><textarea id="ai-input" rows="2" placeholder="Describe a board, or ask for a change" aria-label="Message the assistant"></textarea>'
    + '<button id="ai-send" type="button">Send</button><button id="ai-stop" type="button" hidden>Stop</button></div>'
    + '<div id="ai-usage"></div>';
  bindCollapsible(panel, 'assistant');

  const el = (id) => document.getElementById(id);
  const form = el('ai-settings');
  const meta = panel.querySelector('#ai-meta span');

  function refreshMeta() {
    const s = settings.get();
    meta.textContent = `${PROVIDERS[s.provider].name} · ${s.model || 'no model'}${s.tools === false ? ' · single-shot' : ''}`;
    meta.title = meta.textContent;
  }

  function fillForm() {
    const s = settings.get();
    el('ai-provider').value = s.provider;
    el('ai-model').value = s.model;
    el('ai-base').value = s.baseUrl;
    el('ai-key').value = settings.getKey();
    el('ai-remember').checked = s.remember;
    el('ai-effort').value = s.effort;
    el('ai-key').disabled = !PROVIDERS[s.provider].needsKey;
    el('ai-help').textContent = s.provider === 'ollama' ? OLLAMA_HELP : '';
  }

  function showSettings(on) {
    settingsOpen = on;
    form.hidden = !on;
    if (on) fillForm();
  }

  el('ai-provider').addEventListener('change', () => {
    const provider = el('ai-provider').value;
    settings.set({ provider, model: '', baseUrl: '', tools: null });
    fillForm();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    settings.set({
      provider: el('ai-provider').value,
      model: el('ai-model').value.trim(),
      baseUrl: el('ai-base').value.trim(),
      effort: el('ai-effort').value,
    });
    settings.setKey(el('ai-key').value.trim(), el('ai-remember').checked);
    refreshMeta();
    showSettings(!settings.configured());
    if (settings.configured()) toast('Assistant settings saved.');
  });

  el('ai-forget').addEventListener('click', () => {
    settings.forgetKey();
    el('ai-key').value = '';
    el('ai-remember').checked = false;
    settings.set({ remember: false });
    toast('Key forgotten.');
  });

  el('ai-test').addEventListener('click', async () => {
    const s = { ...settings.get(), provider: el('ai-provider').value, model: el('ai-model').value.trim(), baseUrl: el('ai-base').value.trim() };
    try {
      const ok = await probeTools(makeProvider(s, el('ai-key').value.trim()));
      settings.set({ tools: ok });
      toast(ok ? 'Connected. This model calls tools.' : 'Connected. This model cannot call tools; the assistant will use single-shot mode.');
      refreshMeta();
    } catch (err) {
      toast(`Test failed: ${err.message}${err.hint ? `\n${err.hint}` : ''}`);
    }
  });

  el('ai-models-btn').addEventListener('click', async () => {
    const provider = el('ai-provider').value;
    const baseUrl = el('ai-base').value.trim();
    try {
      const names = provider === 'ollama'
        ? await listOllamaModels({ baseUrl })
        : await listOpenAIModels({ baseUrl, apiKey: el('ai-key').value.trim() });
      el('ai-models').innerHTML = names.map((n) => `<option value="${escAttr(n)}">`).join('');
      toast(names.length ? `${names.length} models listed; pick one in the Model field.` : 'The endpoint listed no models.');
    } catch (err) {
      toast(`Could not list models: ${err.message}${err.hint ? `\n${err.hint}` : ''}`);
    }
  });

  el('ai-gear').addEventListener('click', () => showSettings(!settingsOpen));

  function isOpen() { return !panel.hidden; }
  function open() {
    panel.hidden = false;
    btn.classList.add('active');
    if (!settings.configured()) showSettings(true);
    el('ai-input').focus();
  }
  function close() {
    panel.hidden = true;
    btn.classList.remove('active');
  }
  function toggle() { if (isOpen()) close(); else open(); }
  btn.addEventListener('click', toggle);
  // Like the journey button, opening the assistant is a request to see panels.
  btn.addEventListener('click', () => {
    const app = document.getElementById('app');
    if (app.classList.contains('panels-hidden')) document.getElementById('btn-panels').click();
  }, true);

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    if (e.key.toLowerCase() === 'a') toggle();
  });

  refreshMeta();
  const api = { open, close, toggle, isOpen, send: () => toast('The assistant is not wired up yet.'), settings };
  return api;
}
