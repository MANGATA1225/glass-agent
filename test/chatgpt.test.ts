import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Agent } from '../src/agent.ts';
import { authorizationUrl, ChatGPTCredentials, parseCallback, verifyChatGPTIdentity } from '../src/chatgpt-auth.ts';
import type { LoginAttempt } from '../src/chatgpt-auth.ts';
import { ChatGPTModel, readResponseStream } from '../src/chatgpt-model.ts';
import { workspaceTools } from '../src/tools.ts';

const attempt: LoginAttempt = { redirectUri: 'http://127.0.0.1:1455/auth/callback',
  state: 'correct-state', nonce: 'nonce', verifier: 'verifier', clientId: 'dynamic_agent_client',
  isNewRegistration: true, expiresAt: Date.now() + 60_000 };

test('ChatGPT authorization uses PKCE and rejects changed callback values', () => {
  const url = new URL(authorizationUrl(attempt, 'urn:uuid:host'));
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update('verifier').digest('base64url'));
  assert.equal(url.searchParams.get('agent_name_hint'), 'glass-agent');
  assert.equal(parseCallback('http://127.0.0.1:1455/auth/callback?code=secret&state=correct-state&client_id=issued', attempt).clientId, 'issued');
  assert.throws(() => parseCallback('http://127.0.0.1:1456/auth/callback?code=secret&state=correct-state&client_id=issued', attempt), /address mismatch/);
  assert.throws(() => parseCallback('http://127.0.0.1:1455/auth/callback?code=secret&state=wrong&client_id=issued', attempt), /state mismatch/);
  assert.throws(() => parseCallback('http://127.0.0.1:1455/auth/callback?code=secret&state=correct-state', attempt), /issued client ID/);
  const returning = { ...attempt, clientId: 'issued', isNewRegistration: false };
  assert.equal(new URL(authorizationUrl(returning, 'urn:uuid:host')).searchParams.has('agent_name_hint'), false);
  assert.throws(() => parseCallback('http://127.0.0.1:1455/auth/callback?code=secret&state=correct-state&client_id=other', returning), /client ID mismatch/);
});

test('ChatGPT ID token requires a valid signature, audience, issuer and nonce', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  const good = await new SignJWT({ nonce: 'expected', email: 'test@example.test' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer('https://auth.openai.com')
    .setAudience('issued').setSubject('account-1').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async url => String(url).endsWith('/.well-known/openid-configuration')
    ? Response.json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/test-jwks' })
    : Response.json({ keys: [jwk] });
  try {
    assert.equal((await verifyChatGPTIdentity(good, 'issued', 'expected')).subject, 'account-1');
    await assert.rejects(verifyChatGPTIdentity(good, 'other', 'expected'));
    await assert.rejects(verifyChatGPTIdentity(good, 'issued', 'wrong'));
    const parts = good.split('.');
    parts[2] = `${parts[2]?.startsWith('A') ? 'B' : 'A'}${parts[2]?.slice(1)}`;
    const tampered = parts.join('.');
    await assert.rejects(verifyChatGPTIdentity(tampered, 'issued', 'expected'));
  } finally { globalThis.fetch = previousFetch; }
});

test('ChatGPT credentials stay private and refresh rotates once across concurrent callers', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'glass-chatgpt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'session.json');
  const forms: URLSearchParams[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const form = new URLSearchParams(String(init?.body));
    forms.push(form);
    if (form.get('grant_type') === 'authorization_code') {
      assert.equal(form.get('client_id'), 'issued');
      assert.equal(form.get('code_verifier'), 'verifier');
      assert.equal(form.get('redirect_uri'), attempt.redirectUri);
      return Response.json({ access_token: 'first', refresh_token: 'refresh-1', id_token: 'id-1',
        token_type: 'Bearer', scope: 'openid offline_access resource.invoke chatgpt.tokens.use.direct', expires_in: 1 });
    }
    assert.equal(form.get('refresh_token'), 'refresh-1');
    return Response.json({ access_token: 'second', refresh_token: 'refresh-2', token_type: 'Bearer', expires_in: 3600 });
  };
  const credentials = new ChatGPTCredentials(file, fetcher, async (_token, _client, nonce) => {
    assert.equal(nonce, 'nonce');
    return { subject: 'account-1', email: 'test@example.test' };
  });
  const first = await credentials.finishLogin(attempt,
    'http://127.0.0.1:1455/auth/callback?code=short-lived&state=correct-state&client_id=issued');
  assert.equal(first.ext_agent_host_id, await credentials.hostId());
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const values = await Promise.all([credentials.accessToken(), credentials.accessToken()]);
  assert.deepEqual(values, ['second', 'second']);
  assert.equal(forms.length, 2);
  const stored = JSON.parse(await readFile(file, 'utf8')) as { refresh_token: string };
  assert.equal(stored.refresh_token, 'refresh-2');
  assert.ok(!(await readFile(file, 'utf8')).includes('short-lived'));
});

