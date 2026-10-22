import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { safeOutput } from '../src/output.ts';
import { Agent } from '../src/agent.ts';
import { SlackSessions } from '../src/slack-session.ts';
import { initSlackConfig, loadSlackConfig, SlackBot } from '../src/slack.ts';
import type { SlackAgent, SlackConfig } from '../src/slack.ts';
import type { Message, Model, ToolDeclaration } from '../src/types.ts';

test('Slack config template is private and requires real tokens and allowed users', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glass-slack-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'private', 'slack.env');
  assert.equal(await initSlackConfig(file), file);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(initSlackConfig(file), /EEXIST/);
  await assert.rejects(loadSlackConfig(file), /set SLACK_APP_TOKEN/);
  const text = (await readFile(file, 'utf8'))
    .replace('xapp-REPLACE_ME', 'xapp-1-test')
    .replace('xoxb-REPLACE_ME', 'xoxb-1-test')
    .replace('U_REPLACE_ME', 'U123ABC');
  await writeFile(file, text);
  const config = await loadSlackConfig(file);
  assert.equal(config.appToken, 'xapp-1-test');
  assert.deepEqual([...config.allowedUsers], ['U123ABC']);
  await chmod(file, 0o644);
  await assert.rejects(loadSlackConfig(file), /0600/);
});

function envelope(eventId: string, event: Record<string, unknown>): string {
  return JSON.stringify({ type: 'events_api', envelope_id: `env-${eventId}`, payload: {
    type: 'event_callback', team_id: 'T123', event_id: eventId, event,
  } });
}

test('Slack bot acknowledges, filters users, deduplicates, and keeps DM and thread context separate', async () => {
  const config: SlackConfig = { appToken: 'xapp-1-test', botToken: 'xoxb-1-test',
    allowedUsers: new Set(['U123']), allowedChannels: new Set(['C123']) };
  const posted: Array<{ channel: string; text: string; thread_ts?: string }> = [];
  const runs: Array<{ conversation: string; prompt: string }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/auth.test')) return Response.json({ ok: true, user_id: 'U_BOT', team_id: 'T123' });
    assert.ok(String(url).endsWith('/chat.postMessage'));
    const body = JSON.parse(String(init?.body)) as { channel: string; text: string; thread_ts?: string };
    posted.push(body);
    return Response.json({ ok: true, ts: '2.0' });
  };
  const bot = new SlackBot(config, conversation => ({ run: async prompt => {
    runs.push({ conversation, prompt });
    return `answer ${runs.length}`;
  } }) satisfies SlackAgent, fetcher);
  await bot.initialize();
  const acks: string[] = [];
  const ack = (message: string): void => { acks.push(message); };
  const dm = { type: 'message', channel_type: 'im', channel: 'D123', user: 'U123', text: 'hello', ts: '1.0' };
  await bot.handleEnvelope(envelope('E1', dm), ack);
  await bot.handleEnvelope(envelope('E1', dm), ack);
  await bot.handleEnvelope(envelope('E2', { ...dm, user: 'UOTHER' }), ack);
  await bot.handleEnvelope(envelope('E3', { ...dm, user: 'U_BOT' }), ack);
  await bot.handleEnvelope(envelope('E4', { ...dm, subtype: 'bot_message' }), ack);
  await bot.handleEnvelope(envelope('E5', { type: 'app_mention', channel: 'C123', user: 'U123',
    text: '<@U_BOT> inspect code', ts: '5.0' }), ack);
  await bot.handleEnvelope(envelope('E6', { type: 'app_mention', channel: 'C123', user: 'U123',
    text: '<@U_BOT> follow up', ts: '6.0', thread_ts: '5.0' }), ack);
  await bot.handleEnvelope(envelope('E7', { type: 'app_mention', channel: 'COTHER', user: 'U123',
    text: '<@U_BOT> disallowed', ts: '7.0' }), ack);
  assert.equal(acks.length, 8);
  assert.deepEqual(runs, [
    { conversation: 'T123:D123', prompt: 'hello' },
    { conversation: 'T123:C123:5.0', prompt: 'inspect code' },
    { conversation: 'T123:C123:5.0', prompt: 'follow up' },
  ]);
  assert.deepEqual(posted.map(item => item.thread_ts), [undefined, '5.0', '5.0']);
  assert.equal(JSON.parse(acks[0]!).envelope_id, 'env-E1');
});

test('Slack bot serializes turns within one conversation', async () => {
  const config: SlackConfig = { appToken: 'xapp-1-test', botToken: 'xoxb-1-test',
    allowedUsers: new Set(['U123']), allowedChannels: new Set() };
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetcher: typeof fetch = async url => String(url).endsWith('/auth.test')
    ? Response.json({ ok: true, user_id: 'UBOT', team_id: 'T123' })
    : Response.json({ ok: true });
  const bot = new SlackBot(config, () => ({ run: async prompt => {
    order.push(`start ${prompt}`);
    if (prompt === 'first') await gate;
    order.push(`end ${prompt}`);
    return 'done';
  } }), fetcher);
  await bot.initialize();
  const first = bot.handleEnvelope(envelope('E10', { type: 'message', channel_type: 'im',
    channel: 'D123', user: 'U123', text: 'first', ts: '10.0' }), () => undefined);
  const second = bot.handleEnvelope(envelope('E11', { type: 'message', channel_type: 'im',
    channel: 'D123', user: 'U123', text: 'second', ts: '11.0' }), () => undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['start first']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['start first', 'end first', 'start second', 'end second']);
});

