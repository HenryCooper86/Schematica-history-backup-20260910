// Deterministic placement for what the assistant creates. Full layout works
// outward from a hub: power parts go to columns on the left, everything else
// to the right, rows ordered by their neighbours. Incremental placement
// (Task 9) puts one new item beside an anchor and never moves anything that
// already has a position. Same input, same output; ties break on id.
import { getPart, CATEGORIES } from '../palette.js';
import { nodeSize, nodeRect, snap, contentBounds, zoneMembers, NOTE_W, noteHeight, rectsIntersect } from '../geometry.js';

export const COL_GAP = 96;
export const ROW_GAP = 40;
export const ZONE_PAD = 28;
export const NOTE_GAP = 16;
export const SLOT_MARGIN = 24;
export const ORIGIN = 40;

const CAT_INDEX = new Map(CATEGORIES.map((c, i) => [c.id, i]));
const category = (node) => getPart(node.kind).category;
const isPower = (node) => category(node) === 'power';
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Undirected adjacency over the given nodes: id -> Map(neighbour -> wire count).
export function adjacency(doc, ids) {
  const set = new Set(ids);
  const adj = new Map(ids.map((id) => [id, new Map()]));
  for (const w of doc.wires) {
    const a = w.from.node;
    const b = w.to.node;
    if (a === b || !set.has(a) || !set.has(b)) continue;
    adj.get(a).set(b, (adj.get(a).get(b) || 0) + 1);
    adj.get(b).set(a, (adj.get(b).get(a) || 0) + 1);
  }
  return adj;
}

const degree = (adj, id) => [...adj.get(id).values()].reduce((s, n) => s + n, 0);

// The best-connected compute part, else the best-connected node; ties by id.
export function pickHub(doc, ids, adj) {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const best = (list) => [...list].sort((a, b) => degree(adj, b) - degree(adj, a) || cmp(a, b))[0];
  const compute = ids.filter((id) => category(byId.get(id)) === 'compute');
  return best(compute.length ? compute : ids);
}

export function layoutAll(doc, zoneOf = new Map()) {
  const ids = doc.nodes.map((n) => n.id);
  if (!ids.length) return;
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const adj = adjacency(doc, ids);
  const hub = pickHub(doc, ids, adj);

  // Breadth-first distance from the hub; unreachable parts go one past the edge.
  const dist = new Map([[hub, 0]]);
  const queue = [hub];
  while (queue.length) {
    const id = queue.shift();
    for (const nb of [...adj.get(id).keys()].sort(cmp)) {
      if (!dist.has(nb)) { dist.set(nb, dist.get(id) + 1); queue.push(nb); }
    }
  }
  const far = Math.max(0, ...dist.values()) + 1;
  const col = new Map();
  for (const id of ids) {
    const d = dist.has(id) ? dist.get(id) : far;
    col.set(id, isPower(byId.get(id)) ? -d : d);
  }
  const columns = new Map();
  for (const id of ids) {
    const c = col.get(id) || 0; // -0 becomes 0
    if (!columns.has(c)) columns.set(c, []);
    columns.get(c).push(id);
  }

  // Rows: sweep outward from the hub column; a node's key is the mean row
  // of its neighbours in the column one step nearer the hub, and members of
  // one zone stay contiguous by sharing the group's mean.
  const order = [...columns.keys()].sort((a, b) => Math.abs(a) - Math.abs(b) || b - a);
  const row = new Map();
  for (const c of order) {
    const ref = c > 0 ? c - 1 : c + 1;
    const members = columns.get(c);
    const key = new Map();
    for (const id of members) {
      const rows = [...adj.get(id).keys()].filter((nb) => col.get(nb) === ref && row.has(nb)).map((nb) => row.get(nb));
      key.set(id, rows.length ? rows.reduce((s, r) => s + r, 0) / rows.length : Infinity);
    }
    const group = (id) => zoneOf.get(id) || `~${id}`;
    const groupKeys = new Map();
    for (const id of members) {
      const g = group(id);
      if (!groupKeys.has(g)) groupKeys.set(g, []);
      if (Number.isFinite(key.get(id))) groupKeys.get(g).push(key.get(id));
    }
    const groupKey = (g) => {
      const ks = groupKeys.get(g);
      return ks.length ? ks.reduce((s, k) => s + k, 0) / ks.length : Infinity;
    };
    members.sort((a, b) => cmp(groupKey(group(a)), groupKey(group(b)))
      || cmp(group(a), group(b))
      || cmp(key.get(a), key.get(b))
      || cmp(CAT_INDEX.get(category(byId.get(a))), CAT_INDEX.get(category(byId.get(b))))
      || cmp(byId.get(a).label, byId.get(b).label)
      || cmp(a, b));
    members.forEach((id, i) => row.set(id, i));
  }

  // Coordinates: each column as wide as its widest card, centred on a shared
  // midline, then shifted into positive space and snapped to the grid.
  const widths = new Map();
  const heights = new Map();
  for (const [c, members] of columns) {
    widths.set(c, Math.max(...members.map((id) => nodeSize(byId.get(id)).w)));
    heights.set(c, members.reduce((s, id) => s + nodeSize(byId.get(id)).h, 0) + ROW_GAP * (members.length - 1));
  }
  const cs = [...columns.keys()].sort((a, b) => a - b);
  const xs = new Map([[0, 0]]);
  let prev = 0;
  for (const c of cs.filter((k) => k > 0)) { xs.set(c, xs.get(prev) + widths.get(prev) + COL_GAP); prev = c; }
  prev = 0;
  for (const c of cs.filter((k) => k < 0).sort((a, b) => b - a)) { xs.set(c, xs.get(prev) - COL_GAP - widths.get(c)); prev = c; }
  for (const [c, members] of columns) {
    let y = -heights.get(c) / 2;
    for (const id of members) {
      const n = byId.get(id);
      const s = nodeSize(n);
      n.x = xs.get(c) + (widths.get(c) - s.w) / 2;
      n.y = y;
      y += s.h + ROW_GAP;
    }
  }
  const minX = Math.min(...doc.nodes.map((n) => n.x));
  const minY = Math.min(...doc.nodes.map((n) => n.y));
  for (const n of doc.nodes) {
    n.x = snap(n.x - minX + ORIGIN);
    n.y = snap(n.y - minY + ORIGIN);
  }
}

