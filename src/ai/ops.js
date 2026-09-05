// Edit operations: the only way the assistant changes a board. A batch is
// applied to a working copy and reaches the document only if every
// operation succeeds. No operation carries a coordinate; src/ai/layout.js
// places whatever a batch creates.
import { PARTS, getPart, DISPOSITIONS } from '../palette.js';
import { BUSES } from '../buses.js';
import { uid, NODE_STATUSES, NODE_FLAGS } from '../state.js';
import { MAX_TEXT } from '../serialize.js';

export const MAX_OPS = 200;
export const OP_TYPES = [
  'add_part', 'update_part', 'replace_part', 'remove', 'connect', 'update_wire',
  'add_zone', 'update_zone', 'add_note', 'update_note', 'set_title',
];
// A port on a shared bus carries any number of wires; every other bus is
// point-to-point and a port takes one wire. Untyped buses connect anything.
export const SHARED_BUSES = new Set(['power', 'gnd', 'i2c', 'can', 'canfd', 'rs485']);
export const UNTYPED_BUSES = new Set(['flow', 'link']);
const WIRE_STYLES = ['solid', 'dashed', 'dotted', 'sneakernet'];
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;
const DEFAULT_ZONE_COLOR = '#4a90d9';

export class OpError extends Error {}
export function fail(message) { throw new OpError(message); }

// One object shape for every op: `op` says which fields matter, and the
// handlers below validate the rest. Providers get this as the tool schema.
export const EDIT_SCHEMA = {
  type: 'object',
  properties: {
    ops: {
      type: 'array',
      description: 'Operations applied in order as one atomic batch. New items carry a ref you choose; later ops may use it as an id.',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: OP_TYPES },
          ref: { type: 'string', description: 'Your label for a new item (add_part, connect, add_zone, add_note); usable as an id later in this batch' },
          id: { type: 'string', description: 'Existing item id (update_*, replace_part)' },
          ids: { type: 'array', items: { type: 'string' }, description: 'remove: ids or refs of nodes, wires, zones, notes' },
          kind: { type: 'string', description: 'A palette kind from the catalogue (add_part, replace_part)' },
          label: { type: 'string' },
          sublabel: { type: 'string', description: 'Part number' },
          addr: { type: 'string', description: 'Bus address such as 0x76' },
          rail: { type: 'string', description: 'Supply rail such as 3.3V' },
          notes: { type: 'string' },
          status: { type: ['string', 'null'], enum: [...NODE_STATUSES, null] },
          flags: { type: 'array', items: { type: 'string', enum: [...NODE_FLAGS] } },
          fields: { type: 'object', additionalProperties: { type: 'string' }, description: 'Schema fields for threat, network, and security parts' },
          disposition: { type: ['string', 'null'], enum: [...Object.keys(DISPOSITIONS), null] },
          near: { type: 'string', description: 'Layout anchor: an existing node id or a ref' },
          in: { type: 'string', description: 'Zone id or ref to place the part in' },
          from: { type: 'object', properties: { node: { type: 'string' }, port: { type: 'string' } }, required: ['node'] },
          to: { type: 'object', properties: { node: { type: 'string' }, port: { type: 'string' } }, required: ['node'] },
          bus: { type: 'string', enum: Object.keys(BUSES) },
          arrow: { type: ['string', 'null'], enum: ['fwd', 'both', null] },
          style: { type: ['string', 'null'], enum: [...WIRE_STYLES, null] },
          flow: { type: ['string', 'null'], enum: ['on', 'off', null] },
          color: { type: 'string', description: 'Zone colour as #rrggbb' },
          members: { type: 'array', items: { type: 'string' }, description: 'Zone members: node ids or refs' },
          text: { type: 'string', description: 'Note text' },
          title: { type: 'string', description: 'Board title' },
        },
        required: ['op'],
      },
    },
  },
  required: ['ops'],
};

function makeCtx(doc) {
  return {
    work: structuredClone(doc),
    refs: new Map(),
    failedRefs: new Set(),
    errors: [],
    warnings: [],
    changes: [],
    touched: new Set(),
    layout: { nodes: [], zones: [], notes: [], hints: new Map(), refit: [] },
  };
}

function findAny(work, id) {
  return work.nodes.some((n) => n.id === id) || work.wires.some((w) => w.id === id)
    || work.zones.some((z) => z.id === id) || work.notes.some((t) => t.id === id);
}

// A key is a ref defined earlier in the batch or an existing id.
export function resolve(ctx, key) {
  if (typeof key !== 'string' || !key) fail('expected an id or ref');
  if (ctx.refs.has(key)) return ctx.refs.get(key);
  if (ctx.failedRefs.has(key)) fail(`ref "${key}" belongs to an operation that failed`);
  return key;
}

export function findNode(ctx, key) {
  const id = resolve(ctx, key);
  return ctx.work.nodes.find((n) => n.id === id) || fail(`no node "${key}"`);
}
export function findWire(ctx, key) {
  const id = resolve(ctx, key);
  return ctx.work.wires.find((w) => w.id === id) || fail(`no wire "${key}"`);
}
export function findZone(ctx, key) {
  const id = resolve(ctx, key);
  return ctx.work.zones.find((z) => z.id === id) || fail(`no zone "${key}"`);
}
export function findNote(ctx, key) {
  const id = resolve(ctx, key);
  return ctx.work.notes.find((t) => t.id === id) || fail(`no note "${key}"`);
}

