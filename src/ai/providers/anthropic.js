// The Anthropic Messages API over fetch, streaming. Thinking is adaptive;
// the assistant's raw blocks (thinking with its signature, text, tool_use)
// are replayed verbatim on later turns, as the API requires.
import { sseParser, readStream } from './stream.js';
import { ProviderError, mapHttpError, networkError, MAX_TOOL_INPUT } from './errors.js';

const VERSION = '2023-06-01';
const MAX_TOKENS = 16000;
const STOP = { end_turn: 'end', tool_use: 'tool_use', max_tokens: 'max_tokens', refusal: 'refusal', stop_sequence: 'end' };

export function anthropicMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'assistant' && Array.isArray(m.raw) && m.raw.length) return { role: 'assistant', content: m.raw };
    const content = m.content.map((b) => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
      const r = { type: 'tool_result', tool_use_id: b.id, content: b.text };
      if (b.isError) r.is_error = true;
      return r;
    });
    return { role: m.role, content };
  });
}

export function toAnthropicRequest({ model, effort, system, messages, tools }) {
  const body = {
    model,
    max_tokens: MAX_TOKENS,
    stream: true,
    thinking: { type: 'adaptive' },
    output_config: { effort },
    system: [
      { type: 'text', text: system[0], cache_control: { type: 'ephemeral' } },
      { type: 'text', text: system[1] || '' },
    ],
    messages: anthropicMessages(messages),
  };
  if (tools.length) {
    body.tools = tools.map((t) => {
      const w = { name: t.name, description: t.description, input_schema: t.input_schema };
      if (t.strict) w.strict = true;
      return w;
    });
  }
  return body;
}

// Folds the event stream into blocks; result() gives the internal reply.
export function createAnthropicAccumulator(onText) {
  const blocks = [];
  const partial = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let stopReason = null;
  let failure = null;
  return {
    push({ event, data }) {
      const type = event || data?.type;
      if (type === 'message_start') {
        const u = data.message?.usage || {};
        usage.input = u.input_tokens || 0;
        usage.cacheRead = u.cache_read_input_tokens || 0;
        usage.cacheWrite = u.cache_creation_input_tokens || 0;
      } else if (type === 'content_block_start') {
        const b = { ...data.content_block };
        if (b.type === 'text') b.text = b.text || '';
        if (b.type === 'thinking') b.thinking = b.thinking || '';
        blocks[data.index] = b;
        partial[data.index] = '';
      } else if (type === 'content_block_delta') {
        const b = blocks[data.index];
        const d = data.delta || {};
        if (!b) return;
        if (d.type === 'text_delta') { b.text += d.text; onText?.(d.text); }
        else if (d.type === 'input_json_delta') {
          partial[data.index] += d.partial_json;
          if (partial[data.index].length > MAX_TOOL_INPUT) failure = failure || new ProviderError('A tool call input exceeded 256 KB; split the work into smaller batches.', { code: 'request' });
        }
        else if (d.type === 'thinking_delta') b.thinking += d.thinking;
        else if (d.type === 'signature_delta') b.signature = d.signature;
      } else if (type === 'content_block_stop') {
        const b = blocks[data.index];
        if (b?.type === 'tool_use' && !failure) {
          const json = partial[data.index];
          b.input = json.trim() ? JSON.parse(json) : (b.input || {});
        }
      } else if (type === 'message_delta') {
        stopReason = data.delta?.stop_reason || stopReason;
        usage.output = data.usage?.output_tokens ?? usage.output;
      } else if (type === 'error') {
        failure = new ProviderError(data.error?.message || 'stream error', { code: 'request' });
      }
    },
    result() {
      if (failure) throw failure;
      const raw = blocks.filter(Boolean);
      return {
        text: raw.filter((b) => b.type === 'text').map((b) => b.text).join(''),
        toolCalls: raw.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input })),
        usage,
        stop: STOP[stopReason] || 'end',
        raw,
      };
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function anthropicProvider({ baseUrl, apiKey, model, effort, fetchImpl = globalThis.fetch }) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/v1/messages`;
  async function post(body, signal) {
    try {
      return await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw networkError('Anthropic', err);
    }
  }
  return {
    async chat({ system, messages, tools, signal, onText }) {
      const body = toAnthropicRequest({ model, effort, system, messages, tools });
      let res = await post(body, signal);
      if (res.status === 429) {
        const header = res.headers.get('retry-after');
        const parsed = header === null ? NaN : Number(header);
        const after = Number.isFinite(parsed) ? Math.min(10, Math.max(0, parsed)) : 5;
        await sleep(after * 1000);
        res = await post(body, signal);
      }
      if (!res.ok) throw mapHttpError(res.status, await res.text(), 'Anthropic');
      const acc = createAnthropicAccumulator(onText);
      await readStream(res, sseParser((e) => acc.push(e)));
      return acc.result();
    },
  };
}
