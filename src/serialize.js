import { BUSES, DEFAULT_BUS } from './buses.js';
import { PARTS, getPart, DISPOSITIONS, PORT_ALIASES } from './palette.js';
import { newDoc, NODE_STATUSES, NODE_FLAGS, SCHEMA_VERSION } from './state.js';
import { nodeSize } from './geometry.js';

export function serialize(doc) {
  return JSON.stringify(doc, null, 2);
}

// One entry per schema step: MIGRATIONS[n] takes a raw schema-n file and
// returns its schema-(n+1) shape. The runner stamps the new version, so a
// step only rewrites the fields that changed. Tolerant field-level upgrades
// that never bumped the version (card sizes, journey views) stay inline below.
export const MIGRATIONS = {};

// Caps on what a file may carry: a text field longer than this is cut, a
// position or size beyond this is pulled back into range. Real boards sit
// orders of magnitude below both; the limits keep a hostile or corrupt file
// from stalling the renderer or the panels.
export const MAX_TEXT = 20000;
export const MAX_COORD = 1e6;

export function migrateRaw(raw, migrations = MIGRATIONS, target = SCHEMA_VERSION) {
  let version = Number.isInteger(raw.schema) && raw.schema >= 1 ? raw.schema : 1;
  while (version < target) {
    const step = migrations[version];
    if (!step) break;
    raw = { ...step(raw), schema: version + 1 };
    version += 1;
  }
  return raw;
}

