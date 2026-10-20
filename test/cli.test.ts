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
  globalThis.fetch = async () => Response.json({ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] });
  try {
    assert.equal(await main(['--workspace', root, 'hello']), 0);
    await assert.rejects(stat(path.join(root, '.glass-agent')), /ENOENT/);
    assert.equal(await main(['--workspace', root, '--save', 'hello']), 0);
    assert.equal((await readdir(path.join(root, '.glass-agent', 'sessions'))).length, 1);
    assert.equal(await main(['--workspace', root, '--continue', 'next']), 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});
