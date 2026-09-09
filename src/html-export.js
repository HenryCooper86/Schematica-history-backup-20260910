import { getTheme } from './theme.js';
import { buildExportSVG, exportBounds } from './export.js';
import { esc } from './render.js';
import { nodeRect } from './geometry.js';
import { resolveStep } from './journey.js';
import { connectionFocus } from './explore.js';
import { BUSES, BUS_ORDER } from './buses.js';
import { tr, trd, getLang } from './i18n.js';

// This function is embedded verbatim. It must depend only on its argument and
// browser APIs, so the downloaded file works offline without modules or assets.
function offlineViewer(data, focusGraph) {
  const svg = document.querySelector('svg');
  const search = document.getElementById('search');
  const results = document.getElementById('results');
  const bus = document.getElementById('bus');
  const connections = document.getElementById('connections');
  const chapters = document.getElementById('chapters');
  const caption = document.getElementById('caption');
  let selected = new Set();
  let story = null;
  let bounds = { ...data.bounds };
  function paint() {
    const focus = focusGraph(data.doc, { bus: bus.value, connections: connections.value }, selected);
    for (const el of svg.querySelectorAll('.node, .wire')) {
      const matches = story ? story.includes(el.dataset.id) : (el.dataset.type === 'node' ? focus.nodes : focus.wires).has(el.dataset.id);
      el.classList.toggle('muted', (story || focus.active) && !matches);
      el.classList.toggle('focused', (story || focus.active || selected.has(el.dataset.id)) && matches);
    }
  }
  function view(rect) {
    bounds = { ...rect };
    svg.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`);
  }
  function frame(rect) {
    view({ x: rect.x - 60, y: rect.y - 60, w: rect.w + 120, h: rect.h + 120 });
  }
  function choose(id) {
    const node = data.nodes.find(n => n.id === id);
    if (!node) return;
    selected = new Set([id]); story = null; chapters.value = ''; caption.textContent = '';
    paint(); frame(node.rect);
  }
  function find() {
    const words = search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    results.replaceChildren(new Option(data.labels.results, ''));
    for (const node of data.nodes.filter(n => words.every(w => n.search.includes(w))).slice(0, 100)) results.add(new Option(node.label, node.id));
  }
  function chapter() {
    const step = data.steps.find(s => s.id === chapters.value);
    if (!step) { story = null; caption.textContent = ''; paint(); return; }
    selected.clear(); story = step.ids.length ? step.ids : null;
    caption.textContent = step.caption;
    const r = svg.getBoundingClientRect();
    const w = r.width / step.view.zoom, h = r.height / step.view.zoom;
    view({ x: step.view.cx - w / 2, y: step.view.cy - h / 2, w, h });
    paint();
    history.replaceState(null, '', '#step=' + encodeURIComponent(step.id));
  }
  search.addEventListener('input', find);
  search.addEventListener('keydown', e => { if (e.key === 'Enter' && results.options.length > 1) choose(results.options[1].value); });
  results.addEventListener('change', () => choose(results.value));
  for (const el of [bus, connections]) el.addEventListener('change', () => { story = null; chapters.value = ''; caption.textContent = ''; paint(); });
  document.getElementById('fit').addEventListener('click', () => view(data.bounds));
  document.getElementById('reset').addEventListener('click', () => {
    selected.clear(); story = null; bus.value = ''; connections.value = 'all'; search.value = ''; chapters.value = ''; caption.textContent = '';
    history.replaceState(null, '', location.pathname + location.search); find(); paint(); view(data.bounds);
  });
  chapters.addEventListener('change', chapter);
  for (const [id, delta] of [['previous', -1], ['next', 1]]) document.getElementById(id).addEventListener('click', () => {
    const i = data.steps.findIndex(s => s.id === chapters.value);
    const next = i + delta;
    if (next < 0 || next >= data.steps.length) return;
    chapters.value = data.steps[next].id; chapter();
  });
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const w = Math.min(data.bounds.w * 10, Math.max(40, bounds.w * factor));
    const h = bounds.h * w / bounds.w;
    view({ x: bounds.x + (bounds.w - w) / 2, y: bounds.y + (bounds.h - h) / 2, w, h });
  }, { passive: false });
  let drag = null, dragged = false;
  svg.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, bounds: { ...bounds }, node: e.target.closest('.node')?.dataset.id }; dragged = false; svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) < 4) return;
    dragged = true;
    const r = svg.getBoundingClientRect();
    const scale = Math.max(drag.bounds.w / r.width, drag.bounds.h / r.height);
    view({ ...drag.bounds, x: drag.bounds.x - dx * scale, y: drag.bounds.y - dy * scale });
  });
  svg.addEventListener('pointerup', () => { if (!dragged && drag?.node) choose(drag.node); drag = null; });
  svg.addEventListener('pointercancel', () => { drag = null; });
  document.getElementById('download').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data.doc, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'board.schematica.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  find(); view(data.bounds);
  const step = new URLSearchParams(location.hash.slice(1)).get('step');
  if (data.steps.some(s => s.id === step)) { chapters.value = step; chapter(); }
}

export function buildHTML(doc, options = {}) {
  const json = (value) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const option = (value, label) => `<option value="${esc(value)}">${esc(label)}</option>`;
  const light = (options.theme || getTheme()) === 'light';
  const data = { doc, bounds: exportBounds(doc), labels: { results: tr('Choose a matching part') },
    nodes: doc.nodes.map(n => ({ id: n.id, label: [n.label, n.sublabel].filter(Boolean).join(' — '), rect: nodeRect(n),
      search: [n.label, n.sublabel, n.addr, n.rail, n.notes, ...Object.values(n.fields || {})].filter(Boolean).join(' ').toLowerCase() })),
    steps: (doc.journey || []).map(s => { const r = resolveStep(doc, s); return { ...s, view: r.view, ids: [...r.ids] }; }) };
  return `<!doctype html><html lang="${getLang()}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.title)}</title><style>
*{box-sizing:border-box}body{margin:0;background:${light ? '#f8fafc' : '#0a0e17'};color:${light ? '#1e293b' : '#e6ebf4'};font:14px system-ui}header{padding:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:${light ? '#e8eef6' : '#131a2b'}}h1{font-size:16px;margin:0 12px 0 0}label{font-size:12px;display:flex;gap:5px;align-items:center}input,select,button{font:inherit;max-width:240px;background:${light ? '#fff' : '#0d1220'};color:inherit;border:1px solid ${light ? '#b5c1d2' : '#2c3a5c'};border-radius:6px;padding:6px}button{cursor:pointer}:focus-visible{outline:2px solid #38bdf8}main{height:calc(100dvh - 150px);min-height:280px}svg{width:100%;height:100%;touch-action:none;user-select:none}.muted{opacity:.2}.wire.focused:not(.invalid) .vis{stroke:#38bdf8;stroke-width:3}.node.focused .card{stroke:#38bdf8;stroke-width:2}.node{cursor:pointer}#caption{padding:12px;white-space:pre-wrap;max-height:120px;overflow:auto}
</style><header><h1>${esc(doc.title)}</h1>
<label>${esc(tr('Search this board'))}<input id="search" type="search"></label><select id="results" aria-label="${esc(tr('Choose a matching part'))}"></select>
<label>${esc(tr('Bus filter'))}<select id="bus">${option('', tr('All buses'))}${BUS_ORDER.map(id => option(id, BUSES[id].short + ' — ' + trd(BUSES[id].name))).join('')}</select></label>
<label>${esc(tr('Connections'))}<select id="connections">${option('all', tr('All parts'))}${option('neighbors', tr('Immediate neighbors'))}${option('network', tr('Connected network'))}</select></label>
<button id="fit">${esc(tr('Fit diagram'))}</button><button id="reset">${esc(tr('Reset exploration'))}</button><button id="download">${esc(tr('Download board'))}</button>
<label>${esc(tr('Journey'))}<select id="chapters">${option('', tr('Choose a journey step'))}${data.steps.map(s => option(s.id, s.label)).join('')}</select></label><button id="previous" aria-label="${esc(tr('Previous step'))}">←</button><button id="next" aria-label="${esc(tr('Next step'))}">→</button></header>
<main>${buildExportSVG(doc, options)}</main><div id="caption" role="status"></div>
<script id="board-data" type="application/json">${json(data)}</script>
<script>(${offlineViewer.toString()})(JSON.parse(document.getElementById('board-data').textContent), ${connectionFocus.toString()});</script></html>`;
}
