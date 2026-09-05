import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, MAX_OPS, OP_TYPES, EDIT_SCHEMA } from '../src/ai/ops.js';
import { newDoc } from '../src/state.js';

function node(id, kind, x = 0, y = 0, extra = {}) {
  return {
    id, kind, x, y, label: kind, sublabel: '', color: null, addr: '', rail: '', notes: '',
    status: null, flags: [], ...extra,
  };
}

test('the schema lists every op and needs only op', () => {
  assert.deepEqual(EDIT_SCHEMA.properties.ops.items.properties.op.enum, OP_TYPES);
  assert.deepEqual(EDIT_SCHEMA.properties.ops.items.required, ['op']);
  assert.deepEqual(EDIT_SCHEMA.required, ['ops']);
});

test('add_part creates a node with defaults, a ref, and a layout entry', () => {
  const doc = newDoc('T');
  const res = applyEdits(doc, [
    { op: 'add_part', ref: 'mcu1', kind: 'mcu', sublabel: 'ESP32-S3', rail: '3.3V', status: 'production' },
  ]);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(doc.nodes.length, 1);
  const n = doc.nodes[0];
  assert.equal(res.refs.mcu1, n.id);
  assert.match(n.id, /^n[0-9a-z]{12}$/);
  assert.equal(n.kind, 'mcu');
  assert.equal(n.label, 'MCU');
  assert.equal(n.sublabel, 'ESP32-S3');
  assert.equal(n.rail, '3.3V');
  assert.equal(n.status, 'production');
  assert.deepEqual(n.flags, []);
  assert.deepEqual(res.layout.nodes, [n.id]);
  assert.deepEqual(res.layout.hints.get(n.id), { near: null, zone: null });
  assert.ok(res.touched.has(n.id));
  assert.match(res.changes[0], /^added node n\w+ mcu "MCU" \(ref mcu1\)$/);
});

test('add_part validates kind, status, flags, disposition, and fields', () => {
  const doc = newDoc('T');
  const bad = [
    [{ op: 'add_part', ref: 'a', kind: 'nope' }, /unknown kind "nope"/],
    [{ op: 'add_part', ref: 'a', kind: 'mcu', status: 'shiny' }, /unknown status/],
    [{ op: 'add_part', ref: 'a', kind: 'mcu', flags: ['bug', 'wet'] }, /unknown flags wet/],
    [{ op: 'add_part', ref: 'a', kind: 'mcu', disposition: 'pal' }, /unknown disposition/],
    [{ op: 'add_part', ref: 'a', kind: 'mcu', fields: { ip: '1.2.3.4' } }, /has no schema fields/],
    [{ op: 'add_part', ref: 'a', kind: 'threatactor', fields: { nope: 'x' } }, /unknown field "nope"/],
    [{ op: 'add_part', ref: 'a', kind: 'threatactor', fields: { type: 'wizard' } }, /must be one of/],
    [{ op: 'add_part', ref: 'a', kind: 'threatactor', fields: { severity: 'huge' } }, /must be one of/],
    [{ op: 'add_part', kind: 'mcu' }, /needs a ref/],
  ];
  for (const [op, re] of bad) {
    const res = applyEdits(doc, [op]);
    assert.equal(res.ok, false, JSON.stringify(op));
    assert.equal(res.errors[0].index, 0);
    assert.match(res.errors[0].message, re);
    assert.equal(doc.nodes.length, 0, 'nothing applied');
  }
});

test('schema fields and disposition are stored the way deserialize stores them', () => {
  const doc = newDoc('T');
  const res = applyEdits(doc, [
    { op: 'add_part', ref: 'apt', kind: 'threatactor', label: 'APT', disposition: 'adversary', fields: { severity: 'high', type: 'nation-state', sophistication: '' } },
  ]);
  assert.equal(res.ok, true, JSON.stringify(res));
  const n = doc.nodes[0];
  assert.equal(n.disposition, 'adversary');
  assert.deepEqual(n.fields, { severity: 'high', type: 'nation-state' });
});

test('a ref cannot collide with an existing id or be reused', () => {
  const doc = newDoc('T');
  doc.nodes.push(node('n1', 'mcu'));
  let res = applyEdits(doc, [{ op: 'add_part', ref: 'n1', kind: 'temp' }]);
  assert.equal(res.ok, false);
  assert.match(res.errors[0].message, /already taken/);
  res = applyEdits(doc, [
    { op: 'add_part', ref: 'a', kind: 'temp' },
    { op: 'add_part', ref: 'a', kind: 'imu' },
  ]);
  assert.equal(res.ok, false);
  assert.equal(res.errors[0].index, 1);
});

