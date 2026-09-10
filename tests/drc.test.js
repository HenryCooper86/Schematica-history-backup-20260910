import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDoc, i2cAddrKey } from '../src/drc.js';
import { initI18n, setLang } from '../src/i18n.js';

const node = (id, kind, extra = {}) => ({
  id, kind, x: 0, y: 0, label: id, sublabel: '', color: null,
  addr: '', rail: '', notes: '', status: null, flags: [], ...extra,
});

const wire = (id, bus, fromNode, fromPort, toNode, toPort) => ({
  id, bus, from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort },
  label: '', arrow: null, style: null,
});

const doc = (nodes, wires) => ({ schema: 1, title: 'T', nodes, wires, zones: [], notes: [], journey: [] });

test('detects I2C address conflicts on the same net', () => {
  const d = doc(
    [
      node('m', 'mcu'),
      node('a', 'temp', { addr: '0x76' }),
      node('b', 'tof', { addr: '0x76' }),
      node('c', 'rtc', { addr: '0x68' }),
    ],
    [
      wire('w1', 'i2c', 'm', 'i2c', 'a', 'i2c'),
      wire('w2', 'i2c', 'm', 'i2c', 'b', 'i2c'),
      wire('w3', 'i2c', 'm', 'i2c', 'c', 'i2c'),
    ],
  );
  const findings = checkDoc(d);
  const conflict = findings.find((f) => f.rule === 'i2c-addr-conflict');
  assert.ok(conflict, 'conflict reported');
  assert.equal(conflict.level, 'error');
  assert.ok(conflict.ids.includes('a') && conflict.ids.includes('b'));
  assert.ok(!conflict.ids.includes('c'));
});

test('I2C addresses conflict regardless of surrounding space and hex-prefix case', () => {
  const d = doc(
    [
      node('m', 'mcu'),
      node('a', 'temp', { addr: ' 0x76 ' }),
      node('b', 'tof', { addr: '0X76' }),
      node('c', 'rtc', { addr: '0x68' }),
    ],
    [
      wire('w1', 'i2c', 'm', 'i2c', 'a', 'i2c'),
      wire('w2', 'i2c', 'm', 'i2c', 'b', 'i2c'),
      wire('w3', 'i2c', 'm', 'i2c', 'c', 'i2c'),
    ],
  );
  const conflict = checkDoc(d).find((f) => f.rule === 'i2c-addr-conflict');
  assert.ok(conflict, 'a differently spelled address is the same address');
  assert.deepEqual(conflict.ids, ['a', 'b']);
  assert.equal(conflict.message, 'I2C address 0x76 is used by a and b on the same bus.', 'the reported address is trimmed as the first node wrote it');
  assert.equal(i2cAddrKey(' 0X76 '), '0x76');
  assert.equal(i2cAddrKey(undefined), '', 'a node with no address has no key');
});

test('a blank or whitespace-only address never conflicts', () => {
  const d = doc(
    [node('m', 'mcu'), node('a', 'temp', { addr: '   ' }), node('b', 'tof', { addr: '' })],
    [wire('w1', 'i2c', 'm', 'i2c', 'a', 'i2c'), wire('w2', 'i2c', 'm', 'i2c', 'b', 'i2c')],
  );
  assert.ok(!checkDoc(d).some((f) => f.rule === 'i2c-addr-conflict'));
});

test('no conflict across separate I2C nets', () => {
  const d = doc(
    [node('m1', 'mcu'), node('m2', 'mcu'), node('a', 'temp', { addr: '0x76' }), node('b', 'tof', { addr: '0x76' })],
    [wire('w1', 'i2c', 'm1', 'i2c', 'a', 'i2c'), wire('w2', 'i2c', 'm2', 'i2c', 'b', 'i2c')],
  );
  assert.ok(!checkDoc(d).some((f) => f.rule === 'i2c-addr-conflict'));
});

test('flags unconnected VCC/GND pins and fully floating nodes', () => {
  const d = doc(
    [node('m', 'mcu'), node('t', 'temp'), node('lonely', 'imu')],
    [wire('w1', 'i2c', 'm', 'i2c', 't', 'i2c')],
  );
  const findings = checkDoc(d);
  const power = findings.filter((f) => f.rule === 'unconnected-power');
  assert.ok(power.some((f) => f.ids.includes('m')), 'mcu vcc unconnected');
  assert.ok(power.some((f) => f.ids.includes('t')), 'temp vcc unconnected');
  const floating = findings.find((f) => f.rule === 'floating-node');
  assert.ok(floating && floating.ids.includes('lonely'));
  assert.ok(!floating.ids.includes('m'));
});

