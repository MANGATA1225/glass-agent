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

test('a second question can read source after a file listing without overflowing the active turn', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glass-context-'));
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const source = 'export const architecture = ' + 'x'.repeat(1700);
  await writeFile(path.join(root, 'agent.ts'), source);
  class InspectModel implements Model {
    model = 'fake';
    requests: Array<{ messages: Message[]; tools: ToolDeclaration[] }> = [];
    summaries = 0;
    activeSummaries = 0;
    async complete(messages: Message[], tools: ToolDeclaration[]): Promise<Completion> {
      this.requests.push({ messages, tools });
      if (!tools.length) {
        this.summaries++;
        if (messages[0]!.content!.includes('current user question')) {
          this.activeSummaries++;
          return response('Source defines the agent architecture.');
        }
        return response('The workspace contains agent.ts.');
      }
      const latestUserIndex = messages.findLastIndex(item => item.role === 'user');
      const latestUser = messages[latestUserIndex]?.content;
      const current = messages.slice(latestUserIndex + 1);
      if (latestUser === 'Which files can you see?') {
        return current.some(item => item.role === 'tool') ? response('I can see agent.ts.')
          : response(null, [{ id: 'list', type: 'function', function: { name: 'list_files', arguments: '{}' } }]);
      }
      return current.some(item => item.role === 'tool') ||
        messages.some(item => item.content?.includes('Source defines the agent architecture.'))
        ? response('The agent uses a model and read-only tools.')
        : response(null, [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"agent.ts"}' } }]);
    }
  }
  const model = new InspectModel();
  const agent = new Agent(model, await workspaceTools(root), { contextBudget: 2300 });
  assert.equal(await agent.run('Which files can you see?'), 'I can see agent.ts.');
  assert.equal(await agent.run('What is the architecture?'), 'The agent uses a model and read-only tools.');
  assert.ok(model.summaries >= 1);
  assert.equal(model.activeSummaries, 1);
  assert.equal(agent.history.filter(item => item.role === 'tool' && item.content === source).length, 1);
});

test('read_file supports offsets so omitted content remains accessible', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glass-pages-'));
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const source = 'abcdef'.repeat(1800);
  await writeFile(path.join(root, 'large.txt'), source);
  const read = (await workspaceTools(root)).find(tool => tool.name === 'read_file')!;
  const first = await read.execute({ path: 'large.txt' });
  assert.match(first, /continue with offset 6000/);
  const second = await read.execute({ path: 'large.txt', offset: 6000 });
  assert.equal(first.slice(0, 6000) + second.slice(0, source.length - 6000), source);
  await assert.rejects(Promise.resolve().then(() => read.execute({ path: 'large.txt', offset: -1 })), /offset/);
});

test('older tool results are pruned only in model context, while recent results and raw history remain', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glass-prune-'));
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const source = 'x'.repeat(2200);
  await writeFile(path.join(root, 'source.txt'), source);
  class ReadModel implements Model {
    model = 'fake';
    calls = 0;
    finalContext: Message[] = [];
    async complete(messages: Message[], tools: ToolDeclaration[]): Promise<Completion> {
      assert.ok(tools.length);
      this.calls++;
      if (this.calls <= 3) return response(null, [{ id: `c${this.calls}`, type: 'function',
        function: { name: 'read_file', arguments: '{"path":"source.txt"}' } }]);
      this.finalContext = messages;
      return response('done');
    }
  }
  const model = new ReadModel();
  const agent = new Agent(model, await workspaceTools(root), { contextBudget: 8000 });
  assert.equal(await agent.run('inspect'), 'done');
  const projected = model.finalContext.filter(item => item.role === 'tool');
  assert.equal(projected.length, 3);
  assert.match(projected[0]!.content!, /removed from model context/);
  assert.equal(projected[1]!.content, source);
  assert.equal(projected[2]!.content, source);
  assert.equal(agent.history.filter(item => item.role === 'tool' && item.content === source).length, 3);
});

test('a batch of file reads shares an output budget and exposes continuation offsets', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glass-batch-'));
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  await writeFile(path.join(root, 'large.txt'), 'x'.repeat(10000));
  class BatchModel implements Model {
    model = 'fake';
    calls = 0;
    results: Message[] = [];
    async complete(messages: Message[], _tools: ToolDeclaration[]): Promise<Completion> {
      if (this.calls++ === 0) return response(null, Array.from({ length: 6 }, (_, index) => ({
        id: `c${index}`, type: 'function' as const,
        function: { name: 'read_file', arguments: '{"path":"large.txt"}' },
      })));
      this.results = messages.filter(item => item.role === 'tool');
      return response('done');
    }
  }
  const model = new BatchModel();
  assert.equal(await new Agent(model, await workspaceTools(root)).run('read files'), 'done');
  assert.equal(model.results.length, 6);
  for (const result of model.results) {
    assert.ok(result.content!.length <= 4000);
    assert.match(result.content!, /continue with offset/);
  }
});

test('long history is summarized in bounded chunks while preserving recent turns', async () => {
  class CompactModel implements Model {
    model = 'fake';
    summaries = 0;
    finalMessages: Message[] = [];
    async complete(messages: Message[], _tools: ToolDeclaration[]): Promise<Completion> {
      if (messages[0]?.content?.startsWith('Summarize this prior conversation')) {
        this.summaries++;
        return response(`checkpoint ${this.summaries}`);
      }
      this.finalMessages = messages;
      return response('done');
    }
  }
  const model = new CompactModel();
  const agent = new Agent(model, [], { contextBudget: 2000 });
  agent.history = Array.from({ length: 10 }, (_, index): Message[] => [
    { role: 'user', content: `question ${index}` },
    { role: 'assistant', content: `answer ${index}: ${'x'.repeat(550)}` },
  ]).flat();
  assert.equal(await agent.run('new question'), 'done');
  assert.ok(model.summaries > 1);
  assert.match(agent.summary, /checkpoint/);
  assert.ok(model.finalMessages.some(item => item.content?.includes('question 9')));
  assert.equal(agent.history.length, 22);
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
