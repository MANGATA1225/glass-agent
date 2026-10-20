import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Agent } from '../src/agent.ts';
import { SessionStore } from '../src/session.ts';
import { workspaceTools } from '../src/tools.ts';
import type { Completion, Message, Model, ToolDeclaration } from '../src/types.ts';

class SequenceModel implements Model {
  model = 'fake';
  sessionId?: string;
  private readonly responses: Completion[];
  requests: Array<{ messages: Message[]; tools: ToolDeclaration[] }> = [];
  constructor(responses: Completion[]) { this.responses = responses; }
  async complete(messages: Message[], tools: ToolDeclaration[]): Promise<Completion> {
    this.requests.push({ messages, tools });
    const response = this.responses.shift();
    if (!response) throw new Error('unexpected model call');
    return response;
  }
}

function response(content: string | null, tool_calls?: Completion['message']['tool_calls']): Completion {
  return { message: { role: 'assistant', content, ...(tool_calls ? { tool_calls } : {}) } };
}

test('only issued read tools run; unknown write calls have no effect', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glass-test-'));
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  await writeFile(path.join(root, 'notes.txt'), 'hello');
  const tools = await workspaceTools(root);
  const fakeWrite = { name: 'write_file', description: '', parameters: {}, execute: () => 'written' };
  assert.throws(() => new Agent(new SequenceModel([]), [fakeWrite]), /read-only/);
  const calls = [
    { id: 'c1', type: 'function' as const, function: { name: 'write_file', arguments: '{"path":"created.txt"}' } },
    { id: 'c2', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"notes.txt"}' } },
  ];
  const model = new SequenceModel([response(null, calls), response('done')]);
  assert.equal(await new Agent(model, tools).run('check files'), 'done');
  assert.match(model.requests[1]!.messages.at(-2)!.content!, /unknown tool/);
  assert.equal(model.requests[1]!.messages.at(-1)!.content, 'hello');
  await assert.rejects(lstat(path.join(root, 'created.txt')), /ENOENT/);
  await assert.rejects(Promise.resolve().then(() => tools[1]!.execute({ path: '.git/config' })), /visible/);
});

test('compaction preserves complete recent tool turn and raw transcript', async () => {
  const model = new SequenceModel([response('summary'), response('done')]);
  const agent = new Agent(model, [], { contextBudget: 1200 });
  agent.history = [
    { role: 'user', content: 'first' }, { role: 'assistant', content: 'A'.repeat(700) },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: 'c1', content: 'file result' },
    { role: 'assistant', content: 'found it' },
  ];
  assert.equal(await agent.run('third'), 'done');
  assert.deepEqual(model.requests[0]!.tools, []);
  assert.equal(model.requests[1]!.messages[2]!.content, 'second');
  assert.equal(model.requests[1]!.messages[4]!.tool_call_id, 'c1');
  assert.equal(agent.history.length, 8);
  assert.equal(agent.firstKeptIndex, 2);
});

test('failed compaction does not discard history and oversized input is rejected', async () => {
  const model = new SequenceModel([response('')]);
  const agent = new Agent(model, [], { contextBudget: 1000 });
  agent.history = [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'x'.repeat(800) }];
  await assert.rejects(agent.run('new'), /summarize/);
  assert.equal(agent.firstKeptIndex, 0);
  assert.equal(agent.history.length, 2);
  const empty = new Agent(new SequenceModel([]), [], { contextBudget: 1000 });
  await assert.rejects(empty.run('x'.repeat(1200)), /exceeds context budget/);
});

test('sessions are explicit, private, resumable, and compatible with previous JSON shape', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glass-session-'));
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const file = await SessionStore.newPath(root);
  const store = await SessionStore.create(file, root, 'qoder', 'fake');
  const first = new SequenceModel([]);
  first.sessionId = 'remote-id';
  const agent = new Agent(first, []);
  agent.history = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'world' }];
  agent.summary = 'prior';
  agent.firstKeptIndex = 2;
  await store.save(agent);
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  assert.equal(await SessionStore.latestPath(root), file);
  const state = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(state.first_kept_index, 2);
  assert.equal(state.remote_session_id, 'remote-id');
  assert.equal(state.personal_token, undefined);
  const second = new SequenceModel([]);
  second.sessionId = 'new-id';
  const restored = new Agent(second, []);
  await store.load(restored);
  assert.deepEqual(restored.history, agent.history);
  assert.equal(second.sessionId, 'remote-id');
  await assert.rejects((await SessionStore.create(file, root, 'openai', 'fake')).load(restored), /does not match/);
});
