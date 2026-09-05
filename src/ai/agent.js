// One user message, start to finish: call the provider, run the tool calls
// it makes, feed the results back, repeat until it stops or the round cap
// hits. Everything applied in reply to the message is one store batch, so
// one undo step. Providers speak the internal message format documented in
// the spec; adapters translate to the wire.
import { TOOLS, statusLine } from './tools.js';

export const MAX_ROUNDS = 8;

function addUsage(total, u = {}) {
  total.input += u.input || 0;
  total.output += u.output || 0;
  total.cacheRead += u.cacheRead || 0;
  total.cacheWrite += u.cacheWrite || 0;
}

export async function runRequest({
  provider, executor, system, history = [], userText, boardText,
  store = null, signal = null, onText = null, onStatus = null, maxRounds = MAX_ROUNDS,
}) {
  const messages = [
    ...history,
    { role: 'user', content: [{ type: 'text', text: `${userText}\n\n---\n${boardText}` }] },
  ];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let text = '';
  let stop = 'end';
  let cutOff = false;
  let applied = 0;
  let rounds = 0;
  let error;
  executor.resetTouched();
  store?.beginBatch();
  try {
    for (let round = 0; round < maxRounds; round++) {
      rounds = round + 1;
      const res = await provider.chat({ system, messages, tools: TOOLS, signal, onText });
      addUsage(usage, res.usage);
      const content = [];
      if (res.text) {
        content.push({ type: 'text', text: res.text });
        text += (text ? '\n\n' : '') + res.text;
      }
      const calls = res.toolCalls || [];
      for (const tc of calls) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      messages.push({ role: 'assistant', content, raw: res.raw });
      stop = res.stop;
      if (stop === 'aborted' || stop === 'max_tokens') cutOff = true;
      if (!calls.length) break;
      // Every tool_use gets a tool_result, or the history is unusable for the
      // next request: calls the model made before being cut off are answered
      // with an error instead of being run, and a tool that throws (a bug in
      // our own code) is answered with an error and then reported.
      const results = [];
      let failure = null;
      for (const tc of calls) {
        if (stop !== 'tool_use') {
          results.push({ type: 'tool_result', id: tc.id, text: `Not run: the reply stopped before this call completed (${stop}).`, isError: true });
          continue;
        }
        let r;
        try {
          onStatus?.(statusLine(tc.name, tc.input));
          r = executor.run(tc.name, tc.input);
        } catch (err) {
          failure = failure || err;
          r = { text: `Tool ${tc.name} failed: ${err?.message || err}`, isError: true };
        }
        if (tc.name === 'apply_edits' && !r.isError) applied += 1;
        results.push({ type: 'tool_result', id: tc.id, text: r.text, isError: !!r.isError });
      }
      messages.push({ role: 'user', content: results });
      if (failure) throw failure;
      if (stop !== 'tool_use') break;
      if (round === maxRounds - 1) { cutOff = true; stop = 'rounds'; }
    }
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) {
      stop = 'aborted';
      cutOff = true;
    } else {
      error = err;
    }
  } finally {
    store?.endBatch();
  }
  return { text, messages, touched: new Set(executor.touched), usage, stop, rounds, applied, cutOff, error };
}
