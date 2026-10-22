import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_SLACK_CONFIG = path.join(os.homedir(), '.config', 'glass-agent', 'slack.env');

export interface SlackConfig {
  appToken: string;
  botToken: string;
  allowedUsers: Set<string>;
  allowedChannels: Set<string>;
}

export interface SlackAgent { run(prompt: string): Promise<string> }

const TEMPLATE = `# Keep this file outside the agent workspace and set permissions to 0600.
# Slack > Basic Information > App-Level Tokens (connections:write)
SLACK_APP_TOKEN=xapp-REPLACE_ME
# Slack > OAuth & Permissions > Bot User OAuth Token
SLACK_BOT_TOKEN=xoxb-REPLACE_ME
# Your Slack member ID (U... or W...), comma-separated for several users
SLACK_ALLOWED_USERS=U_REPLACE_ME
# Optional channel IDs (C... or G...). Leave empty to allow mentions in any joined channel.
SLACK_ALLOWED_CHANNELS=
`;

export async function initSlackConfig(file = DEFAULT_SLACK_CONFIG): Promise<string> {
  const target = path.resolve(file);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { await handle.writeFile(TEMPLATE); }
  finally { await handle.close(); }
  return target;
}

export async function loadSlackConfig(file = DEFAULT_SLACK_CONFIG): Promise<SlackConfig> {
  const target = path.resolve(file);
  const info = await lstat(target);
  if (!info.isFile() || (info.mode & 0o077) !== 0) {
    throw new Error(`Slack config must be an owner-only regular file (0600): ${target}`);
  }
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  let source: string;
  try {
    if ((await handle.stat()).size > 16 * 1024) throw new Error('Slack config is too large');
    source = await handle.readFile('utf8');
  } finally { await handle.close(); }
  const settings = new Map<string, string>();
  for (const line of source.split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry || entry.startsWith('#')) continue;
    const match = /^([A-Z_]+)=(.*)$/.exec(entry);
    if (!match) throw new Error('invalid Slack config line');
    if (settings.has(match[1]!)) throw new Error(`duplicate Slack config key: ${match[1]}`);
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    settings.set(match[1]!, value);
  }
  const appToken = settings.get('SLACK_APP_TOKEN') ?? '';
  const botToken = settings.get('SLACK_BOT_TOKEN') ?? '';
  if (!/^xapp-[A-Za-z0-9-]+$/.test(appToken) || appToken.includes('REPLACE') ||
      !/^xoxb-[A-Za-z0-9-]+$/.test(botToken) || botToken.includes('REPLACE')) {
    throw new Error(`set SLACK_APP_TOKEN and SLACK_BOT_TOKEN in ${target}`);
  }
  const values = (name: string): Set<string> => new Set((settings.get(name) ?? '').split(',').map(value => value.trim()).filter(Boolean));
  const allowedUsers = values('SLACK_ALLOWED_USERS');
  const allowedChannels = values('SLACK_ALLOWED_CHANNELS');
  if (!allowedUsers.size || [...allowedUsers].some(id => !/^[UW][A-Z0-9]+$/.test(id))) {
    throw new Error(`set your Slack member ID in SLACK_ALLOWED_USERS in ${target}`);
  }
  if ([...allowedChannels].some(id => !/^[CG][A-Z0-9]+$/.test(id))) {
    throw new Error('SLACK_ALLOWED_CHANNELS must contain channel IDs, not names');
  }
  return { appToken, botToken, allowedUsers, allowedChannels };
}

interface SlackEvent {
  type?: unknown;
  subtype?: unknown;
  channel_type?: unknown;
  channel?: unknown;
  user?: unknown;
  bot_id?: unknown;
  text?: unknown;
  ts?: unknown;
  thread_ts?: unknown;
}

interface SlackEnvelope {
  type?: unknown;
  envelope_id?: unknown;
  payload?: { type?: unknown; team_id?: unknown; event_id?: unknown; event?: SlackEvent };
}

class SlackApiError extends Error {
  readonly code: string;
  constructor(method: string, code: string) {
    super(`Slack ${method} failed: ${code}`);
    this.code = code;
  }
}

export class SlackBot {
  private readonly config: SlackConfig;
  private readonly makeAgent: (conversation: string) => SlackAgent;
  private readonly fetcher: typeof fetch;
  private readonly safe: (text: string) => string;
  private botUserId = '';
  private teamId = '';
  private readonly agents = new Map<string, SlackAgent>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly seen = new Map<string, number>();

  constructor(config: SlackConfig, makeAgent: (conversation: string) => SlackAgent,
              fetcher: typeof fetch = fetch, safe: (text: string) => string = text => text) {
    this.config = config;
    this.makeAgent = makeAgent;
    this.fetcher = fetcher;
    this.safe = safe;
  }

