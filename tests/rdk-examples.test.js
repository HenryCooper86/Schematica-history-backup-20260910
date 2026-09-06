import test from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLES } from '../src/examples.js';
import { checkRdk } from '../src/rdk/checks.js';
import { checkDoc } from '../src/drc.js';
import { nodePart } from '../src/rdk/profiles.js';
import { serialize, deserialize } from '../src/serialize.js';

for (const id of ['rdk-rover', 'rdk-perception']) {
  test(`${id} documents a complete X5 stereo topology and descriptive software pipeline`, () => {
    const ex = EXAMPLES.find((e) => e.id === id);
    assert.ok(ex, 'starter exists');
    const { doc } = ex;
    const board = doc.nodes.find((n) => n.sublabel === 'RDK X5');
    const stereo = doc.nodes.find((n) => n.sublabel === 'GS130W');
    assert.ok(board && stereo, 'literal supported product identities');
    const csi = doc.wires.filter((w) => w.bus === 'mipi');
    assert.equal(csi.length, 2, 'stereo consumes both connectors, no third camera');
    assert.deepEqual(new Set(csi.map((w) => w.from.node)), new Set([board.id]));
    assert.deepEqual(new Set(csi.map((w) => w.from.port)), new Set(['csi1', 'csi2']));
    assert.deepEqual(new Set(csi.map((w) => w.to.node)), new Set([stereo.id]));
    assert.deepEqual(new Set(csi.map((w) => w.to.port)), new Set(['csi', 'csi-right']));
    for (const w of doc.wires) {
      const ports = [w.from, w.to].map((r) => nodePart(doc.nodes.find((n) => n.id === r.node)).ports.find((p) => p.id === r.port));
      assert.ok(ports.every(Boolean));
      assert.ok(!(ports.some((p) => p.bus === 'uart') && ports.some((p) => p.bus === 'rs485')), 'no UART-to-RS485 shortcut');
    }
    const stages = doc.nodes.filter((n) => n.kind === 'rdksoftware');
    assert.deepEqual(stages.map((n) => n.fields.package), ['hobot_sensor', 'hobot_dnn', 'hobot_codec', 'hobot_render']);
    for (const n of stages) {
      assert.equal(n.fields.target, board.id);
      assert.equal(n.fields.runtime || '', '');
    }
    assert.equal(doc.wires.filter((w) => w.bus === 'flow').length, 3);
    assert.deepEqual(checkRdk(doc), []);
    assert.deepEqual(new Set(checkDoc(doc).map((f) => f.rule)), new Set(['unconnected-power']), 'intentional supply/return omissions remain general findings');
    assert.ok(doc.nodes.every((n) => n.status === null), 'no tested hardware claims');
    assert.ok(doc.nodes.length >= 5 && doc.wires.length >= 4 && doc.zones.length >= 1);
    assert.ok(doc.journey.length >= 3 && doc.journey.every((j) => j.caption.length > 40));
    const restored = deserialize(serialize(doc));
    assert.deepEqual(restored.warnings, []);
    assert.deepEqual(restored.doc, doc);
  });
}
test('rover menu identity and document title remain stable', () => {
  const rover = EXAMPLES.find((e) => e.id === 'rdk-rover');
  assert.equal(rover.name, 'RDK X5 Rover (D-Robotics)');
  assert.equal(rover.doc.title, 'RDK X5 Rover');
});