export function deserialize(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Not a valid Schematica file: could not parse JSON.');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Not a valid Schematica file: top level must be an object.');
  }
  for (const key of ['nodes', 'wires', 'zones', 'notes', 'journey']) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) {
      throw new Error(`Not a valid Schematica file: "${key}" must be an array.`);
    }
  }

  const warnings = [];
  if (typeof raw.schema === 'number' && raw.schema > SCHEMA_VERSION) {
    warnings.push(`File schema ${raw.schema} is newer than this app understands (${SCHEMA_VERSION}); loading best-effort.`);
  }
  raw = migrateRaw(raw);

  let clampedText = 0;
  let clampedCoord = 0;
  // A string field, cut to MAX_TEXT; anything else becomes the fallback.
  const str = (v, fallback = '') => {
    if (typeof v !== 'string') return fallback;
    if (v.length <= MAX_TEXT) return v;
    clampedText += 1;
    return v.slice(0, MAX_TEXT);
  };
  // A finite coordinate or size, pulled back to +-MAX_COORD.
  const coord = (v) => {
    if (v > MAX_COORD) { clampedCoord += 1; return MAX_COORD; }
    if (v < -MAX_COORD) { clampedCoord += 1; return -MAX_COORD; }
    return v;
  };

  const doc = newDoc(typeof raw.title === 'string' && raw.title.trim() ? str(raw.title) : 'Untitled Board');
  const seen = new Set();
  const validId = (v) => typeof v === 'string' && v.length > 0;
  const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;
  const coerced = new Set(); // nodes whose unknown kind became a custom box

  for (const n of raw.nodes ?? []) {
    if (!n || !validId(n.id) || !Number.isFinite(n.x) || !Number.isFinite(n.y)) {
      warnings.push('Dropped a node with a missing id or position.');
      continue;
    }
    if (seen.has(n.id)) {
      warnings.push(`Dropped duplicate id "${n.id}".`);
      continue;
    }
    seen.add(n.id);
    let kind = typeof n.kind === 'string' ? n.kind : 'generic';
    if (typeof n.kind !== 'string') {
      // A missing kind quietly becomes a custom box; its wires may remap too.
      coerced.add(n.id);
    } else if (!PARTS[kind]) {
      warnings.push(`Unknown part "${kind}" became a custom box.`);
      kind = 'generic';
      coerced.add(n.id);
    }
    const part = PARTS[kind];
    let color = typeof n.color === 'string' ? n.color : null;
    if (color !== null && !HEX_COLOR.test(color)) {
      warnings.push(`Ignored invalid color on node "${n.id}".`);
      color = null;
    }
    let status = typeof n.status === 'string' ? n.status : null;
    if (status !== null && !NODE_STATUSES.includes(status)) {
      warnings.push(`Ignored unknown status "${status}" on node "${n.id}".`);
      status = null;
    }
    let flags = Array.isArray(n.flags) ? n.flags.filter((f) => NODE_FLAGS.includes(f)) : [];
    if (Array.isArray(n.flags) && flags.length !== n.flags.length) {
      warnings.push(`Dropped unknown flags on node "${n.id}".`);
    }
    const node = {
      id: n.id, kind, x: coord(n.x), y: coord(n.y),
      label: str(n.label, part.name),
      sublabel: str(n.sublabel),
      color,
      addr: str(n.addr),
      rail: str(n.rail),
      notes: str(n.notes),
      status,
      flags,
    };
    // Schema fields (threat parts) travel as a string map; only ids the part
    // knows survive, blanks are dropped, and the key is absent when empty.
    if (n.fields && typeof n.fields === 'object' && !Array.isArray(n.fields)) {
      if (!part.fields) {
        if (Object.values(n.fields).some((x) => typeof x === 'string' && x.trim())) {
          warnings.push(`Dropped fields on node "${n.id}": ${part.name} has none.`);
        }
      } else {
        const known = new Set(part.fields.map((fd) => fd.id));
        const fields = {};
        for (const [k, v] of Object.entries(n.fields)) {
          if (!known.has(k)) {
            warnings.push(`Dropped unknown field "${k}" on node "${n.id}".`);
            continue;
          }
          if (typeof v === 'string' && v.trim()) fields[k] = str(v);
        }
        if (Object.keys(fields).length) node.fields = fields;
      }
    }
    if (n.disposition != null) {
      if (typeof n.disposition === 'string' && DISPOSITIONS[n.disposition]) node.disposition = n.disposition;
      else warnings.push(`Ignored unknown disposition "${n.disposition}" on node "${n.id}".`);
    }
    // Older files stored a fixed card size. Cards now size to their content,
    // so shift the top-left corner to keep the card centered where it was.
    if (Number.isFinite(n.w) && n.w > 0 && Number.isFinite(n.h) && n.h > 0) {
      const { w, h } = nodeSize(node);
      node.x = coord(node.x + (coord(n.w) - w) / 2);
      node.y = coord(node.y + (coord(n.h) - h) / 2);
    }
    doc.nodes.push(node);
  }

  const nodeById = new Map(doc.nodes.map((n) => [n.id, n]));
  // A wire endpoint on a node whose unknown kind became a custom box loses its
  // original ports; keep the wire by moving it onto a generic side port.
  const resolvePort = (ref, fallbackPort) => {
    if (!ref || typeof ref !== 'object') return null;
    const node = nodeById.get(ref.node);
    if (!node) return null;
    // A renamed port keeps its wires through the alias table.
    const port = PORT_ALIASES[node.kind]?.[ref.port] ?? ref.port;
    if (getPart(node.kind).ports.some((p) => p.id === port)) {
      return { node: ref.node, port, remapped: false };
    }
    if (coerced.has(ref.node)) return { node: ref.node, port: fallbackPort, remapped: true };
    return null;
  };

  for (const w of raw.wires ?? []) {
    const from = w ? resolvePort(w.from, 'right') : null;
    const to = w ? resolvePort(w.to, 'left') : null;
    if (!w || !validId(w.id) || seen.has(w.id) || !from || !to) {
      warnings.push('Dropped a wire with a bad id or missing endpoint.');
      continue;
    }
    seen.add(w.id);
    if (from.remapped || to.remapped) {
      warnings.push(`Wire "${w.id}" was moved onto the custom box's generic ports.`);
    }
    let bus = typeof w.bus === 'string' ? w.bus : DEFAULT_BUS;
    if (!BUSES[bus]) {
      warnings.push(`Unknown bus "${bus}" became ${BUSES[DEFAULT_BUS].short}.`);
      bus = DEFAULT_BUS;
    }
    doc.wires.push({
      id: w.id, bus,
      from: { node: from.node, port: from.port },
      to: { node: to.node, port: to.port },
      label: str(w.label),
      arrow: w.arrow === 'fwd' || w.arrow === 'both' ? w.arrow : null,
      style: ['solid', 'dashed', 'dotted', 'sneakernet'].includes(w.style) ? w.style : null,
      flow: w.flow === 'on' || w.flow === 'off' ? w.flow : null,
    });
  }

  for (const z of raw.zones ?? []) {
    if (!z || !validId(z.id) || seen.has(z.id) || !Number.isFinite(z.x) || !Number.isFinite(z.y)
      || !(Number.isFinite(z.w) && z.w > 0) || !(Number.isFinite(z.h) && z.h > 0)) {
      warnings.push('Dropped a zone with a bad id or geometry.');
      continue;
    }
    seen.add(z.id);
    let zColor = typeof z.color === 'string' && HEX_COLOR.test(z.color) ? z.color : '#4a90d9';
    if (typeof z.color === 'string' && !HEX_COLOR.test(z.color)) {
      warnings.push(`Replaced invalid color on zone "${z.id}".`);
    }
    const zone = {
      id: z.id, x: coord(z.x), y: coord(z.y), w: coord(z.w), h: coord(z.h),
      label: str(z.label, 'Zone'),
      color: zColor,
    };
    // Swimlanes carry extra fields; plain zones keep their exact old shape.
    if (z.kind === 'swimlane') {
      zone.kind = 'swimlane';
      zone.orient = z.orient === 'v' ? 'v' : 'h';
      const lanes = Array.isArray(z.lanes)
        ? z.lanes.filter((l) => typeof l === 'string' && l.length > 0).map((l) => str(l)) : [];
      if (Array.isArray(z.lanes) && lanes.length !== z.lanes.length) {
        warnings.push(`Dropped invalid lanes on swimlane "${z.id}".`);
      }
      zone.lanes = lanes.length ? lanes : ['Lane 1'];
    }
    doc.zones.push(zone);
  }

  for (const t of raw.notes ?? []) {
    if (!t || !validId(t.id) || seen.has(t.id) || !Number.isFinite(t.x) || !Number.isFinite(t.y)) {
      warnings.push('Dropped a note with a bad id or position.');
      continue;
    }
    seen.add(t.id);
    doc.notes.push({ id: t.id, x: coord(t.x), y: coord(t.y), text: str(t.text) });
  }

  for (const s of raw.journey ?? []) {
    const v = s?.view;
    const modern = v && Number.isFinite(v.cx) && Number.isFinite(v.cy);
    const legacy = v && Number.isFinite(v.x) && Number.isFinite(v.y);
    if (!s || !validId(s.id) || seen.has(s.id) || !v
      || !Number.isFinite(v.zoom) || (!modern && !legacy)) {
      warnings.push('Dropped a journey step with a bad id or view.');
      continue;
    }
    seen.add(s.id);
    const zoom = Math.min(4, Math.max(0.2, v.zoom));
    // Legacy views stored raw screen offsets; convert to an approximate world
    // center assuming the historical ~1280x800 canvas.
    const view = modern
      ? { cx: coord(v.cx), cy: coord(v.cy), zoom }
      : { cx: coord((640 - v.x) / zoom), cy: coord((400 - v.y) / zoom), zoom };
    doc.journey.push({
      id: s.id,
      label: str(s.label, 'Step'),
      view,
      caption: str(s.caption),
    });
  }

  if (clampedText) warnings.push(`Clamped ${clampedText} over-long text field(s) to ${MAX_TEXT} characters.`);
  if (clampedCoord) warnings.push(`Clamped ${clampedCoord} out-of-range position(s) or size(s).`);
  return { doc, warnings };
}
