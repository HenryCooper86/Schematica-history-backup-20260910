import test from 'node:test';
import assert from 'node:assert/strict';
import { toOllamaRequest, createOllamaAccumulator, ollamaProvider, listOllamaModels } from '../src/ai/providers/ollama.js';
import { MAX_TOOL_INPUT, ProviderError } from '../src/ai/providers/errors.js';

const TOOLS = [{ name: 'get_board', description: 'd', input_schema: { type: 'object', properties: {} } }];
const SYSTEM = ['STABLE', 'PER'];

test('the request uses Ollama chat shapes with object tool arguments', () => {
  const body = toOllamaRequest({ model: 'llama3.1', system: SYSTEM, tools: TOOLS, messages: [
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_0', name: 'get_board', input: { a: 1 } }] },
    { role: 'user', content: [{ type: 'tool_result', id: 'call_0', text: 'board', isError: false }] },
  ] });
  assert.equal(body.model, 'llama3.1');
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages[0], { role: 'system', content: 'STABLE\n\nPER' });
  assert.deepEqual(body.messages[2], { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_board', arguments: { a: 1 } } }] });
  assert.deepEqual(body.messages[3], { role: 'tool', content: 'board' });
  assert.deepEqual(body.tools[0], { type: 'function', function: { name: 'get_board', description: 'd', parameters: TOOLS[0].input_schema } });
  assert.equal(body.options.num_ctx, 16384, 'the default context would truncate the system prompt');
});

test('the accumulator joins streamed lines, mints tool-call ids, and maps done_reason', () => {
  const chunks = [];
  const acc = createOllamaAccumulator((t) => chunks.push(t));
  acc.push({ message: { role: 'assistant', content: 'He' }, done: false });
  acc.push({ message: { role: 'assistant', content: 'y' }, done: false });
  acc.push({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'run_checks', arguments: {} } }] }, done: false });
  acc.push({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 4 });
  const r = acc.result();
  assert.equal(r.text, 'Hey');
  assert.deepEqual(chunks, ['He', 'y']);
  assert.deepEqual(r.toolCalls, [{ id: 'call_0', name: 'run_checks', input: {} }]);
  assert.equal(r.stop, 'tool_use', 'tool calls win over done_reason stop');
  assert.deepEqual(r.usage, { input: 12, output: 4, cacheRead: 0, cacheWrite: 0 });
  const a2 = createOllamaAccumulator(() => {});
  a2.push({ message: { content: 'x' }, done: true, done_reason: 'length' });
  assert.equal(a2.result().stop, 'max_tokens');
});

test('a tool input past 256 KB fails the reply', () => {
  const acc = createOllamaAccumulator(() => {});
  acc.push({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'apply_edits', arguments: { ops: Array.from({ length: MAX_TOOL_INPUT / 2 }, () => 1) } } }] }, done: false });
  acc.push({ message: { content: '' }, done: true, done_reason: 'stop' });
  assert.throws(() => acc.result(), (e) => e instanceof ProviderError && e.code === 'request' && /256 KB/.test(e.message));
});

test('the provider posts to /api/chat without a key and lists local models', async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, init });
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'llama3.1:8b' }, { name: 'gemma:2b' }] }), { status: 200 });
    const lines = [{ message: { content: 'ok' }, done: false }, { message: { content: '' }, done: true, done_reason: 'stop' }];
    return new Response(new Blob([lines.map((l) => JSON.stringify(l)).join('\n') + '\n']).stream(), { status: 200 });
  };
  const p = ollamaProvider({ baseUrl: 'http://localhost:11434/', model: 'llama3.1', fetchImpl });
  const r = await p.chat({ system: SYSTEM, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: TOOLS });
  assert.equal(seen[0].url, 'http://localhost:11434/api/chat');
  assert.equal(seen[0].init.headers.authorization, undefined);
  assert.equal(r.text, 'ok');
  assert.deepEqual(await listOllamaModels({ baseUrl: 'http://localhost:11434', fetchImpl }), ['gemma:2b', 'llama3.1:8b']);
});

test('ollamaProvider and listOllamaModels send a Bearer key when given one (Ollama Cloud)', async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, init });
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'gpt-oss:120b' }] }), { status: 200 });
    const lines = [{ message: { content: 'ok' }, done: true, done_reason: 'stop' }];
    return new Response(new Blob([lines.map((l) => JSON.stringify(l)).join('\n') + '\n']).stream(), { status: 200 });
  };
  const p = ollamaProvider({ baseUrl: 'https://ollama.com', model: 'gpt-oss:120b', apiKey: 'sk-cloud', fetchImpl });
  const r = await p.chat({ system: SYSTEM, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: TOOLS });
  assert.equal(r.text, 'ok');
  assert.equal(seen[0].url, 'https://ollama.com/api/chat');
  assert.equal(seen[0].init.headers.authorization, 'Bearer sk-cloud');
  assert.deepEqual(await listOllamaModels({ baseUrl: 'https://ollama.com', apiKey: 'sk-cloud', fetchImpl }), ['gpt-oss:120b']);
  assert.equal(seen[1].init.headers.authorization, 'Bearer sk-cloud');
});