test('flags bus mismatches and lifecycle risks', () => {
  const d = doc(
    [
      node('m', 'mcu', { status: 'deprecated' }),
      node('t', 'temp', { flags: ['eol'] }),
    ],
    [wire('w1', 'spi', 'm', 'i2c', 't', 'i2c')],
  );
  const findings = checkDoc(d);
  const mismatch = findings.find((f) => f.rule === 'bus-mismatch');
  assert.ok(mismatch && mismatch.ids.includes('w1'));
  const lifecycle = findings.filter((f) => f.rule === 'lifecycle');
  assert.equal(lifecycle.length, 2);
});

test('a clean board yields no findings', () => {
  const d = doc(
    [node('b', 'battery'), node('r', 'regulator')],
    [
      wire('w1', 'power', 'b', 'out', 'r', 'in'),
      wire('w2', 'gnd', 'b', 'gnd', 'r', 'gnd'),
    ],
  );
  assert.deepEqual(checkDoc(d), []);
});

test('custom parts report unwired required ports by bus; optional ports and built-in heuristics are unchanged', () => {
  const part = {
    name: 'Driver', category: 'actuators', accent: null, icon: { text: 'D' }, fields: [],
    ports: [
      { id: 'p1', name: 'VIN', side: 'top', bus: 'power', required: true },
      { id: 'p2', name: 'GND', side: 'top', bus: 'gnd', required: true },
      { id: 'p3', name: 'EN', side: 'left', bus: 'gpio', required: true },
      { id: 'p4', name: 'OUT', side: 'right', bus: 'power', required: false },
      { id: 'p5', name: 'CAN', side: 'left', bus: 'can', required: false },
    ],
  };
  const d = doc(
    [node('c', 'custom', { part }), node('m', 'mcu')],
    [wire('w1', 'gnd', 'c', 'p2', 'm', 'gnd'), wire('w2', 'can', 'c', 'p5', 'm', 'can')],
  );
  const findings = checkDoc(d).filter((f) => f.ids.includes('c'));
  const power = findings.filter((f) => f.rule === 'unconnected-power');
  const port = findings.filter((f) => f.rule === 'unconnected-port');
  assert.deepEqual(power.map((f) => f.message), ["c's VIN pin is unconnected."]);
  assert.deepEqual(port.map((f) => f.message), ["c's EN pin is unconnected."]);
  assert.equal(port[0].level, 'warning');
  assert.ok(!findings.some((f) => /OUT|CAN|GND/.test(f.message)), 'optional and wired ports are silent');
});

// ---- Power budget ----
// Every board below wires GND as well, so the only findings left are the ones
// the budget rules raise.
const powered = (supply, consumers) => {
  const nodes = [supply, ...consumers];
  const wires = [];
  consumers.forEach((c, i) => {
    wires.push(wire(`p${i}`, 'power', supply.id, 'out', c.id, 'vcc'));
    wires.push(wire(`g${i}`, 'gnd', supply.id, 'gnd', c.id, 'gnd'));
  });
  return doc(nodes, wires);
};
const budget = (d) => checkDoc(d).filter((f) => f.rule.startsWith('power-') || f.rule === 'battery-runtime');

test('a rail drawing more than its supply is rated for is an error that names both numbers', () => {
  const d = powered(node('LDO', 'regulator', { fields: { imax: '600mA' } }), [
    node('MCU', 'mcu', { fields: { ityp: '500mA' } }),
    node('Radio', 'wifi', { fields: { ityp: '250mA' } }),
  ]);
  const [f] = budget(d);
  assert.equal(f.level, 'error');
  assert.equal(f.rule, 'power-budget');
  assert.equal(f.message, 'LDO can supply 600 mA, but the parts on its rail draw 750 mA.');
  assert.deepEqual(f.ids, ['LDO', 'MCU', 'Radio'], 'the supply and its consumers are the selection');
});

test('over four fifths of the limit is a warning, and under it nothing is said', () => {
  const under = powered(node('LDO', 'regulator', { fields: { imax: '1A' } }), [node('MCU', 'mcu', { fields: { ityp: '800mA' } })]);
  assert.deepEqual(budget(under), [], '800 of 1000 is exactly four fifths, which is still within budget');
  const over = powered(node('LDO', 'regulator', { fields: { imax: '1A' } }), [node('MCU', 'mcu', { fields: { ityp: '810mA' } })]);
  const [f] = budget(over);
  assert.equal(f.level, 'warning');
  assert.equal(f.rule, 'power-budget');
  assert.equal(f.message, 'LDO can supply 1 A and the parts on its rail already draw 810 mA.');
});

