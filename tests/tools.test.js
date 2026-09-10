import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, addNode, addWire, addZone, addNote, updateItem, setLock } from '../src/state.js';

// tools.js wires itself to the DOM at creation time, so a minimal fake of the
// pieces it touches (elements with closest/dataset/classList, document,
// window) stands in for a browser. Each test builds a fresh canvas.

function classListOf(el) {
  return {
    add: (c) => el.classes.add(c),
    remove: (c) => el.classes.delete(c),
    toggle: (c, on) => { if (on) el.classes.add(c); else el.classes.delete(c); },
    contains: (c) => el.classes.has(c),
  };
}

function matches(el, sel) {
  const notIdx = sel.indexOf(':not(');
  if (notIdx >= 0) {
    const inner = sel.slice(notIdx + 5, -1);
    return matches(el, sel.slice(0, notIdx)) && !matches(el, inner);
  }
  if (sel.startsWith('.')) return el.classes.has(sel.slice(1));
  const m = /^\[data-([\w-]+)(?:="([^"]*)")?\]$/.exec(sel);
  if (!m) throw new Error(`unsupported selector ${sel}`);
  const key = m[1].replace(/-(\w)/g, (_, c) => c.toUpperCase());
  if (m[2] === undefined) return el.dataset[key] !== undefined;
  return el.dataset[key] === m[2];
}

function makeEl({ tag = 'g', classes = [], dataset = {}, parent = null } = {}) {
  const el = {
    tagName: tag, classes: new Set(classes), dataset: { ...dataset }, parent, attrs: {},
    listeners: {}, hidden: true, style: {}, value: '', innerHTML: '',
  };
  el.classList = classListOf(el);
  el.closest = (sel) => {
    for (let cur = el; cur; cur = cur.parent) if (matches(cur, sel)) return cur;
    return null;
  };
  el.setAttribute = (k, v) => { el.attrs[k] = v; };
  el.removeAttribute = (k) => { delete el.attrs[k]; };
  el.hasAttribute = (k) => k in el.attrs;
  el.addEventListener = (type, fn) => { (el.listeners[type] ||= []).push(fn); };
  el.removeEventListener = (type, fn) => { el.listeners[type] = (el.listeners[type] || []).filter((f) => f !== fn); };
  el.dispatch = (type, e) => { for (const fn of el.listeners[type] || []) fn(e); };
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
  el.setPointerCapture = () => {};
  el.releasePointerCapture = () => {};
  el.querySelectorAll = () => [];
  el.contains = () => false;
  el.focus = () => {};
  el.select = () => {};
  return el;
}

async function setup() {
  const svg = makeEl({ tag: 'svg' });
  const body = makeEl({ tag: 'BODY' });
  const popover = makeEl({ tag: 'DIV' });
  const editor = makeEl({ tag: 'INPUT' });
  // press.js's toast() writes into this one and arms a dismissal timer.
  const toastEl = makeEl({ tag: 'DIV' });
  toastEl.append = () => {};
  const doc = {
    body,
    getElementById: (id) => ({ 'bus-popover': popover, 'inline-editor': editor, toast: toastEl }[id]),
    querySelector: () => null,
    elementFromPoint: () => null,
  };
  const win = {
    listeners: {}, innerWidth: 1280, innerHeight: 800,
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); },
    dispatch(type, e) { for (const fn of this.listeners[type] || []) fn(e); },
  };
  globalThis.document = doc;
  globalThis.window = win;
  const { createTools } = await import('../src/tools.js');
  const store = new Store();
  const toolChanges = [];
  const tools = createTools({
    svg, store, requestRender: () => {}, onToolChange: (t) => toolChanges.push(t),
  });
  // Cancel the pointerdown-time zoom offset so world == client coordinates.
  tools.view.x = 0;
  tools.view.y = 0;
  const ev = (target, extra = {}) => ({
    target, button: 0, clientX: 0, clientY: 0, pointerId: 1, shiftKey: false,
    metaKey: false, ctrlKey: false, prevented: false,
    preventDefault() { this.prevented = true; }, ...extra,
  });
  const key = (k, extra = {}) => ev(body, { key: k, ...extra });
  return { svg, body, doc, win, store, tools, editor, toastEl, toolChanges, ev, key };
}