test('a batch is atomic and reports every failing index', () => {
  const doc = newDoc('T');
  const res = applyEdits(doc, [
    { op: 'add_part', ref: 'a', kind: 'mcu' },
    { op: 'add_part', ref: 'b', kind: 'nope' },
    { op: 'set_title', title: 'X' },
    { op: 'add_part', ref: 'c', kind: 'temp', near: 'b' },
    { op: 'bogus' },
  ]);
  assert.equal(res.ok, false);
  assert.deepEqual(res.errors.map((e) => e.index), [1, 3, 4]);
  assert.match(res.errors[1].message, /belongs to an operation that failed/);
  assert.match(res.errors[2].message, /unknown op "bogus"/);
  assert.equal(doc.nodes.length, 0);
  assert.equal(doc.title, 'T');
});

test('set_title sets the title and blank falls back', () => {
  const doc = newDoc('T');
  assert.equal(applyEdits(doc, [{ op: 'set_title', title: 'Rover' }]).ok, true);
  assert.equal(doc.title, 'Rover');
  assert.equal(applyEdits(doc, [{ op: 'set_title', title: '   ' }]).ok, true);
  assert.equal(doc.title, 'Untitled Board');
});

test('the batch size is capped and ops must be an array', () => {
  const doc = newDoc('T');
  const many = Array.from({ length: MAX_OPS + 1 }, () => ({ op: 'set_title', title: 'x' }));
  let res = applyEdits(doc, many);
  assert.equal(res.ok, false);
  assert.match(res.errors[0].message, /at most 200/);
  res = applyEdits(doc, 'nope');
  assert.equal(res.ok, false);
});

test('add_note and update_note', () => {
  const doc = newDoc('T');
  doc.nodes.push(node('n1', 'mcu', 100, 100));
  let res = applyEdits(doc, [{ op: 'add_note', ref: 'nt', text: 'All logic on 3.3V', near: 'n1' }]);
  assert.equal(res.ok, true, JSON.stringify(res));
  const t = doc.notes[0];
  assert.match(t.id, /^t[0-9a-z]{12}$/);
  assert.equal(t.text, 'All logic on 3.3V');
  assert.deepEqual(res.layout.notes, [t.id]);
  assert.deepEqual(res.layout.hints.get(t.id), { near: 'n1', zone: null });
  res = applyEdits(doc, [{ op: 'update_note', id: t.id, text: 'Changed' }]);
  assert.equal(res.ok, true);
  assert.equal(doc.notes[0].text, 'Changed');
  res = applyEdits(doc, [{ op: 'update_note', id: 'nope', text: 'x' }]);
  assert.match(res.errors[0].message, /no note "nope"/);
  res = applyEdits(doc, [{ op: 'add_note', ref: 'z', text: 5 }]);
  assert.match(res.errors[0].message, /text must be a string/);
});

test('update_part changes fields, merges schema fields, and refuses kind', () => {
  const doc = newDoc('T');
  doc.nodes.push(node('n1', 'mcu', 0, 0), node('n2', 'threatactor', 0, 0, { fields: { severity: 'low', type: 'spy' } }));
  let res = applyEdits(doc, [{ op: 'update_part', id: 'n1', sublabel: 'STM32H7', notes: 'Cortex-M7', status: 'prototype', flags: ['thermal'] }]);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(doc.nodes[0].sublabel, 'STM32H7');
  assert.equal(doc.nodes[0].status, 'prototype');
  assert.deepEqual(doc.nodes[0].flags, ['thermal']);
  assert.match(res.changes[0], /^updated node n1 \(sublabel, notes, status, flags\)$/);
  res = applyEdits(doc, [{ op: 'update_part', id: 'n2', fields: { severity: 'critical', type: '' } }]);
  assert.equal(res.ok, true);
  assert.deepEqual(doc.nodes[1].fields, { severity: 'critical' });
  res = applyEdits(doc, [{ op: 'update_part', id: 'n1', status: null }]);
  assert.equal(doc.nodes[0].status, null);
  res = applyEdits(doc, [{ op: 'update_part', id: 'n1', kind: 'sbc' }]);
  assert.match(res.errors[0].message, /replace_part/);
  res = applyEdits(doc, [{ op: 'update_part', id: 'n1' }]);
  assert.match(res.errors[0].message, /changes nothing/);
});
