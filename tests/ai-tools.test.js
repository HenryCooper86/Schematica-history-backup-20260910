import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, createExecutor, statusLine } from '../src/ai/tools.js';
import { newDoc } from '../src/state.js';
import { EXAMPLES } from '../src/examples.js';

function plain(doc) {
  return createExecutor({ getDoc: () => doc, commit: (fn) => fn(doc), selection: () => ['n5'] });
}

test('seven tools with the expected names and strict flags', () => {
  assert.deepEqual(TOOLS.map((t) => t.name), ['rdk_reference', 'search_parts', 'get_board', 'run_checks', 'list_presets', 'apply_edits', 'arrange']);
  for (const t of TOOLS) {
    assert.equal(typeof t.description, 'string');
    assert.equal(t.input_schema.type, 'object');
    if (t.name !== 'apply_edits') {
      assert.equal(t.strict, true, t.name);
      assert.equal(t.input_schema.additionalProperties, false, t.name);
    } else {
      assert.equal(t.strict, undefined);
    }
  }
});

test('search_parts lists kinds with ports and says when nothing matches', () => {
  const ex = plain(newDoc('T'));
  const hit = ex.run('search_parts', { query: 'rdk' });
  assert.equal(hit.isError, false);
  assert.match(hit.text, /^aisbc  AI SBC/m);
  const miss = ex.run('search_parts', { query: 'zzzz' });
  assert.match(miss.text, /No kinds match/);
});

test('get_board and run_checks read the current document', () => {
  const doc = structuredClone(EXAMPLES.find((e) => e.id === 'weather-station').doc);
  const ex = plain(doc);
  const board = ex.run('get_board', {});
  assert.match(board.text, /^board "Weather Station"/);
  assert.match(board.text, /selected: n5/);
  const checks = ex.run('run_checks', {});
  assert.match(checks.text, /^(error|warning) [\w-]+ ".+" ids: /m);
  const clean = plain(structuredClone(EXAMPLES.find((e) => e.id === 'sensor-node-clean').doc)).run('run_checks', {});
  assert.match(clean.text, /passes every check/);
});

test('list_presets shows part numbers or says there are none', () => {
  const ex = plain(newDoc('T'));
  assert.match(ex.run('list_presets', { kind: 'aisbc' }).text, /pn=RDK X5/);
  assert.match(ex.run('list_presets', { kind: 'temp' }).text, /No presets for temp/);
  assert.equal(ex.run('list_presets', { kind: 'nope' }).isError, true);
});

test('apply_edits applies, places, reports refs and changes, and records touched ids', () => {
  const doc = newDoc('T');
  const ex = plain(doc);
  const res = ex.run('apply_edits', { ops: [
    { op: 'add_part', ref: 'mcu', kind: 'mcu' },
    { op: 'add_part', ref: 'bme', kind: 'temp', addr: '0x76' },
    { op: 'connect', from: { node: 'mcu' }, to: { node: 'bme' }, bus: 'i2c' },
  ] });
  assert.equal(res.isError, false, res.text);
  assert.match(res.text, /^Applied 3 change\(s\)\./);
  assert.match(res.text, /refs: mcu=n\w+ bme=n\w+/);
  assert.equal(doc.nodes.length, 2);
  assert.ok(doc.nodes[1].x > doc.nodes[0].x, 'placed: the sensor sits right of the MCU');
  assert.equal(ex.touched.size, 3);
  ex.resetTouched();
  assert.equal(ex.touched.size, 0);
});

test('a rejected batch changes nothing and returns the errors as a tool error', () => {
  const doc = newDoc('T');
  const ex = plain(doc);
  const res = ex.run('apply_edits', { ops: [{ op: 'add_part', ref: 'a', kind: 'nope' }] });
  assert.equal(res.isError, true);
  assert.match(res.text, /Batch rejected, nothing applied:\n#0: unknown kind "nope"/);
  assert.equal(doc.nodes.length, 0);
  assert.equal(ex.run('apply_edits', {}).isError, true, 'missing ops');
});

test('arrange lays the board out and refuses swimlane boards', () => {
  const doc = structuredClone(EXAMPLES.find((e) => e.id === 'weather-station').doc);
  const ex = plain(doc);
  const before = JSON.stringify(doc.nodes.map((n) => [n.x, n.y]));
  const res = ex.run('arrange', {});
  assert.equal(res.isError, false);
  assert.notEqual(JSON.stringify(doc.nodes.map((n) => [n.x, n.y])), before);
  assert.equal(ex.touched.size, doc.nodes.length);
  const lanes = structuredClone(EXAMPLES.find((e) => e.id === 'ota-pipeline').doc);
  assert.ok(lanes.zones.some((z) => z.kind === 'swimlane'));
  assert.equal(plain(lanes).run('arrange', {}).isError, true);
});

test('unknown tools are errors and status lines are short', () => {
  const ex = plain(newDoc('T'));
  assert.equal(ex.run('teleport', {}).isError, true);
  assert.equal(statusLine('search_parts', { query: 'lora' }), 'searching parts: lora');
  assert.equal(statusLine('apply_edits', { ops: [{}, {}] }), 'applying 2 edits');
  assert.equal(statusLine('run_checks', {}), 'running checks');
  assert.equal(statusLine('search_parts', null), 'searching parts: ');
  assert.equal(ex.run('constructor', {}).isError, true);
  assert.equal(ex.run('list_presets', { kind: 'constructor' }).isError, true);
});

// Some models stringify the ops array; a JSON string that parses to an array
// is accepted rather than costing a round.
test('apply_edits accepts ops given as a JSON string', () => {
  const doc = { schema: 1, title: '', nodes: [], wires: [], zones: [], notes: [], journey: [] };
  const ex = createExecutor({ getDoc: () => doc, commit: (fn) => fn(doc), selection: () => [] });
  const res = ex.run('apply_edits', { ops: JSON.stringify([{ op: 'add_part', ref: 'm', kind: 'mcu', label: 'MCU' }]) });
  assert.match(res.text, /Applied 1 change/);
  assert.equal(doc.nodes.length, 1);
  const bad = ex.run('apply_edits', { ops: 'not json' });
  assert.match(bad.text, /ops array/);
});
