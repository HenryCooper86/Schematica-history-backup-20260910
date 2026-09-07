import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, SIDES, PATH_RE, initials, portsWithOffsets, normalizePart, partOf, mergePortIds, mergeFieldIds } from '../src/custom.js';
import { PARTS } from '../src/palette.js';

const DEF = {
  name: 'Motor driver x4', category: 'actuators', accent: null, icon: { kind: 'motor' },
  ports: [
    { id: 'p1', name: 'VCC', side: 'top', bus: 'power', required: true },
    { id: 'p2', name: 'GND', side: 'top', bus: 'gnd', required: true },
    { id: 'p3', name: 'CAN', side: 'left', bus: 'can', required: false },
    { id: 'p4', name: 'M1', side: 'right', bus: 'pwm', required: false },
    { id: 'p5', name: 'M2', side: 'right', bus: 'pwm', required: false },
  ],
  fields: [{ id: 'f1', label: 'Channels' }, { id: 'f2', label: 'Drive', options: ['brushed', 'brushless', 'stepper'] }],
};

test('limits match the spec and sides are the four card edges', () => {
  assert.equal(LIMITS.name, 60);
  assert.equal(LIMITS.ports, 24);
  assert.equal(LIMITS.portName, 12);
  assert.equal(LIMITS.fields, 8);
  assert.equal(LIMITS.options, 20);
  assert.equal(LIMITS.option, 40);
  assert.equal(LIMITS.path, 2000);
  assert.equal(LIMITS.library, 200);
  assert.deepEqual(SIDES, ['left', 'right', 'top', 'bottom']);
  assert.ok(PATH_RE.test('M4 4h8v8H4z M6 1v3'));
  assert.ok(!PATH_RE.test('M4 4<script>'));
});

test('initials take the first letters of the first two words', () => {
  assert.equal(initials('Motor driver x4'), 'MD');
  assert.equal(initials('MCU'), 'MC');
  assert.equal(initials('x'), 'X');
  assert.equal(initials(''), '?');
});