function nodeEl(id, parent = null) {
  return makeEl({ dataset: { type: 'node', id }, parent });
}

function portEl(node, port) {
  return makeEl({ classes: ['portg'], dataset: { node, port } });
}

test('keys other than Escape are ignored while a move drag is in flight', async () => {
  const { svg, store, win, key, ev, toolChanges } = await setup();
  const a = addNode(store, 'mcu', 0, 0);
  const el = nodeEl(a);
  svg.dispatch('pointerdown', ev(el, { clientX: 10, clientY: 10 }));
  assert.equal(store.isDragging(), true);
  const before = store.undoStack.length;
  win.dispatch('keydown', key('Delete'));
  assert.equal(store.doc.nodes.length, 1, 'Delete mid-drag does nothing');
  win.dispatch('keydown', key('z', { ctrlKey: true }));
  win.dispatch('keydown', key('d', { ctrlKey: true }));
  win.dispatch('keydown', key('c'));
  assert.deepEqual(toolChanges, [], 'no tool switch mid-drag');
  assert.equal(store.undoStack.length, before);
  assert.equal(store.doc.nodes.length, 1);
  // The gesture keeps working and Escape still abandons it.
  svg.dispatch('pointermove', ev(el, { clientX: 50, clientY: 10 }));
  assert.equal(store.doc.nodes[0].x, 40);
  win.dispatch('keydown', key('Escape'));
  assert.equal(store.isDragging(), false);
  assert.equal(store.doc.nodes[0].x, 0, 'Escape puts the card back');
});

test('a locked card is still selectable but never moves with a drag', async () => {
  const { svg, store, ev } = await setup();
  const a = addNode(store, 'mcu', 0, 0);
  setLock(store, [a], true);
  const el = nodeEl(a);
  svg.dispatch('pointerdown', ev(el, { clientX: 10, clientY: 10 }));
  assert.deepEqual([...store.selection], [a], 'the lock does not block selection');
  assert.equal(store.isDragging(), false, 'and no drag starts');
  svg.dispatch('pointermove', ev(el, { clientX: 90, clientY: 90 }));
  svg.dispatch('pointerup', ev(el, { clientX: 90, clientY: 90 }));
  assert.deepEqual([store.doc.nodes[0].x, store.doc.nodes[0].y], [0, 0]);
});

test('arrow keys nudge the unlocked half of a selection and leave the rest', async () => {
  const { store, win, key } = await setup();
  const a = addNode(store, 'mcu', 0, 0);
  const b = addNode(store, 'temp', 300, 0);
  setLock(store, [a], true);
  store.setSelection([a, b]);
  win.dispatch('keydown', key('ArrowRight', { shiftKey: true }));
  assert.equal(store.doc.nodes[0].x, 0, 'the locked card stays');
  assert.equal(store.doc.nodes[1].x, 308);
});

test('a dragged zone carries its unlocked cards and travels over the locked ones', async () => {
  const { svg, store, ev } = await setup();
  addNode(store, 'mcu', 100, 100);
  const pinned = addNode(store, 'temp', 200, 100);
  const z = addZone(store, { x: 40, y: 40, w: 400, h: 300 });
  setLock(store, [pinned], true);
  store.setSelection([z]);
  svg.dispatch('pointerdown', ev(makeEl({ dataset: { type: 'zone', id: z } }), { clientX: 0, clientY: 0 }));
  svg.dispatch('pointermove', ev(svg, { clientX: 40, clientY: 0 }));
  svg.dispatch('pointerup', ev(svg, { clientX: 40, clientY: 0 }));
  assert.equal(store.doc.zones[0].x, 80, 'the zone moves');
  assert.equal(store.doc.nodes[0].x, 140, 'its unlocked passenger comes along');
  assert.equal(store.doc.nodes[1].x, 200, 'the locked one stays behind');
});

