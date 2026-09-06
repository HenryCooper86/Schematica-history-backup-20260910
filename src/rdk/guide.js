// Pure document-derived reference guide. No provider, settings or command access.
import { profileFor, RDK_PRODUCTS } from './catalogue.js';
import { cameraOccupancy } from './checks.js';
import { checkDoc } from '../drc.js';

export function rdkProfile(node) {
  return profileFor(
    node?.kind === 'rdksoftware'
      ? { kind: node.kind, sublabel: node.fields?.package }
      : node,
  );
}
function compatiblePeripherals(profile) {
  if (profile?.kind !== 'aisbc') return [];
  return RDK_PRODUCTS.filter(
    (p) =>
      !['aisbc', 'rdksoftware'].includes(p.kind) &&
      p.compatibility.boardIds?.includes(profile.id) &&
      !p.compatibility.unsupportedBoardIds.includes(profile.id),
  );
}
export function safeSources(profile) {
  const sources = [profile, ...compatiblePeripherals(profile)].flatMap(
    (p) => p?.sources || [],
  );
  return [...new Map(sources.map((s) => [s.url, s])).values()].filter((s) => {
    try {
      const url = new URL(s.url);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      return false;
    }
  });
}
// Flatten user text and encode Markdown punctuation, including HTML and links.
export function markdownText(value) {
  return String(value ?? '')
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/[&<>\\`*_{}\[\]()#+.!|~-]/g, (c) => `&#${c.charCodeAt(0)};`);
}
function profileFacts(p) {
  if (!p) return ['Package or product identity is unverified.'];
  const lines = [
    p.name,
    `Checked: ${p.checkedOn}`,
    p.notes,
    `Ports: ${p.ports ? p.ports.map((port) => `${port.id} (${port.bus})`).join(', ') : 'unverified; generic drawing ports are not validated connectors'}`,
  ];
  if (p.power)
    lines.push(
      `Power: ${p.power.rail}; input ${p.power.inputMinV}–${p.power.inputMaxV}V${p.power.recommendedCurrentA ? `; recommended ${p.power.recommendedCurrentA}A` : ''}${p.power.recommendedPowerW ? `; recommended ${p.power.recommendedPowerW}W` : ''}${p.power.maxLoadPowerW ? `; maximum-load supply ${p.power.maxLoadPowerW}W` : ''}`,
    );
  lines.push(...p.requirements);
  if (p.compatibility.boardIds)
    lines.push(`Documented boards: ${p.compatibility.boardIds.join(', ')}`);
  if (p.compatibility.unsupportedBoardIds.length)
    lines.push(
      `Unsupported boards: ${p.compatibility.unsupportedBoardIds.join(', ')}`,
    );
  const peripherals = compatiblePeripherals(p);
  if (peripherals.length) {
    lines.push(
      `Documented peripherals: ${peripherals.map((part) => part.name).join(', ')}`,
    );
    for (const part of peripherals)
      lines.push(`${part.name} requirements: ${part.requirements.join(' ')}`);
    lines.push(
      'These documented relationships do not validate other peripherals or replace carrier, adapter and connector requirements.',
    );
  }
  return lines;
}
export function referenceText(profile) {
  return [
    ...profileFacts(profile),
    ...safeSources(profile).map(
      (s) => `${s.title}${s.archived ? ' (archived)' : ''}: ${s.url}`,
    ),
  ].join('\n');
}
export function rdkFacts(node, doc) {
  const lines = profileFacts(rdkProfile(node));
  for (const slot of cameraOccupancy(doc, node))
    lines.push(
      `CSI ${slot.port}: ${slot.endpoints.length ? slot.endpoints.map((e) => `${e.node}.${e.port}`).join(', ') : 'unused'}`,
    );
  return lines;
}
export function rdkGuide(doc) {
  if (!doc.nodes.some((n) => n.kind === 'aisbc' && rdkProfile(n))) return '';
  const m = markdownText;
  const out = [
    `# RDK setup guide: ${m(doc.title)}`,
    '',
    'Architecture reference only. Verify the exact hardware revision, adapters, power supply and software documentation before setup. Diagram checks do not certify hardware operation.',
    '',
    '## Bill of materials',
  ];
  // Include every diagram component: unknown accessories must remain visible.
  for (const n of doc.nodes) {
    out.push(
      `- ${m(n.label)} (${m(n.id)}): ${m(n.kind === 'rdksoftware' ? n.fields?.package || 'package not selected' : n.sublabel || n.kind)}`,
    );
    if (rdkProfile(n) || n.kind === 'rdksoftware')
      for (const line of rdkFacts(n, doc)) out.push(`  - ${m(line)}`);
    if (n.notes) out.push(`  - Component notes / assumptions: ${m(n.notes)}`);
  }
  out.push('', '## Connections');
  for (const w of doc.wires)
    out.push(
      `- ${m(w.from.node)}.${m(w.from.port)} → ${m(w.to.node)}.${m(w.to.port)} (${m(w.bus)})`,
    );
  if (!doc.wires.length) out.push('No connections drawn.');
  out.push('', '## Software mapping');
  for (const n of doc.nodes.filter((n) => n.kind === 'rdksoftware')) {
    const target = doc.nodes.find(
      (b) => b.id === n.fields?.target && b.kind === 'aisbc',
    );
    out.push(
      `- ${m(n.label)}: package ${m(n.fields?.package || 'not selected')}; target: ${m(target ? `${target.label} (${target.id})` : `${n.fields?.target || 'not selected'} (missing or non-board target)`)}; Runtime: ${m(n.fields?.runtime || 'not selected (optional component-level assumption)')}`,
    );
  }
  out.push('', '## Diagram notes and assumptions');
  for (const note of doc.notes) out.push(`- ${m(note.text)}`);
  if (!doc.notes.length) out.push('No diagram notes recorded.');
  out.push('', '## Findings');
  const findings = checkDoc(doc);
  for (const f of findings)
    out.push(`- ${m(f.level)} ${f.rule}: ${m(f.message)}`);
  if (!findings.length)
    out.push(
      'No current architectural findings. Physical operation still requires verification.',
    );
  out.push(
    '',
    '## Preparation checklist',
    '- Confirm the exact hardware revision and any carrier or expansion board against the official references; resolve unverified connectors and adapter requirements.',
    '- Verify the required cables, connector orientation and separate stereo CSI paths against the documented assembly.',
    '- Check power voltage, supply capacity, regulation and all return/ground connections; resolve the current findings above.',
    '- Review each software package, target board and selected runtime in the software mapping against its official documentation. If runtime is not selected, record that decision before setup.',
    '- Create a hardware validation record with the actual board revision, assembly, software/runtime versions, observations and unresolved issues after physical testing. This guide does not establish validation results.',
  );
  out.push('', '## Official references');
  const sources = new Map();
  for (const n of doc.nodes)
    for (const s of safeSources(rdkProfile(n))) sources.set(s.url, s);
  for (const s of sources.values())
    out.push(
      `- [${m(s.title)}${s.archived ? ' (archived)' : ''}](<${s.url.replace(/[<>\s()]/g, (c) => encodeURIComponent(c))}>)`,
    );
  return out.join('\n') + '\n';
}