const down = (v) => Math.floor(v / 8) * 8;
const up = (v) => Math.ceil(v / 8) * 8;
export const noteRect = (t) => ({ x: t.x, y: t.y, w: NOTE_W, h: noteHeight(t.text) });
export const zoneRect = (z) => ({ x: z.x, y: z.y, w: z.w, h: z.h });

// The zone rectangle around its members: padding all round plus room for
// the title pill on the top edge.
export function fitZone(doc, zone, memberIds) {
  const rects = memberIds.map((id) => doc.nodes.find((n) => n.id === id)).filter(Boolean).map(nodeRect);
  if (!rects.length) return false;
  const x1 = down(Math.min(...rects.map((r) => r.x)) - ZONE_PAD);
  const y1 = down(Math.min(...rects.map((r) => r.y)) - ZONE_PAD - 8);
  const x2 = up(Math.max(...rects.map((r) => r.x + r.w)) + ZONE_PAD);
  const y2 = up(Math.max(...rects.map((r) => r.y + r.h)) + ZONE_PAD);
  Object.assign(zone, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
  return true;
}

// Zones that overlap after placement: the later one (by list order) moves
// down with its members, then is fitted again. A push whose moved cards
// would land on a card that did not move is undone: cards never overlap,
// zone rectangles occasionally do.
export function pushApart(doc, zones) {
  const byId = new Map(doc.zones.map((z) => [z.id, z]));
  const nodeById = new Map(doc.nodes.map((n) => [n.id, n]));
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const zi = byId.get(zones[i].id);
      const zj = byId.get(zones[j].id);
      if (!zi || !zj || !rectsIntersect(zi, zj)) continue;
      const dy = up(zi.y + zi.h + NOTE_GAP - zj.y);
      const moved = zones[j].members.map((id) => nodeById.get(id)).filter(Boolean);
      const movedIds = new Set(moved.map((n) => n.id));
      const before = { x: zj.x, y: zj.y, w: zj.w, h: zj.h };
      for (const n of moved) n.y += dy;
      fitZone(doc, zj, zones[j].members);
      const still = doc.nodes.filter((n) => !movedIds.has(n.id)).map(nodeRect);
      const collides = moved.some((n) => still.some((r) => rectsIntersect(nodeRect(n), r)));
      if (collides) {
        for (const n of moved) n.y -= dy;
        Object.assign(zj, before);
      }
    }
  }
}

// A note goes just above the node it is near, else above the whole board;
// either way it steps past anything it would cover.
export function placeNote(doc, noteId, hint = {}, skip = new Set()) {
  const note = doc.notes.find((t) => t.id === noteId);
  if (!note) return;
  const h = noteHeight(note.text);
  const anchor = hint.near ? doc.nodes.find((n) => n.id === hint.near) : null;
  const others = doc.notes.filter((t) => t.id !== noteId && !skip.has(t.id));
  const obstacles = [...doc.nodes.map(nodeRect), ...others.map(noteRect)];
  let x;
  let y;
  if (anchor) {
    const ar = nodeRect(anchor);
    x = ar.x + (ar.w - NOTE_W) / 2;
    y = ar.y - NOTE_GAP - h;
  } else {
    const b = contentBounds({ nodes: doc.nodes, zones: doc.zones, notes: others });
    x = b ? b.x : ORIGIN;
    y = b ? b.y - NOTE_GAP - h : ORIGIN;
  }
  x = snap(x);
  y = snap(y);
  for (let tries = 0; tries < 12; tries++) {
    const hit = obstacles.find((o) => rectsIntersect({ x, y, w: NOTE_W, h }, o));
    if (!hit) break;
    if (anchor) y = snap(hit.y - NOTE_GAP - h);
    else x = snap(hit.x + hit.w + NOTE_GAP);
  }
  note.x = x;
  note.y = y;
}

// "Tidy up": every card is laid out again, zones are refitted around the
// members they had, and notes are stacked above the board. Refuses (and
// changes nothing) when the board has a swimlane, since relaying members
// would strand them outside their lane.
export function arrangeAll(doc) {
  if (doc.zones.some((z) => z.kind === 'swimlane')) return false;
  const zones = doc.zones
    .filter((z) => z.kind !== 'swimlane')
    .map((z) => ({ id: z.id, members: zoneMembers(doc, z).filter((id) => doc.nodes.some((n) => n.id === id)) }));
  const zoneOf = new Map();
  for (const z of zones) for (const m of z.members) zoneOf.set(m, z.id);
  layoutAll(doc, zoneOf);
  for (const z of zones) {
    const zone = doc.zones.find((x) => x.id === z.id);
    if (z.members.length) fitZone(doc, zone, z.members);
  }
  pushApart(doc, zones);
  const skip = new Set(doc.notes.map((t) => t.id));
  for (const t of doc.notes) {
    placeNote(doc, t.id, {}, skip);
    skip.delete(t.id);
  }
  return true;
}