test('a locked zone refuses a corner-handle resize', async () => {
  const { svg, store, ev } = await setup();
  const z = addZone(store, { x: 0, y: 0, w: 400, h: 300 });
  setLock(store, [z], true);
  store.setSelection([z]);
  const zoneEl = makeEl({ dataset: { type: 'zone', id: z } });
  const handle = makeEl({ dataset: { zhandle: 'se' }, parent: zoneEl });
  svg.dispatch('pointerdown', ev(handle, { clientX: 400, clientY: 300 }));
  svg.dispatch('pointermove', ev(svg, { clientX: 600, clientY: 500 }));
  svg.dispatch('pointerup', ev(svg, { clientX: 600, clientY: 500 }));
  assert.deepEqual([store.doc.zones[0].w, store.doc.zones[0].h], [400, 300]);
});

test('Delete removes the unlocked items and the toast counts what it kept', async () => {
  const { store, win, key, toastEl } = await setup();
  const a = addNode(store, 'mcu', 0, 0);
  const b = addNode(store, 'temp', 300, 0);
  const t = addNote(store, 0, 400, 'pinned');
  setLock(store, [a, t], true);
  store.setSelection([a, b, t]);
  win.dispatch('keydown', key('Delete'));
  assert.deepEqual(store.doc.nodes.map((n) => n.id), [a]);
  assert.equal(store.doc.notes.length, 1);
  assert.match(toastEl.textContent, /^2 locked items were kept/);
});

test('K locks a mixed selection, then unlocks it once everything is locked', async () => {
  const { store, win, key } = await setup();
  const a = addNode(store, 'mcu', 0, 0);
  const b = addNode(store, 'temp', 300, 0);
  setLock(store, [a], true);
  store.setSelection([a, b]);
  win.dispatch('keydown', key('k'));
  assert.deepEqual(store.doc.nodes.map((n) => !!n.locked), [true, true]);
  win.dispatch('keydown', key('k'));
  assert.deepEqual(store.doc.nodes.map((n) => !!n.locked), [false, false]);
});

test('K with nothing selected costs no undo step', async () => {
  const { store, win, key } = await setup();
  addNode(store, 'mcu', 0, 0);
  const depth = store.undoStack.length;
  win.dispatch('keydown', key('k'));
  assert.equal(store.undoStack.length, depth);
});

test('a wire can still be drawn to a locked node\'s port', async () => {
  const { svg, store, doc, ev } = await setup();
  const a = addNode(store, 'mcu', 0, 0);
  const b = addNode(store, 'temp', 300, 0);
  setLock(store, [b], true);
  const target = portEl(b, 'i2c');
  doc.elementFromPoint = () => target;
  svg.dispatch('pointerdown', ev(portEl(a, 'i2c')));
  svg.dispatch('pointermove', ev(svg));
  assert.equal(target.hasAttribute('data-hot'), true, 'a lock protects position, not connectivity');
  svg.dispatch('pointerup', ev(svg));
  assert.equal(store.doc.wires.length, 1);
});

test('a tool key mid-wire keeps the draft, so pointermove has a cursor to update', async () => {
  const { svg, store, win, key, ev, tools } = await setup();
  const a = addNode(store, 'mcu', 0, 0);
  svg.dispatch('pointerdown', ev(portEl(a, 'i2c')));
  assert.ok(tools.ui.wireDraft);
  win.dispatch('keydown', key('v'));
  assert.ok(tools.ui.wireDraft, 'the draft survives a tool key');
  assert.doesNotThrow(() => svg.dispatch('pointermove', ev(svg, { clientX: 30, clientY: 30 })));
  assert.deepEqual(tools.ui.wireDraft.cursor, { x: 30, y: 30 });
});

test('shift-clicking the only selected item off does not start a drag', async () => {
  const { svg, store, ev } = await setup();
  const a = addNode(store, 'mcu', 0, 0);
  store.setSelection([a]);
  const el = nodeEl(a);
  svg.dispatch('pointerdown', ev(el, { shiftKey: true }));
  assert.equal(store.selection.size, 0);
  assert.equal(store.isDragging(), false);
  assert.doesNotThrow(() => svg.dispatch('pointermove', ev(el, { clientX: 20, clientY: 20 })));
  assert.doesNotThrow(() => svg.dispatch('pointerup', ev(el, { clientX: 20, clientY: 20 })));
  assert.equal(store.doc.nodes[0].x, 0);
});

