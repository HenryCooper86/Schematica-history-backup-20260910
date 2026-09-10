// Design-rule checker: pure derivation from a document; the messages are
// written in the interface language.
// Findings: { level: 'error'|'warning'|'info', rule, message, ids: [nodeOrWireIds] }.

import { nodePart } from './rdk/profiles.js';
import { checkRdk } from './rdk/checks.js';
import { busComponents, powerRails, runtimeHours, formatCurrent, formatCapacity, formatHours } from './power.js';
import { tr } from './i18n.js';

// The comparison form of an I2C address: surrounding whitespace and the case
// of the hex prefix and digits carry no meaning. Empty when there is none.
export function i2cAddrKey(addr) {
  return String(addr ?? '').trim().toLowerCase();
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

  // 1. I2C address conflicts within one net. "0x76", " 0X76 " and "0x76"
  //    are the same device address, so compare a normalised key and report
  //    the address as the first conflicting node wrote it.
  for (const component of busComponents(doc, 'i2c')) {
    const byAddr = new Map();
    for (const id of component) {
      const n = byId.get(id);
      const key = i2cAddrKey(n?.addr);
      if (key) {
        if (!byAddr.has(key)) byAddr.set(key, []);
        byAddr.get(key).push(n);
      }
    }
    for (const nodes of byAddr.values()) {
      if (nodes.length > 1) {
        const addr = String(nodes[0].addr).trim();
        findings.push({
          level: 'error',
          rule: 'i2c-addr-conflict',
          message: tr('I2C address {addr} is used by {names} on the same bus.', { addr, names: nodes.map((n) => n.label).join(tr(' and ')) }),
          ids: nodes.map((n) => n.id),
        });
      }
    }
  }

  // 2. Unconnected supply pins. Built-in parts: the VCC/GND consumption pins
  //    by id. Custom parts: every port the definition marks required, on any
  //    bus; power and ground report under the same rule as built-ins.
  for (const n of doc.nodes) {
    const part = nodePart(n);
    for (const port of part.ports) {
      const supply = port.bus === 'power' || port.bus === 'gnd';
      const must = part.custom
        ? port.required === true
        : supply && (port.id === 'vcc' || port.id === 'gnd');
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

  // 6. Power budget. A rail is what the power wires join: one or more supplies
  //    feeding a set of consumers, with a regulator sitting on two rails at
  //    once (see power.js). Only a rail somebody has put a figure on is
  //    reported, so a board that never fills the current fields in stays as
  //    quiet as it was before the fields existed.
  for (const rail of powerRails(doc)) {
    if (!rail.declared || !rail.sources.length) continue;
    const draw = formatCurrent(rail.typicalMa);
    // Peaks are summed and named, never judged: whether two of them land in
    // the same instant, and whether the bulk capacitance rides them out, is
    // not something a sum of datasheet numbers can say.
    const extra = [];
    if (rail.peakMa > rail.typicalMa) extra.push(tr('Peaks add up to {peak}.', { peak: formatCurrent(rail.peakMa) }));
    if (rail.unknown === 1) extra.push(tr('One more part on this rail declares no current.'));
    else if (rail.unknown > 1) extra.push(tr('{n} more parts on this rail declare no current.', { n: rail.unknown }));
    const say = (text) => [text, ...extra].join(' ');
    const ids = [...rail.sources, ...rail.draws].map((e) => e.node.id);

    for (const source of rail.sources) {
      const limit = source.currents.limitMa;
      if (limit == null || !(limit > 0)) continue;
      const vars = { label: source.node.label, limit: formatCurrent(limit), draw };
      if (rail.typicalMa > limit) {
        findings.push({
          level: 'error',
          rule: 'power-budget',
          message: say(tr('{label} can supply {limit}, but the parts on its rail draw {draw}.', vars)),
          ids,
        });
      } else if (rail.typicalMa > limit * 0.8) {
        findings.push({
          level: 'warning',
          rule: 'power-budget',
          message: say(tr('{label} can supply {limit} and the parts on its rail already draw {draw}.', vars)),
          ids,
        });
      }
    }
    // Nothing states a limit, yet parts on the rail state what they draw: the
    // sum is real but there is nothing to compare it with. A rail whose only
    // figure was carried across from downstream says nothing here, because a
    // derived number is no reason to demand a rating.
    if (rail.declaredDraw && !rail.declaredLimit) {
      const names = rail.sources.map((s) => s.node.label).join(tr(' and '));
      findings.push({
        level: 'info',
        rule: 'power-budget-unknown',
        message: say(rail.sources.length === 1
          ? tr('{names} declares no output current limit, so the {draw} on its rail cannot be checked.', { names, draw })
          : tr('{names} declare no output current limit, so the {draw} on their rail cannot be checked.', { names, draw })),
        ids,
      });
    }
    // A cell with a capacity and a known load has a runtime. It is division,
    // not a model: no duty cycle, no converter losses, no ageing, no cut-off.
    for (const source of rail.sources) {
      const hours = runtimeHours(source.currents.capacityMah, rail.typicalMa);
      if (hours == null) continue;
      findings.push({
        level: 'info',
        rule: 'battery-runtime',
        message: tr('{label} holds {capacity}; at {draw} that is about {hours} h, ignoring duty cycle and conversion efficiency.', {
          label: source.node.label, capacity: formatCapacity(source.currents.capacityMah), draw, hours: formatHours(hours),
        }),
        ids: [source.node.id],
      });
    }
  }

  findings.push(...checkRdk(doc));
  const order = { error: 0, warning: 1, info: 2 };
  return findings.sort((a, b) => order[a.level] - order[b.level]);
}
