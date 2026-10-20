import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Agent } from '../src/agent.ts';
import { QoderModel, readQoderStream } from '../src/qoder.ts';
import { workspaceTools } from '../src/tools.ts';

const alphabet = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeBody(bytes: Uint8Array): Record<string, unknown> {
  const encoded = Buffer.from(bytes).toString('ascii');
  const third = Math.floor(encoded.length / 3);
  const rotated = encoded.slice(-third) + encoded.slice(third, -third) + encoded.slice(0, third);
  const base64 = rotated.replace(/./g, char => char === '$' ? '=' : standard[alphabet.indexOf(char)]!);
  return JSON.parse(Buffer.from(base64, 'base64').toString('utf8')) as Record<string, unknown>;
}

function event(body: string): string {
  return `data: ${JSON.stringify({ statusCodeValue: 200, body })}\n\n`;
}

test('Qoder native auth, signature, catalog and tool round trip', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glass-qoder-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'notes.txt'), 'hello');
  const seen: string[] = [];
  const chats: Array<Record<string, unknown>> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    seen.push(url.pathname);
    const headers = new Headers(init?.headers);
    const body = init?.body ? new Uint8Array(init.body as Uint8Array) : new Uint8Array();
    assert.ok(!JSON.stringify([...headers]).includes('synthetic-pat'));
    if (url.pathname === '/api/v1/jobToken/exchange') {
      assert.deepEqual(JSON.parse(Buffer.from(body).toString()), { personal_token: 'synthetic-pat' });
      return Response.json({ token: 'synthetic-job', expires_at: new Date(Date.now() + 3600000).toISOString() });
    }
    if (url.pathname === '/api/v1/userinfo') {
      assert.equal(headers.get('authorization'), 'Bearer synthetic-job');
      return Response.json({ id: 'synthetic-user', organization_id: 'synthetic-org' });
    }
    const authorization = headers.get('authorization')!;
    assert.match(authorization, /^Bearer COSY\./);
    const [payload, digest] = authorization.slice('Bearer COSY.'.length).split('.');
    const signed = Buffer.concat([Buffer.from(`${payload}\n${headers.get('cosy-key')}\n${headers.get('cosy-date')}\n`),
      Buffer.from(body), Buffer.from(`\n${url.pathname.replace(/^\/algo/, '')}`)]);
    assert.equal(createHash('md5').update(signed).digest('hex'), digest);
    if (url.pathname === '/algo/api/v2/model/list') {
      return Response.json({ assistant: [{ key: 'live-key', display_name: 'Live Model', enable: true, source: 'system' }] });
    }
    assert.equal(url.pathname, '/algo/api/v2/service/pro/sse/agent_chat_generation');
    const decoded = decodeBody(body);
    chats.push(decoded);
    const chunk = chats.length === 1
      ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1',
        function: { name: 'read_file', arguments: '{"path":"notes.txt"}' } }] }, finish_reason: 'tool_calls' }] }
      : { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] };
    if (chats.length === 2) {
      const messages = decoded.messages as Array<Record<string, unknown>>;
      assert.equal(messages.at(-1)?.content, 'hello');
      assert.equal(messages.at(-1)?.tool_call_id, 'call-1');
    }
    return new Response(event(JSON.stringify(chunk)) + event('[DONE]'),
      { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const model = new QoderModel('synthetic-pat', 'Live Model', undefined, fetcher);
  assert.equal(await new Agent(model, await workspaceTools(root)).run('read notes'), 'done');
  assert.equal(chats.length, 2);
  assert.equal(chats[0]!.session_id, chats[1]!.session_id);
  assert.notEqual(chats[0]!.request_id, chats[1]!.request_id);
  assert.equal(seen.filter(item => item === '/api/v1/jobToken/exchange').length, 1);
  assert.equal(seen.filter(item => item === '/algo/api/v2/model/list').length, 1);
});

test('Qoder incomplete stream fails and unofficial endpoint is rejected', async () => {
  await assert.rejects(readQoderStream(new Response(event(JSON.stringify({ choices: [
    { delta: { content: 'partial' } },
  ] })))), /before inference completed/);
  assert.throws(() => new QoderModel('synthetic-pat', 'model', 'https://example.test'), /official/);
});
