import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBOM, bomCSV, bomMarkdown } from '../src/bom.js';
import { initI18n, setLang } from '../src/i18n.js';

const node = (id, kind, label, sublabel, extra = {}) => ({
  id, kind, x: 0, y: 0, label, sublabel, color: null,
  addr: '', rail: '', notes: '', status: null, flags: [], ...extra,
});

function sampleDoc() {
  return {
    schema: 1,
    title: 'T',
    nodes: [
      node('n1', 'servo', 'Base servo', 'MG996R', { rail: '5V' }),
      node('n2', 'servo', 'Elbow servo', 'MG996R', { rail: '5V', flags: ['power'] }),
      node('n3', 'mcu', 'Brain', 'STM32F4', { addr: 'CAN 0x10', status: 'tested', notes: 'has "quotes", commas' }),
      node('n4', 'temp', 'Temp', 'BME280', { addr: '0x76' }),
    ],
    wires: [], zones: [], notes: [], journey: [],
  };
}

test('buildBOM groups by kind + part number with quantities and collected metadata', () => {
  const rows = buildBOM(sampleDoc());
  assert.equal(rows.length, 3);
  const servos = rows.find((r) => r.sublabel === 'MG996R');
  assert.equal(servos.qty, 2);
  assert.deepEqual(servos.refs, ['Base servo', 'Elbow servo']);
  assert.deepEqual(servos.rails, ['5V']);
  assert.deepEqual(servos.flags, ['power']);
  const mcu = rows.find((r) => r.sublabel === 'STM32F4');
  assert.equal(mcu.qty, 1);
  assert.deepEqual(mcu.addrs, ['CAN 0x10']);
  assert.deepEqual(mcu.statuses, ['tested']);
});

test('buildBOM output is sorted and empty doc yields empty list', () => {
  const rows = buildBOM(sampleDoc());
  const names = rows.map((r) => r.part);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(buildBOM({ nodes: [], wires: [], zones: [], notes: [], journey: [] }), []);
});

test('bomCSV escapes quotes, commas, and newlines correctly', () => {
  const csv = bomCSV(buildBOM(sampleDoc()));
  const lines = csv.split('\n');
  assert.equal(lines[0], 'Part,Part number,Qty,Refs,Addresses,Rails,Status,Flags,Notes');
  assert.equal(lines.length, 4);
  assert.ok(csv.includes('"has ""quotes"", commas"'), 'quoted cell with doubled quotes');
  assert.ok(csv.includes('Base servo; Elbow servo'));
});

test('bomMarkdown renders a table and escapes pipes', () => {
  const doc = sampleDoc();
  doc.nodes[3].label = 'A|B';
  const md = bomMarkdown(buildBOM(doc));
  const lines = md.split('\n');
  assert.ok(lines[0].startsWith('| Part |'));
  assert.ok(lines[1].startsWith('|---'));
  assert.equal(lines.length, 2 + 3);
  assert.ok(md.includes('A\\|B'));
});

test('an export names catalogue parts in the interface language and leaves custom names alone', () => {
  initI18n({ storage: null });
  const custom = { name: 'Battery', category: 'power', accent: null, icon: { text: 'B' }, ports: [], fields: [] };
  const rows = buildBOM({
    schema: 2, title: 'T', wires: [], zones: [], notes: [], journey: [],
    nodes: [node('n1', 'mcu', 'Brain', 'STM32'), node('c1', 'custom', 'Pack', '18650', { part: custom })],
  });
  setLang('zh');
  try {
    const csv = bomCSV(rows).split('\n');
    assert.equal(csv[0], '部件,型号,数量,位号,地址,电压轨,状态,标记,备注');
    assert.ok(csv.some((l) => l.startsWith('微控制器,')), bomCSV(rows));
    assert.ok(csv.some((l) => l.startsWith('Battery,')), 'the author\'s own name is not translated');
    const md = bomMarkdown(rows).split('\n');
    assert.ok(md[0].startsWith('| 部件 |'), md[0]);
    assert.ok(md.some((l) => l.startsWith('| 微控制器 |')), bomMarkdown(rows));
    assert.ok(md.some((l) => l.startsWith('| Battery |')), 'the author\'s own name is not translated');
  } finally {
    setLang('en');
  }
  assert.ok(bomCSV(rows).includes('\nMCU,'), 'English is unchanged');
  assert.ok(bomMarkdown(rows).includes('| MCU |'), 'English is unchanged');
});

test('custom nodes group by template, or by name without one, and show the definition name', () => {
  const part = (lib) => ({ ...(lib ? { lib } : {}), name: 'Motor driver x4', category: 'actuators', accent: null, icon: { text: 'MD' }, ports: [], fields: [] });
  const rows = buildBOM({
    schema: 2, title: 'T', wires: [], zones: [], notes: [], journey: [],
    nodes: [
      node('c1', 'custom', 'Left', 'MD-4', { part: part('lp1') }),
      node('c2', 'custom', 'Right', 'MD-4', { part: part('lp1') }),
      node('c3', 'custom', 'Spare', 'MD-4', { part: part(null) }),
      node('m', 'mcu', 'Brain', 'STM32', {}),
    ],
  });
  const md = rows.filter((r) => r.part === 'Motor driver x4');
  assert.equal(md.length, 2, 'template copies group together; the one-off is its own row');
  assert.deepEqual(md.map((r) => r.qty).sort(), [1, 2]);
});
