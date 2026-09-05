import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutAll, pickHub, adjacency, COL_GAP, fitZone, pushApart, placeNote, arrangeAll, ZONE_PAD } from '../src/ai/layout.js';
import { EXAMPLES } from '../src/examples.js';
import { nodeRect, rectsIntersect, zoneMembers } from '../src/geometry.js';
import { getPart } from '../src/palette.js';
import { newDoc } from '../src/state.js';

function node(id, kind, extra = {}) {
  return {
    id, kind, x: 0, y: 0, label: kind, sublabel: '', color: null, addr: '', rail: '', notes: '',
    status: null, flags: [], ...extra,
  };
}
function wire(id, bus, a, pa, b, pb) {
  return { id, bus, from: { node: a, port: pa }, to: { node: b, port: pb }, label: '', arrow: null, style: null, flow: null };
}
function example(id) {
  return structuredClone(EXAMPLES.find((e) => e.id === id).doc);
}
function noOverlaps(doc) {
  const rects = doc.nodes.map((n) => ({ id: n.id, ...nodeRect(n) }));
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      assert.ok(!rectsIntersect(rects[i], rects[j]), `${rects[i].id} overlaps ${rects[j].id}`);
    }
  }
}

test('pickHub prefers the best-connected compute part', () => {
  const doc = example('weather-station');
  const ids = doc.nodes.map((n) => n.id);
  assert.equal(pickHub(doc, ids, adjacency(doc, ids)), 'n5');
  const lone = newDoc('L');
  lone.nodes.push(node('b', 'temp'), node('a', 'temp'));
  assert.equal(pickHub(lone, ['b', 'a'], adjacency(lone, ['b', 'a'])), 'a', 'ties break on id');
});

test('full layout puts power left of the hub and peripherals right, on the grid, with no overlaps', () => {
  const doc = example('weather-station');
  for (const n of doc.nodes) { n.x = 0; n.y = 0; }
  layoutAll(doc);
  const byId = Object.fromEntries(doc.nodes.map((n) => [n.id, n]));
  const hub = byId.n5;
  for (const n of doc.nodes) {
    assert.equal(n.x % 8, 0, `${n.id} x on grid`);
    assert.equal(n.y % 8, 0, `${n.id} y on grid`);
    if (n.id === 'n5') continue;
    if (getPart(n.kind).category === 'power') assert.ok(n.x < hub.x, `${n.id} left of the hub`);
    else assert.ok(n.x > hub.x, `${n.id} right of the hub`);
  }
  noOverlaps(doc);
  assert.ok(Math.min(...doc.nodes.map((n) => n.x)) >= 40);
  assert.ok(Math.min(...doc.nodes.map((n) => n.y)) >= 40);
});

test('full layout is deterministic and orders rows by neighbours', () => {
  const a = example('adas-security');
  const b = structuredClone(a);
  layoutAll(a);
  layoutAll(b);
  assert.deepEqual(a.nodes.map((n) => [n.id, n.x, n.y]), b.nodes.map((n) => [n.id, n.x, n.y]));
  noOverlaps(a);
});

test('zone members stay contiguous within a column', () => {
  const doc = newDoc('Z');
  doc.nodes.push(node('m', 'mcu'), node('s1', 'temp'), node('s2', 'imu'), node('s3', 'gps'), node('s4', 'camera'));
  doc.wires.push(
    wire('w1', 'i2c', 'm', 'i2c', 's1', 'i2c'), wire('w2', 'spi', 'm', 'spi', 's2', 'spi'),
    wire('w3', 'uart', 'm', 'uart', 's3', 'uart'), wire('w4', 'i2c', 'm', 'i2c', 's4', 'i2c'),
  );
  const zoneOf = new Map([['s1', 'zA'], ['s3', 'zA']]);
  layoutAll(doc, zoneOf);
  const rightCol = doc.nodes.filter((n) => n.id !== 'm').sort((p, q) => p.y - q.y).map((n) => n.id);
  const i1 = rightCol.indexOf('s1');
  const i3 = rightCol.indexOf('s3');
  assert.equal(Math.abs(i1 - i3), 1, `zone members adjacent: ${rightCol}`);
});

test('unreachable parts land in an outer column', () => {
  const doc = newDoc('U');
  doc.nodes.push(node('m', 'mcu'), node('t', 'temp'), node('lonely', 'led'), node('bat', 'battery'));
  doc.wires.push(wire('w1', 'i2c', 'm', 'i2c', 't', 'i2c'));
  layoutAll(doc);
  const byId = Object.fromEntries(doc.nodes.map((n) => [n.id, n]));
  assert.ok(byId.lonely.x > byId.t.x + COL_GAP - 1, 'lonely LED sits past the sensors');
  assert.ok(byId.bat.x < byId.m.x, 'the unwired battery still goes left');
  noOverlaps(doc);
});

function contains(zone, r) {
  return r.x >= zone.x && r.y >= zone.y && r.x + r.w <= zone.x + zone.w && r.y + r.h <= zone.y + zone.h;
}

