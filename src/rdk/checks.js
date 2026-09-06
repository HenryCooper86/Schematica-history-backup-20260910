// Pure, source-aware architectural checks. Unknown metadata is never support.
import { profileFor } from './profiles.js';

const refs = (w) => [
  [w.from, w.to],
  [w.to, w.from],
];
const sources = (...profiles) =>
  [
    ...new Set(profiles.flatMap((p) => (p?.sources || []).map((s) => s.url))),
  ].join(' ');
const requirements = (...profiles) =>
  [...new Set(profiles.flatMap((p) => p?.requirements || []))].join(' ');
const isBoard = (n) => n?.kind === 'aisbc';
const isCamera = (n) => ['mipicam', 'depthcam'].includes(n?.kind);
const voltage = (value) => {
  const m = String(value || '')
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*V?(?:\s*[-–]\s*(\d+(?:\.\d+)?)\s*V)?$/i);
  // Require a voltage unit; bare numbers are not declared voltages.
  if (!m || !/v/i.test(value)) return null;
  const a = Number(m[1]),
    b = Number(m[2] || m[1]);
  return a <= b ? [a, b] : null;
};

// cameraOccupancy(doc, node) -> [{port, endpoints:[{node,port}], wireIds}].
// Only documented board CSI ports count; duplicate edges share an endpoint.
export function cameraOccupancy(doc, node) {
  const profile = profileFor(node);
  if (!isBoard(node) || !profile?.ports) return [];
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  return profile.ports
    .filter((p) => p.bus === 'mipi')
    .map((port) => {
      const endpoints = new Map(),
        wireIds = [];
      for (const w of doc.wires)
        for (const [own, other] of refs(w)) {
          if (
            own.node !== node.id ||
            own.port !== port.id ||
            !isCamera(byId.get(other.node))
          )
            continue;
          endpoints.set(`${other.node}|${other.port}`, other);
          wireIds.push(w.id);
        }
      return { port: port.id, endpoints: [...endpoints.values()], wireIds };
    });
}

