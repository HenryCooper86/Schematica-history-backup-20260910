// What the model reads: the board as one line per item, ids first, and the
// palette catalogue (Task 11). Both are plain text a person can read too.
import { getPart } from '../palette.js';
import { zoneMembers } from '../geometry.js';

export function quote(s) {
  return `"${String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

// Bare when it is one simple token, quoted otherwise.
const value = (s) => (/^[\w.:/#@+-]+$/.test(String(s)) ? String(s) : quote(s));

export function nodeLine(doc, node) {
  const part = getPart(node.kind);
  let s = `node ${node.id} ${node.kind} ${quote(node.label)}`;
  if (node.sublabel) s += ` pn=${value(node.sublabel)}`;
  if (node.addr) s += ` addr=${value(node.addr)}`;
  if (node.rail) s += ` rail=${value(node.rail)}`;
  if (node.status) s += ` status=${node.status}`;
  if (node.flags?.length) s += ` flags=${node.flags.join(',')}`;
  if (node.disposition) s += ` disposition=${node.disposition}`;
  for (const fd of part.fields || []) {
    const v = node.fields?.[fd.id];
    if (v) s += ` ${fd.id}=${value(v)}`;
  }
  if (node.color) s += ` color=${node.color}`;
  if (node.notes) s += ` notes=${quote(node.notes)}`;
  return s;
}

export function wireLine(w) {
  const arrow = w.arrow === 'fwd' ? '->' : (w.arrow === 'both' ? '<->' : '--');
  let s = `wire ${w.id} ${w.bus} ${w.from.node}.${w.from.port} ${arrow} ${w.to.node}.${w.to.port}`;
  if (w.label) s += ` ${quote(w.label)}`;
  if (w.style) s += ` style=${w.style}`;
  if (w.flow) s += ` flow=${w.flow}`;
  return s;
}

export function zoneLine(doc, z) {
  const members = zoneMembers(doc, z).filter((id) => doc.nodes.some((n) => n.id === id));
  const list = members.join(' ') || '-';
  if (z.kind === 'swimlane') return `swimlane ${z.id} ${quote(z.label)} lanes: ${z.lanes.map(quote).join(', ')} members: ${list}`;
  return `zone ${z.id} ${quote(z.label)} members: ${list}`;
}

export function boardText(doc, { selection = [], findings = [] } = {}) {
  const lines = [`board ${quote(doc.title)}`];
  for (const z of doc.zones) lines.push(zoneLine(doc, z));
  for (const n of doc.nodes) lines.push(nodeLine(doc, n));
  for (const w of doc.wires) lines.push(wireLine(w));
  for (const t of doc.notes) lines.push(`note ${t.id} ${quote(t.text)}`);
  if (selection.length) lines.push(`selected: ${selection.join(' ')}`);
  for (const f of findings) lines.push(`checks: ${f.level} ${f.rule} ${quote(f.message)} ${f.ids.join(' ')}`);
  return lines.join('\n');
}
