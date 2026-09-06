import test from 'node:test';
import assert from 'node:assert/strict';
import { newDoc } from '../src/state.js';
import { rdkGuide, safeSources } from '../src/rdk/guide.js';
import { rdkDetails, targetOptions } from '../src/ui/rdk-details.js';
const node = (id, kind, sublabel, fields) => ({
  id,
  kind,
  sublabel,
  fields,
  label: id,
  rail: '',
  notes: '',
  x: 0,
  y: 0,
});
const sample = () => ({
  ...newDoc('RDK design'),
  nodes: [
    node('host', 'aisbc', 'RDK X5'),
    node('camera', 'depthcam', 'GS130W'),
    node('stage', 'rdksoftware', 'hobot_render', {
      package: 'hobot_dnn',
      target: 'host',
    }),
  ],
  wires: [
    {
      id: 'w1',
      bus: 'mipi',
      from: { node: 'camera', port: 'csi' },
      to: { node: 'host', port: 'csi1' },
    },
  ],
});
test('document-only guide includes BOM, endpoints, checks, software mapping and sources', () => {
  const g = rdkGuide(sample()).replace(/&#(\d+);/g, (_, n) =>
    String.fromCharCode(Number(n)),
  );
  for (const re of [
    /RDK X5/,
    /camera.csi/,
    /host.csi1/,
    /rdk-stereo-links/,
    /hobot_dnn/,
    /target: host/,
    /Runtime: not selected/,
    /https:\/\/d-robotics/,
    /5V/,
  ])
    assert.match(g, re);
  assert.doesNotMatch(g, /```|sudo |apt install|hardware tested/i);
  assert.equal(rdkGuide(newDoc()), '');
});
test('hostile text cannot introduce markdown blocks or HTML; stale target visible', () => {
  const d = sample();
  d.title = '<script>\n# [bad](javascript:x) `x`';
  d.nodes[0].label = d.title;
  d.nodes[2].fields.target = 'deleted<board>';
  const g = rdkGuide(d);
  assert.doesNotMatch(g, /<script>|\n# \[bad\]|`x`/);
  assert.match(g, /missing/);
  const h = rdkDetails(d.nodes[0], d);
  assert.doesNotMatch(h, /<script>/);
  assert.match(h, /rel="noopener noreferrer"/);
  assert.match(targetOptions(d.nodes[2], d), /Missing.*deleted&lt;board&gt;/);
});
test('unknown connector profile and authoritative package remain explicit', () => {
  const d = sample();
  d.nodes[0].sublabel = 'RDK S100';
  d.nodes[2].fields.package = 'unknown';
  assert.match(rdkDetails(d.nodes[0], d), /unverified/);
  assert.match(rdkDetails(d.nodes[2], d), /unverified/);
  assert.doesNotMatch(rdkDetails(d.nodes[2], d), /Web\/HDMI/);
});

test('source links allow HTTPS only and escape hostile source labels', () => {
  assert.deepEqual(
    safeSources({
      sources: [
        { url: 'javascript:alert(1)' },
        { url: 'http://example.com' },
        { url: 'not a URL' },
        { url: 'https://user:pass@example.com' },
        { url: 'https://example.com' },
      ],
    }),
    [{ url: 'https://example.com' }],
  );
});