export function checkRdk(doc) {
  const findings = [],
    byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const add = (level, rule, message, ids) =>
    findings.push({ level, rule, message, ids: [...new Set(ids)] });
  for (const n of doc.nodes) {
    const p = profileFor(n);
    if (p && n.kind !== 'rdksoftware' && !p.ports) {
      add(
        'warning',
        'rdk-interface',
        `${n.label}: connector profile is unverified. ${requirements(p)} ${sources(p)}`,
        [n.id],
      );
    }
    for (const slot of cameraOccupancy(doc, n))
      if (slot.endpoints.length > 1) {
        add(
          'error',
          'rdk-csi-capacity',
          `${n.label} ${slot.port} is shared by multiple camera inputs.`,
          [n.id, ...slot.endpoints.map((e) => e.node), ...slot.wireIds],
        );
      }
    // Known stereo cameras declare their two actual camera-side CSI ports.
    const stereoPorts = isCamera(n)
      ? p?.ports?.filter((port) => port.bus === 'mipi')
      : null;
    if (stereoPorts?.length === 2) {
      const links = stereoPorts.map((port) => {
        const unique = new Map();
        for (const w of doc.wires)
          for (const [own, other] of refs(w)) {
            if (own.node === n.id && own.port === port.id)
              unique.set(`${other.node}|${other.port}`, { other, wire: w });
          }
        return [...unique.values()];
      });
      const all = links.flat(),
        ids = [n.id, ...all.flatMap((l) => [l.other.node, l.wire.id])];
      const endpoints = all.map((l) => l.other),
        hosts = endpoints.map((e) => byId.get(e.node));
      const malformed =
        links.some((l) => l.length !== 1) ||
        hosts.some((h) => !isBoard(h)) ||
        endpoints[0]?.node !== endpoints[1]?.node ||
        endpoints[0]?.port === endpoints[1]?.port ||
        endpoints.some(
          (e, i) =>
            profileFor(hosts[i])?.ports &&
            !profileFor(hosts[i]).ports.some(
              (p) => p.id === e.port && p.bus === 'mipi',
            ),
        ) ||
        all.some((l) => l.wire.bus !== 'mipi');
      if (malformed)
        add(
          'error',
          'rdk-stereo-links',
          `${n.label} requires left and right MIPI links to two distinct supported CSI connectors on the same board. ${sources(p)}`,
          ids,
        );
      else if (hosts.some((h) => !profileFor(h)?.ports))
        add(
          'warning',
          'rdk-stereo-links',
          `${n.label}: stereo connector pair is unverified. ${requirements(p, ...hosts.map(profileFor))} ${sources(p, ...hosts.map(profileFor))}`,
          ids,
        );
    }
    if (isBoard(n) && p?.power) {
      const supplies = [{ rail: n.rail, ids: [n.id] }];
      for (const w of doc.wires)
        for (const [own, other] of refs(w)) {
          if (own.node !== n.id || own.port !== 'vcc' || w.bus !== 'power')
            continue;
          const supply = byId.get(other.node);
          // A regulator's generic rail may describe its input. Do not infer output.
          if (
            ['battery', 'vbat'].includes(supply?.kind) &&
            other.port === 'out'
          )
            supplies.push({ rail: supply.rail, ids: [n.id, supply.id, w.id] });
        }
      for (const supply of supplies) {
        const v = voltage(supply.rail);
        if (v && (v[0] < p.power.inputMinV || v[1] > p.power.inputMaxV))
          add(
            'error',
            'rdk-power',
            `${n.label} supply ${supply.rail} is outside its documented ${p.power.inputMinV}–${p.power.inputMaxV}V input range. ${sources(p)}`,
            supply.ids,
          );
      }
    }
    if (n.kind === 'rdksoftware') {
      const fields = n.fields || {},
        component = profileFor({
          kind: 'rdksoftware',
          sublabel: fields.package,
        });
      const target = byId.get(fields.target),
        board = profileFor(target),
        data = component?.software;
      const ids = [n.id, ...(target ? [target.id] : [])];
      let reason = '';
      if (!fields.target) reason = 'Select a target RDK board.';
      else if (!isBoard(target))
        reason = 'Target board is missing or is not a board.';
      else if (!data || !board)
        reason = 'Package/board compatibility is unverified.';
      else if (component.compatibility.unsupportedBoardIds.includes(board.id))
        reason = 'Package is explicitly unsupported on the selected board.';
      else if (!data.boardIds?.includes(board.id))
        reason = 'Package/board compatibility is unverified.';
      else if (String(fields.runtime || '').trim()) {
        if (!data.runtimes)
          reason = 'Selected runtime compatibility is unverified.';
        else if (!data.runtimes.includes(fields.runtime.trim()))
          reason =
            'Selected runtime is outside the documented supported runtimes.';
      }
      if (reason)
        add(
          'warning',
          'rdk-software',
          `${n.label}: ${reason} ${sources(component, board) || 'https://d-robotics.github.io/tros_doc/en/tros/'}`,
          ids,
        );
    }
  }
  const pairs = new Set();
  for (const w of doc.wires) {
    for (const [own, other] of refs(w)) {
      const n = byId.get(own.node),
        p = profileFor(n);
      if (p?.ports && !p.ports.some((port) => port.id === own.port))
        add(
          'error',
          'rdk-interface',
          `${n.label}: connector ${own.port} is unavailable on ${p.name}. ${sources(p)}`,
          [n.id, w.id],
        );
      const host = byId.get(other.node);
      if (!isCamera(n) || !isBoard(host)) continue;
      const key = `${n.id}|${host.id}`;
      if (pairs.has(key)) continue;
      pairs.add(key);
      const board = profileFor(host),
        compatibility = p?.compatibility;
      const ids = [
        n.id,
        host.id,
        ...doc.wires
          .filter((link) =>
            refs(link).some(([a, b]) => a.node === n.id && b.node === host.id),
          )
          .map((link) => link.id),
      ];
      if (board && compatibility?.unsupportedBoardIds.includes(board.id))
        add(
          'error',
          'rdk-compatibility',
          `${n.label} is explicitly unsupported on ${board.name}. ${sources(p, board) || 'https://d-robotics.github.io/rdk_doc/en/Quick_start/accessory/'}`,
          ids,
        );
      else if (
        !p ||
        !board ||
        !compatibility?.boardIds?.includes(board.id) ||
        !board.ports
      )
        add(
          'warning',
          'rdk-compatibility',
          `${n.label} with ${host.label}: compatibility is unverified. ${requirements(p, board)} ${sources(p, board) || 'https://d-robotics.github.io/rdk_doc/en/Quick_start/accessory/'}`,
          ids,
        );
    }
  }
  return findings;
}