test('a wire cannot land on a port of its own node', async () => {
  const { svg, store, doc, ev } = await setup();
  const a = addNode(store, 'mcu', 0, 0);
  const b = addNode(store, 'temp', 300, 0);
  // Onto another port of the same node: no hot port, no wire.
  const own = portEl(a, 'spi');
  doc.elementFromPoint = () => own;
  svg.dispatch('pointerdown', ev(portEl(a, 'i2c')));
  svg.dispatch('pointermove', ev(svg));
  assert.equal(own.hasAttribute('data-hot'), false);
  svg.dispatch('pointerup', ev(svg));
  assert.equal(store.doc.wires.length, 0);
  // Onto another node: the port lights up and the wire is added.
  const other = portEl(b, 'i2c');
  doc.elementFromPoint = () => other;
  svg.dispatch('pointerdown', ev(portEl(a, 'i2c')));
  svg.dispatch('pointermove', ev(svg));
  assert.equal(other.hasAttribute('data-hot'), true);
  svg.dispatch('pointerup', ev(svg));
  assert.equal(store.doc.wires.length, 1);
});

test('re-attaching a wire end onto the other end\'s node is refused', async () => {
  const { svg, store, doc, ev } = await setup();
  const a = addNode(store, 'mcu', 0, 0);
  const b = addNode(store, 'temp', 300, 0);
  const w = addWire(store, 'i2c', { node: a, port: 'i2c' }, { node: b, port: 'i2c' });
  store.setSelection([w]);
  const wireEl = makeEl({ dataset: { type: 'wire', id: w } });
  const handle = makeEl({ dataset: { wend: 'to' }, parent: wireEl });
  doc.elementFromPoint = () => portEl(a, 'spi');
  svg.dispatch('pointerdown', ev(handle));
  svg.dispatch('pointerup', ev(svg));
  assert.deepEqual(store.doc.wires[0].to, { node: b, port: 'i2c' }, 'the wire stays put');
  doc.elementFromPoint = () => portEl(b, 'vcc');
  svg.dispatch('pointerdown', ev(handle));
  svg.dispatch('pointerup', ev(svg));
  assert.deepEqual(store.doc.wires[0].to, { node: b, port: 'vcc' }, 'another port of the far node is fine');
});

test('Space pans only when the canvas or the page has focus', async () => {
  const { svg, body, win, ev } = await setup();
  const button = makeEl({ tag: 'BUTTON' });
  const onButton = ev(button, { key: ' ' });
  win.dispatch('keydown', onButton);
  assert.equal(onButton.prevented, false, 'a focused button still activates on Space');
  assert.equal(svg.classList.contains('panning'), false);
  const onBody = ev(body, { key: ' ' });
  win.dispatch('keydown', onBody);
  assert.equal(onBody.prevented, true);
  assert.equal(svg.classList.contains('panning'), true);
  win.dispatch('keyup', ev(body, { key: ' ' }));
  const onSvg = ev(svg, { key: ' ' });
  win.dispatch('keydown', onSvg);
  assert.equal(onSvg.prevented, true);
});

test('clearing the last schema field drops the fields key instead of leaving {}', async () => {
  const { svg, store, editor, ev } = await setup();
  const a = addNode(store, 'threatactor', 0, 0);
  updateItem(store, a, { fields: { type: 'insider' } });
  const el = nodeEl(a);
  const line = makeEl({ dataset: { edit: 'fields.type' }, parent: el });
  // Two presses within the double-click window open the inline editor.
  svg.dispatch('pointerdown', ev(line));
  svg.dispatch('pointerdown', ev(line));
  assert.equal(editor.hidden, false);
  assert.equal(editor.value, 'insider');
  editor.value = '   ';
  editor.dispatch('keydown', { key: 'Enter', stopPropagation() {} });
  const node = store.doc.nodes[0];
  assert.equal(node.fields, undefined);
  assert.equal(JSON.stringify(node).includes('fields'), false, 'serializes without the key');
});
