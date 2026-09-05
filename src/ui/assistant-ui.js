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
const OLLAMA_HELP = 'For browser access, start Ollama with OLLAMA_ORIGINS including this site\'s origin (or "*").'
  + ' Requests ask for a 16k context (num_ctx); the model must support tool calling or Test will switch the assistant to single-shot mode.';

export function initAssistant({ store, tools, render, svg }) {
  const panel = document.getElementById('assistant');
  const btn = document.getElementById('btn-assistant');
  // Reading `window.localStorage` throws outright when site data is blocked,
  // so the settings take a storage that may be null and live in memory.
  let storage = null;
  try { storage = window.localStorage; } catch { storage = null; }
  const settings = createSettings(storage);
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
    // Anthropic has no model list endpoint the browser may call.
    el('ai-models-btn').hidden = s.provider === 'anthropic';
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
    // Model-facing turns from one provider must not replay to another (raw
    // thinking blocks, tool-call ids); the visible thread stays.
    history = [];
    saveThread();
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
  let visible = [];          // what the thread shows: { role, text, undoSnap?, touched? }
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

  const VISIBLE_ROLES = ['user', 'assistant', 'status', 'error'];

  function saveThread() {
    try {
      // The undo snapshot is a whole document and belongs to this session
      // only: a restored thread's chips are dead.
      const shown = visible.slice(-80).map(({ undoSnap, ...m }) => m);
      localStorage.setItem(THREAD_KEY, JSON.stringify({ history, visible: shown, totals }));
    } catch { /* storage may be blocked; the thread lives for this session */ }
  }
  function loadThread() {
    try {
      const t = JSON.parse(localStorage.getItem(THREAD_KEY) || 'null');
      const ok = t && Array.isArray(t.history) && Array.isArray(t.visible)
        && t.history.every((m) => m && typeof m.role === 'string' && Array.isArray(m.content))
        && t.visible.every((m) => m && VISIBLE_ROLES.includes(m.role) && typeof m.text === 'string');
      if (ok) {
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
    const live = !busy && m.undoSnap && store.undoStack.at(-1) === m.undoSnap;
    return `<div class="ai-chips"><button type="button" data-undo="${index}"${live ? '' : ' disabled'}>Undo this</button>`
      + `<button type="button" data-show="${index}">Show changes</button></div>`;
  }

  function renderThread() {
    thread.innerHTML = visible.map((m, i) => {
      if (m.role === 'status') return `<div class="ai-status">${escAttr(m.text)}</div>`;
      return `<div class="ai-msg ${m.role}">${escAttr(m.text)}${m.role === 'assistant' ? chipRow(m, i) : ''}</div>`;
    }).join('');
    thread.querySelectorAll('[data-undo]').forEach((b) => onPress(b, () => { if (!b.disabled && !busy) store.undo(); }));
    thread.querySelectorAll('[data-show]').forEach((b) => onPress(b, () => highlight(visible[Number(b.dataset.show)].touched || [])));
    thread.scrollTop = thread.scrollHeight;
  }

  // A chip is live only while the exact snapshot its reply pushed is still on
  // top of the undo stack, and no request is open: an undo inside the agent's
  // batch would cut it in half. Identity, not depth: an edit that pushes one
  // step and an undo that pops it leave the depth unchanged.
  function refreshChips() {
    thread.querySelectorAll('[data-undo]').forEach((b) => {
      const m = visible[Number(b.dataset.undo)];
      b.disabled = !!busy || !(m?.undoSnap && store.undoStack.at(-1) === m.undoSnap);
    });
  }

  store.subscribe(() => {
    if (store.generation !== generation) {
      generation = store.generation;
      // The board a running request was editing is gone; nothing it returns
      // applies to the new one.
      busy?.abort();
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
    // `inert` takes the chrome out of the tab order as well as the pointer,
    // which pointer-events alone does not; the assistant's own button stays.
    for (const id of ['palette', 'props', 'journey-panel']) document.getElementById(id).inert = on;
    document.querySelectorAll('#toolbar button, #toolbar input').forEach((node) => { if (node.id !== 'btn-assistant') node.inert = on; });
    document.getElementById('app').classList.toggle('ai-busy', on);
    refreshChips();
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
    const gen = store.generation;
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
    // The chip is live only while this exact snapshot stays on top; capture
    // what was there before so an unchanged stack leaves no chip at all.
    const undoTopBefore = store.undoStack.at(-1);
    const undoLenBefore = store.undoStack.length;
    busy = new AbortController();
    setBusy(true);
    input.value = '';
    const run = s.tools === false ? runSingleShot : runRequest;
    // The lock is released in a finally: a throw inside the busy window must
    // not leave the canvas read-only. It reaches the user as an error bubble
    // through the same res.error path a provider failure takes.
    let res;
    try {
      res = await run({
        provider: makeProvider(s, settings.getKey()),
        executor, store, system, history, userText, boardText: board, signal: busy.signal,
        onText: (t) => { reply.text += t; renderThread(); },
        onStatus: (line) => { visible.splice(visible.length - 1, 0, { role: 'status', text: line }); renderThread(); },
      });
    } catch (err) {
      res = { text: '', messages: history, touched: new Set(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stop: 'end', rounds: 0, applied: 0, cutOff: false, error: err };
    } finally {
      busy = null;
      setBusy(false);
    }
    // The board this reply was written against is gone: it has its own thread.
    if (store.generation !== gen) return;
    history = trimHistory(res.messages);
    reply.text = res.text || (res.error ? '' : '(no reply)');
    if (res.cutOff) reply.text += `\n\n(${res.stop === 'aborted' ? 'Stopped' : 'Cut off'}; edits made so far are kept.)`;
    if (res.stop === 'max_tokens') reply.text += '\n\n(The reply hit the length limit.)';
    reply.touched = [...res.touched];
    reply.undoSnap = (store.undoStack.length > undoLenBefore || store.undoStack.at(-1) !== undoTopBefore)
      ? store.undoStack.at(-1)
      : null;
    if (res.error) {
      visible.push({ role: 'error', text: errorText(res.error) });
      if (res.error instanceof ProviderError && (res.error.code === 'auth' || res.error.code === 'model')) showSettings(true);
    }
    // A refusal is not an error on the wire: the reply simply stops. Say so,
    // with whatever explanation the model gave.
    if (res.stop === 'refusal') visible.push({ role: 'error', text: errorText(new ProviderError(res.stopDetails?.explanation || 'The model declined this request.', { code: 'refusal' })) });
    for (const k of Object.keys(totals)) totals[k] += res.usage[k] || 0;
    const priced = s.provider === 'anthropic';
    const lastCost = priced ? estimateCost(s.model, res.usage) : null;
    const threadCost = priced ? estimateCost(s.model, totals) : null;
    usageEl.textContent = `last: ${usageText(res.usage, lastCost)} · thread: ${usageText(totals, threadCost)}`;
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
  // A restored thread keeps its running total; the last reply's usage is not
  // persisted, so only the thread half comes back.
  if (totals.input || totals.output) usageEl.textContent = `thread: ${usageText(totals, null)}`;
  renderThread();
  return { open, close, toggle, isOpen, send, settings };
}
