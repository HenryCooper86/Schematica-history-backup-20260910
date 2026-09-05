import test from 'node:test';
import assert from 'node:assert/strict';
import { sseParser, ndjsonParser, readStream } from '../src/ai/providers/stream.js';

test('sse events survive chunk boundaries, CRLF, comments, and multi-line data', () => {
  const got = [];
  const p = sseParser((e) => got.push(e));
  p.push('event: message_start\r\ndata: {"a":1}\r\n\r\n: keep-alive\n\nevent: content_block_delta\ndata: {"b":');
  p.push('2}\n\ndata: line one\ndata: line two\n\ndata: [DONE]');
  p.end();
  assert.deepEqual(got, [
    { event: 'message_start', data: { a: 1 } },
    { event: 'content_block_delta', data: { b: 2 } },
    { event: null, data: 'line one\nline two' },
    { event: null, data: '[DONE]' },
  ]);
});

test('ndjson lines survive chunk boundaries and skip blanks', () => {
  const got = [];
  const p = ndjsonParser((o) => got.push(o));
  p.push('{"x":1}\n{"x":');
  p.push('2}\n\n{"x":3}');
  p.end();
  assert.deepEqual(got, [{ x: 1 }, { x: 2 }, { x: 3 }]);
});

test('readStream drains a Response body into the parser', async () => {
  const body = new ReadableStream({
    start(c) {
      const enc = new TextEncoder();
      c.enqueue(enc.encode('data: {"n":1}\n\ndata: {"n"'));
      c.enqueue(enc.encode(':2}\n\n'));
      c.close();
    },
  });
  const got = [];
  await readStream(new Response(body), sseParser((e) => got.push(e.data.n)));
  assert.deepEqual(got, [1, 2]);
});
