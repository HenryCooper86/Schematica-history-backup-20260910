import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutAll, pickHub, adjacency, COL_GAP } from '../src/ai/layout.js';
import { EXAMPLES } from '../src/examples.js';
import { nodeRect, rectsIntersect } from '../src/geometry.js';
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
