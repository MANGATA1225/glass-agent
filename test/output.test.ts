import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { safeOutput, SafeOutputStream } from '../src/output.ts';

test('local output keeps the workspace name and hides its parent directories', () => {
  const root = '/Users/example/glass-agent';
  assert.equal(safeOutput(`open ${root}/src/cli.ts`, root), 'open glass-agent/src/cli.ts');
  assert.equal(safeOutput('cache /private/tmp/secret.txt', root), 'cache [local path]');
  assert.equal(safeOutput(`open ${path.resolve(process.env.HOME ?? '/', '.config', 'glass-agent')}`, root)
    .includes('/Users/'), false);
});

test('streamed paths stay private when split across deltas', () => {
  const root = '/Users/example/glass-agent';
  const chunks: string[] = [];
  const stream = new SafeOutputStream(root, text => chunks.push(text));
  for (const delta of ['see /Us', 'ers/example/gla', 'ss-agent/src', '/cli.ts now']) stream.write(delta);
  stream.finish();
  assert.equal(chunks.join(''), 'see glass-agent/src/cli.ts now');
  assert.ok(chunks.every(chunk => !chunk.includes('/Users/')));
});

test('unfinished streamed path is withheld', () => {
  const chunks: string[] = [];
  const stream = new SafeOutputStream('/Users/example/glass-agent', text => chunks.push(text));
  stream.write('see /Users/exam');
  stream.finish();
  assert.equal(chunks.join(''), 'see [local path]');
});

test('streamed paths outside the workspace are replaced before output', () => {
  const chunks: string[] = [];
  const stream = new SafeOutputStream('/Users/example/glass-agent', text => chunks.push(text));
  for (const delta of ['cache /pri', 'vate/tmp/secret.txt', ' exists']) stream.write(delta);
  stream.finish();
  assert.equal(chunks.join(''), 'cache [local path] exists');
  assert.ok(chunks.every(chunk => !chunk.includes('/private/')));
});
