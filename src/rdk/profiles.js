import { getPart } from '../palette.js';
import { RDK_PRODUCTS, profileFor } from './catalogue.js';
export { profileFor } from './catalogue.js';
export function nodePart(node) {
  const part = getPart(node.kind);
  const profile = profileFor(node);
  return profile?.ports ? { ...part, ports: profile.ports } : part;
}
export function knownPorts(kind) {
  const ports = new Map(getPart(kind).ports.map((p) => [p.id, p]));
  for (const product of RDK_PRODUCTS.filter((p) => p.kind === kind)) {
    for (const port of product.ports || [])
      if (!ports.has(port.id)) ports.set(port.id, port);
  }
  return [...ports.values()];
}
export function displayPart(node, wires = []) {
  const part = nodePart(node);
  const used = new Set(
    wires
      .flatMap((w) => [w.from, w.to])
      .filter((ref) => ref?.node === node.id)
      .map((ref) => ref.port),
  );
  const supported = new Set(part.ports.map((p) => p.id));
  const ports = [...part.ports];
  for (const legacy of knownPorts(node.kind)) {
    if (!used.has(legacy.id) || supported.has(legacy.id)) continue;
    const occupied = ports
      .filter((p) => p.side === legacy.side)
      .map((p) => p.offset);
    let offset = legacy.offset;
    if (occupied.includes(offset)) {
      // Put the preserved endpoint in the largest free gap on its side.
      const edges = [0, ...occupied, 1].sort((a, b) => a - b);
      let gap = -1;
      for (let i = 1; i < edges.length; i++) {
        if (edges[i] - edges[i - 1] > gap) {
          gap = edges[i] - edges[i - 1];
          offset = (edges[i] + edges[i - 1]) / 2;
        }
      }
    }
    ports.push({ ...legacy, offset, unsupported: true });
  }
  return { ...part, ports };
}
