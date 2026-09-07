// The custom part editor: a modal dialog that builds or edits a definition
// with a live preview of the card. Opened from the palette (+ New, or a
// template's pencil), from a custom node's properties (Edit part…), and from
// a built-in node's properties (Customize…). A save onto the board is one
// undo step; the library is updated alongside when the box is ticked.
import { CATEGORIES, PARTS } from '../palette.js';
import { BUSES, BUS_ORDER } from '../buses.js';
import {
  LIMITS, SIDES, initials, normalizePart, draftProblems, optionList, applyDefinition, siblings,
} from '../custom.js';
import { addNode, findItem } from '../state.js';
import { snap, nodeSize } from '../geometry.js';
import { diagramMarkup, defsMarkup } from '../render.js';
import { ACCENT_SWATCHES } from './props.js';
import { badgeHTML } from './badge.js';
import { escAttr, toast, openModal } from './press.js';

export function initPartEditor({ store, library, svg, tools }) {
  const dialog = document.getElementById('part-dialog');
  const $ = (id) => document.getElementById(id);
  let draft = null; // the definition being edited, in the editor's shape
  let ctx = null;   // { nodeId, templateId, mode, others }
  let nextPort = 0;
  let nextField = 0;

  $('pe-category').innerHTML = CATEGORIES.map((c) => `<option value="${c.id}">${escAttr(c.name)}</option>`).join('');
  $('pe-icon-kind').innerHTML = Object.values(PARTS).map((p) => (
    `<button type="button" data-kind="${p.kind}" title="${escAttr(p.name)}">${badgeHTML(p)}</button>`
  )).join('');
  $('pe-swatches').innerHTML = ACCENT_SWATCHES.map((c) => (
    `<button type="button" class="swatch" data-swatch="${c}" style="background:${c}" title="${c}"></button>`
  )).join('') + '<button type="button" class="swatch swatch-auto" data-swatch="" title="Category color">Auto</button>';

  // ---- draft <-> definition ----
  // Rows keep their ids (a customized built-in keeps vcc, i2c, …); new rows
  // get p<n>/f<n> past the highest such id already present.
  function toDraft(def) {
    const top = (arr, prefix) => arr.reduce((n, x) => {
      const m = new RegExp(`^${prefix}(\\d+)$`).exec(x.id || '');
      return m ? Math.max(n, Number(m[1])) : n;
    }, 0);
    const d = {
      lib: def.lib || null,
      name: def.name || '',
      category: CATEGORIES.some((c) => c.id === def.category) ? def.category : 'misc',
      accent: def.accent || null,
      icon: def.icon ? { ...def.icon } : { text: '' },
      ports: (def.ports || []).map((p) => ({ id: p.id, name: p.name || '', side: p.side || 'left', bus: p.bus || 'gpio', required: !!p.required })),
      fields: (def.fields || []).map((f) => ({ id: f.id, label: f.label || '', options: (f.options || []).join(', ') })),
    };
    nextPort = top(d.ports, 'p');
    nextField = top(d.fields, 'f');
    return d;
  }
  function freshId(prefix, list, counter) {
    let n = counter;
    let id;
    do { n += 1; id = `${prefix}${n}`; } while (list.some((x) => x.id === id));
    return { id, n };
  }
  function rawDraft() {
    return {
      ...(draft.lib ? { lib: draft.lib } : {}),
      name: draft.name,
      category: draft.category,
      accent: draft.accent,
      icon: draft.icon,
      ports: draft.ports.map((p) => ({ ...p })),
      fields: draft.fields.map((f) => {
        const out = { id: f.id, label: f.label };
        const options = optionList(f.options);
        if (options.length) out.options = options;
        return out;
      }),
    };
  }

  // ---- rows ----
  function portRow(p, i, n) {
    return `<tr data-i="${i}">`
      + `<td><input type="text" data-pname maxlength="${LIMITS.portName}" value="${escAttr(p.name)}" placeholder="Name" spellcheck="false"></td>`
      + `<td><select data-pside>${SIDES.map((s) => `<option value="${s}"${s === p.side ? ' selected' : ''}>${s}</option>`).join('')}</select></td>`
      + `<td><select data-pbus>${BUS_ORDER.map((b) => `<option value="${b}"${b === p.bus ? ' selected' : ''}>${escAttr(BUSES[b].name)}</option>`).join('')}</select></td>`
      + `<td><label class="dialog-check" title="Check reports this port when it is unwired"><input type="checkbox" data-preq${p.required ? ' checked' : ''}> req</label></td>`
      + `<td class="pe-move"><button type="button" data-up title="Move up"${i === 0 ? ' disabled' : ''}>&uarr;</button>`
      + `<button type="button" data-down title="Move down"${i === n - 1 ? ' disabled' : ''}>&darr;</button>`
      + `<button type="button" data-del title="Remove port">&times;</button></td></tr>`;
  }
  function fieldRow(f, i) {
    return `<tr data-i="${i}">`
      + `<td><input type="text" data-flabel maxlength="${LIMITS.fieldLabel}" value="${escAttr(f.label)}" placeholder="Label" spellcheck="false"></td>`
      + `<td colspan="3"><input type="text" data-fopts value="${escAttr(f.options)}" placeholder="Choices, comma separated (blank = free text)" spellcheck="false"></td>`
      + `<td class="pe-move"><button type="button" data-fdel title="Remove field">&times;</button></td></tr>`;
  }
  const renderPorts = () => { $('pe-ports').innerHTML = draft.ports.map((p, i) => portRow(p, i, draft.ports.length)).join(''); };
  const renderFields = () => { $('pe-fields').innerHTML = draft.fields.map((f, i) => fieldRow(f, i)).join(''); };
  function renderIcon() {
    const tab = draft.icon.kind !== undefined ? 'kind' : (draft.icon.path !== undefined ? 'path' : 'text');
    $('pe-icon-tabs').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $('pe-icon-kind').hidden = tab !== 'kind';
    $('pe-icon-text').hidden = tab !== 'text';
    $('pe-icon-path').hidden = tab !== 'path';
    $('pe-icon-kind').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.kind === draft.icon.kind));
    if (tab === 'text') $('pe-icon-text').value = draft.icon.text ?? '';
    if (tab === 'path') $('pe-icon-path').value = draft.icon.path ?? '';
  }
  function renderSwatches() {
    $('pe-swatches').querySelectorAll('[data-swatch]').forEach((b) => b.classList.toggle('active', (b.dataset.swatch || null) === draft.accent));
  }
  function renderAll() {
    $('pe-name').value = draft.name;
    $('pe-category').value = draft.category;
    renderSwatches();
    renderIcon();
    renderPorts();
    renderFields();
  }

  // ---- preview and validation, on every change ----
  function refresh() {
    const raw = rawDraft();
    const problems = draftProblems(raw);
    $('pe-problems').innerHTML = problems.map((p) => `<li>${escAttr(p)}</li>`).join('');
    $('pe-save').disabled = problems.length > 0;
    // The preview draws even while the name is still blank.
    const { part } = normalizePart({ ...raw, name: raw.name || 'Part' });
    if (!part) return;
    const node = { id: 'preview', kind: 'custom', x: 0, y: 0, label: part.name, sublabel: '', color: null, addr: '', rail: '', notes: '', status: null, flags: [], part };
    const { w, h } = nodeSize(node);
    const preview = $('pe-preview');
    preview.setAttribute('viewBox', `-30 -30 ${w + 60} ${h + 60}`);
    preview.innerHTML = `<defs>${defsMarkup()}</defs>${diagramMarkup({ nodes: [node], wires: [], zones: [], notes: [] }, {})}`;
  }

  // ---- form events ----
  $('pe-name').addEventListener('input', () => { draft.name = $('pe-name').value; refresh(); });
  $('pe-category').addEventListener('change', () => { draft.category = $('pe-category').value; refresh(); });
  $('pe-swatches').addEventListener('click', (e) => {
    const b = e.target.closest('[data-swatch]');
    if (!b) return;
    draft.accent = b.dataset.swatch || null;
    renderSwatches();
    refresh();
  });
  $('pe-icon-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    const tab = b.dataset.tab;
    if (tab === 'kind') draft.icon = { kind: draft.icon.kind || 'generic' };
    if (tab === 'text') draft.icon = { text: draft.icon.text ?? initials(draft.name) };
    if (tab === 'path') draft.icon = { path: draft.icon.path ?? 'M4 4h8v8H4z' };
    renderIcon();
    refresh();
  });
  $('pe-icon-kind').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    draft.icon = { kind: b.dataset.kind };
    renderIcon();
    refresh();
  });
  $('pe-icon-text').addEventListener('input', () => { draft.icon = { text: $('pe-icon-text').value }; refresh(); });
  $('pe-icon-path').addEventListener('input', () => { draft.icon = { path: $('pe-icon-path').value }; refresh(); });

  const rowIndex = (e) => Number(e.target.closest('tr')?.dataset.i);
  $('pe-ports').addEventListener('input', (e) => {
    const p = draft.ports[rowIndex(e)];
    if (!p) return;
    if (e.target.matches('[data-pname]')) p.name = e.target.value;
    refresh();
  });
  $('pe-ports').addEventListener('change', (e) => {
    const p = draft.ports[rowIndex(e)];
    if (!p) return;
    if (e.target.matches('[data-pside]')) p.side = e.target.value;
    if (e.target.matches('[data-pbus]')) {
      p.bus = e.target.value;
      // A supply pin is required unless the user unticks it afterwards.
      p.required = p.bus === 'power' || p.bus === 'gnd';
      e.target.closest('tr').querySelector('[data-preq]').checked = p.required;
    }
    if (e.target.matches('[data-preq]')) p.required = e.target.checked;
    refresh();
  });
  $('pe-ports').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const i = rowIndex(e);
    if (b.hasAttribute('data-del')) draft.ports.splice(i, 1);
    if (b.hasAttribute('data-up') && i > 0) [draft.ports[i - 1], draft.ports[i]] = [draft.ports[i], draft.ports[i - 1]];
    if (b.hasAttribute('data-down') && i < draft.ports.length - 1) [draft.ports[i + 1], draft.ports[i]] = [draft.ports[i], draft.ports[i + 1]];
    renderPorts();
    refresh();
  });
  $('pe-port-add').addEventListener('click', () => {
    if (draft.ports.length >= LIMITS.ports) { toast(`At most ${LIMITS.ports} ports.`); return; }
    const { id, n } = freshId('p', draft.ports, nextPort);
    nextPort = n;
    draft.ports.push({ id, name: '', side: 'left', bus: 'gpio', required: false });
    renderPorts();
    refresh();
    $('pe-ports').querySelector('tr:last-child [data-pname]').focus();
  });
  $('pe-fields').addEventListener('input', (e) => {
    const f = draft.fields[rowIndex(e)];
    if (!f) return;
    if (e.target.matches('[data-flabel]')) f.label = e.target.value;
    if (e.target.matches('[data-fopts]')) f.options = e.target.value;
    refresh();
  });
  $('pe-fields').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !b.hasAttribute('data-fdel')) return;
    draft.fields.splice(rowIndex(e), 1);
    renderFields();
    refresh();
  });
  $('pe-field-add').addEventListener('click', () => {
    if (draft.fields.length >= LIMITS.fields) { toast(`At most ${LIMITS.fields} fields.`); return; }
    const { id, n } = freshId('f', draft.fields, nextField);
    nextField = n;
    draft.fields.push({ id, label: '', options: '' });
    renderFields();
    refresh();
    $('pe-fields').querySelector('tr:last-child [data-flabel]').focus();
  });

  // ---- open and save ----
  // def: a definition to start from. nodeId: the node being edited or
  // customized. templateId: a library template being edited from the palette.
  // Neither: a new part.
  function open({ def, nodeId = null, templateId = null, mode = 'new' }) {
    draft = toDraft(def);
    if (templateId) draft.lib = templateId;
    const node = nodeId ? findItem(store.doc, nodeId)?.item : null;
    const others = node
      ? siblings(store.doc, node)
      : (templateId ? store.doc.nodes.filter((n) => n.kind === 'custom' && n.part?.lib === templateId) : []);
    ctx = { nodeId, templateId, mode, others: others.map((n) => n.id) };
    $('pe-title').textContent = mode === 'new' ? 'New part' : (mode === 'customize' ? `Customize ${def.name}` : `Edit ${def.name}`);
    $('pe-save-lib').checked = mode === 'new' || !!templateId || !!draft.lib;
    $('pe-save-lib').disabled = mode === 'new' || !!templateId;
    $('pe-apply-all-row').hidden = !others.length;
    $('pe-apply-all').checked = true;
    const n = others.length;
    $('pe-apply-all-label').textContent = nodeId
      ? `Apply to the ${n} other part${n === 1 ? '' : 's'} on this board from this template`
      : `Apply to the ${n} part${n === 1 ? '' : 's'} on this board from this template`;
    renderAll();
    refresh();
    openModal(dialog);
    $('pe-name').focus();
  }

  function save() {
    const raw = rawDraft();
    if (draftProblems(raw).length) return;
    const { part } = normalizePart(raw);
    let libId = draft.lib;
    if ($('pe-save-lib').checked) {
      try { libId = library.save(part, libId); } catch (err) { toast(err.message); return; }
    }
    if (libId) part.lib = libId;
    else delete part.lib;
    const applyAll = !$('pe-apply-all-row').hidden && $('pe-apply-all').checked;
    const targets = [...(ctx.nodeId ? [ctx.nodeId] : []), ...(applyAll ? ctx.others : [])];
    if (targets.length) {
      let dropped = 0;
      store.apply((doc) => {
        for (const id of targets) dropped += applyDefinition(doc, id, structuredClone(part)).dropped;
      });
      const where = targets.length > 1 ? ` on ${targets.length} parts` : '';
      const wires = dropped ? `; ${dropped} wire${dropped === 1 ? '' : 's'} dropped` : '';
      toast(`${part.name} updated${where}${wires}.`);
    } else if (ctx.mode === 'new') {
      // A new part goes to My parts and onto the canvas at the centre of the view.
      const r = svg.getBoundingClientRect();
      const cx = (r.width / 2 - tools.view.x) / tools.view.zoom;
      const cy = (r.height / 2 - tools.view.y) / tools.view.zoom;
      const { w, h } = nodeSize({ kind: 'custom', label: part.name, part });
      const id = addNode(store, 'custom', snap(cx - w / 2), snap(cy - h / 2), part);
      store.setSelection([id]);
      toast(`${part.name} saved to My parts.`);
    } else {
      toast(`${part.name} updated in My parts.`);
    }
    dialog.close();
  }

  $('pe-save').addEventListener('click', save);
  $('pe-cancel').addEventListener('click', () => dialog.close());
  dialog.addEventListener('pointerdown', (e) => { if (e.target === dialog) dialog.close(); });
  // Canvas shortcuts listen on window; a keypress inside the form is the form's.
  dialog.addEventListener('keydown', (e) => e.stopPropagation());

  return { open };
}
