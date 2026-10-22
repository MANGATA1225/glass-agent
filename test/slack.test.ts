import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initSlackConfig, loadSlackConfig, SlackBot } from '../src/slack.ts';
import type { SlackAgent, SlackConfig } from '../src/slack.ts';

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
