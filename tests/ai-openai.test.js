import test from 'node:test';
import assert from 'node:assert/strict';
import { toOpenAIRequest, createOpenAIAccumulator, openaiProvider, listOpenAIModels } from '../src/ai/providers/openai.js';
import { MAX_TOOL_INPUT, ProviderError } from '../src/ai/providers/errors.js';

const TOOLS = [{ name: 'get_board', description: 'd', input_schema: { type: 'object', properties: {} } }];
const SYSTEM = ['STABLE', 'PER'];

test('the request uses chat completions shapes: system message, function tools, streamed usage', () => {
  const body = toOpenAIRequest({ model: 'gpt-x', system: SYSTEM, tools: TOOLS, messages: [
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 'c1', name: 'get_board', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', id: 'c1', text: 'board', isError: false }, { type: 'tool_result', id: 'c2', text: 'x', isError: true }] },
  ] });
  assert.equal(body.model, 'gpt-x');
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.tool_choice, 'auto');
  assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'get_board', description: 'd', parameters: TOOLS[0].input_schema } }]);
  assert.deepEqual(body.messages[0], { role: 'system', content: 'STABLE\n\nPER' });
  assert.deepEqual(body.messages[1], { role: 'user', content: 'q' });
  assert.deepEqual(body.messages[2], { role: 'assistant', content: 'a', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_board', arguments: '{}' } }] });
  assert.deepEqual(body.messages[3], { role: 'tool', tool_call_id: 'c1', content: 'board' });
  assert.deepEqual(body.messages[4], { role: 'tool', tool_call_id: 'c2', content: 'x' });
});

test('the accumulator joins text and tool-call argument fragments and reads usage', () => {
  const chunks = [];
  const acc = createOpenAIAccumulator((t) => chunks.push(t));
  acc.push({ choices: [{ delta: { content: 'Hel' } }] });
  acc.push({ choices: [{ delta: { content: 'lo' } }] });
  acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'apply_edits', arguments: '{"ops":' } }] } }] });
  acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '[]}' } }] } }] });
  acc.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  acc.push({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 20 } } });
  acc.push('[DONE]');
  const r = acc.result();
  assert.equal(r.text, 'Hello');
  assert.deepEqual(chunks, ['Hel', 'lo']);
  assert.deepEqual(r.toolCalls, [{ id: 'call_1', name: 'apply_edits', input: { ops: [] } }]);
  assert.equal(r.stop, 'tool_use');
  assert.deepEqual(r.usage, { input: 30, output: 7, cacheRead: 20, cacheWrite: 0 });
  const a2 = createOpenAIAccumulator(() => {});
  a2.push({ choices: [{ delta: { content: 'x' }, finish_reason: 'length' }] });
  assert.equal(a2.result().stop, 'max_tokens');
});

test('a tool input past 256 KB fails the reply instead of being parsed', () => {
  const acc = createOpenAIAccumulator(() => {});
  acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'apply_edits', arguments: '{"ops":[' + '1,'.repeat(MAX_TOOL_INPUT / 2) } }] } }] });
  acc.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  assert.throws(() => acc.result(), (e) => e instanceof ProviderError && e.code === 'request' && /256 KB/.test(e.message));
});

function sse(objs) {
  const text = objs.map((o) => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`).join('');
  return new Response(new Blob([text]).stream(), { status: 200 });
}

test('the provider posts with a bearer token and lists models', async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, init });
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'gpt-b' }, { id: 'gpt-a' }] }), { status: 200 });
    return sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]']);
  };
  const p = openaiProvider({ baseUrl: 'https://api.openai.com/v1/', apiKey: 'sk-o', model: 'gpt-x', fetchImpl });
  const r = await p.chat({ system: SYSTEM, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: TOOLS });
  assert.equal(seen[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(seen[0].init.headers.authorization, 'Bearer sk-o');
  assert.equal(r.text, 'ok');
  assert.equal(r.stop, 'end');
  assert.deepEqual(await listOpenAIModels({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-o', fetchImpl }), ['gpt-a', 'gpt-b']);
});