test('fitZone wraps its members with padding on the grid', () => {
  const doc = newDoc('F');
  doc.nodes.push(node('a', 'mcu', { x: 100, y: 100 }), node('b', 'temp', { x: 300, y: 260 }));
  const zone = { id: 'z', x: 0, y: 0, w: 0, h: 0, label: 'Z', color: '#4a90d9' };
  assert.equal(fitZone(doc, zone, ['a', 'b']), true);
  for (const id of ['a', 'b']) assert.ok(contains(zone, nodeRect(doc.nodes.find((n) => n.id === id))), `${id} inside`);
  assert.ok(zone.x <= 100 - ZONE_PAD && zone.y <= 100 - ZONE_PAD - 8);
  for (const v of [zone.x, zone.y, zone.w, zone.h]) assert.equal(v % 8, 0);
  assert.equal(fitZone(doc, zone, ['nope']), false);
});

test('pushApart moves a later zone and its members below an earlier one', () => {
  const doc = newDoc('P');
  doc.nodes.push(node('a', 'mcu', { x: 100, y: 100 }), node('b', 'temp', { x: 120, y: 120 }));
  const zA = { id: 'zA', x: 0, y: 0, w: 0, h: 0, label: 'A', color: '#4a90d9' };
  const zB = { id: 'zB', x: 0, y: 0, w: 0, h: 0, label: 'B', color: '#4a90d9' };
  doc.zones.push(zA, zB);
  fitZone(doc, zA, ['a']);
  fitZone(doc, zB, ['b']);
  assert.ok(rectsIntersect(zA, zB), 'they start overlapping');
  pushApart(doc, [{ id: 'zA', members: ['a'] }, { id: 'zB', members: ['b'] }]);
  assert.ok(!rectsIntersect(zA, zB));
  assert.ok(contains(zB, nodeRect(doc.nodes[1])), 'b moved with its zone');
  assert.deepEqual([doc.nodes[0].x, doc.nodes[0].y], [100, 100], 'a did not move');
});

test('placeNote sits above its anchor, or above the board, never on a card', () => {
  const doc = newDoc('N');
  doc.nodes.push(node('a', 'mcu', { x: 200, y: 200 }), node('b', 'temp', { x: 200, y: 60 }));
  doc.notes.push({ id: 't1', x: 0, y: 0, text: 'near a' }, { id: 't2', x: 0, y: 0, text: 'free' });
  placeNote(doc, 't1', { near: 'a' }, new Set(['t1', 't2']));
  const t1 = doc.notes[0];
  assert.ok(t1.y + 16 < 200, 'above the anchor');
  const noteR = { x: t1.x, y: t1.y, w: 160, h: 32 };
  assert.ok(!rectsIntersect(noteR, nodeRect(doc.nodes[1])), 'skipped past the card in the way');
  placeNote(doc, 't2', {}, new Set(['t2']));
  assert.ok(doc.notes[1].y < 60, 'above everything');
  assert.equal(doc.notes[1].x % 8, 0);
});

test('arrangeAll relays every card, refits zones around their members, and replaces notes', () => {
  const doc = structuredClone(EXAMPLES.find((e) => e.id === 'weather-station').doc);
  const before = Object.fromEntries(doc.zones.map((z) => [z.id, zoneMembers(doc, z).filter((id) => doc.nodes.some((n) => n.id === id))]));
  arrangeAll(doc);
  noOverlaps(doc);
  for (const z of doc.zones) {
    for (const id of before[z.id]) assert.ok(contains(z, nodeRect(doc.nodes.find((n) => n.id === id))), `${id} still in ${z.label}`);
  }
  for (const t of doc.notes) assert.equal(t.x % 8, 0);
});

test('pushApart leaves zones overlapping rather than landing a card on another', () => {
  const doc = newDoc('P2');
  doc.nodes.push(node('a', 'mcu', { x: 100, y: 100 }), node('b', 'temp', { x: 150, y: 190 }), node('c', 'led', { x: 150, y: 300 }));
  const zA = { id: 'zA', x: 0, y: 0, w: 0, h: 0, label: 'A', color: '#4a90d9' };
  const zB = { id: 'zB', x: 0, y: 0, w: 0, h: 0, label: 'B', color: '#4a90d9' };
  doc.zones.push(zA, zB);
  fitZone(doc, zA, ['a']);
  fitZone(doc, zB, ['b']);
  assert.ok(rectsIntersect(zA, zB), 'zones overlap before the push');
  pushApart(doc, [{ id: 'zA', members: ['a'] }, { id: 'zB', members: ['b'] }]);
  noOverlaps(doc);
  assert.deepEqual([doc.nodes[1].x, doc.nodes[1].y], [150, 190], 'b stayed: moving it would land on c');
  assert.ok(contains(zB, nodeRect(doc.nodes[1])), 'the zone rectangle was restored around b');
});

test('arrangeAll refuses swimlane boards and leaves every other example overlap-free with members inside their zones', () => {
  for (const ex of EXAMPLES) {
    const doc = structuredClone(ex.doc);
    const lanes = doc.zones.some((z) => z.kind === 'swimlane');
    const before = Object.fromEntries(doc.zones.map((z) => [z.id, zoneMembers(doc, z).filter((id) => doc.nodes.some((n) => n.id === id))]));
    const snapshot = JSON.stringify(doc);
    const ok = arrangeAll(doc);
    if (lanes) {
      assert.equal(ok, false, ex.id);
      assert.equal(JSON.stringify(doc), snapshot, `${ex.id} untouched`);
      continue;
    }
    assert.equal(ok, true, ex.id);
    noOverlaps(doc);
    for (const z of doc.zones) {
      for (const id of before[z.id]) assert.ok(contains(z, nodeRect(doc.nodes.find((n) => n.id === id))), `${ex.id}: ${id} still in ${z.label}`);
    }
  }
});
