import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHTML } from '../src/html-export.js';
import { EXAMPLES } from '../src/examples.js';

test('offline export embeds a full board and working script without external assets', () => {
  const doc = structuredClone(EXAMPLES[0].doc);
  const html = buildHTML(doc);
  const data = JSON.parse(html.match(/<script id="board-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(data.doc, doc);
  assert.equal(data.nodes.length, doc.nodes.length);
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|fetch\(/);
  const script = html.match(/<script>\(([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function('(' + script));
});

test('hostile board strings cannot end the embedded JSON script or introduce markup', () => {
  const doc = structuredClone(EXAMPLES[0].doc);
  doc.title = '</script><script>alert(1)</script>';
  doc.nodes[0].label = '<img src=x onerror=alert(1)>';
  const html = buildHTML(doc);
  assert.equal((html.match(/<script/g) || []).length, 2);
  assert.doesNotMatch(html, /<img src=x/);
  const data = JSON.parse(html.match(/<script id="board-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.doc.title, doc.title);
});