test('peaks and unstated parts are reported beside the sum, never folded into it', () => {
  const d = powered(node('LDO', 'regulator', { fields: { imax: '600mA' } }), [
    node('MCU', 'mcu', { fields: { ityp: '500mA', ipeak: '900mA' } }),
    node('Radio', 'wifi', { fields: { ityp: '250mA' } }),
    node('LED', 'led'),
  ]);
  const [f] = budget(d);
  assert.equal(f.message, 'LDO can supply 600 mA, but the parts on its rail draw 750 mA.'
    + ' Peaks add up to 1.15 A. One more part on this rail declares no current.');
  const two = powered(node('LDO', 'regulator', { fields: { imax: '600mA' } }), [
    node('MCU', 'mcu', { fields: { ityp: '700mA' } }), node('LED', 'led'), node('Buzz', 'buzzer'),
  ]);
  assert.match(budget(two)[0].message, /2 more parts on this rail declare no current\.$/);
});

test('a rail whose consumers state a current but whose supply states no limit is an info finding', () => {
  const d = powered(node('LDO', 'regulator'), [node('MCU', 'mcu', { fields: { ityp: '120mA' } })]);
  const [f] = budget(d);
  assert.equal(f.level, 'info');
  assert.equal(f.rule, 'power-budget-unknown');
  assert.equal(f.message, 'LDO declares no output current limit, so the 120 mA on its rail cannot be checked.');
  assert.deepEqual(f.ids, ['LDO', 'MCU']);
});

test('a board that fills in no currents at all is as quiet as it was before the fields existed', () => {
  assert.deepEqual(budget(powered(node('LDO', 'regulator'), [node('MCU', 'mcu'), node('LED', 'led')])), []);
});

test('a battery with a capacity reports a runtime, and says what it leaves out', () => {
  const d = doc(
    [node('Pack', 'battery', { fields: { capacity: '2000mAh' } }), node('LDO', 'regulator', { fields: { imax: '600mA' } }),
      node('MCU', 'mcu', { fields: { ityp: '100mA' } })],
    [wire('w1', 'power', 'Pack', 'out', 'LDO', 'in'), wire('w2', 'gnd', 'Pack', 'gnd', 'LDO', 'gnd'),
      wire('w3', 'power', 'LDO', 'out', 'MCU', 'vcc'), wire('w4', 'gnd', 'LDO', 'gnd', 'MCU', 'gnd')],
  );
  const findings = budget(d);
  assert.deepEqual(findings.map((f) => f.rule), ['battery-runtime'], 'the load carries across the regulator, so nothing is unknown');
  assert.equal(findings[0].level, 'info');
  assert.equal(findings[0].message, 'Pack holds 2000 mAh; at 100 mA that is about 20 h, ignoring duty cycle and conversion efficiency.');
  assert.deepEqual(findings[0].ids, ['Pack']);
});

test('a capacity with nothing drawing on the rail reports no runtime at all', () => {
  const d = powered(node('Pack', 'battery', { fields: { capacity: '2000mAh' } }), [node('MCU', 'mcu')]);
  assert.deepEqual(budget(d), []);
});

test('power findings sort under errors and warnings and read in Chinese', () => {
  initI18n({ storage: null });
  const d = powered(node('LDO', 'regulator'), [node('MCU', 'mcu', { fields: { ityp: '120mA' } })]);
  const levels = checkDoc(d).map((f) => f.level);
  assert.deepEqual(levels, [...levels].sort((a, b) => ({ error: 0, warning: 1, info: 2 }[a] - { error: 0, warning: 1, info: 2 }[b])));
  setLang('zh');
  try {
    const zh = checkDoc(d).find((f) => f.rule === 'power-budget-unknown');
    assert.equal(zh.message, 'LDO 未声明输出电流上限，因此无法校核其电压轨上的 120 mA。');
  } finally {
    setLang('en');
  }
});

test('design-rule messages follow the interface language and keep their rule ids', () => {
  initI18n({ storage: null });
  const doc = { schema: 2, title: '', nodes: [node('a', 'mcu'), node('b', 'temp', { addr: '0x76' }), node('c', 'temp', { addr: '0x76' })], wires: [
    { id: 'w1', bus: 'i2c', from: { node: 'a', port: 'i2c' }, to: { node: 'b', port: 'i2c' }, label: '', arrow: null, style: null, flow: null },
    { id: 'w2', bus: 'i2c', from: { node: 'a', port: 'i2c' }, to: { node: 'c', port: 'i2c' }, label: '', arrow: null, style: null, flow: null },
  ], zones: [], notes: [], journey: [] };
  const en = checkDoc(doc);
  assert.equal(en[0].rule, 'i2c-addr-conflict');
  assert.equal(en[0].message, 'I2C address 0x76 is used by b and c on the same bus.');
  setLang('zh');
  try {
    const zh = checkDoc(doc);
    assert.deepEqual(zh.map((f) => f.rule), en.map((f) => f.rule));
    assert.equal(zh[0].message, 'I2C 地址 0x76 被同一总线上的 b 和 c 同时使用。');
    assert.match(zh.find((f) => f.rule === 'unconnected-power').message, /引脚未连接/);
  } finally {
    setLang('en');
  }
});
