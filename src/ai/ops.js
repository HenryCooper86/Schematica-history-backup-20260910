import { nodePart } from '../rdk/profiles.js';
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

// The assistant creates and refits plain zones only; a swimlane's rectangle
// and lanes are the user's.
function plainZone(ctx, key) {
  const zone = findZone(ctx, key);
  if (zone.kind === 'swimlane') fail(`zone "${key}" is a swimlane; the assistant edits plain zones only`);
  return zone;
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
    if (op.disposition !== null && !Object.hasOwn(DISPOSITIONS, op.disposition)) {
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

const RAILS = new Set(['power', 'gnd']);
const portList = (ports) => ports.map((p) => `${p.id}(${p.bus})`).join(', ');
const busList = (ports) => [...new Set(ports.map((p) => p.bus))].join(', ');

// The port on `node` that a wire of `bus` should use: the first port of that
// bus when the bus is shared, the first free one otherwise, a side port for
// the untyped buses when the part has none of that bus.
export function pickPort(doc, node, bus) {
  const ports = nodePart(node).ports;
  const ofBus = ports.filter((p) => p.bus === bus);
  if (!ofBus.length) {
    if (UNTYPED_BUSES.has(bus)) {
      const side = ports.find((p) => p.side === 'right') || ports.find((p) => p.side === 'left') || ports[0];
      if (side) return side.id;
    }
    fail(`node ${node.id} (${node.kind}) has no ${bus} port; ports: ${portList(ports)}`);
  }
  if (SHARED_BUSES.has(bus) || UNTYPED_BUSES.has(bus)) return ofBus[0].id;
  const used = new Set();
  for (const w of doc.wires) {
    if (w.from.node === node.id) used.add(w.from.port);
    if (w.to.node === node.id) used.add(w.to.port);
  }
  const free = ofBus.find((p) => !used.has(p.id));
  if (!free) fail(`every ${bus} port on ${node.id} is in use (${ofBus.map((p) => p.id).join(', ')})`);
  return free.id;
}

// Resolves the two ends of a connect op. Explicit ports must exist; they
// may differ in bus only when the op names the bus, which warns. Without
// ports the bus is given, or inferred when the parts share exactly one bus
// besides power and ground.
export function pickPorts(doc, a, b, portA, portB, bus) {
  const pa = nodePart(a).ports;
  const pb = nodePart(b).ports;
  if (portA !== undefined || portB !== undefined) {
    if (portA === undefined || portB === undefined) fail('give both ports or neither');
    const A = pa.find((p) => p.id === portA) || fail(`node ${a.id} has no port "${portA}"; ports: ${portList(pa)}`);
    const B = pb.find((p) => p.id === portB) || fail(`node ${b.id} has no port "${portB}"; ports: ${portList(pb)}`);
    if (A.bus === B.bus) {
      if (bus && bus !== A.bus && !UNTYPED_BUSES.has(bus)) fail(`ports ${portA} and ${portB} carry ${A.bus}, not ${bus}`);
      return { from: A.id, to: B.id, bus: bus || A.bus, warning: null };
    }
    if (!bus) fail(`ports ${portA} (${A.bus}) and ${portB} (${B.bus}) differ; name the bus to connect them anyway`);
    return { from: A.id, to: B.id, bus, warning: `wire ${bus} joins a ${A.bus} port to a ${B.bus} port` };
  }
  let chosen = bus;
  if (!chosen) {
    const common = [...new Set(pa.map((p) => p.bus))]
      .filter((x) => !RAILS.has(x) && pb.some((p) => p.bus === x));
    if (common.length !== 1) fail(`name the bus: ${a.id} offers ${busList(pa)}; ${b.id} offers ${busList(pb)}`);
    chosen = common[0];
  }
  return { from: pickPort(doc, a, chosen), to: pickPort(doc, b, chosen), bus: chosen, warning: null };
}

function parseArrow(v) {
  if (v === null || v === undefined) return null;
  if (v === 'fwd' || v === 'both') return v;
  return fail('arrow must be fwd, both, or null');
}

function parseStyle(v) {
  if (v === null || v === undefined) return null;
  if (WIRE_STYLES.includes(v)) return v;
  return fail(`style must be one of ${WIRE_STYLES.join(', ')} or null`);
}

export const HANDLERS = {};

HANDLERS.add_part = (ctx, op) => {
  claimRef(ctx, op.ref, 'add_part');
  const part = Object.hasOwn(PARTS, op.kind) ? PARTS[op.kind] : null;
  if (!part) fail(`unknown kind "${op.kind}"; use search_parts to find kinds`);
  const near = op.near !== undefined ? findNode(ctx, op.near).id : null;
  const zone = op.in !== undefined ? plainZone(ctx, op.in).id : null;
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

HANDLERS.add_note = (ctx, op) => {
  claimRef(ctx, op.ref, 'add_note');
  const near = op.near !== undefined ? findNode(ctx, op.near).id : null;
  const note = { id: uid('t'), x: 0, y: 0, text: text(ctx, op.text, 'text') };
  ctx.work.notes.push(note);
  ctx.refs.set(op.ref, note.id);
  ctx.touched.add(note.id);
  ctx.layout.notes.push(note.id);
  ctx.layout.hints.set(note.id, { near, zone: null });
  ctx.changes.push(`added note ${note.id} (ref ${op.ref})`);
};

HANDLERS.update_note = (ctx, op) => {
  const note = findNote(ctx, op.id);
  note.text = text(ctx, op.text, 'text');
  ctx.touched.add(note.id);
  ctx.changes.push(`updated note ${note.id}`);
};

HANDLERS.update_part = (ctx, op) => {
  const node = findNode(ctx, op.id);
  if (op.kind !== undefined) fail('use replace_part to change the kind');
  const patch = nodePatch(ctx, getPart(node.kind), op, node);
  const keys = Object.keys(patch);
  if (!keys.length) fail('update_part changes nothing');
  assignPatch(node, patch);
  ctx.touched.add(node.id);
  ctx.changes.push(`updated node ${node.id} (${keys.join(', ')})`);
};

HANDLERS.connect = (ctx, op) => {
  if (!op.from || typeof op.from !== 'object' || !op.to || typeof op.to !== 'object') fail('connect needs from and to');
  if (op.ref !== undefined) claimRef(ctx, op.ref, 'connect');
  const a = findNode(ctx, op.from.node);
  const b = findNode(ctx, op.to.node);
  if (a.id === b.id) fail('cannot connect a node to itself');
  if (op.bus !== undefined && !Object.hasOwn(BUSES, op.bus)) fail(`unknown bus "${op.bus}"`);
  const pick = pickPorts(ctx.work, a, b, op.from.port, op.to.port, op.bus);
  const w = {
    id: uid('w'), bus: pick.bus,
    from: { node: a.id, port: pick.from }, to: { node: b.id, port: pick.to },
    label: op.label !== undefined ? text(ctx, op.label, 'label') : '',
    arrow: parseArrow(op.arrow), style: parseStyle(op.style), flow: null,
  };
  ctx.work.wires.push(w);
  if (op.ref !== undefined) ctx.refs.set(op.ref, w.id);
  ctx.touched.add(w.id);
  if (pick.warning) ctx.warnings.push(pick.warning);
  ctx.changes.push(`connected ${w.id} ${w.bus} ${a.id}.${w.from.port} -- ${b.id}.${w.to.port}`);
};

HANDLERS.update_wire = (ctx, op) => {
  const w = findWire(ctx, op.id);
  const changed = [];
  if (op.bus !== undefined) {
    if (!Object.hasOwn(BUSES, op.bus)) fail(`unknown bus "${op.bus}"`);
    w.bus = op.bus;
    changed.push('bus');
  }
  if (op.label !== undefined) { w.label = text(ctx, op.label, 'label'); changed.push('label'); }
  if (op.arrow !== undefined) { w.arrow = parseArrow(op.arrow); changed.push('arrow'); }
  if (op.style !== undefined) { w.style = parseStyle(op.style); changed.push('style'); }
  if (op.flow !== undefined) {
    if (![null, 'on', 'off'].includes(op.flow)) fail('flow must be on, off, or null');
    w.flow = op.flow;
    changed.push('flow');
  }
  if (!changed.length) fail('update_wire changes nothing');
  ctx.touched.add(w.id);
  ctx.changes.push(`updated wire ${w.id} (${changed.join(', ')})`);
};

HANDLERS.replace_part = (ctx, op) => {
  const node = findNode(ctx, op.id);
  const part = Object.hasOwn(PARTS, op.kind) ? PARTS[op.kind] : null;
  if (!part) fail(`unknown kind "${op.kind}"; use search_parts to find kinds`);
  if (part.kind === node.kind) fail(`${node.id} is already a ${part.kind}`);
  const oldPart = getPart(node.kind);
  if (node.fields) {
    const schema = new Map((part.fields || []).map((f) => [f.id, f]));
    const kept = {};
    const dropped = [];
    for (const [k, v] of Object.entries(node.fields)) {
      const fd = schema.get(k);
      if (fd && (!fd.options || fd.options.includes(v))) kept[k] = v;
      else dropped.push(k);
    }
    if (dropped.length) ctx.warnings.push(`dropped fields ${dropped.join(', ')} from ${node.id}: ${part.name} has no such fields`);
    if (Object.keys(kept).length) node.fields = kept;
    else delete node.fields;
  }
  node.kind = part.kind;
  let kept = 0;
  let rewired = 0;
  const dropped = [];
  for (const w of ctx.work.wires) {
    for (const end of ['from', 'to']) {
      if (w[end].node !== node.id) continue;
      const oldPort = oldPart.ports.find((p) => p.id === w[end].port);
      const wantBus = oldPort ? oldPort.bus : w.bus;
      if (part.ports.some((p) => p.id === w[end].port && p.bus === wantBus)) { kept += 1; continue; }
      let pid = null;
      try { pid = pickPort(ctx.work, node, wantBus); } catch (err) { if (!(err instanceof OpError)) throw err; }
      if (pid) { w[end].port = pid; rewired += 1; } else dropped.push(w.id);
    }
  }
  if (dropped.length) {
    ctx.work.wires = ctx.work.wires.filter((w) => !dropped.includes(w.id));
    ctx.warnings.push(`removed wires ${dropped.join(', ')}: ${part.name} has no port for their bus`);
    for (const id of dropped) ctx.touched.add(id);
  }
  ctx.touched.add(node.id);
  ctx.changes.push(`replaced ${node.id} with ${part.kind} (kept ${kept}, rewired ${rewired}, dropped ${dropped.length})`);
};

HANDLERS.remove = (ctx, op) => {
  if (!Array.isArray(op.ids) || !op.ids.length) fail('remove needs ids');
  const dead = new Set();
  for (const key of op.ids) {
    const id = resolve(ctx, key);
    if (!findAny(ctx.work, id)) fail(`no item "${key}"`);
    dead.add(id);
  }
  const w = ctx.work;
  w.nodes = w.nodes.filter((n) => !dead.has(n.id));
  w.zones = w.zones.filter((z) => !dead.has(z.id));
  w.notes = w.notes.filter((t) => !dead.has(t.id));
  for (const x of w.wires) {
    if (dead.has(x.from.node) || dead.has(x.to.node)) dead.add(x.id);
  }
  w.wires = w.wires.filter((x) => !dead.has(x.id));
  const L = ctx.layout;
  L.nodes = L.nodes.filter((id) => !dead.has(id));
  L.notes = L.notes.filter((id) => !dead.has(id));
  L.zones = L.zones.filter((z) => !dead.has(z.id)).map((z) => ({ ...z, members: z.members.filter((m) => !dead.has(m)) }));
  const emptied = L.zones.find((z) => !z.members.length);
  if (emptied) fail(`removing ${op.ids.join(', ')} empties zone ${emptied.id} made in this batch; remove the zone too`);
  L.refit = L.refit.filter((z) => !dead.has(z.id)).map((z) => ({ ...z, members: z.members.filter((m) => !dead.has(m)) }));
  for (const id of dead) { L.hints.delete(id); ctx.touched.delete(id); }
  ctx.changes.push(`removed ${[...dead].join(' ')}`);
};

function zoneColor(v) {
  if (v === undefined) return DEFAULT_ZONE_COLOR;
  if (typeof v !== 'string' || !HEX_COLOR.test(v)) fail('colour must be a hex value like #f87171');
  return v;
}

function zoneMemberIds(ctx, members) {
  if (!Array.isArray(members) || !members.length) fail('a zone needs at least one member');
  return [...new Set(members.map((m) => findNode(ctx, m).id))];
}

HANDLERS.add_zone = (ctx, op) => {
  claimRef(ctx, op.ref, 'add_zone');
  const label = text(ctx, op.label, 'label');
  const color = zoneColor(op.color);
  const members = zoneMemberIds(ctx, op.members);
  const zone = { id: uid('z'), x: 0, y: 0, w: 0, h: 0, label, color };
  ctx.work.zones.push(zone);
  ctx.refs.set(op.ref, zone.id);
  ctx.touched.add(zone.id);
  ctx.layout.zones.push({ id: zone.id, members });
  for (const m of members) {
    const hint = ctx.layout.hints.get(m);
    if (hint && !hint.zone) hint.zone = zone.id;
  }
  ctx.changes.push(`added zone ${zone.id} "${label}" (${members.length} members, ref ${op.ref})`);
};

HANDLERS.update_zone = (ctx, op) => {
  const zone = findZone(ctx, op.id);
  const changed = [];
  if (op.label !== undefined) { zone.label = text(ctx, op.label, 'label'); changed.push('label'); }
  if (op.color !== undefined) { zone.color = zoneColor(op.color); changed.push('color'); }
  if (op.members !== undefined) {
    if (zone.kind === 'swimlane') fail(`zone "${op.id}" is a swimlane; the assistant edits plain zones only`);
    ctx.layout.refit.push({ id: zone.id, members: zoneMemberIds(ctx, op.members) });
    changed.push('members');
  }
  if (!changed.length) fail('update_zone changes nothing');
  ctx.touched.add(zone.id);
  ctx.changes.push(`updated zone ${zone.id} (${changed.join(', ')})`);
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
      const handler = op && Object.hasOwn(HANDLERS, op.op) ? HANDLERS[op.op] : null;
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
