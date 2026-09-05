import test from 'node:test';
import assert from 'node:assert/strict';
import { runRequest, MAX_ROUNDS } from '../src/ai/agent.js';
import { createExecutor } from '../src/ai/tools.js';
import { newDoc, Store } from '../src/state.js';

// A provider that replays scripted replies and records what it was sent.
function scripted(replies) {
  const calls = [];
  return {
    calls,
    chat: async ({ system, messages, tools, signal, onText }) => {
      calls.push({ system, messages: structuredClone(messages), tools });
      if (signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      const r = replies[Math.min(calls.length - 1, replies.length - 1)];
      if (r instanceof Error) throw r;
      if (r.text) onText?.(r.text);
      return { usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, toolCalls: [], text: '', ...r };
    },
  };
}
const SYSTEM = ['stable', 'per-request'];
const build = { id: 'c1', name: 'apply_edits', input: { ops: [
  { op: 'add_part', ref: 'mcu', kind: 'mcu' }, { op: 'add_part', ref: 't', kind: 'temp' },
  { op: 'connect', from: { node: 'mcu' }, to: { node: 't' }, bus: 'i2c' },
] } };

function setup(replies) {
  const store = new Store(newDoc('T'));
  const executor = createExecutor({ getDoc: () => store.doc, commit: (fn) => store.mutate(fn) });
  return { store, executor, provider: scripted(replies) };
}

test('a build runs a tool round, feeds results back, and ends as one undo step', async () => {
  const { store, executor, provider } = setup([
    { text: 'Building.', toolCalls: [build], stop: 'tool_use' },
    { text: 'Done: an MCU and a sensor on I2C.', stop: 'end' },
  ]);
  const statuses = [];
  const res = await runRequest({
    provider, executor, store, system: SYSTEM, history: [],
    userText: 'build a sensor node', boardText: 'board "T"', onStatus: (s) => statuses.push(s),
  });
  assert.equal(res.error, undefined);
  assert.equal(res.stop, 'end');
  assert.equal(res.rounds, 2);
  assert.equal(res.applied, 1);
  assert.equal(res.text, 'Building.\n\nDone: an MCU and a sensor on I2C.');
  assert.equal(store.doc.nodes.length, 2);
  assert.equal(store.undoStack.length, 1, 'one undo step for the whole request');
  assert.equal(res.touched.size, 3);
  assert.deepEqual(statuses, ['applying 3 edits']);
  assert.deepEqual(res.usage, { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 });
  // The provider saw the board text appended to the user message and the tool result on the next call.
  assert.match(provider.calls[0].messages[0].content[0].text, /build a sensor node\n\n---\nboard "T"$/);
  const second = provider.calls[1].messages;
  assert.equal(second[1].role, 'assistant');
  assert.equal(second[1].content[1].type, 'tool_use');
  assert.equal(second[2].role, 'user');
  assert.equal(second[2].content[0].type, 'tool_result');
  assert.equal(second[2].content[0].id, 'c1');
  assert.match(second[2].content[0].text, /^Applied 3 change/);
  assert.equal(res.messages.length, 4, 'history: user, assistant, tool results, assistant');
  assert.deepEqual(provider.calls[0].tools.map((t) => t.name).slice(0, 2), ['search_parts', 'get_board']);
});

test('a failing batch is returned to the model as an error result, not thrown', async () => {
  const { store, executor, provider } = setup([
    { toolCalls: [{ id: 'c1', name: 'apply_edits', input: { ops: [{ op: 'add_part', ref: 'a', kind: 'nope' }] } }], stop: 'tool_use' },
    { text: 'Could not.', stop: 'end' },
  ]);
  const res = await runRequest({ provider, executor, store, system: SYSTEM, history: [], userText: 'x', boardText: 'b' });
  assert.equal(res.applied, 0);
  assert.equal(provider.calls[1].messages[2].content[0].isError, true);
  assert.equal(store.doc.nodes.length, 0);
  assert.equal(store.undoStack.length, 0, 'nothing changed, no undo step');
});

test('the round cap stops a model that never finishes and marks the reply cut off', async () => {
  const { store, executor, provider } = setup([
    { toolCalls: [{ id: 'c', name: 'run_checks', input: {} }], stop: 'tool_use' },
  ]);
  const res = await runRequest({ provider, executor, store, system: SYSTEM, history: [], userText: 'x', boardText: 'b', maxRounds: 3 });
  assert.equal(res.rounds, 3);
  assert.equal(res.cutOff, true);
  assert.equal(res.stop, 'rounds');
  assert.equal(MAX_ROUNDS, 8);
});

test('abort ends the request, keeps edits already applied, and leaves a valid history', async () => {
  const controller = new AbortController();
  const { store, executor, provider } = setup([
    { toolCalls: [build], stop: 'tool_use' },
    { text: 'never', stop: 'end' },
  ]);
  const original = provider.chat;
  provider.chat = async (args) => { if (provider.calls.length === 1) controller.abort(); return original(args); };
  const res = await runRequest({ provider, executor, store, system: SYSTEM, history: [], userText: 'x', boardText: 'b', signal: controller.signal });
  assert.equal(res.stop, 'aborted');
  assert.equal(res.cutOff, true);
  assert.equal(store.doc.nodes.length, 2, 'the first round applied');
  assert.equal(store.undoStack.length, 1);
  assert.equal(res.messages.at(-1).role, 'user', 'history ends on the tool results, ready for the next message');
});

test('a provider error is reported, the batch is closed, and the store is left consistent', async () => {
  const { store, executor, provider } = setup([new Error('401 invalid key')]);
  const res = await runRequest({ provider, executor, store, system: SYSTEM, history: [], userText: 'x', boardText: 'b' });
  assert.equal(res.error.message, '401 invalid key');
  assert.equal(store.inBatch(), false);
  assert.equal(res.messages.length, 1);
});

test('history is passed through and text streams to onText', async () => {
  const { store, executor, provider } = setup([{ text: 'hi', stop: 'end' }]);
  const chunks = [];
  const history = [{ role: 'user', content: [{ type: 'text', text: 'earlier' }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }];
  const res = await runRequest({ provider, executor, store, system: SYSTEM, history, userText: 'now', boardText: 'b', onText: (t) => chunks.push(t) });
  assert.deepEqual(chunks, ['hi']);
  assert.equal(provider.calls[0].messages.length, 3);
  assert.equal(res.messages.length, 4);
});
