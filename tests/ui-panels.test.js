// The DOM-less half of the panel fixes: the selector that finds a control
// again after its panel is rebuilt, and the props label/control pairing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { focusSelector } from '../src/ui/press.js';
import { propField, lockField } from '../src/ui/props.js';

// A stand-in for the element chain focusSelector walks: id, data-* attributes,
// and a parent link are all it reads.
function el(spec, ...children) {
  const { id = '', ...rest } = spec;
  const node = {
    id,
    attributes: Object.entries(rest).map(([name, value]) => ({ name, value })),
    parentElement: null,
  };
  for (const c of children) c.parentElement = node;
  return node;
}

test('focusSelector names a control by the data attributes on its way to the panel', () => {
  const button = el({ 'data-jact': 'up' });
  const step = el({ 'data-step': 's1' }, button);
  const panel = el({ id: 'journey-panel' }, step);
  assert.equal(focusSelector(button, panel), '[data-step="s1"] [data-jact="up"]');
});

test('focusSelector prefers an id and stops at the panel', () => {
  const button = el({ id: 'journey-add' });
  const panel = el({ id: 'journey-panel' }, button);
  assert.equal(focusSelector(button, panel), '#journey-add');
});

test('focusSelector returns null for a control nothing identifies', () => {
  const plain = el({ class: 'chip' });
  const panel = el({ id: 'props' }, plain);
  assert.equal(focusSelector(plain, panel), null);
});

test('focusSelector escapes quotes in a data value', () => {
  const input = el({ 'data-prop': 'la"bel' });
  const panel = el({ id: 'props' }, input);
  assert.equal(focusSelector(input, panel), '[data-prop="la\\"bel"]');
});

test('propField gives the control an id its label points at', () => {
  const html = propField('Label', '<input type="text" data-prop="label" value="x">');
  const id = /<label for="([^"]+)">/.exec(html)[1];
  assert.ok(html.includes(`id="${id}"`), html);
  assert.ok(new RegExp(`<input id="${id}" type="text"`).test(html), html);
});

test('propField pairs a select and a textarea the same way', () => {
  for (const inner of ['<select data-field="target"></select>', '<textarea data-prop="notes"></textarea>']) {
    const html = propField('Label', inner);
    const id = /<label for="([^"]+)">/.exec(html)[1];
    assert.ok(html.includes(`id="${id}"`), html);
  }
});

test('propField leaves a label alone when the markup carries no single control', () => {
  const html = propField('Color', '<div class="swatches"><button data-swatch="#fff"></button></div>');
  assert.ok(html.startsWith('<label>'), html);
  assert.ok(!html.includes('for='), html);
});

test('propField escapes the label text it interpolates', () => {
  const html = propField('<img src=x> & "q"', '<input data-prop="label">');
  assert.ok(!html.includes('<img'), html);
  assert.ok(html.includes('&lt;img src=x&gt; &amp; &quot;q&quot;'), html);
});

test('lockField reads as its own state and reports it to a screen reader', () => {
  const off = lockField({ id: 'n1' });
  assert.ok(off.includes('aria-pressed="false"'), off);
  assert.ok(off.includes('>Unlocked</button>'), off);
  assert.ok(!off.includes('chip active'), off);
  const on = lockField({ id: 'n1', locked: true });
  assert.ok(on.includes('aria-pressed="true"'), on);
  assert.ok(on.includes('chip active'), on);
  assert.ok(on.includes('>Locked</button>'), on);
});
