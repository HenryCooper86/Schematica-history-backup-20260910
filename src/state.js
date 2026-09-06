import { getPart } from './palette.js';

// Ids are random so that two tabs, two peers, or a script minting ids in the
// same millisecond never collide: 12 base36 characters (~62 bits) after the
// prefix. getRandomValues works outside secure contexts, unlike randomUUID.
const ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';
const ID_LENGTH = 12;

export function uid(prefix = 'id') {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
  let body = '';
  for (const b of bytes) body += ID_CHARS[b % 36];
  return prefix + body;
}

// The document format version this app writes. Bump it when a saved field
// changes meaning or shape, and add the matching step to MIGRATIONS in
// src/serialize.js so older files are upgraded on load.
export const SCHEMA_VERSION = 1;

export function newDoc(title = 'Untitled Board') {
  return { schema: SCHEMA_VERSION, title, nodes: [], wires: [], zones: [], notes: [], journey: [] };
}

const MAX_UNDO = 100;

export class Store {
  constructor(doc = newDoc()) {
    this.doc = doc;
    this.undoStack = [];
    this.redoStack = [];
    this.selection = new Set();
    this.listeners = new Set();
    this._batchSnap = null;
    // Bumped by replaceDoc so subscribers can tell "a different board" from
    // "the same board edited" (the assistant clears its thread on the former).
    this.generation = 0;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  _push(snap) {
    this.undoStack.push(snap);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  apply(fn) {
    const snap = structuredClone(this.doc);
    fn(this.doc);
    // A mutation that changed nothing (e.g. a blur committing an unedited
    // field) must not cost an undo step or clear the redo stack.
    if (JSON.stringify(snap) !== JSON.stringify(this.doc)) this._push(snap);
    this.emit();
  }

  mutate(fn) {
    fn(this.doc);
    this.emit();
  }

  // A batch collapses any number of mutate() calls into one undo step: a
  // pointer drag, or everything the assistant does in reply to one message.
  // A nested begin keeps the outer snapshot.
  beginBatch() {
    if (this._batchSnap === null) this._batchSnap = structuredClone(this.doc);
  }

  endBatch() {
    if (this._batchSnap && JSON.stringify(this._batchSnap) !== JSON.stringify(this.doc)) {
      this._push(this._batchSnap);
    }
    this._batchSnap = null;
    this.emit();
  }

  cancelBatch() {
    if (this._batchSnap) {
      this.doc = this._batchSnap;
      this._batchSnap = null;
      this.emit();
    }
  }

  inBatch() { return this._batchSnap !== null; }

  // The drag names stay for tools.js and main.js.
  beginDrag() { this.beginBatch(); }
  endDrag() { this.endBatch(); }
  cancelDrag() { this.cancelBatch(); }
  isDragging() { return this.inBatch(); }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  undo() {
    if (!this.canUndo()) return;
    this.redoStack.push(structuredClone(this.doc));
    this.doc = this.undoStack.pop();
    this._pruneSelection();
    this.emit();
  }

  redo() {
    if (!this.canRedo()) return;
    this.undoStack.push(structuredClone(this.doc));
    this.doc = this.redoStack.pop();
    this._pruneSelection();
    this.emit();
  }

  replaceDoc(doc) {
    this.doc = doc;
    this.undoStack = [];
    this.redoStack = [];
    this.selection.clear();
    this.generation += 1;
    this.emit();
  }

  setSelection(ids) {
    this.selection = new Set(ids);
    this.emit();
  }

  toggleSelection(id) {
    if (this.selection.has(id)) this.selection.delete(id);
    else this.selection.add(id);
    this.emit();
  }

  clearSelection() {
    if (this.selection.size) {
      this.selection.clear();
      this.emit();
    }
  }

  _pruneSelection() {
    const ids = new Set(
      [...this.doc.nodes, ...this.doc.wires, ...this.doc.zones, ...this.doc.notes].map((i) => i.id),
    );
    for (const id of [...this.selection]) {
      if (!ids.has(id)) this.selection.delete(id);
    }
  }
}

export const NODE_STATUSES = ['planned', 'prototype', 'tested', 'production', 'deprecated'];

export const NODE_FLAGS = ['bug', 'thermal', 'power', 'lead', 'safety', 'eol'];

export function addNode(store, kind, x, y) {
  const part = getPart(kind);
  const id = uid('n');
  store.apply((doc) => {
    doc.nodes.push({
      id, kind: part.kind, x, y,
      label: part.defaultLabel || part.name, sublabel: '', color: null,
      addr: '', rail: '', notes: '', status: null, flags: [],
    });
  });
  return id;
}

export function addWire(store, bus, from, to) {
  const id = uid('w');
  store.apply((doc) => {
    doc.wires.push({ id, bus, from, to, label: '', arrow: null, style: null, flow: null });
  });
  return id;
}

// Move one end ('from' | 'to') of a wire onto another port; `bus` optionally
// retypes the wire at the same time (one undo step for both).
export function rewireEnd(store, id, end, ref, bus = null) {
  store.apply((doc) => {
    const wire = doc.wires.find((w) => w.id === id);
    if (!wire) return;
    wire[end] = { node: ref.node, port: ref.port };
    if (bus) wire.bus = bus;
  });
}

// Which bus a re-attached wire should carry, given the buses of its two port
// ends: an agreed bus wins, a current bus that still matches one end is kept,
// and null means the user has to choose.
export function resolveBus(current, busA, busB) {
  if (busA && busA === busB) return busA;
  if (current && (current === busA || current === busB)) return current;
  return null;
}

export function addZone(store, rect, label = 'Zone') {
  const id = uid('z');
  store.apply((doc) => {
    doc.zones.push({ id, x: rect.x, y: rect.y, w: rect.w, h: rect.h, label, color: '#4a90d9' });
  });
  return id;
}

export function addSwimlane(store, rect) {
  const id = uid('z');
  store.apply((doc) => {
    doc.zones.push({
      id,
      x: rect.x,
      y: rect.y,
      w: Math.max(rect.w, 320),
      h: Math.max(rect.h, 220),
      label: 'Process',
      color: '#a78bfa',
      kind: 'swimlane',
      orient: 'h',
      lanes: ['Lane 1', 'Lane 2', 'Lane 3'],
    });
  });
  return id;
}

export function addNote(store, x, y, text = 'Note') {
  const id = uid('t');
  store.apply((doc) => {
    doc.notes.push({ id, x, y, text });
  });
  return id;
}

export function findItem(doc, id) {
  for (const [type, arr] of [
    ['node', doc.nodes], ['wire', doc.wires], ['zone', doc.zones], ['note', doc.notes],
  ]) {
    const item = arr.find((i) => i.id === id);
    if (item) return { type, item };
  }
  return null;
}

export function updateItem(store, id, props) {
  store.apply((doc) => {
    const found = findItem(doc, id);
    if (found) Object.assign(found.item, props);
  });
}

export function deleteItems(store, ids) {
  if (!ids.length) return;
  const dead = new Set(ids);
  store.apply((doc) => {
    doc.nodes = doc.nodes.filter((n) => !dead.has(n.id));
    doc.zones = doc.zones.filter((z) => !dead.has(z.id));
    doc.notes = doc.notes.filter((n) => !dead.has(n.id));
    doc.wires = doc.wires.filter(
      (w) => !dead.has(w.id) && !dead.has(w.from.node) && !dead.has(w.to.node),
    );
    store._pruneSelection();
  });
}

export function duplicateItems(store, ids) {
  if (!ids.length) return [];
  const src = new Set(ids);
  const map = new Map();
  const newIds = [];
  store.apply((doc) => {
    for (const n of doc.nodes.filter((n) => src.has(n.id))) {
      const id = uid('n');
      map.set(n.id, id);
      newIds.push(id);
      doc.nodes.push({ ...structuredClone(n), id, x: n.x + 16, y: n.y + 16 });
    }
    for (const n of doc.nodes.filter((n) => newIds.includes(n.id) && n.kind === 'rdksoftware')) {
      if (map.has(n.fields?.target)) n.fields.target = map.get(n.fields.target);
    }
    for (const z of doc.zones.filter((z) => src.has(z.id))) {
      const id = uid('z');
      newIds.push(id);
      doc.zones.push({ ...structuredClone(z), id, x: z.x + 16, y: z.y + 16 });
    }
    for (const t of doc.notes.filter((t) => src.has(t.id))) {
      const id = uid('t');
      newIds.push(id);
      doc.notes.push({ ...structuredClone(t), id, x: t.x + 16, y: t.y + 16 });
    }
    for (const w of doc.wires.filter((w) => src.has(w.from.node) && src.has(w.to.node))) {
      const id = uid('w');
      doc.wires.push({
        ...structuredClone(w), id,
        from: { node: map.get(w.from.node), port: w.from.port },
        to: { node: map.get(w.to.node), port: w.to.port },
      });
    }
  });
  return newIds;
}