  private async api(method: 'auth.test' | 'apps.connections.open' | 'chat.postMessage',
                    token: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const response = await this.fetcher(`https://slack.com/api/${method}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new SlackApiError(method, `HTTP ${response.status}`);
    const data = await response.json() as Record<string, unknown>;
    if (data.ok !== true) {
      const code = typeof data.error === 'string' && /^[a-z0-9_]+$/i.test(data.error) ? data.error : 'unknown_error';
      throw new SlackApiError(method, code);
    }
    return data;
  }

  async initialize(): Promise<void> {
    const identity = await this.api('auth.test', this.config.botToken);
    if (typeof identity.user_id !== 'string' || typeof identity.team_id !== 'string') {
      throw new Error('Slack auth.test did not identify the bot user or workspace');
    }
    this.botUserId = identity.user_id;
    this.teamId = identity.team_id;
  }

  private async post(channel: string, text: string, threadTs?: string): Promise<void> {
    const answer = this.safe(text);
    if (!answer.trim()) return;
    for (let offset = 0; offset < answer.length; offset += 3500) {
      await this.api('chat.postMessage', this.config.botToken, {
        channel, text: answer.slice(offset, offset + 3500),
        ...(threadTs ? { thread_ts: threadTs } : {}), unfurl_links: false, unfurl_media: false,
      });
    }
  }

  async handleEnvelope(raw: string, acknowledge: (message: string) => void): Promise<void> {
    let envelope: SlackEnvelope;
    try { envelope = JSON.parse(raw) as SlackEnvelope; }
    catch { return; }
    if (typeof envelope.envelope_id === 'string') {
      acknowledge(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }
    if (envelope.type !== 'events_api' || envelope.payload?.type !== 'event_callback') return;
    const payload = envelope.payload;
    if (payload.team_id !== this.teamId || typeof payload.event_id !== 'string') return;
    const now = Date.now();
    for (const [id, time] of this.seen) if (now - time > 10 * 60_000) this.seen.delete(id);
    if (this.seen.has(payload.event_id)) return;
    this.seen.set(payload.event_id, now);
    const event = payload.event;
    if (!event || typeof event.channel !== 'string' || typeof event.user !== 'string' ||
        typeof event.text !== 'string' || typeof event.ts !== 'string' ||
        event.subtype || event.bot_id || event.user === this.botUserId ||
        !this.config.allowedUsers.has(event.user)) return;
    const dm = event.type === 'message' && event.channel_type === 'im';
    const mention = event.type === 'app_mention';
    if (!dm && !mention) return;
    if (mention && this.config.allowedChannels.size && !this.config.allowedChannels.has(event.channel)) return;
    const text = mention ? event.text.replace(new RegExp(`<@${this.botUserId}>`, 'g'), '').trim() : event.text.trim();
    if (!text) return;
    const rootTs = dm ? undefined : typeof event.thread_ts === 'string' ? event.thread_ts : event.ts;
    const key = dm ? `${this.teamId}:${event.channel}` : `${this.teamId}:${event.channel}:${rootTs}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const agent = this.agents.get(key) ?? this.makeAgent(key);
      this.agents.set(key, agent);
      try { await this.post(event.channel as string, await agent.run(text), rootTs); }
      catch (error) {
        process.stderr.write(`Slack turn failed: ${this.safe(error instanceof Error ? error.message : 'unknown error')}\n`);
        await this.post(event.channel as string, '处理失败，请查看 glass-agent 的终端日志。', rootTs);
      }
    });
    this.queues.set(key, current);
    try { await current; }
    finally { if (this.queues.get(key) === current) this.queues.delete(key); }
  }

  private async connectionUrl(): Promise<string> {
    const data = await this.api('apps.connections.open', this.config.appToken);
    if (typeof data.url !== 'string') throw new Error('Slack did not provide a Socket Mode URL');
    const url = new URL(data.url);
    if (url.protocol !== 'wss:' || !(url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com'))) {
      throw new Error('Slack returned an invalid Socket Mode URL');
    }
    return data.url;
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.initialize();
    process.stderr.write(`Slack bot authenticated as ${this.botUserId} in ${this.teamId}.\n`);
    let delay = 500;
    while (!signal.aborted) {
      try {
        const url = await this.connectionUrl();
        const socket = new WebSocket(url);
        await new Promise<void>((resolve, reject) => {
          const cleanup = (): void => {
            socket.removeEventListener('open', onOpen);
            socket.removeEventListener('error', onError);
            socket.removeEventListener('close', onClose);
            signal.removeEventListener('abort', onAbort);
          };
          const onOpen = (): void => { cleanup(); resolve(); };
          const onError = (): void => { cleanup(); reject(new Error('Slack WebSocket connection failed')); };
          const onClose = (): void => { cleanup(); reject(new Error('Slack WebSocket closed during connection')); };
          const onAbort = (): void => { cleanup(); socket.close(); resolve(); };
          socket.addEventListener('open', onOpen);
          socket.addEventListener('error', onError);
          socket.addEventListener('close', onClose);
          signal.addEventListener('abort', onAbort, { once: true });
        });
        if (signal.aborted) break;
        delay = 500;
        process.stderr.write('Slack Socket Mode ready; waiting for DMs and mentions.\n');
        await new Promise<void>(resolve => {
          socket.addEventListener('message', event => {
            const data = String(event.data);
            try {
              const frame = JSON.parse(data) as { type?: unknown };
              if (frame.type === 'disconnect') { socket.close(); return; }
            } catch { return; }
            void this.handleEnvelope(data, ack => socket.send(ack)).catch(error => {
              process.stderr.write(`Slack event failed: ${this.safe(error instanceof Error ? error.message : 'unknown error')}\n`);
            });
          });
          const onClose = (): void => { signal.removeEventListener('abort', onAbort); resolve(); };
          const onAbort = (): void => {
            socket.removeEventListener('close', onClose);
            socket.close();
            resolve();
          };
          socket.addEventListener('close', onClose, { once: true });
          signal.addEventListener('abort', onAbort, { once: true });
        });
      } catch (error) {
        if (error instanceof SlackApiError && ['invalid_auth', 'not_authed', 'missing_scope', 'token_revoked'].includes(error.code)) throw error;
        if (!signal.aborted) process.stderr.write(`Slack reconnecting: ${this.safe(error instanceof Error ? error.message : 'unknown error')}\n`);
      }
      if (signal.aborted) break;
      await new Promise<void>(resolve => {
        const onAbort = (): void => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, delay);
        signal.addEventListener('abort', onAbort, { once: true });
      });
      delay = Math.min(delay * 2, 30_000);
    }
  }
}
