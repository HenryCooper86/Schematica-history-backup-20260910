// Ollama's chat endpoint: newline-delimited JSON, tools as function
// definitions, tool-call arguments already parsed. No key. The browser must
// be an allowed origin (OLLAMA_ORIGINS); the settings help says so.
import { ndjsonParser, readStream } from './stream.js';
import { ProviderError, mapHttpError, networkError, MAX_TOOL_INPUT } from './errors.js';

const NUM_CTX = 16384;

export function toOllamaRequest({ model, system, messages, tools }) {
  const out = [{ role: 'system', content: system.filter(Boolean).join('\n\n') }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({ function: { name: b.name, arguments: b.input ?? {} } }));
      const msg = { role: 'assistant', content: text };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
      continue;
    }
    const results = m.content.filter((b) => b.type === 'tool_result');
    if (results.length) {
      for (const r of results) out.push({ role: 'tool', content: r.text });
      continue;
    }
    out.push({ role: 'user', content: m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') });
  }
  // Ollama's default context is 2k-4k tokens and it truncates silently: the
  // system prompt alone is about 3.5k, so ask for room.
  const body = { model, stream: true, messages: out, options: { num_ctx: NUM_CTX } };
  if (tools.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  }
  return body;
}

export function createOllamaAccumulator(onText) {
  let text = '';
  const toolCalls = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let reason = null;
  let failure = null;
  return {
    push(line) {
      const m = line.message || {};
      if (m.content) { text += m.content; onText?.(m.content); }
      for (const tc of m.tool_calls || []) {
        const size = JSON.stringify(tc.function?.arguments ?? {}).length;
        if (size > MAX_TOOL_INPUT) failure = failure || new ProviderError('A tool call input exceeded 256 KB; split the work into smaller batches.', { code: 'request' });
        toolCalls.push({ id: `call_${toolCalls.length}`, name: tc.function?.name, input: tc.function?.arguments ?? {} });
      }
      if (line.done) {
        reason = line.done_reason || 'stop';
        usage.input = line.prompt_eval_count || 0;
        usage.output = line.eval_count || 0;
      }
    },
    result() {
      if (failure) throw failure;
      let stop = reason === 'length' ? 'max_tokens' : 'end';
      if (toolCalls.length) stop = 'tool_use';
      return { text, toolCalls, usage, stop };
    },
  };
}

export function ollamaProvider({ baseUrl, model, fetchImpl = globalThis.fetch }) {
  const base = String(baseUrl).replace(/\/+$/, '');
  return {
    async chat({ system, messages, tools, signal, onText }) {
      let res;
      try {
        res = await fetchImpl(`${base}/api/chat`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal,
          body: JSON.stringify(toOllamaRequest({ model, system, messages, tools })),
        });
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        throw networkError('ollama', err);
      }
      if (!res.ok) throw mapHttpError(res.status, await res.text(), 'Ollama');
      const acc = createOllamaAccumulator(onText);
      await readStream(res, ndjsonParser((l) => acc.push(l)));
      return acc.result();
    },
  };
}

export async function listOllamaModels({ baseUrl, fetchImpl = globalThis.fetch }) {
  const base = String(baseUrl).replace(/\/+$/, '');
  let res;
  try { res = await fetchImpl(`${base}/api/tags`); } catch (err) { throw networkError('ollama', err); }
  if (!res.ok) throw mapHttpError(res.status, await res.text(), 'Ollama');
  const j = await res.json();
  return (j.models || []).map((m) => m.name).filter(Boolean).sort();
}
