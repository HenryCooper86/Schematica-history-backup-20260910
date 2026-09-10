// The overlay's data must describe the keys the app actually handles, so this
// reads both sides: SHORTCUT_GROUPS, and every key literal a keydown handler
// in src/ compares against.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SHORTCUT_GROUPS, MOD, isMacPlatform, keyLabel } from '../src/shortcuts.js';

const ROOT = new URL('../', import.meta.url).pathname;

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
})(join(ROOT, 'src'));

// The four shapes a key comparison takes in this codebase:
//   e.key === 'Escape' / e.code === 'Space' / e.key.toLowerCase() === 'z'
//   k === 'v'                       (k is a lowercased e.key)
//   e.key.startsWith('Arrow')
//   key: 'b'                        (panels.js, compared as toggle.key)
const COMPARISONS = [
  /\be\.(?:key|code)(?:\.toLowerCase\(\))?\s*[!=]==\s*'([^']*)'/g,
  /\bk\s*[!=]==\s*'([^']*)'/g,
  /\be\.key(?:\.toLowerCase\(\))?\.startsWith\(\s*'([^']*)'/g,
  /\bkey:\s*'([^']*)'/g,
];

const handled = new Map(); // key literal -> the file that compares it
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  if (!src.includes('keydown')) continue;
  for (const re of COMPARISONS) {
    for (const m of src.matchAll(re)) {
      if (!handled.has(m[1])) handled.set(m[1], relative(ROOT, f));
    }
  }
}

// Modifiers are read as event flags (e.shiftKey, e.metaKey), never compared
// as a key; the arrow family is matched by prefix and Space by its key value.
const NOT_A_KEY = new Set([MOD, 'Shift']);
const AS_COMPARED = { Arrows: 'Arrow', Space: ' ' };
const rows = SHORTCUT_GROUPS.flatMap((g) => g.rows);
const isLetter = (k) => /^[A-Za-z]$/.test(k);

test('the overlay lists every group exactly once, in the documented order', () => {
  assert.deepEqual(SHORTCUT_GROUPS.map((g) => g.id), ['tools', 'selection', 'view', 'panels', 'editing']);
  for (const g of SHORTCUT_GROUPS) {
    assert.ok(g.rows.length, `${g.id} has rows`);
    for (const row of g.rows) {
      assert.ok(row.keys.length, `${g.id} row has keys`);
      assert.equal(typeof row.desc(), 'string');
      assert.ok(row.desc().length, `${g.id} row has a description`);
    }
  }
});

test('every key the overlay lists is compared by a keydown handler in src/', () => {
  const missing = [];
  for (const row of rows) {
    for (const k of row.keys) {
      if (NOT_A_KEY.has(k)) continue;
      const compared = AS_COMPARED[k] ?? (isLetter(k) ? k.toLowerCase() : k);
      if (!handled.has(compared)) missing.push(`${row.keys.join('+')} -> ${JSON.stringify(compared)}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every letter a keydown handler compares is listed in the overlay', () => {
  const listed = new Set(rows.flatMap((r) => r.keys).filter(isLetter).map((k) => k.toLowerCase()));
  const unlisted = [...handled].filter(([k]) => isLetter(k) && !listed.has(k.toLowerCase()))
    .map(([k, where]) => `${k} (${where})`);
  assert.deepEqual(unlisted, []);
});

test('the scan found the handlers it expects', () => {
  assert.equal(handled.get('v'), 'src/tools.js');
  assert.equal(handled.get('k'), 'src/tools.js');
  assert.equal(handled.get('b'), 'src/ui/panels.js');
  assert.equal(handled.get('a'), 'src/ui/assistant-ui.js');
  assert.equal(handled.get('?'), 'src/ui/shortcuts-ui.js');
  assert.equal(handled.get('/'), 'src/ui/explore-ui.js');
});

test('isMacPlatform reads userAgentData first and navigator.platform as a fallback', () => {
  assert.equal(isMacPlatform({ platform: 'MacIntel' }), true);
  assert.equal(isMacPlatform({ platform: 'iPhone' }), true);
  assert.equal(isMacPlatform({ platform: 'Win32' }), false);
  assert.equal(isMacPlatform({ platform: 'Linux x86_64' }), false);
  assert.equal(isMacPlatform({ platform: 'Linux x86_64', userAgentData: { platform: 'macOS' } }), true);
  assert.equal(isMacPlatform({ userAgentData: { platform: 'Windows' } }), false);
  assert.equal(isMacPlatform(), false);
  assert.equal(isMacPlatform({}), false);
});

test('a Linux "x86_64" platform is not mistaken for a Mac', () => {
  // The word boundary matters: "x86_64" contains no key word, but a naive
  // /mac/ test over "MacIntel" and a /ipad/ test must both still hit.
  assert.equal(isMacPlatform({ platform: 'X11; Linux x86_64' }), false);
  assert.equal(isMacPlatform({ platform: 'iPad Simulator' }), true);
});

test('keyLabel shows the platform modifier and leaves plain keys alone', () => {
  assert.equal(keyLabel(MOD, true), '⌘');
  assert.equal(keyLabel(MOD, false), 'Ctrl');
  assert.equal(keyLabel('Shift', true), '⇧');
  assert.equal(keyLabel('Shift', false), 'Shift');
  assert.equal(keyLabel('Escape', false), 'Esc');
  assert.equal(keyLabel('Arrows', false), '← ↑ → ↓');
  assert.equal(keyLabel('V', false), 'V');
  assert.equal(keyLabel('?', true), '?');
});