test('Slack replies omit the local workspace prefix', async () => {
  const root = '/Users/example/glass-agent';
  const config: SlackConfig = { appToken: 'xapp-1-test', botToken: 'xoxb-1-test',
    allowedUsers: new Set(['U123']), allowedChannels: new Set() };
  const posted: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/auth.test')) return Response.json({ ok: true, user_id: 'UBOT', team_id: 'T123' });
    posted.push((JSON.parse(String(init?.body)) as { text: string }).text);
    return Response.json({ ok: true });
  };
  const bot = new SlackBot(config, () => ({ run: async () => `read ${root}/src/agent.ts` }),
    fetcher, text => safeOutput(text, root));
  await bot.initialize();
  await bot.handleEnvelope(envelope('E12', { type: 'message', channel_type: 'im',
    channel: 'D123', user: 'U123', text: 'where?', ts: '12.0' }), () => undefined);
  assert.deepEqual(posted, ['read glass-agent/src/agent.ts']);
});

test('Slack DM resumes after restart, separates threads, and archives on !new', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glass-slack-resume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = await SlackSessions.create(root, 'fake-model');
  const requests: Message[][] = [];
  const model: Model = { model: 'fake-model', complete: async (messages: Message[], _tools: ToolDeclaration[]) => {
    requests.push(messages);
    return { message: { role: 'assistant', content: `reply ${requests.length}` } };
  } };
  const config: SlackConfig = { appToken: 'xapp-1-test', botToken: 'xoxb-1-test',
    allowedUsers: new Set(['U123']), allowedChannels: new Set() };
  const posted: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/auth.test')) return Response.json({ ok: true, user_id: 'UBOT', team_id: 'T123' });
    posted.push((JSON.parse(String(init?.body)) as { text: string }).text);
    return Response.json({ ok: true });
  };
  const createBot = (): SlackBot => new SlackBot(config,
    key => sessions.open(key, () => new Agent(model, [])), fetcher, text => text,
    key => sessions.reset(key));
  const first = createBot();
  await first.initialize();
  const dm = { type: 'message', channel_type: 'im', channel: 'D123', user: 'U123', ts: '1.0' };
  await first.handleEnvelope(envelope('E21', { ...dm, text: 'first' }), () => undefined);
  const file = sessions.fileFor('T123:D123');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).history.length, 2);

  const restarted = createBot();
  await restarted.initialize();
  await restarted.handleEnvelope(envelope('E22', { ...dm, text: 'follow up', ts: '2.0' }), () => undefined);
  assert.deepEqual(requests[1]!.filter(item => item.role === 'user').map(item => item.content), ['first', 'follow up']);
  await restarted.handleEnvelope(envelope('E23', { type: 'app_mention', channel: 'C123', user: 'U123',
    text: '<@UBOT> channel question', ts: '3.0' }), () => undefined);
  assert.deepEqual(requests[2]!.filter(item => item.role === 'user').map(item => item.content), ['channel question']);
  assert.notEqual(sessions.fileFor('T123:D123'), sessions.fileFor('T123:C123:3.0'));

  const again = createBot();
  await again.initialize();
  await again.handleEnvelope(envelope('E23b', { type: 'app_mention', channel: 'C123', user: 'U123',
    text: '<@UBOT> channel follow up', ts: '3.1', thread_ts: '3.0' }), () => undefined);
  assert.deepEqual(requests[3]!.filter(item => item.role === 'user').map(item => item.content),
    ['channel question', 'channel follow up']);

  await restarted.handleEnvelope(envelope('E24', { ...dm, text: '!new', ts: '4.0' }), () => undefined);
  assert.equal(posted.at(-1), '已开启新会话。');
  await assert.rejects(stat(file), /ENOENT/);
  assert.equal((await readdir(path.join(path.dirname(file), 'archive'))).length, 1);
  await restarted.handleEnvelope(envelope('E25', { ...dm, text: 'fresh', ts: '5.0' }), () => undefined);
  assert.deepEqual(requests[4]!.filter(item => item.role === 'user').map(item => item.content), ['fresh']);
});

test('Slack session snapshots redact known credentials', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glass-slack-secret-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = await SlackSessions.create(root, 'fake-model');
  const model: Model = { model: 'fake-model', complete: async () => ({
    message: { role: 'assistant', content: 'done' },
  }) };
  const agent = await sessions.open('T123:D123', () => new Agent(model, []));
  const fake = `ghp_${'A'.repeat(24)}`;
  await agent.run(`hello ${fake}`);
  const saved = await readFile(sessions.fileFor('T123:D123'), 'utf8');
  assert.ok(!saved.includes(fake));
  assert.match(saved, /\[REDACTED\]/);
});
