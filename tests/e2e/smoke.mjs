// Browser smoke test: serves the repo, drives a headless Chrome over the
// DevTools Protocol, and checks the interactions unit tests cannot reach
// (hover-revealed ports, dragging a wire, panning, renaming, zone resizing,
// presets, palette search). Zero dependencies: Node's http, fetch, and
// WebSocket. Run with `npm run e2e`; CHROME_PATH overrides the browser.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXAMPLES } from '../../src/examples.js';
import { encodeShare } from '../../src/share.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(mac)) return mac;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']) {
    const r = spawnSync('which', [name], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  throw new Error('No Chrome found; set CHROME_PATH');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A scripted Anthropic look-alike so the assistant runs in CI without a key.
// It answers the first call of a request with one tool call, and any call
// carrying tool results with a short final text.
const fakeSeen = [];
async function fakeAnthropic(req, res) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const last = body.messages.at(-1);
  const lastText = last.content.map((b) => b.text || '').join(' ');
  fakeSeen.push({ headers: req.headers, lastText, system: body.system, tools: body.tools.map((t) => t.name) });
  const hasResults = last.content.some((b) => b.type === 'tool_result');
  const events = [];
  const ev = (event, data) => events.push(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  ev('message_start', { message: { usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  if (hasResults) {
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Done. ' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'The board is in place.' } });
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } });
  } else {
    let ops;
    if (/^Fix this finding/i.test(lastText)) {
      ops = [{ op: 'add_note', ref: 'fx', text: 'Fix acknowledged by the fake assistant' }];
    } else {
      ops = [
        { op: 'set_title', title: 'Fake Build' },
        { op: 'add_part', ref: 'mcu', kind: 'mcu', sublabel: 'ESP32-S3', rail: '3.3V' },
        { op: 'add_part', ref: 'bme', kind: 'temp', sublabel: 'BME280', addr: '0x76', rail: '3.3V' },
        { op: 'add_part', ref: 'bat', kind: 'battery' },
        { op: 'connect', from: { node: 'mcu' }, to: { node: 'bme' }, bus: 'i2c' },
        { op: 'connect', from: { node: 'bat' }, to: { node: 'mcu' }, bus: 'power' },
        { op: 'add_zone', ref: 'pwr', label: 'Power', color: '#f87171', members: ['bat'] },
      ];
    }
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Working…' } });
    ev('content_block_stop', { index: 0 });
    ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'apply_edits', input: {} } });
    ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ ops }) } });
    ev('content_block_stop', { index: 1 });
    ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } });
  }
  ev('message_stop', {});
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.end(events.join(''));
}

// ---- static server ----
const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/fake/v1/messages') return fakeAnthropic(req, res);
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const file = join(ROOT, path === '/' ? 'index.html' : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const url = `${origin}/#${await encodeShare(EXAMPLES.find((e) => e.id === 'weather-station').doc)}`;

// ---- browser ----
// Chrome picks its own debugging port and writes it to DevToolsActivePort in
// the profile; a fresh profile means no stale file. Cold runners can take a
// while to start, so wait up to a minute and surface Chrome's stderr on failure.
const profile = join(ROOT, '.e2e-profile');
rmSync(profile, { recursive: true, force: true });
const chrome = spawn(findChrome(), [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1500,950', url,
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr = (chromeErr + d).slice(-2000); });

let port = 0;
for (let i = 0; i < 240 && !port && chrome.exitCode === null; i++) {
  try {
    const first = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    if (Number(first) > 0) port = Number(first);
  } catch { /* not written yet */ }
  if (!port) await sleep(250);
}
if (!port) {
  server.close();
  throw new Error(`Chrome did not start (exit code ${chrome.exitCode}). stderr: ${chromeErr}`);
}
let target;
for (let i = 0; i < 120 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    target = list.find((t) => t.type === 'page' && t.url.startsWith(origin));
  } catch { /* not up yet */ }
  if (!target) await sleep(250);
}
if (!target) {
  chrome.kill();
  server.close();
  throw new Error(`Chrome did not expose the page. stderr: ${chromeErr}`);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let seq = 0;
const pending = new Map();
const problems = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  // A confirm() would block every later command; accept it and report it.
  if (m.method === 'Page.javascriptDialogOpening') {
    problems.push(`dialog: ${m.params.message}`);
    send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  }
  if (m.method === 'Runtime.exceptionThrown') {
    problems.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  }
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
    problems.push(`console.${m.params.type}: ` + m.params.args.map((a) => a.value ?? a.description).join(' '));
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`${method} did not answer within 15s`));
  }, 15000);
  pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
  ws.send(JSON.stringify({ id, method, params }));
});
const js = async (expr) => {
  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (res.result.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description || 'eval failed');
  return res.result.result.value;
};
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, ...extra });
const click = async (x, y) => {
  await mouse('mousePressed', x, y, { button: 'left', clickCount: 1 });
  await mouse('mouseReleased', x, y, { button: 'left', clickCount: 1 });
};
// `buttons` must carry the held-button bitmask on every move, or Chrome (on
// Linux at least) treats the move as a release and the drag ends early.
const BUTTONS = { left: 1, right: 2, middle: 4 };
const drag = async (x0, y0, x1, y1, button = 'left') => {
  const buttons = BUTTONS[button];
  await mouse('mouseMoved', x0, y0);
  await mouse('mousePressed', x0, y0, { button, buttons, clickCount: 1 });
  for (let i = 1; i <= 6; i++) {
    await mouse('mouseMoved', x0 + ((x1 - x0) * i) / 6, y0 + ((y1 - y0) * i) / 6, { button, buttons });
    await sleep(20);
  }
  await mouse('mouseReleased', x1, y1, { button, clickCount: 1 });
};
const key = async (k, code, vk, mods = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
};
const center = (sel) => js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);

await send('Runtime.enable');
await send('Page.enable');
await sleep(1500);

// Watchdog: a hung browser must fail the run, not stall CI.
const watchdog = setTimeout(() => {
  console.log('FAIL watchdog — the smoke test did not finish within 120s');
  chrome.kill();
  server.close();
  process.exit(1);
}, 120000);

const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed += 1;
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