test('ports on one side are spaced evenly in list order and keep their order', () => {
  const out = portsWithOffsets(DEF.ports);
  assert.deepEqual(out.map((p) => p.id), ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.deepEqual(out.map((p) => p.offset), [0.333, 0.667, 0.5, 0.333, 0.667]);
  assert.deepEqual(portsWithOffsets([]), []);
});

test('a complete definition round-trips unchanged with no warnings', () => {
  const { part, warnings } = normalizePart(DEF);
  assert.deepEqual(warnings, []);
  assert.deepEqual(part, DEF);
  assert.notEqual(part, DEF, 'a fresh object');
  const withLib = normalizePart({ ...DEF, lib: 'lp1abc' }).part;
  assert.equal(withLib.lib, 'lp1abc');
  assert.deepEqual(Object.keys(withLib)[0], 'lib');
});

test('an unusable definition is null with a reason', () => {
  assert.equal(normalizePart(null).part, null);
  assert.equal(normalizePart([]).part, null);
  assert.equal(normalizePart({}).part, null);
  assert.match(normalizePart({ name: '   ' }).warnings[0], /no name/);
});

test('name, category, accent, and icon fall back with warnings', () => {
  const long = normalizePart({ name: 'x'.repeat(100) }).part;
  assert.equal(long.name.length, LIMITS.name);
  const cat = normalizePart({ name: 'A', category: 'toys' });
  assert.equal(cat.part.category, 'misc');
  assert.match(cat.warnings[0], /Unknown category "toys"/);
  assert.equal(normalizePart({ name: 'A' }).part.category, 'misc');
  assert.deepEqual(normalizePart({ name: 'A' }).warnings, [], 'a missing category is the default, not a warning');
  const acc = normalizePart({ name: 'A', accent: 'red' });
  assert.equal(acc.part.accent, null);
  assert.match(acc.warnings[0], /invalid accent/);
  assert.equal(normalizePart({ name: 'A', accent: '#f87171' }).part.accent, '#f87171');
  // Icons: a built-in kind, initials, a path; anything else is initials.
  assert.deepEqual(normalizePart({ name: 'Ab Cd', icon: { kind: 'mcu' } }).part.icon, { kind: 'mcu' });
  assert.deepEqual(normalizePart({ name: 'Ab Cd', icon: { text: ' md ' } }).part.icon, { text: 'md' });
  assert.deepEqual(normalizePart({ name: 'Ab Cd', icon: { path: 'M1 1h2' } }).part.icon, { path: 'M1 1h2' });
  assert.deepEqual(normalizePart({ name: 'Ab Cd' }).part.icon, { text: 'AC' });
  const bad = normalizePart({ name: 'Ab Cd', icon: { kind: 'nope' } });
  assert.deepEqual(bad.part.icon, { text: 'AC' });
  assert.match(bad.warnings[0], /Icon/);
  assert.deepEqual(normalizePart({ name: 'Ab', icon: { text: 'ABCD' } }).part.icon, { text: 'AB' }, 'over-long initials fall back');
  assert.deepEqual(normalizePart({ name: 'Ab', icon: { path: 'x1' } }).part.icon, { text: 'AB' }, 'a path must start with M');
});

test('ports: ids are generated and unique, bad entries drop, buses fall back, same-side duplicates drop', () => {
  const res = normalizePart({
    name: 'P',
    ports: [
      { name: 'VCC', side: 'left', bus: 'power' },
      { name: 'vcc', side: 'left', bus: 'gnd' },
      { name: 'VCC', side: 'right', bus: 'power' },
      { name: '', side: 'left', bus: 'i2c' },
      { name: 'X', side: 'middle', bus: 'i2c' },
      { name: 'Y', side: 'bottom', bus: 'warp' },
      { id: 'p1', name: 'Z', side: 'top', bus: 'spi', required: true },
      { id: 'a b', name: 'Q', side: 'top', bus: 'spi' },
    ],
  });
  const ports = res.part.ports;
  assert.deepEqual(ports.map((p) => p.name), ['VCC', 'VCC', 'Y', 'Z', 'Q']);
  assert.deepEqual(ports.map((p) => p.id), ['p1', 'p2', 'p3', 'p4', 'p5'], 'explicit p1 collides with the generated one and is regenerated');
  assert.equal(ports[2].bus, 'gpio');
  assert.equal(ports[3].required, true);
  assert.equal(ports[0].required, false);
  assert.ok(res.warnings.some((w) => /duplicate port "vcc"/i.test(w)));
  assert.ok(res.warnings.some((w) => /no name or side/.test(w)));
  assert.ok(res.warnings.some((w) => /unknown bus "warp"/.test(w)));
  assert.equal(res.warnings.filter((w) => /no name or side/.test(w)).length, 2);
  const many = normalizePart({ name: 'P', ports: Array.from({ length: 30 }, (_, i) => ({ name: `P${i}`, side: 'left', bus: 'gpio' })) });
  assert.equal(many.part.ports.length, LIMITS.ports);
  assert.ok(many.warnings.some((w) => /first 24 ports/.test(w)));
  assert.equal(normalizePart({ name: 'P', ports: [{ name: 'ABCDEFGHIJKLMNOP', side: 'left', bus: 'gpio' }] }).part.ports[0].name.length, LIMITS.portName);
  assert.deepEqual(normalizePart({ name: 'P', ports: 'nope' }).part.ports, []);
});

test('fields: labels required, choices need two or more, ids generated', () => {
  const res = normalizePart({
    name: 'F',
    fields: [
      { label: 'Channels' },
      { label: '', options: ['a', 'b'] },
      { label: 'Drive', options: ['brushed', ' brushed ', 'stepper', ''] },
      { label: 'Lonely', options: ['one'] },
      { id: 'f9', label: 'Keep', placeholder: 'e.g. 4' },
    ],
  });
  const fields = res.part.fields;
  assert.deepEqual(fields.map((f) => f.id), ['f1', 'f2', 'f3', 'f9']);
  assert.deepEqual(fields[1].options, ['brushed', 'stepper']);
  assert.equal(fields[2].options, undefined);
  assert.equal(fields[3].placeholder, 'e.g. 4');
  assert.ok(res.warnings.some((w) => /no label/.test(w)));
  assert.ok(res.warnings.some((w) => /at least two choices/.test(w)));
  const many = normalizePart({ name: 'F', fields: Array.from({ length: 10 }, (_, i) => ({ label: `L${i}` })) });
  assert.equal(many.part.fields.length, LIMITS.fields);
});

test('partOf resolves a custom node to a catalogue-shaped part and memoizes it', () => {
  const node = { id: 'n1', kind: 'custom', part: DEF, label: 'MD' };
  const part = partOf(node);
  assert.equal(part.kind, 'custom');
  assert.equal(part.custom, true);
  assert.equal(part.name, 'Motor driver x4');
  assert.equal(part.category, 'actuators');
  assert.equal(part.icon, PARTS.motor.icon, 'a kind icon is the built-in path');
  assert.equal(part.glyph, undefined);
  assert.equal(part.ports.length, 5);
  assert.equal(part.ports[0].offset, 0.333);
  assert.deepEqual(part.fields, DEF.fields);
  assert.equal(partOf(node), part, 'same definition object, same part');
  assert.notEqual(partOf({ ...node, part: structuredClone(DEF) }), part, 'a clone resolves afresh');
});

test('partOf draws initials, paths, and glyph kinds, and hides an empty field list', () => {
  const text = partOf({ kind: 'custom', part: { name: 'Ab Cd', category: 'misc', accent: null, icon: { text: 'ZZ' }, ports: [], fields: [] } });
  assert.equal(text.text, 'ZZ');
  assert.equal(text.icon, undefined);
  assert.equal(text.fields, undefined, 'no fields means no schema section');
  const path = partOf({ kind: 'custom', part: { name: 'P', category: 'misc', accent: null, icon: { path: 'M1 1h2' }, ports: [], fields: [] } });
  assert.equal(path.icon, 'M1 1h2');
  const glyph = partOf({ kind: 'custom', part: { name: 'R', category: 'network', accent: '#123456', icon: { kind: 'router' }, ports: [], fields: [] } });
  assert.equal(glyph.glyph, PARTS.router.glyph);
  assert.equal(glyph.accent, '#123456');
  const noIcon = partOf({ kind: 'custom', part: { name: 'Ab Cd', category: 'misc', accent: null, ports: [], fields: [] } });
  assert.equal(noIcon.text, 'AC', 'a definition with no icon shows initials');
});

test('partOf falls through to the catalogue for built-in nodes and broken custom nodes', () => {
  assert.equal(partOf({ kind: 'mcu' }), PARTS.mcu);
  assert.equal(partOf({ kind: 'custom' }), PARTS.generic, 'custom without a definition is the generic box');
  assert.equal(partOf({ kind: 'nope' }), PARTS.generic);
});

test('mergePortIds keeps the ids of ports matched by name, same side first, and mints fresh ids for the rest', () => {
  const old = [
    { id: 'vcc', name: 'VCC', side: 'left', bus: 'power', required: true },
    { id: 'gnd', name: 'GND', side: 'left', bus: 'gnd', required: true },
    { id: 'p3', name: 'IO', side: 'right', bus: 'gpio', required: false },
    { id: 'p4', name: 'IO', side: 'bottom', bus: 'gpio', required: false },
  ];
  const fresh = [
    { id: 'p1', name: 'io', side: 'bottom', bus: 'gpio', required: false },
    { id: 'p2', name: 'GND', side: 'top', bus: 'gnd', required: true },
    { id: 'p3', name: 'EN', side: 'left', bus: 'gpio', required: false },
    { id: 'p4', name: 'IO', side: 'top', bus: 'gpio', required: false },
  ];
  const { ports, kept } = mergePortIds(old, fresh);
  assert.deepEqual(ports.map((p) => p.id), ['p4', 'gnd', 'p5', 'p3'], 'io matches the bottom IO first; the second IO takes the remaining old IO; EN is new');
  assert.deepEqual([...kept].sort(), ['gnd', 'p3', 'p4']);
  assert.ok(!ports.some((p) => p.id === 'vcc'), 'a removed port id never comes back');
  assert.ok(ports.every((p, i) => p.name === fresh[i].name), 'order and names are the new list');
});

test('mergePortIds with no old ports keeps the new ids', () => {
  const fresh = [{ id: 'p1', name: 'A', side: 'left', bus: 'gpio', required: false }];
  assert.deepEqual(mergePortIds([], fresh).ports, fresh);
});

test('mergeFieldIds matches by label and mints ids that no old field had', () => {
  const old = [{ id: 'f1', label: 'Channels' }, { id: 'f2', label: 'Drive', options: ['a', 'b'] }];
  const fresh = [{ id: 'f1', label: 'drive', options: ['a', 'b', 'c'] }, { id: 'f2', label: 'Rating' }];
  const out = mergeFieldIds(old, fresh);
  assert.deepEqual(out.map((f) => f.id), ['f2', 'f3']);
  assert.deepEqual(out[0].options, ['a', 'b', 'c']);
});