test('ChatGPT stream requires response.completed and keeps tool calls together', async () => {
  const event = (type: string, value: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
  const output = [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
    { type: 'function_call', namespace: 'workspace', call_id: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' }];
  const seen: string[] = [];
  const result = await readResponseStream(new Response(event('response.output_text.delta', { delta: 'Hello' })
    + event('response.completed', { response: { status: 'completed', output } }) + 'data: [DONE]\n\n'), value => seen.push(value));
  assert.deepEqual(seen, ['Hello']);
  assert.equal(result.message.content, 'Hello');
  assert.equal(result.message.tool_calls?.[0]?.function.name, 'read_file');
  const withoutFinalOutput = await readResponseStream(new Response(
    event('response.output_text.delta', { output_index: 0, content_index: 0, delta: 'Visible answer' })
    + event('response.output_text.done', { output_index: 0, content_index: 0, text: 'Visible answer' })
    + event('response.output_item.done', { output_index: 0, item: { type: 'message',
      content: [{ type: 'output_text', text: 'Visible answer' }] } })
    + event('response.completed', { response: { status: 'completed', output: [] } })));
  assert.equal(withoutFinalOutput.message.content, 'Visible answer');
  const textFallback = await readResponseStream(new Response(
    event('response.output_text.delta', { delta: 'Delta answer' })
    + event('response.completed', { response: { status: 'completed', output: [] } })));
  assert.equal(textFallback.message.content, 'Delta answer');
  const toolFallback = await readResponseStream(new Response(
    event('response.output_item.done', { output_index: 0, item: {
      type: 'function_call', namespace: 'workspace', call_id: 'call-2',
      name: 'list_files', arguments: '{}' } })
    + event('response.completed', { response: { status: 'completed', output: [] } })));
  assert.equal(toolFallback.message.tool_calls?.[0]?.function.name, 'list_files');
  await assert.rejects(readResponseStream(new Response(event('response.output_text.delta', { delta: 'partial' }))), /without response.completed/);
  await assert.rejects(readResponseStream(new Response(event('response.failed', { response: {
    error: { code: 'subscription_sharing_usage_limit_exceeded' } } }))), /subscription_sharing_usage_limit_exceeded/);
});

test('ChatGPT model sends full read-only tool history through Responses', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'glass-chatgpt-model-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'a.txt'), 'file contents');
  const credentialFile = path.join(directory, 'session.json');
  await writeFile(credentialFile, JSON.stringify({ client_id: 'issued', ext_agent_host_id: 'urn:uuid:host',
    subject: 'account-1', access_token: 'token', refresh_token: 'refresh', id_token: 'id',
    scope: 'resource.invoke chatgpt.tokens.use.direct', expires_at: Date.now() + 60 * 60_000 }), { mode: 0o600 });
  const requests: Array<Record<string, unknown>> = [];
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/models')) return Response.json({ models: [{ slug: 'visible-model',
      display_name: 'Visible', visibility: 'list' }, { slug: 'hidden', visibility: 'hidden' }] });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    const output = requests.length === 1
      ? [{ type: 'function_call', namespace: 'workspace', call_id: 'call-1',
        name: 'read_file', arguments: '{"path":"a.txt"}' }]
      : [{ type: 'message', content: [{ type: 'output_text', text: 'The file says file contents.' }] }];
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`);
  };
  const model = new ChatGPTModel(new ChatGPTCredentials(credentialFile), 'visible-model', fetcher);
  assert.deepEqual(await model.listModels(), [{ slug: 'visible-model', display_name: 'Visible' }]);
  const agent = new Agent(model, await workspaceTools(directory));
  assert.equal(await agent.run('Read a.txt'), 'The file says file contents.');
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.store, false);
  assert.equal(requests[0]?.stream, true);
  assert.equal((requests[0]?.tools as Array<{ type: string }>)?.[0]?.type, 'namespace');
  const second = requests[1]?.input as Array<Record<string, unknown>>;
  assert.ok(second.some(item => item.type === 'function_call' && item.call_id === 'call-1'));
  assert.ok(second.some(item => item.type === 'function_call_output' && String(item.output).includes('file contents')));
  assert.ok(second.some(item => item.role === 'developer'));
});