export function claimRef(ctx, ref, what) {
  if (typeof ref !== 'string' || !ref) fail(`${what} needs a ref`);
  if (ctx.refs.has(ref) || findAny(ctx.work, ref)) fail(`ref "${ref}" is already taken`);
}

export function text(ctx, value, what) {
  if (typeof value !== 'string') fail(`${what} must be a string`);
  if (value.length <= MAX_TEXT) return value;
  ctx.warnings.push(`${what} was cut to ${MAX_TEXT} characters`);
  return value.slice(0, MAX_TEXT);
}

// The node fields an op may set, validated the way deserialize validates a
// file. Returns a patch; `node` is the current node for merging fields.
export function nodePatch(ctx, part, op, node) {
  const patch = {};
  for (const k of ['label', 'sublabel', 'addr', 'rail', 'notes']) {
    if (op[k] !== undefined) patch[k] = text(ctx, op[k], k);
  }
  if (op.status !== undefined) {
    if (op.status !== null && !NODE_STATUSES.includes(op.status)) {
      fail(`unknown status "${op.status}"; one of ${NODE_STATUSES.join(', ')} or null`);
    }
    patch.status = op.status;
  }
  if (op.flags !== undefined) {
    if (!Array.isArray(op.flags)) fail('flags must be an array');
    const bad = op.flags.filter((f) => !NODE_FLAGS.includes(f));
    if (bad.length) fail(`unknown flags ${bad.join(', ')}; one of ${NODE_FLAGS.join(', ')}`);
    patch.flags = [...new Set(op.flags)];
  }
  if (op.disposition !== undefined) {
    if (op.disposition !== null && !DISPOSITIONS[op.disposition]) {
      fail(`unknown disposition "${op.disposition}"; one of ${Object.keys(DISPOSITIONS).join(', ')} or null`);
    }
    patch.disposition = op.disposition;
  }
  if (op.fields !== undefined) {
    if (!op.fields || typeof op.fields !== 'object' || Array.isArray(op.fields)) fail('fields must be an object of strings');
    if (!part.fields) fail(`${part.name} has no schema fields`);
    const merged = { ...(node?.fields || {}) };
    for (const [k, v] of Object.entries(op.fields)) {
      const fd = part.fields.find((f) => f.id === k);
      if (!fd) fail(`unknown field "${k}" on ${part.name}; fields: ${part.fields.map((f) => f.id).join(', ')}`);
      if (typeof v !== 'string') fail(`field "${k}" must be a string`);
      if (fd.options && v && !fd.options.includes(v)) fail(`field "${k}" must be one of ${fd.options.join(', ')}`);
      if (v.trim()) merged[k] = text(ctx, v, k);
      else delete merged[k];
    }
    patch.fields = merged;
  }
  return patch;
}

// Null disposition and empty fields are absent keys, as in a saved file.
export function assignPatch(node, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'disposition' && v === null) delete node.disposition;
    else if (k === 'fields' && !Object.keys(v).length) delete node.fields;
    else node[k] = v;
  }
}

export const HANDLERS = {};

HANDLERS.add_part = (ctx, op) => {
  claimRef(ctx, op.ref, 'add_part');
  const part = PARTS[op.kind];
  if (!part) fail(`unknown kind "${op.kind}"; use search_parts to find kinds`);
  const near = op.near !== undefined ? findNode(ctx, op.near).id : null;
  const zone = op.in !== undefined ? findZone(ctx, op.in).id : null;
  const node = {
    id: uid('n'), kind: part.kind, x: 0, y: 0,
    label: part.defaultLabel || part.name, sublabel: '', color: null,
    addr: '', rail: '', notes: '', status: null, flags: [],
  };
  assignPatch(node, nodePatch(ctx, part, op, node));
  ctx.work.nodes.push(node);
  ctx.refs.set(op.ref, node.id);
  ctx.touched.add(node.id);
  ctx.layout.nodes.push(node.id);
  ctx.layout.hints.set(node.id, { near, zone });
  ctx.changes.push(`added node ${node.id} ${node.kind} "${node.label}" (ref ${op.ref})`);
};

HANDLERS.set_title = (ctx, op) => {
  const title = text(ctx, op.title, 'title').trim();
  ctx.work.title = title || 'Untitled Board';
  ctx.changes.push(`title "${ctx.work.title}"`);
};

// Applies a batch: every op runs against a working copy, errors are
// collected with their index, and the document is replaced only when the
// whole batch succeeded.
export function applyEdits(doc, ops) {
  if (!Array.isArray(ops)) return { ok: false, errors: [{ index: -1, message: 'ops must be an array' }] };
  if (ops.length > MAX_OPS) {
    return { ok: false, errors: [{ index: -1, message: `at most ${MAX_OPS} operations per batch; split the work` }] };
  }
  const ctx = makeCtx(doc);
  ops.forEach((op, index) => {
    try {
      const handler = op && HANDLERS[op.op];
      if (!handler) fail(`unknown op "${op?.op}"; one of ${OP_TYPES.join(', ')}`);
      handler(ctx, op);
    } catch (err) {
      if (!(err instanceof OpError)) throw err;
      if (typeof op?.ref === 'string') ctx.failedRefs.add(op.ref);
      ctx.errors.push({ index, message: err.message });
    }
  });
  if (ctx.errors.length) return { ok: false, errors: ctx.errors };
  Object.assign(doc, ctx.work);
  return {
    ok: true,
    refs: Object.fromEntries(ctx.refs),
    changes: ctx.changes,
    warnings: ctx.warnings,
    touched: ctx.touched,
    layout: ctx.layout,
  };
}
