// The assistant panel: settings, a message thread, quick actions, and the
// composer. One reply is one undo step: the agent owns the store batch, the
// panel only shows what happened and points the camera at it.
import { createSettings, PROVIDERS, EFFORTS, estimateCost, THREAD_KEY } from '../ai/settings.js';
import { makeProvider, probeTools } from '../ai/providers/index.js';
import { listOpenAIModels } from '../ai/providers/openai.js';
import { listOllamaModels } from '../ai/providers/ollama.js';
import { runRequest, runSingleShot } from '../ai/agent.js';
import { createExecutor } from '../ai/tools.js';
import { boardText } from '../ai/context.js';
import { stableSystem, perRequestSystem } from '../ai/prompt.js';
import { ProviderError } from '../ai/providers/errors.js';
import { checkDoc } from '../drc.js';
import { contentBounds, nodeRect, NOTE_W, noteHeight } from '../geometry.js';
import { findItem } from '../state.js';
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

  // ---- Thread ----
  const thread = el('ai-thread');
  const input = el('ai-input');
  const sendBtn = el('ai-send');
  const stopBtn = el('ai-stop');
  const usageEl = el('ai-usage');
  let history = [];          // provider-facing messages
  let visible = [];          // what the thread shows: { role, text, undoDepth?, touched? }
  let busy = null;           // AbortController while a request runs
  let generation = store.generation;
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const stable = stableSystem();

  // Keep the last 40 model-facing messages, but never cut between a
  // tool_use and its results: start at a user message that carries text.
  function trimHistory(h, max = 40) {
    if (h.length <= max) return h;
    let start = h.length - max;
    while (start < h.length && !(h[start].role === 'user' && h[start].content.some((b) => b.type === 'text'))) start += 1;
    return h.slice(start);
  }

  function saveThread() {
    try {
      localStorage.setItem(THREAD_KEY, JSON.stringify({ history, visible: visible.slice(-80), totals }));
    } catch { /* storage may be blocked; the thread lives for this session */ }
  }
  function loadThread() {
    try {
      const t = JSON.parse(localStorage.getItem(THREAD_KEY) || 'null');
      if (t && Array.isArray(t.history) && Array.isArray(t.visible)) {
        history = t.history;
        visible = t.visible;
        Object.assign(totals, t.totals || {});
      }
    } catch { /* corrupt thread: start fresh */ }
  }
  function clearThread() {
    history = [];
    visible = [];
    for (const k of Object.keys(totals)) totals[k] = 0;
    try { localStorage.removeItem(THREAD_KEY); } catch { /* fine */ }
    renderThread();
    usageEl.textContent = '';
  }

  function chipRow(m, index) {
    if (!m.touched?.length) return '';
    const live = m.undoDepth > 0 && store.undoStack.length === m.undoDepth;
    return `<div class="ai-chips"><button type="button" data-undo="${index}"${live ? '' : ' disabled'}>Undo this</button>`
      + `<button type="button" data-show="${index}">Show changes</button></div>`;
  }

  function renderThread() {
    thread.innerHTML = visible.map((m, i) => {
      if (m.role === 'status') return `<div class="ai-status">${escAttr(m.text)}</div>`;
      return `<div class="ai-msg ${m.role}">${escAttr(m.text)}${m.role === 'assistant' ? chipRow(m, i) : ''}</div>`;
    }).join('');
    thread.querySelectorAll('[data-undo]').forEach((b) => onPress(b, () => { if (!b.disabled) store.undo(); }));
    thread.querySelectorAll('[data-show]').forEach((b) => onPress(b, () => highlight(visible[Number(b.dataset.show)].touched || [])));
    thread.scrollTop = thread.scrollHeight;
  }

  function refreshChips() {
    thread.querySelectorAll('[data-undo]').forEach((b) => {
      const m = visible[Number(b.dataset.undo)];
      b.disabled = !(m?.undoDepth > 0 && store.undoStack.length === m.undoDepth);
    });
  }

  store.subscribe(() => {
    if (store.generation !== generation) {
      generation = store.generation;
      clearThread();
      return;
    }
    refreshChips();
  });

  // ---- Canvas feedback ----
  function highlight(ids) {
    tools.ui.highlight.clear();
    for (const id of ids) tools.ui.highlight.add(id);
    render('overlay');
  }

  function itemRect(id) {
    const doc = store.doc;
    const n = doc.nodes.find((x) => x.id === id);
    if (n) return nodeRect(n);
    const z = doc.zones.find((x) => x.id === id);
    if (z) return { x: z.x, y: z.y, w: z.w, h: z.h };
    const t = doc.notes.find((x) => x.id === id);
    if (t) return { x: t.x, y: t.y, w: NOTE_W, h: noteHeight(t.text) };
    return null;
  }

  // Pan the least that brings the touched items into view; fit if the board
  // was empty when the request started.
  function showTouched(ids, wasEmpty) {
    if (wasEmpty) { tools.zoomFit(); return; }
    const rects = ids.map(itemRect).filter(Boolean);
    if (!rects.length) return;
    const b = contentBounds({ nodes: [], zones: rects, notes: [] });
    const r = svg.getBoundingClientRect();
    const { zoom } = tools.view;
    const M = 40;
    const sx1 = b.x * zoom + tools.view.x;
    const sy1 = b.y * zoom + tools.view.y;
    const sx2 = (b.x + b.w) * zoom + tools.view.x;
    const sy2 = (b.y + b.h) * zoom + tools.view.y;
    let dx = 0;
    let dy = 0;
    if (sx1 < M) dx = M - sx1; else if (sx2 > r.width - M) dx = r.width - M - sx2;
    if (sy1 < M) dy = M - sy1; else if (sy2 > r.height - M) dy = r.height - M - sy2;
    if (dx || dy) { tools.view.x += dx; tools.view.y += dy; render('view'); }
  }

  // ---- Sending ----
  function errorText(err) {
    if (err instanceof ProviderError) {
      const lead = {
        auth: 'The provider rejected the key.',
        rate: 'The provider is rate-limiting requests; try again in a moment.',
        network: 'Could not reach the provider.',
        model: 'The model was not found.',
        context: 'The thread is too long for the model; start a new thread.',
        refusal: 'The model declined this request.',
      }[err.code] || 'The request failed.';
      return `${lead} ${err.message}${err.hint ? `\n${err.hint}` : ''}`;
    }
    return err?.message || String(err);
  }

  // While a request runs the canvas is read-only: a drag, an Escape, or a
  // toolbar edit aliases the same store batch and would cut the reply's
  // single undo step in half.
  function setBusy(on) {
    sendBtn.hidden = on;
    stopBtn.hidden = !on;
    input.disabled = on;
    el('ai-actions').querySelectorAll('button').forEach((b) => { b.disabled = on; });
    tools.ui.locked = on;
    document.getElementById('app').classList.toggle('ai-busy', on);
  }

  function usageText(u, cost) {
    let s = `${u.input.toLocaleString()} in · ${u.output.toLocaleString()} out`;
    if (u.cacheRead) s += ` · ${u.cacheRead.toLocaleString()} cached`;
    if (cost !== null) s += ` · ≈ $${cost.toFixed(cost < 0.01 ? 4 : 2)} (estimate)`;
    return s;
  }

  async function send(text) {
    const userText = String(text ?? '').trim();
    if (!userText || busy) return;
    if (!settings.configured()) { open(); showSettings(true); toast('Add a provider and key first.'); return; }
    const s = settings.get();
    const wasEmpty = !store.doc.nodes.length && !store.doc.zones.length && !store.doc.notes.length;
    const executor = createExecutor({
      getDoc: () => store.doc,
      commit: (fn) => store.mutate(fn),
      selection: () => [...store.selection],
    });
    const board = boardText(store.doc, { selection: [...store.selection], findings: checkDoc(store.doc) });
    const system = [stable, perRequestSystem({ date: new Date().toISOString().slice(0, 10), effort: s.effort, singleShot: s.tools === false })];
    visible.push({ role: 'user', text: userText });
    const reply = { role: 'assistant', text: '' };
    visible.push(reply);
    renderThread();
    busy = new AbortController();
    setBusy(true);
    input.value = '';
    const run = s.tools === false ? runSingleShot : runRequest;
    const res = await run({
      provider: makeProvider(s, settings.getKey()),
      executor, store, system, history, userText, boardText: board, signal: busy.signal,
      onText: (t) => { reply.text += t; renderThread(); },
      onStatus: (line) => { visible.splice(visible.length - 1, 0, { role: 'status', text: line }); renderThread(); },
    });
    busy = null;
    setBusy(false);
    history = trimHistory(res.messages);
    reply.text = res.text || (res.error ? '' : '(no reply)');
    if (res.cutOff) reply.text += `\n\n(${res.stop === 'aborted' ? 'Stopped' : 'Cut off'}; edits made so far are kept.)`;
    if (res.stop === 'max_tokens') reply.text += '\n\n(The reply hit the length limit.)';
    reply.touched = [...res.touched];
    reply.undoDepth = res.touched.size ? store.undoStack.length : 0;
    if (res.error) {
      visible.push({ role: 'error', text: errorText(res.error) });
      if (res.error instanceof ProviderError && (res.error.code === 'auth' || res.error.code === 'model')) showSettings(true);
    }
    for (const k of Object.keys(totals)) totals[k] += res.usage[k] || 0;
    usageEl.textContent = `last: ${usageText(res.usage, s.provider === 'anthropic' ? estimateCost(s.model, res.usage) : null)}`;
    // A removed part must not linger in the selection.
    const kept = [...store.selection].filter((id) => findItem(store.doc, id));
    if (kept.length !== store.selection.size) store.setSelection(kept);
    renderThread();
    saveThread();
    if (res.touched.size) {
      highlight(res.touched);
      showTouched([...res.touched], wasEmpty);
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input.value);
    }
  });
  sendBtn.addEventListener('click', () => send(input.value));
  stopBtn.addEventListener('click', () => busy?.abort());
  el('ai-new').addEventListener('click', () => { if (!busy) clearThread(); });

  const ACTIONS = {
    build: () => {
      input.value = 'Build a board for: \nMust have: \nPower: \nConnectivity: ';
      input.focus();
      input.setSelectionRange(19, 19);
    },
    fix: () => {
      const findings = checkDoc(store.doc);
      if (!findings.length) { toast('The board passes every check.'); return; }
      send(`Fix these findings:\n${findings.map((f) => `${f.level} ${f.rule} "${f.message}" ids: ${f.ids.join(' ')}`).join('\n')}`);
    },
    fill: () => send('Fill in blank part numbers, addresses, rails, and notes from the presets. Change nothing else.'),
  };
  el('ai-actions').querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => ACTIONS[b.dataset.act]());
  });

  document.addEventListener('schematica:fix-finding', (e) => {
    const f = e.detail;
    open();
    send(`Fix this finding: ${f.level} ${f.rule} "${f.message}" ids: ${f.ids.join(' ')}`);
  });

  loadThread();
  renderThread();
  return { open, close, toggle, isOpen, send, settings };
}
