import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { safeOutput, SafeOutputStream } from '../src/output.ts';
import { redactSecrets } from '../src/secrets.ts';
import { workspaceTools } from '../src/tools.ts';

const fakeToken = `ghp_${'A'.repeat(24)}`;

test('credential patterns are hidden in tool text and user-facing output', () => {
  const input = `token=${fakeToken}\nAuthorization: Bearer ${'B'.repeat(24)}\n${fakeToken}`;
  const result = redactSecrets(input);
  assert.ok(!result.includes(fakeToken));
  assert.ok(!result.includes('B'.repeat(24)));
  assert.match(result, /\[REDACTED\]/);
  assert.equal(safeOutput(`found ${fakeToken}`, '/Users/example/glass-agent'), 'found [REDACTED]');
  assert.equal(redactSecrets('-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----'),
    '[REDACTED PRIVATE KEY]');
});

test('read_file redacts credentials before pagination', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glass-secret-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'notes.txt'), `before\nAPI_KEY=${fakeToken}\nafter`);
  const read = (await workspaceTools(root)).find(tool => tool.name === 'read_file')!;
  const first = await read.execute({ path: 'notes.txt' });
  const second = await read.execute({ path: 'notes.txt', offset: 7 });
  assert.ok(!first.includes(fakeToken));
  assert.ok(!second.includes(fakeToken));
  assert.match(first, /API_KEY=\[REDACTED\]/);
});

test('streamed credential fragments are never emitted', () => {
  const chunks: string[] = [];
  const stream = new SafeOutputStream('/Users/example/glass-agent', text => chunks.push(text));
  for (const delta of ['key gh', 'p_', 'A'.repeat(24), ' done']) stream.write(delta);
  stream.finish();
  assert.equal(chunks.join(''), 'key [REDACTED] done');
  assert.ok(chunks.every(chunk => !chunk.includes('ghp_')));
});

test('streamed labeled credentials are held across fragments', () => {
  const chunks: string[] = [];
  const stream = new SafeOutputStream('/Users/example/glass-agent', text => chunks.push(text));
  for (const delta of ['config tok', 'en=', 'opaqueValue123', ' done']) stream.write(delta);
  stream.finish();
  assert.equal(chunks.join(''), 'config token=[REDACTED] done');
  assert.ok(chunks.every(chunk => !chunk.includes('opaqueValue123')));
});

test('ordinary words keep streaming normally', () => {
  const chunks: string[] = [];
  const stream = new SafeOutputStream('/Users/example/glass-agent', text => chunks.push(text));
  stream.write('glass');
  stream.finish();
  assert.equal(chunks.join(''), 'glass');
  const label: string[] = [];
  const another = new SafeOutputStream('/Users/example/glass-agent', text => label.push(text));
  another.write('token');
  another.finish();
  assert.equal(label.join(''), 'token');
});
