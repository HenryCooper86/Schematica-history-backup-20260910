// Design-rule checker: pure derivation from a document. Zero dependencies.
// Findings: { level: 'error'|'warning', rule, message, ids: [nodeOrWireIds] }.

import { nodePart } from './rdk/profiles.js';
import { checkRdk } from './rdk/checks.js';
import { tr } from './i18n.js';

function i2cComponents(doc) {
  // Connected components over nodes joined by i2c-bus wires.
  const parent = new Map();
  const find = (a) => {
    while (parent.get(a) !== a) {
      parent.set(a, parent.get(parent.get(a)));
      a = parent.get(a);
    }
    return a;
  };
  const union = (a, b) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  };
  for (const w of doc.wires) {
    if (w.bus === 'i2c') union(w.from.node, w.to.node);
  }
  const groups = new Map();
  for (const id of parent.keys()) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  }
  return [...groups.values()];
}

export function checkDoc(doc) {
  const findings = [];
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const wiredPorts = new Set();
  const wiredNodes = new Set();
  for (const w of doc.wires) {
    wiredPorts.add(`${w.from.node}|${w.from.port}`);
    wiredPorts.add(`${w.to.node}|${w.to.port}`);
    wiredNodes.add(w.from.node);
    wiredNodes.add(w.to.node);
  }

  // 1. I2C address conflicts within one net.
  for (const component of i2cComponents(doc)) {
    const byAddr = new Map();
    for (const id of component) {
      const n = byId.get(id);
      if (n && n.addr) {
        if (!byAddr.has(n.addr)) byAddr.set(n.addr, []);
        byAddr.get(n.addr).push(n);
      }
    }
    for (const [addr, nodes] of byAddr) {
      if (nodes.length > 1) {
        findings.push({
          level: 'error',
          rule: 'i2c-addr-conflict',
          message: tr('I2C address {addr} is used by {names} on the same bus.', { addr, names: nodes.map((n) => n.label).join(tr(' and ')) }),
          ids: nodes.map((n) => n.id),
        });
      }
    }
  }

  // 2. Unconnected supply pins. Built-in parts: VCC/GND/VIN* consumption pins
  //    by name. Custom parts: every port the definition marks required, on any
  //    bus; power and ground report under the same rule as built-ins.
  for (const n of doc.nodes) {
    const part = nodePart(n);
    for (const port of part.ports) {
      const supply = port.bus === 'power' || port.bus === 'gnd';
      const must = part.custom
        ? port.required === true
        : supply && (port.id === 'vcc' || port.id === 'gnd' || port.id.startsWith('vin'));
      if (must && !wiredPorts.has(`${n.id}|${port.id}`)) {
        findings.push({
          level: 'warning',
          rule: supply ? 'unconnected-power' : 'unconnected-port',
          message: tr('{label}\'s {port} pin is unconnected.', { label: n.label, port: port.name }),
          ids: [n.id],
        });
      }
    }
  }

  // 3. Fully floating nodes.
  const floating = doc.nodes.filter((n) => !wiredNodes.has(n.id));
  if (floating.length) {
    findings.push({
      level: 'warning',
      rule: 'floating-node',
      message: floating.length === 1
        ? tr('{names} is not wired to anything.', { names: floating.map((n) => n.label).join(', ') })
        : tr('{names} are not wired to anything.', { names: floating.map((n) => n.label).join(', ') }),
      ids: floating.map((n) => n.id),
    });
  }

  // 4. Wire bus matches neither endpoint's port bus.
  for (const w of doc.wires) {
    const busOf = (ref) => {
      const n = byId.get(ref.node);
      return n ? nodePart(n).ports.find((p) => p.id === ref.port)?.bus : undefined;
    };
    const ends = [busOf(w.from), busOf(w.to)];
    if (ends[0] !== undefined && ends[1] !== undefined && !ends.includes(w.bus)) {
      findings.push({
        level: 'warning',
        rule: 'bus-mismatch',
        message: tr('A {bus} wire connects ports that are {a} and {b}.', { bus: w.bus.toUpperCase(), a: String(ends[0]).toUpperCase(), b: String(ends[1]).toUpperCase() }),
        ids: [w.id],
      });
    }
  }

  // 5. Lifecycle risks: deprecated status or EOL flag in the design.
  for (const n of doc.nodes) {
    if (n.status === 'deprecated' || (n.flags || []).includes('eol')) {
      findings.push({
        level: 'warning',
        rule: 'lifecycle',
        message: n.status === 'deprecated' ? tr('{label} is marked deprecated.', { label: n.label }) : tr('{label} is flagged end-of-life.', { label: n.label }),
        ids: [n.id],
      });
    }
  }

  findings.push(...checkRdk(doc));
  const order = { error: 0, warning: 1 };
  return findings.sort((a, b) => order[a.level] - order[b.level]);
}
