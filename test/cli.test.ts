import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from '../src/cli.ts';

test('CLI defaults to memory-only and saves only when requested', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glass-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'synthetic-key';
  let workspacePrompt = '';
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    workspacePrompt = body.messages.find(message => message.role === 'system')?.content ?? '';
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] });
  };
  try {
    assert.equal(await main(['--provider', 'openai', '--workspace', root, 'hello']), 0);
    assert.match(workspacePrompt, /current workspace root/);
    assert.ok(workspacePrompt.includes(root));
    assert.match(workspacePrompt, /list_files and read_file/);
    await assert.rejects(stat(path.join(root, '.glass-agent')), /ENOENT/);
    assert.equal(await main(['--provider', 'openai', '--workspace', root, '--save', 'hello']), 0);
    assert.equal((await readdir(path.join(root, '.glass-agent', 'sessions'))).length, 1);
    assert.equal(await main(['--provider', 'openai', '--workspace', root, '--continue', 'next']), 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('one-shot --stream prints deltas once and ends with a newline', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glass-stream-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  const previousWrite = process.stdout.write;
  const output: string[] = [];
  process.env.OPENAI_API_KEY = 'synthetic-key';
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { stream?: boolean };
    assert.equal(body.stream, true);
    return new Response('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n'
      + 'data: [DONE]\n\n');
  };
  process.stdout.write = ((chunk: string | Uint8Array) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    assert.equal(await main(['--provider', 'openai', '--workspace', root, '--stream', 'hello']), 0);
    assert.equal(output.join(''), 'hello\n');
  } finally {
    process.stdout.write = previousWrite;
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});