try {
  // Ports hidden at rest, revealed by CSS on hover without a DOM rebuild.
  const rest = await js(`(() => { const p = document.querySelectorAll('#canvas .ports'); return { count: p.length, opacity: getComputedStyle(p[0]).opacity }; })()`);
  check('ports exist for every card and are hidden at rest', rest.count === 8 && rest.opacity === '0', JSON.stringify(rest));
  const mcu = await center('#canvas g.node[data-id="n5"] .card');
  await js(`window.__card = document.querySelector('#canvas g.node[data-id="n5"] .card'); true`);
  await mouse('mouseMoved', mcu.x, mcu.y);
  await sleep(250);
  const hover = await js(`(() => { const g = document.querySelector('#canvas g.node[data-id="n5"]'); return { on: g.matches(':hover'), opacity: getComputedStyle(g.querySelector('.ports')).opacity, same: window.__card === g.querySelector('.card') }; })()`);
  check('hovering a card reveals its ports without rebuilding the DOM', hover.on && hover.opacity === '1' && hover.same, JSON.stringify(hover));

  // Drag a wire between two matching ports.
  const before = await js(`document.querySelectorAll('#canvas g.wire').length`);
  const from = await center('#canvas .portg[data-node="n5"][data-port="i2c"] .port');
  const to = await center('#canvas .portg[data-node="n6"][data-port="i2c"] .port');
  await drag(from.x, from.y, to.x, to.y);
  await sleep(200);
  const wired = await js(`(() => ({ wires: document.querySelectorAll('#canvas g.wire').length, popover: !document.getElementById('bus-popover').hidden, sel: document.querySelector('#canvas g.wire.sel .vis')?.getAttribute('stroke') }))()`);
  check('dragging port to port adds a selected wire without a bus popover', wired.wires === before + 1 && !wired.popover && wired.sel === '#7dd3fc', JSON.stringify({ before, ...wired }));

  // Panning only moves the camera transform. Pan with the hand tool (H) and
  // a left drag; middle-drag and Space-drag also pan in the app, but headless
  // Linux Chrome delivers neither reliably.
  await key('h', 'KeyH', 72);
  await sleep(50);
  await js(`window.__diag = document.querySelector('#canvas .layer-diagram').firstElementChild; true`);
  const t0 = await js(`document.querySelector('#canvas > g').getAttribute('transform')`);
  // Start on empty canvas measured from the canvas itself: hard-coded screen
  // coordinates fall outside the viewport on some runners.
  const at = await js(`(() => { const r = document.getElementById('canvas').getBoundingClientRect(); const x = r.left + r.width * 0.45, y = r.top + r.height * 0.88; return { x, y, vw: innerWidth, vh: innerHeight, hit: (document.elementFromPoint(x, y) || {}).id || (document.elementFromPoint(x, y) || {}).tagName }; })()`);
  await drag(at.x, at.y, at.x + 60, at.y + 40);
  await sleep(100);
  const pan = await js(`({ t: document.querySelector('#canvas > g').getAttribute('transform'), same: window.__diag === document.querySelector('#canvas .layer-diagram').firstElementChild })`);
  check('panning moves the camera without rebuilding the diagram', pan.t !== t0 && pan.same, JSON.stringify({ t0, ...pan, at }));
  await key('v', 'KeyV', 86);
  await sleep(50);

  // Double-click renames.
  const label = await center('#canvas g.node[data-id="n5"] text[data-edit="label"]');
  for (const c of [1, 2]) {
    await mouse('mousePressed', label.x, label.y, { button: 'left', clickCount: c });
    await mouse('mouseReleased', label.x, label.y, { button: 'left', clickCount: c });
    await sleep(60);
  }
  await sleep(150);
  const editor = await js(`(() => { const e = document.getElementById('inline-editor'); return { hidden: e.hidden, value: e.value, focused: document.activeElement === e }; })()`);
  check('double-click on a label opens the inline editor', !editor.hidden && editor.value === 'MCU' && editor.focused, JSON.stringify(editor));
  await key('Escape', 'Escape', 27);
  await sleep(100);

  // Arrow keys nudge the selection (the card moved on screen with the pan).
  const mcu2 = await center('#canvas g.node[data-id="n5"] .card');
  await click(mcu2.x, mcu2.y);
  await sleep(100);
  const x0 = await js(`document.querySelector('#canvas g.node[data-id="n5"]').getAttribute('transform')`);
  await key('ArrowRight', 'ArrowRight', 39);
  await key('ArrowDown', 'ArrowDown', 40, 8);
  await sleep(100);
  const x1 = await js(`document.querySelector('#canvas g.node[data-id="n5"]').getAttribute('transform')`);
  const px = (t) => t.match(/translate\(([-\d.]+) ([-\d.]+)\)/).slice(1).map(Number);
  const [ax, ay] = px(x0);
  const [bx, by] = px(x1);
  check('arrow keys nudge by 1px, Shift by a grid step', bx === ax + 1 && by === ay + 8, `${x0} -> ${x1}`);

  // Zone: select by its label, resize by the SE handle, then drag it with its cards.
  const zl = await center('#canvas g.zone[data-id="z1"] text[data-edit="label"]');
  await click(zl.x, zl.y);
  await sleep(150);
  const handles = await js(`document.querySelectorAll('#canvas g.zone[data-id="z1"] [data-zhandle]').length`);
  check('selecting a zone shows four corner handles', handles === 4, String(handles));
  const zone0 = await js(`(() => { const r = document.querySelector('#canvas g.zone[data-id="z1"] rect').getBBox(); return { w: r.width, h: r.height, x: r.x }; })()`);
  const se = await center('#canvas g.zone[data-id="z1"] [data-zhandle="se"]');
  await drag(se.x, se.y, se.x + 48, se.y + 32);
  await sleep(150);
  const zone1 = await js(`(() => { const r = document.querySelector('#canvas g.zone[data-id="z1"] rect').getBBox(); return { w: r.width, h: r.height, x: r.x }; })()`);
  check('dragging a corner handle resizes the zone', zone1.w === zone0.w + 48 && zone1.h === zone0.h + 32 && zone1.x === zone0.x, JSON.stringify({ zone0, zone1 }));
  const solar0 = px(await js(`document.querySelector('#canvas g.node[data-id="n1"]').getAttribute('transform')`));
  const zl2 = await center('#canvas g.zone[data-id="z1"] text[data-edit="label"]');
  await drag(zl2.x, zl2.y, zl2.x + 40, zl2.y);
  await sleep(150);
  const zone2 = await js(`(() => { const r = document.querySelector('#canvas g.zone[data-id="z1"] rect').getBBox(); return { x: r.x }; })()`);
  const solar1 = px(await js(`document.querySelector('#canvas g.node[data-id="n1"]').getAttribute('transform')`));
  check('dragging a zone carries the cards inside it', zone2.x === zone1.x + 40 && solar1[0] === solar0[0] + 40, JSON.stringify({ zone1, zone2, solar0, solar1 }));

  // Re-attach a wire end: select the MCU-to-temp I2C wire, drag its far end
  // onto the soil probe's ADC port. The bus stays I2C (it still matches the
  // MCU end), so no picker appears.
  // Reset the camera first: after the pan, the right-hand cards sit under the
  // floating properties panel, which would swallow the drop.
  await js(`document.getElementById('zoom-reset').click(); true`);
  await sleep(100);
  const pill = await center('#canvas g.wire[data-id="w6"] text[data-edit="label"]');
  await click(pill.x, pill.y);
  await sleep(150);
  const wireHandles = await js(`document.querySelectorAll('#canvas g.wire[data-id="w6"] [data-wend]').length`);
  check('selecting a wire shows a handle at each end', wireHandles === 2, String(wireHandles));
  const wend = await center('#canvas g.wire[data-id="w6"] [data-wend="to"]');
  const hitAtHandle = await js(`(() => { const el = document.elementFromPoint(${wend.x}, ${wend.y}); return el.tagName + '.' + (el.className.baseVal ?? el.className) + ' in ' + (el.closest('[data-type]')?.dataset.id || '-'); })()`);
  const adc = await center('#canvas .portg[data-node="n7"][data-port="out"] .port');
  await mouse('mouseMoved', wend.x, wend.y);
  await mouse('mousePressed', wend.x, wend.y, { button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 6; i++) {
    await mouse('mouseMoved', wend.x + ((adc.x - wend.x) * i) / 6, wend.y + ((adc.y - wend.y) * i) / 6, { button: 'left', buttons: 1 });
    await sleep(20);
  }
  const midDrag = await js(`({ drafting: document.getElementById('canvas').classList.contains('drafting'), rewiring: !!document.querySelector('.wire.rewiring'), hot: document.querySelector('[data-hot]')?.dataset.node || null })`);
  await mouse('mouseReleased', adc.x, adc.y, { button: 'left', clickCount: 1 });
  await sleep(200);
  const rewired = await js(`(() => { const g = document.querySelector('#canvas g.wire[data-id="w6"]'); return { to: g.dataset.to, from: g.dataset.from, label: g.querySelector('text[data-edit="label"]').textContent, popover: !document.getElementById('bus-popover').hidden, wires: document.querySelectorAll('#canvas g.wire').length }; })()`);
  check('dragging an end handle onto another port re-attaches the wire and keeps its bus', rewired.to === 'n7:out' && rewired.from === 'n5:i2c' && rewired.label === 'I2C' && !rewired.popover && rewired.wires === before + 1, JSON.stringify({ ...rewired, hitAtHandle, midDrag }));
  await js(`document.getElementById('undo').click(); true`);
  await sleep(100);
  const undone = await js(`document.querySelector('#canvas g.wire[data-id="w6"]').dataset.to`);
  check('re-attaching is a single undo step', undone === 'n6:i2c', undone);

  // Switch to another example through its share link. A hash-only
  // navigation would not reload the app, and a non-empty autosave raises a
  // confirm dialog, so wait for the debounced autosave to settle, clear
  // storage, blank the page, then load the link and wait for its cards.
  async function loadBoard(doc) {
    await sleep(700);
    await js('localStorage.clear(); true');
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(200);
    await send('Page.navigate', { url: `${origin}/#${await encodeShare(doc)}` });
    for (let i = 0; i < 40; i++) {
      const n = await js(`document.querySelectorAll('#canvas g.node').length`).catch(() => 0);
      if (n === doc.nodes.length) break;
      await sleep(150);
    }
    await sleep(300);
  }

  // Presets live on the rover board. A hash-only navigation would not reload
  // the app, and a non-empty autosave would raise a confirm dialog, so clear
  // storage, blank the page, then load the rover share link.
  await loadBoard(EXAMPLES.find((e) => e.id === 'rdk-rover').doc);
  const brain = await center('#canvas g.node[data-id="n3"] .card');
  await click(brain.x, brain.y);
  await sleep(200);
  const dl = await js(`(() => { const inp = document.querySelector('#props input[data-prop="sublabel"]'); const dl = document.getElementById('preset-list'); return { value: inp?.value, options: dl ? [...dl.options].map((o) => o.value) : null }; })()`);
  check('selecting the RDK card offers the D-Robotics presets under Part number', dl.value === 'RDK X5' && dl.options?.includes('RDK S100P'), JSON.stringify(dl));
  await js(`(() => { const inp = document.querySelector('#props input[data-prop="sublabel"]'); inp.value = 'rdk x3'; inp.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(200);
  const applied = await js(`(() => ({ sub: document.querySelector('#props input[data-prop="sublabel"]')?.value, meta: document.querySelector('#canvas g.node[data-id="n3"] text[data-edit="sublabel"]')?.textContent }))()`);
  check('typing a preset in any case sets the canonical part number on the card', applied.sub === 'RDK X3' && applied.meta === 'RDK X3', JSON.stringify(applied));

  // Threat metadata lives on the ADAS security board: schema fields, a
  // severity tag, and a disposition tag on the card.
  await loadBoard(EXAMPLES.find((e) => e.id === 'adas-security').doc);
  const spoofer = await center('#canvas g.node[data-id="t1"] .card');
  await click(spoofer.x, spoofer.y);
  await sleep(200);
  const threatProps = await js(`(() => {
    const sev = document.querySelector('#props select[data-field="severity"]');
    const target = document.querySelector('#props select[data-field="target"]');
    const card = document.querySelector('#canvas g.node[data-id="t1"]');
    const texts = [...card.querySelectorAll('text')].map((t) => t.textContent);
    const glowEl = card.querySelector('.fxhalo.anim');
    return { sev: sev?.value, target: target?.value, partNumber: !!document.querySelector('#props input[data-prop="sublabel"]'), texts,
      header: document.querySelector('#props h3')?.textContent.replace(/[▸▾]/g, '').trim(),
      glow: glowEl ? getComputedStyle(glowEl).animationName : null, steady: !!card.querySelector('.fxhalo:not(.anim)'), animating: document.getElementById('btn-animate')?.classList.contains('active') === true };
  })()`);
  check('a threat card edits STIX-style fields instead of a part number and wears severity and disposition tags',
    threatProps.sev === 'high' && threatProps.target === 'GNSS' && !threatProps.partNumber
      && threatProps.texts.includes('HIGH') && threatProps.texts.includes('ADVERSARY') && threatProps.texts.includes('GNSS'),
    JSON.stringify(threatProps));
  check('the panel header names the part and an adversary glows with the Animate toggle off',
    threatProps.header === 'Sensor spoofing' && threatProps.glow === 'fxpulse' && threatProps.steady === false && !threatProps.animating, JSON.stringify(threatProps));
  // The toggle owns the wires: none flow until it is on, and none after it is off again.
  check('no wire flows while Animate is off', (await js(`document.querySelectorAll('#canvas .vis.anim').length`)) === 0);
  await js(`document.getElementById('btn-animate').click(); true`);
  await sleep(150);
  const flowing = await js(`(() => ({ wires: document.querySelectorAll('#canvas .vis.anim').length, glow: !!document.querySelector('#canvas g.node[data-id="t1"] .fxhalo.anim') }))()`);
  check('turning Animate on makes the wires flow and keeps the adversary pulsing', flowing.wires > 0 && flowing.glow, JSON.stringify(flowing));
  await js(`document.getElementById('btn-animate').click(); true`);
  await sleep(150);
  const stillAgain = await js(`(() => ({ wires: document.querySelectorAll('#canvas .vis.anim').length, glow: !!document.querySelector('#canvas g.node[data-id="t1"] .fxhalo.anim') }))()`);
  check('turning Animate off stops the wires but not the adversary glow', stillAgain.wires === 0 && stillAgain.glow, JSON.stringify(stillAgain));
  await js(`(() => { const s = document.querySelector('#props select[data-field="severity"]'); s.value = 'critical'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(150);
  const victim = await center('#props [data-disp="victim"]');
  await click(victim.x, victim.y);
  await sleep(200);
  const retagged = await js(`(() => [...document.querySelectorAll('#canvas g.node[data-id="t1"] text')].map((t) => t.textContent))()`);
  check('changing severity and disposition retags the card', retagged.includes('CRITICAL') && retagged.includes('VICTIM') && !retagged.includes('HIGH') && !retagged.includes('ADVERSARY'), JSON.stringify(retagged));
  const ring = await js(`(() => { const h = document.querySelector('#canvas g.node[data-id="t1"] .fxhalo'); return { anim: h?.classList.contains('anim'), stroke: h?.getAttribute('stroke') }; })()`);
  check('a victim wears a steady amber ring instead of the pulse', ring.anim === false && ring.stroke === '#fbbf24', JSON.stringify(ring));

  // Collapsible panel: the RDK card is selected, so the properties panel is up.
  const panelBefore = await js(`(() => { const p = document.getElementById('props'); const visible = (el) => getComputedStyle(el).display !== 'none'; return { hidden: p.hidden, collapsed: p.classList.contains('collapsed'), fields: [...p.querySelectorAll('label')].filter(visible).length, toggle: !!p.querySelector('.panel-toggle') }; })()`);
  const tog = await center('#props .panel-toggle');
  await click(tog.x, tog.y);
  await sleep(150);
  const folded = await js(`(() => { const p = document.getElementById('props'); const visible = (el) => getComputedStyle(el).display !== 'none'; return { collapsed: p.classList.contains('collapsed'), fields: [...p.querySelectorAll('label')].filter(visible).length, header: visible(p.querySelector('h3')), stored: localStorage.getItem('schematica.panel.props.collapsed'), height: p.getBoundingClientRect().height }; })()`);
  check('the ▾ folds the properties panel to its header and remembers it', panelBefore.toggle && !panelBefore.collapsed && panelBefore.fields > 3 && folded.collapsed && folded.fields === 0 && folded.header && folded.stored === '1' && folded.height < 60, JSON.stringify({ panelBefore, folded }));
  const tog2 = await center('#props .panel-toggle');
  await click(tog2.x, tog2.y);
  await sleep(150);
  const reopened = await js(`(() => { const p = document.getElementById('props'); return { collapsed: p.classList.contains('collapsed'), stored: localStorage.getItem('schematica.panel.props.collapsed') }; })()`);
  check('clicking it again unfolds the panel', !reopened.collapsed && reopened.stored === '0', JSON.stringify(reopened));

  // Hide the panels entirely with P, bring them back with the toolbar button.
  await key('p', 'KeyP', 80);
  await sleep(150);
  const gone = await js(`(() => { const p = document.getElementById('props'); return { display: getComputedStyle(p).display, cls: document.getElementById('app').classList.contains('panels-hidden'), stored: localStorage.getItem('schematica.panels.hidden'), btnActive: document.getElementById('btn-panels').classList.contains('active') }; })()`);
  check('P hides the right-hand panels and remembers it', gone.display === 'none' && gone.cls && gone.stored === '1' && !gone.btnActive, JSON.stringify(gone));
  await js(`document.getElementById('btn-panels').click(); true`);
  await sleep(150);
  const back = await js(`(() => { const p = document.getElementById('props'); return { display: getComputedStyle(p).display, cls: document.getElementById('app').classList.contains('panels-hidden'), stored: localStorage.getItem('schematica.panels.hidden') }; })()`);
  check('the panels button shows them again', back.display !== 'none' && !back.cls && back.stored === '0', JSON.stringify(back));

  // Hide the palette with B: the canvas takes the width; the button restores it.
  const canvasLeft0 = await js(`document.getElementById('canvas').getBoundingClientRect().left`);
  await key('b', 'KeyB', 66);
  await sleep(150);
  const noPalette = await js(`(() => ({ display: getComputedStyle(document.getElementById('palette')).display, cls: document.getElementById('app').classList.contains('palette-hidden'), stored: localStorage.getItem('schematica.palette.hidden'), canvasLeft: document.getElementById('canvas').getBoundingClientRect().left }))()`);
  check('B hides the palette and the canvas widens', noPalette.display === 'none' && noPalette.cls && noPalette.stored === '1' && noPalette.canvasLeft < canvasLeft0, JSON.stringify({ canvasLeft0, ...noPalette }));
  await js(`document.getElementById('btn-palette').click(); true`);
  await sleep(150);
  const paletteBack = await js(`(() => ({ display: getComputedStyle(document.getElementById('palette')).display, cls: document.getElementById('app').classList.contains('palette-hidden'), canvasLeft: document.getElementById('canvas').getBoundingClientRect().left }))()`);
  check('the palette button brings it back', paletteBack.display !== 'none' && !paletteBack.cls && paletteBack.canvasLeft === canvasLeft0, JSON.stringify(paletteBack));

  // Palette search.
  await js(`(() => { const s = document.getElementById('palette-search'); s.value = 'rdk'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(100);
  // Visibility is judged by computed style, not the attribute: an author
  // display rule can silently defeat the hidden attribute.
  const visible = `(el) => getComputedStyle(el).display !== 'none'`;
  const search = await js(`(() => { const visible = ${visible}; const items = [...document.querySelectorAll('#palette .palette-item')]; const shown = items.filter(visible).map((i) => i.querySelector('.pi-name').textContent); const heads = [...document.querySelectorAll('#palette h3')].filter(visible).map((h) => h.textContent); return { shown, heads }; })()`);
  check('palette search "rdk" shows only the AI SBC and RDK cameras under a single Robotics heading', search.shown.length === 3 && search.shown.includes('AI SBC / robot kit') && search.heads.length === 1 && search.heads[0] === 'Robotics', JSON.stringify(search));
  await js(`(() => { const visible = ${visible}; const s = document.getElementById('palette-search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); return [...document.querySelectorAll('#palette .palette-item')].filter(visible).length; })()`).then((n) => check('clearing the search restores every part', n >= 60, String(n)));
  const collapsed = await js(`(() => { const visible = ${visible}; const h = document.querySelector('#palette h3'); h.click(); const box = h.nextElementSibling; const out = !visible(box); h.click(); return out && visible(box); })()`);
  check('clicking a category heading collapses and re-expands its tiles', collapsed === true, String(collapsed));

  // ---- Robustness and accessibility ----
  const weather = EXAMPLES.find((e) => e.id === 'weather-station').doc;
  await loadBoard(weather);

  // Every pointermove of a drag emits from the store; the properties panel
  // must not be torn down and rebuilt on each one.
  const cardSel = '#canvas g.node[data-id="n5"] .card';
  const cardA = await center(cardSel);
  const restX = await js(`document.querySelector(${JSON.stringify(cardSel)}).getBoundingClientRect().x`);
  await mouse('mouseMoved', cardA.x, cardA.y);
  await mouse('mousePressed', cardA.x, cardA.y, { button: 'left', buttons: 1, clickCount: 1 });
  await sleep(50);
  // The press selected the card and showed its panel; hold on to that panel.
  await js(`window.__h3 = document.querySelector('#props h3'); true`);
  for (let i = 1; i <= 4; i++) {
    await mouse('mouseMoved', cardA.x + i * 10, cardA.y + i * 5, { button: 'left', buttons: 1 });
    await sleep(20);
  }
  const dragPanel = await js(`(() => ({ same: window.__h3 === document.querySelector('#props h3'), x: document.querySelector(${JSON.stringify(cardSel)}).getBoundingClientRect().x }))()`);
  await mouse('mouseReleased', cardA.x + 40, cardA.y + 20, { button: 'left', clickCount: 1 });
  check('the properties panel is left alone while a card is dragged', dragPanel.same === true && dragPanel.x !== restX, JSON.stringify({ restX, ...dragPanel }));

  // An interrupted pointer (touch cancel, OS gesture) must abandon the drag
  // where it started and cost no undo step.
  await loadBoard(weather);
  const cardB = await center(cardSel);
  const beforeX = await js(`document.querySelector(${JSON.stringify(cardSel)}).getBoundingClientRect().x`);
  await mouse('mouseMoved', cardB.x, cardB.y);
  await mouse('mousePressed', cardB.x, cardB.y, { button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 4; i++) {
    await mouse('mouseMoved', cardB.x + i * 15, cardB.y, { button: 'left', buttons: 1 });
    await sleep(20);
  }
  const movedX = await js(`document.querySelector(${JSON.stringify(cardSel)}).getBoundingClientRect().x`);
  await js(`document.getElementById('canvas').dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })); true`);
  await sleep(50);
  const cancelled = await js(`(() => ({ x: document.querySelector(${JSON.stringify(cardSel)}).getBoundingClientRect().x, undoDisabled: document.getElementById('undo').disabled }))()`);
  await mouse('mouseReleased', cardB.x + 60, cardB.y, { button: 'left', clickCount: 1 });
  await sleep(50);
  const afterUp = await js(`document.querySelector(${JSON.stringify(cardSel)}).getBoundingClientRect().x`);
  check('pointercancel abandons a move and costs no undo step', movedX !== beforeX && cancelled.x === beforeX && cancelled.undoDisabled === true && afterUp === beforeX, JSON.stringify({ beforeX, movedX, afterUp, ...cancelled }));

  // Dialogs are native <dialog>s: modal, Escape closes, focus comes back,
  // and a click on the backdrop dismisses.
  await js(`document.getElementById('btn-bom').focus(); true`);
  const bomBtn = await center('#btn-bom');
  // With a card selected the properties panel is showing; it lives inside
  // the canvas area, so it can never cover a toolbar control. The toolbar
  // itself fits one row at this window width (it wraps below ~1366 px).
  const covering = await js(`(() => { const hit = document.elementFromPoint(${bomBtn.x}, ${bomBtn.y}); return hit && (hit.id || hit.tagName); })()`);
  check('the floating panel never covers a toolbar control', covering === 'btn-bom', String(covering));
  const toolbarRows = await js(`(() => { const tops = new Set([...document.getElementById('toolbar').children].map((k) => { const r = k.getBoundingClientRect(); return Math.round(r.top + r.height / 2); })); return { rows: tops.size, tagline: !!document.querySelector('.brand-sub') }; })()`);
  check('the toolbar fits on one row at 1500 px with no tagline beside the name', toolbarRows.rows === 1 && toolbarRows.tagline === false, JSON.stringify(toolbarRows));
  await click(bomBtn.x, bomBtn.y);
  await sleep(100);
  const modal = await js(`(() => { const d = document.getElementById('bom-dialog'); return { tag: d.tagName, open: d.open === true, modal: d.matches(':modal'), inside: d.contains(document.activeElement) }; })()`);
  check('the BOM opens as a modal <dialog> and takes focus', modal.tag === 'DIALOG' && modal.open && modal.modal && modal.inside, JSON.stringify(modal));
  await key('Escape', 'Escape', 27);
  await sleep(100);
  const closed = await js(`(() => { const d = document.getElementById('bom-dialog'); return { open: d.open === true, focus: document.activeElement && document.activeElement.id }; })()`);
  check('Escape closes the dialog and returns focus to the BOM button', closed.open === false && closed.focus === 'btn-bom', JSON.stringify(closed));
  await click(bomBtn.x, bomBtn.y);
  await sleep(100);
  const vh = await js('window.innerHeight');
  await click(20, vh - 20);
  await sleep(100);
  const outside = await js(`document.getElementById('bom-dialog').open === true`);
  check('clicking outside the card closes the dialog', outside === false, String(outside));

  // Toasts are announced to assistive tech, and a failed autosave is
  // reported instead of silently dropped.
  const live = await js(`(() => { const t = document.getElementById('toast'); return { role: t.getAttribute('role'), live: t.getAttribute('aria-live') }; })()`);
  check('the toast is a polite live region', live.role === 'status' && live.live === 'polite', JSON.stringify(live));
  await js(`window.__setItem = Storage.prototype.setItem; Storage.prototype.setItem = function () { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }; true`);
  const cardC = await center(cardSel);
  await click(cardC.x, cardC.y);
  await key('ArrowRight', 'ArrowRight', 39);
  await sleep(600);
  const unsaved = await js(`(() => { const t = document.getElementById('toast'); return { hidden: t.hidden, text: t.textContent }; })()`);
  await js(`Storage.prototype.setItem = window.__setItem; true`);
  check('a failed autosave tells the user', unsaved.hidden === false && /autosave/i.test(unsaved.text), JSON.stringify(unsaved));

  // A share link opened over existing work loads at once (no blocking
  // confirm), keeps the previous board as a backup, and offers to restore it.
  const drone = EXAMPLES.find((e) => e.id === 'drone-fc').doc;
  await js(`localStorage.setItem('schematica.autosave', ${JSON.stringify(JSON.stringify(weather))}); true`);
  await sleep(400);
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(200);
  await send('Page.navigate', { url: `${origin}/#${await encodeShare(drone)}` });
  for (let i = 0; i < 40; i++) {
    const t = await js(`document.getElementById('title').value`).catch(() => '');
    if (t === drone.title) break;
    await sleep(150);
  }
  await sleep(200);
  const shared = await js(`(() => { const t = document.getElementById('toast'); return { title: document.getElementById('title').value, nodes: document.querySelectorAll('#canvas g.node').length, toast: t.hidden ? '' : t.textContent, restore: !!t.querySelector('button'), backup: !!localStorage.getItem('schematica.autosave.backup') }; })()`);
  check('a share link over existing work loads at once, keeps a backup, and offers to restore it', shared.title === drone.title && shared.nodes === drone.nodes.length && shared.restore && shared.backup, JSON.stringify(shared));
  await js(`document.querySelector('#toast button')?.click(); true`);
  await sleep(200);
  const restored = await js(`(() => ({ title: document.getElementById('title').value, nodes: document.querySelectorAll('#canvas g.node').length }))()`);
  check('restoring brings the previous board back', restored.title === weather.title && restored.nodes === weather.nodes.length, JSON.stringify(restored));

  // ---- Assistant panel: toggle, fold, settings, key handling ----
  await loadBoard(weather);
  const panelOpen = await js(`(() => { const p = document.getElementById('assistant'); return { exists: !!p, hidden: p && p.hidden, inCanvas: p && p.closest('#canvas-wrap') !== null }; })()`);
  check('the assistant panel exists inside the canvas area and starts hidden', panelOpen.exists && panelOpen.hidden === true && panelOpen.inCanvas, JSON.stringify(panelOpen));
  await key('a', 'KeyA', 65);
  await sleep(100);
  const afterA = await js(`(() => { const p = document.getElementById('assistant'); return { hidden: p.hidden, settingsShown: getComputedStyle(document.getElementById('ai-settings')).display !== 'none', btnActive: document.getElementById('btn-assistant').classList.contains('active') }; })()`);
  check('A opens the panel, and with no key configured the settings form shows', afterA.hidden === false && afterA.settingsShown && afterA.btnActive, JSON.stringify(afterA));
  await js(`(() => { document.getElementById('ai-key').value = 'sk-test-123'; document.getElementById('ai-remember').checked = false; document.getElementById('ai-save').click(); return true; })()`);
  await sleep(100);
  const saved = await js(`(() => ({ stored: localStorage.getItem('schematica.ai.key.anthropic'), settings: JSON.parse(localStorage.getItem('schematica.ai.settings') || '{}'), meta: document.getElementById('ai-meta').textContent, settingsShown: getComputedStyle(document.getElementById('ai-settings')).display !== 'none' }))()`);
  check('a key saved without "remember" stays out of storage and the panel shows the model', saved.stored === null && saved.settings.remember === false && /claude-opus-5/.test(saved.meta) && !saved.settingsShown, JSON.stringify(saved));
  await js(`(() => { document.getElementById('ai-gear').click(); document.getElementById('ai-key').value = 'sk-test-456'; document.getElementById('ai-remember').checked = true; document.getElementById('ai-save').click(); return true; })()`);
  await sleep(100);
  const remembered = await js(`localStorage.getItem('schematica.ai.key.anthropic')`);
  check('ticking "remember" stores the key on this device', remembered === 'sk-test-456', String(remembered));
  await js(`(() => { document.getElementById('ai-gear').click(); document.getElementById('ai-forget').click(); return true; })()`);
  await sleep(100);
  const forgotten = await js(`localStorage.getItem('schematica.ai.key.anthropic')`);
  check('forget clears the stored key', forgotten === null, String(forgotten));
  // Seven providers; switching one fills its base URL, default model, model
  // suggestions, and help, and only the local Ollama entry drops the key.
  const pick = (id) => js(`(() => { const sel = document.getElementById('ai-provider'); sel.value = ${JSON.stringify(id)}; sel.dispatchEvent(new Event('change', { bubbles: true })); return { base: document.getElementById('ai-base').value, model: document.getElementById('ai-model').value, options: [...document.querySelectorAll('#ai-models option')].map((o) => o.value), keyOff: document.getElementById('ai-key').disabled, listHidden: document.getElementById('ai-models-btn').hidden, help: document.getElementById('ai-help').textContent }; })()`);
  const providerIds = await js(`[...document.querySelectorAll('#ai-provider option')].map((o) => o.value)`);
  check('the provider menu lists Anthropic, OpenAI-compatible, OpenRouter, Z.AI, Kimi, Ollama, and Ollama Cloud', JSON.stringify(providerIds) === JSON.stringify(['anthropic', 'openai', 'openrouter', 'zai', 'kimi', 'ollama', 'ollamacloud']), JSON.stringify(providerIds));
  const kimi = await pick('kimi');
  check('picking Kimi fills the Moonshot base URL, the kimi-k3 default, and model suggestions', kimi.base === 'https://api.moonshot.ai/v1' && kimi.model === 'kimi-k3' && kimi.options.includes('kimi-k3') && kimi.keyOff === false && kimi.listHidden === false, JSON.stringify(kimi));
  const cloud = await pick('ollamacloud');
  check('picking Ollama Cloud points at the local Ollama with a :cloud model and no key field', cloud.base === 'http://localhost:11434' && cloud.model === 'glm-5.3:cloud' && cloud.options.includes('glm-5.3:cloud') && cloud.keyOff === true && cloud.listHidden === false && /ollama signin/.test(cloud.help), JSON.stringify(cloud));
  const local = await pick('ollama');
  check('picking local Ollama disables the key field and shows the CORS note', local.keyOff === true && /OLLAMA_ORIGINS/.test(local.help) && local.options.length === 0, JSON.stringify(local));
  const zai = await pick('zai');
  check('picking Z.AI fills the GLM endpoint and glm-5.3', zai.base === 'https://api.z.ai/api/paas/v4' && zai.model === 'glm-5.3' && zai.keyOff === false, JSON.stringify(zai));
  await pick('anthropic');
  const backOnClaude = await js(`(() => ({ listHidden: document.getElementById('ai-models-btn').hidden, options: [...document.querySelectorAll('#ai-models option')].map((o) => o.value) }))()`);
  check('back on Anthropic the List models button hides and the Claude ids are suggested', backOnClaude.listHidden === true && backOnClaude.options.includes('claude-opus-5'), JSON.stringify(backOnClaude));
  const foldedAi = await js(`(() => { const p = document.getElementById('assistant'); p.querySelector('.panel-toggle').click(); const out = p.classList.contains('collapsed'); p.querySelector('.panel-toggle').click(); return out; })()`);
  check('the assistant panel folds like the others', foldedAi === true, String(foldedAi));
  // With the assistant open, the journey panel must end above it (it scrolls
  // instead of running underneath).
  await js(`document.getElementById('btn-journey').click(); true`);
  await sleep(200);
  const stacked = await js(`(() => { const a = document.getElementById('assistant').getBoundingClientRect(); const j = document.getElementById('journey-panel').getBoundingClientRect(); return { journeyBottom: Math.round(j.bottom), assistantTop: Math.round(a.top), reserve: getComputedStyle(document.getElementById('canvas-wrap')).getPropertyValue('--ai-reserve').trim(), journeyVisible: j.height > 100 }; })()`);
  check('the journey panel ends above the open assistant panel', stacked.journeyVisible && stacked.journeyBottom <= stacked.assistantTop && stacked.reserve !== '0px', JSON.stringify(stacked));
  await js(`document.getElementById('btn-journey').click(); true`);
  await sleep(100);
  await js(`document.activeElement && document.activeElement.blur(); true`);
  await key('a', 'KeyA', 65);
  await sleep(100);
  check('A closes the panel again', (await js(`document.getElementById('assistant').hidden`)) === true);

  // The Examples menu lists every board under a topic heading; Escape closes it
  // (choosing one would confirm(), which the smoke test never does).
  await js(`document.getElementById('btn-examples').click(); true`);
  await sleep(100);
  const menu = await js(`(() => { const m = document.getElementById('examples-menu'); return { hidden: m.hidden, headings: [...m.querySelectorAll('.menu-group')].map((h) => h.textContent), buttons: m.querySelectorAll('button').length }; })()`);
  check('the Examples menu opens with Embedded, Vehicle, and Security headings over sixteen boards', menu.hidden === false && JSON.stringify(menu.headings) === JSON.stringify(['Embedded', 'Vehicle', 'Security']) && menu.buttons === EXAMPLES.length && EXAMPLES.length === 16, JSON.stringify(menu));
  await key('Escape', 'Escape', 27);
  await sleep(100);
  check('Escape closes the Examples menu', (await js(`document.getElementById('examples-menu').hidden`)) === true);

  // ---- Assistant: build, undo, highlight, Fix button, thread ----
  // An empty board through a share link (loadBoard clears storage, so the
  // settings are seeded afterwards; they are read at send time).
  const EMPTY = { schema: 1, title: 'Empty', nodes: [], wires: [], zones: [], notes: [], journey: [] };
  const seedFake = () => js(`localStorage.setItem('schematica.ai.settings', JSON.stringify({ provider: 'anthropic', model: 'test-model', baseUrl: location.origin + '/fake', effort: 'low', remember: true, tools: true })); localStorage.setItem('schematica.ai.key.anthropic', 'sk-fake'); true`);
  await loadBoard(EMPTY);
  await seedFake();
  check('the board is empty before the build', (await js(`document.querySelectorAll('#canvas g.node').length`)) === 0);
  await key('a', 'KeyA', 65);
  await sleep(100);
  await js(`(() => { const i = document.getElementById('ai-input'); i.value = 'build a small sensor node'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  let built = null;
  for (let i = 0; i < 40; i++) {
    built = await js(`(() => ({ nodes: document.querySelectorAll('#canvas g.node').length, wires: document.querySelectorAll('#canvas g.wire').length, zones: document.querySelectorAll('#canvas g.zone').length, title: document.getElementById('title').value, done: !!document.querySelector('#ai-thread .ai-msg.assistant') && /Done\\./.test(document.querySelector('#ai-thread .ai-msg.assistant:last-of-type').textContent), sending: !document.getElementById('ai-stop').hidden }))()`);
    if (built.done && !built.sending) break;
    await sleep(150);
  }
  check('a build request through the fake provider produces cards, wires, a zone, and a title', built.nodes === 3 && built.wires === 2 && built.zones === 1 && built.title === 'Fake Build' && built.done, JSON.stringify(built));
  const overlapFree = await js(`(() => { const r = [...document.querySelectorAll('#canvas g.node .card')].map((c) => c.getBoundingClientRect()); for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) { if (r[i].left < r[j].right && r[j].left < r[i].right && r[i].top < r[j].bottom && r[j].top < r[i].bottom) return false; } return r.length === 3; })()`);
  check('the placed cards do not overlap', overlapFree === true, String(overlapFree));
  const highlighted = await js(`document.querySelectorAll('#canvas .hl, #canvas .hl-wire').length`);
  check('everything the assistant touched is highlighted', highlighted === 6, String(highlighted));
  const statusLines = await js(`[...document.querySelectorAll('#ai-thread .ai-status')].map((s) => s.textContent)`);
  check('tool activity shows as status lines', statusLines.some((s) => /applying 7 edits/.test(s)), JSON.stringify(statusLines));
  const chip = await js(`(() => { const b = document.querySelector('#ai-thread .ai-chips button[data-undo]'); return { exists: !!b, disabled: b && b.disabled, undoEnabled: !document.getElementById('undo').disabled }; })()`);
  check('the reply carries a live "Undo this" chip', chip.exists && chip.disabled === false && chip.undoEnabled, JSON.stringify(chip));
  await js(`document.querySelector('#ai-thread .ai-chips button[data-undo]').click(); true`);
  await sleep(100);
  const undoneBuild = await js(`(() => ({ nodes: document.querySelectorAll('#canvas g.node').length, chipDisabled: document.querySelector('#ai-thread .ai-chips button[data-undo]').disabled }))()`);
  check('one undo removes the whole reply and disables the chip', undoneBuild.nodes === 0 && undoneBuild.chipDisabled === true, JSON.stringify(undoneBuild));
  check('the request carried the browser headers and the cached system block', fakeSeen[0]?.headers['anthropic-dangerous-direct-browser-access'] === 'true' && fakeSeen[0]?.system?.[0]?.cache_control?.type === 'ephemeral' && fakeSeen[0].tools.includes('apply_edits'), JSON.stringify(fakeSeen[0]?.tools));
  const usageLine = await js(`document.getElementById('ai-usage').textContent`);
  check('the usage line reports tokens', /\d+ in/.test(usageLine) && /\d+ out/.test(usageLine), usageLine);

  // The Fix button on a design-rule finding sends it to the assistant.
  await loadBoard(weather);
  await seedFake();
  const notesBefore = await js(`document.querySelectorAll('#canvas [data-type="note"]').length`);
  await js(`document.getElementById('btn-check').click(); true`);
  await sleep(100);
  const fixBtn = await js(`(() => { const b = document.querySelector('#drc-list [data-drc-fix]'); if (!b) return null; b.click(); return true; })()`);
  check('every finding has a Fix button', fixBtn === true, String(fixBtn));
  let fixed = null;
  for (let i = 0; i < 40; i++) {
    fixed = await js(`(() => ({ dialogOpen: document.getElementById('drc-dialog').open === true, panelOpen: !document.getElementById('assistant').hidden, notes: document.querySelectorAll('#canvas [data-type="note"]').length, sending: !document.getElementById('ai-stop').hidden }))()`);
    if (fixed.notes > notesBefore && !fixed.sending) break;
    await sleep(150);
  }
  const fixSeen = fakeSeen.find((f) => /^Fix this finding/.test(f.lastText));
  check('Fix closes the dialog, opens the panel, sends the finding, and the reply applies', fixed.dialogOpen === false && fixed.panelOpen && fixed.notes === notesBefore + 1 && !!fixSeen && /ids:/.test(fixSeen.lastText), JSON.stringify({ ...fixed, sent: fixSeen?.lastText.slice(0, 80) }));

  // The thread survives a reload of the same board (autosave restores it, no
  // hash, so the store's generation stays put) and clears when a share link
  // replaces the board. Neither path shows a confirm().
  const threadCount = await js(`document.querySelectorAll('#ai-thread .ai-msg').length`);
  await sleep(700);
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(200);
  await send('Page.navigate', { url: `${origin}/` });
  await sleep(1200);
  const restored2 = await js(`document.querySelectorAll('#ai-thread .ai-msg').length`);
  check('the thread is restored after a reload', restored2 === threadCount && restored2 > 0, `${restored2} vs ${threadCount}`);
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(200);
  await send('Page.navigate', { url: `${origin}/#${await encodeShare(drone)}` });
  await sleep(1200);
  const cleared = await js(`(() => ({ title: document.getElementById('title').value, msgs: document.querySelectorAll('#ai-thread .ai-msg').length }))()`);
  check('replacing the board through a share link clears the thread', cleared.title === drone.title && cleared.msgs === 0, JSON.stringify(cleared));
} catch (err) {
  failed += 1;
  results.push(`FAIL script error — ${err.message}`);
} finally {
  ws.close();
  // Let Chrome exit before removing its profile, or the delete races its
  // shutdown writes.
  if (chrome.exitCode === null) {
    chrome.kill();
    await Promise.race([
      new Promise((r) => chrome.once('exit', r)),
      sleep(3000).then(() => chrome.kill('SIGKILL')),
    ]);
  }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  server.close();
}

clearTimeout(watchdog);
console.log(results.join('\n'));
if (problems.length) {
  failed += 1;
  console.log('PROBLEMS:\n' + problems.join('\n'));
} else {
  console.log('no console errors or exceptions');
}
console.log(`${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
