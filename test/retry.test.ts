import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/agent.ts';
import { request } from '../src/models.ts';
import { withRetry } from '../src/retry.ts';
import { ModelError, RetryableModelError } from '../src/types.ts';
import type { Completion, Message, Model, ToolDeclaration } from '../src/types.ts';

test('transient HTTP failures honor Retry-After and stop after the retry budget', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return calls < 3
      ? new Response('', { status: 429, headers: { 'retry-after-ms': '12' } })
      : Response.json({ ok: true });
  };
  const delays: number[] = [];
  await withRetry(() => request(fetcher, 'https://example.test', {}, 1000), {
    maxRetries: 2, sleep: async ms => { delays.push(ms); },
  });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [12, 12]);

  calls = 0;
  await assert.rejects(withRetry(() => request(async () => {
    calls++;
    return new Response('', { status: 503 });
  }, 'https://example.test', {}, 1000), { maxRetries: 2, sleep: async () => {} }), /HTTP 503/);
  assert.equal(calls, 3);
});

test('permanent failures and explicit no-retry header fail immediately', async () => {
  for (const [status, headers] of [[401, {}], [503, { 'x-should-retry': 'false' }]] as const) {
    let calls = 0;
    await assert.rejects(withRetry(() => request(async () => {
      calls++;
      return new Response('', { status, headers });
    }, 'https://example.test', {}, 1000), { maxRetries: 2, sleep: async () => {} }), ModelError);
    assert.equal(calls, 1);
  }
});

test('network failures retry, but oversized server delays fail without waiting', async () => {
  let calls = 0;
  const result = await withRetry(() => request(async () => {
    if (++calls === 1) throw new TypeError('network failed');
    return Response.json({ ok: true });
  }, 'https://example.test', {}, 1000), { maxRetries: 1, random: () => 0, sleep: async ms => {
    assert.equal(ms, 375);
  } });
  assert.equal(result.status, 200);
  assert.equal(calls, 2);

  let slept = false;
  await assert.rejects(withRetry(async () => {
    throw new RetryableModelError('rate limited', 61000);
  }, { maxRetries: 1, sleep: async () => { slept = true; } }), /exceeds 60 seconds/);
  assert.equal(slept, false);
});

test('agent retries before committing a tool call and retains failed turn outside history', async () => {
  class FakeModel implements Model {
    model = 'fake';
    calls = 0;
    async complete(_messages: Message[], _tools: ToolDeclaration[]): Promise<Completion> {
      this.calls++;
      if (this.calls === 1) throw new RetryableModelError('HTTP 503');
      return { message: { role: 'assistant', content: 'done' } };
    }
  }
  const model = new FakeModel();
  const retries: number[] = [];
  const agent = new Agent(model, [], { onRetry: (_attempt, delay) => retries.push(delay) });
  assert.equal(await agent.run('hello'), 'done');
  assert.equal(model.calls, 2);
  assert.equal(retries.length, 1);
  assert.deepEqual(agent.history.map(item => item.role), ['user', 'assistant']);
});
