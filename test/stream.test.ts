import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/agent.ts';
import { ChatCompletionsModel, readChatStream } from '../src/models.ts';
import { readQoderStream } from '../src/qoder.ts';
import { RetryableModelError } from '../src/types.ts';
import type { Completion, Message, Model, ToolDeclaration } from '../src/types.ts';

function sse(value: unknown): string { return `data: ${JSON.stringify(value)}\n\n`; }

test('OpenAI-compatible SSE joins split text and tool argument deltas', async () => {
  const payload = sse({ choices: [{ delta: { content: 'Hel' } }] })
    + sse({ choices: [{ delta: { content: 'lo' } }] })
    + sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1',
      function: { name: 'read_file', arguments: '{"path":' } }] } }] })
    + sse({ choices: [{ delta: { tool_calls: [{ index: 0,
      function: { arguments: '"a.txt"}' } }] }, finish_reason: 'tool_calls' }] })
    + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(payload);
  const response = new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } }));
  const deltas: string[] = [];
  const result = await readChatStream(response, delta => deltas.push(delta));
  assert.deepEqual(deltas, ['Hel', 'lo']);
  assert.equal(result.message.content, 'Hello');
  assert.equal(result.message.tool_calls?.[0]?.function.arguments, '{"path":"a.txt"}');
});

test('Chat Completions requests streaming only when text callback is provided', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    return body.stream ? new Response(sse({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })
      + 'data: [DONE]\n\n')
      : Response.json({ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] });
  };
  const model = new ChatCompletionsModel('synthetic-key', 'fake', 'https://example.test/v1', fetcher);
  const deltas: string[] = [];
  assert.equal((await model.complete([], [], delta => deltas.push(delta))).message.content, 'done');
  assert.equal((await model.complete([], [])).message.content, 'done');
  assert.deepEqual(deltas, ['done']);
  assert.equal(bodies[0]?.stream, true);
  assert.equal(bodies[1]?.stream, undefined);
});

test('Qoder exposes text deltas without waiting for the completed stream', async () => {
  const event = (text: string, finish?: string): string => `data: ${JSON.stringify({ statusCodeValue: 200,
    body: JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: finish }] }) })}\n\n`;
  const seen: string[] = [];
  const result = await readQoderStream(new Response(event('a') + event('b', 'stop')
    + 'data: [DONE]\n\n'), delta => seen.push(delta));
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(result.message.content, 'ab');
});

test('a visible partial stream is not retried or committed to conversation history', async () => {
  class PartialModel implements Model {
    model = 'fake';
    calls = 0;
    async complete(_messages: Message[], _tools: ToolDeclaration[], onText?: (delta: string) => void): Promise<Completion> {
      this.calls++;
      onText?.('partial');
      throw new RetryableModelError('connection lost');
    }
  }
  const model = new PartialModel();
  const seen: string[] = [];
  const agent = new Agent(model, [], { onText: delta => seen.push(delta) });
  await assert.rejects(agent.run('hello'), /stream failed after partial output/);
  assert.equal(model.calls, 1);
  assert.deepEqual(seen, ['partial']);
  assert.deepEqual(agent.history, []);
});
