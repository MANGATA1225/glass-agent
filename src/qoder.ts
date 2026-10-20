import { constants, createCipheriv, createHash, publicEncrypt, randomUUID } from 'node:crypto';
import { limitedText, request } from './models.ts';
import type { Fetcher } from './models.ts';
import { ModelError } from './types.ts';
import type { Completion, Message, Model, ToolCall, ToolDeclaration } from './types.ts';

const OPENAPI = 'https://openapi.qoder.sh';
export const OFFICIAL_ENDPOINTS = ['https://api2.qoder.sh', 'https://api3.qoder.sh'] as const;
const CHAT_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation';
const CHAT_QUERY = '?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1';
const COSY_VERSION = '1.1.68';
const ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STANDARD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

interface Credentials {
  token: string; uid: string; name: string; email: string; organization: string; expires: number;
}
export interface QoderCatalogModel {
  key: string; display_name?: string; enable: boolean; source?: string; [key: string]: unknown;
}

export function encodeBody(payload: Buffer): Buffer {
  const translated = payload.toString('base64').replace(/[A-Za-z0-9+/=]/g, char =>
    char === '=' ? '$' : ALPHABET[STANDARD.indexOf(char)]!);
  const third = Math.floor(translated.length / 3);
  return Buffer.from(translated.slice(-third) + translated.slice(third, -third || undefined) + translated.slice(0, third));
}

export class QoderModel implements Model {
  readonly model: string;
  sessionId = randomUUID();
  readonly machineId = randomUUID();
  private credentialsCache?: Credentials;
  private catalog: QoderCatalogModel[] = [];
  private catalogUntil = 0;
  private readonly baseUrl: string;
  private readonly pat: string;
  private readonly fetcher: Fetcher;
  private readonly timeoutMs: number;

  constructor(pat: string, model = '', baseUrl: string = OFFICIAL_ENDPOINTS[0],
              fetcher: Fetcher = fetch, timeoutMs = 60000) {
    if (!pat.trim()) throw new Error('QODER_PERSONAL_ACCESS_TOKEN is required');
    if (timeoutMs <= 0) throw new Error('timeout must be positive');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    if (!OFFICIAL_ENDPOINTS.includes(this.baseUrl as typeof OFFICIAL_ENDPOINTS[number])) {
      throw new Error('Qoder endpoint must be an official global endpoint');
    }
    this.model = model;
    this.pat = pat.trim();
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
  }

  private async jsonRequest(method: string, url: string, body?: Buffer, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const response = await request(this.fetcher, url, { method, headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? new Uint8Array(body) : undefined }, this.timeoutMs);
    let result: unknown;
    try { result = JSON.parse(await limitedText(response)); }
    catch { throw new ModelError('Qoder returned invalid JSON'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ModelError('Qoder returned an invalid object');
    return result as Record<string, unknown>;
  }

  private async credentials(): Promise<Credentials> {
    if (this.credentialsCache && this.credentialsCache.expires > Date.now() + 60000) return this.credentialsCache;
    const exchange = await this.jsonRequest('POST', `${OPENAPI}/api/v1/jobToken/exchange`,
      Buffer.from(JSON.stringify({ personal_token: this.pat })));
    const expires = typeof exchange.expires_at === 'string' ? Date.parse(exchange.expires_at) : NaN;
    if (typeof exchange.token !== 'string' || !exchange.token || !Number.isFinite(expires) || expires <= Date.now()) {
      throw new ModelError('Qoder returned invalid job-token credentials');
    }
    const user = await this.jsonRequest('GET', `${OPENAPI}/api/v1/userinfo`, undefined,
      { Authorization: `Bearer ${exchange.token}` });
    if (typeof user.id !== 'string' || !user.id) throw new ModelError('Qoder returned no account identity');
    this.credentialsCache = { token: exchange.token, uid: user.id,
      name: typeof user.name === 'string' ? user.name : '',
      email: typeof user.email === 'string' ? user.email : '',
      organization: typeof user.organization_id === 'string' ? user.organization_id : '', expires };
    return this.credentialsCache;
  }

  async listModels(): Promise<QoderCatalogModel[]> {
    const auth = await this.credentials();
    if (Date.now() >= this.catalogUntil) {
      const url = `${this.baseUrl}/algo/api/v2/model/list?Encode=1`;
      const catalog = await this.jsonRequest('GET', url, undefined, this.sign(url, Buffer.alloc(0), auth));
      if (!Array.isArray(catalog.assistant)) throw new ModelError('Qoder returned an invalid model catalog');
      this.catalog = catalog.assistant.filter((item): item is QoderCatalogModel =>
        !!item && typeof item === 'object' && item.enable === true && typeof item.key === 'string' && !!item.key);
      if (!this.catalog.length) throw new ModelError('Qoder returned no enabled assistant models');
      this.catalogUntil = Date.now() + 300000;
    }
    return structuredClone(this.catalog);
  }

  private sign(url: string, body: Buffer, auth: Credentials): Record<string, string> {
    const requestId = randomUUID();
    const key = Buffer.from(requestId.replaceAll('-', '').slice(0, 16));
    const identity = Buffer.from(JSON.stringify({ uid: auth.uid, security_oauth_token: auth.token,
      name: auth.name, email: auth.email, aid: '' }));
    const cipher = createCipheriv('aes-128-cbc', key, key);
    const encrypted = Buffer.concat([cipher.update(identity), cipher.final()]);
    const cosyKey = publicEncrypt({ key: PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING }, key).toString('base64');
    const payloadB64 = Buffer.from(JSON.stringify({ version: 'v1', requestId,
      info: encrypted.toString('base64'), cosyVersion: COSY_VERSION, ideVersion: '' })).toString('base64');
    const date = String(Math.floor(Date.now() / 1000));
    const path = new URL(url).pathname.replace(/^\/algo/, '');
    const digest = createHash('md5').update(Buffer.concat([
      Buffer.from(`${payloadB64}\n${cosyKey}\n${date}\n`), body, Buffer.from(`\n${path}`),
    ])).digest('hex');
    return { Authorization: `Bearer COSY.${payloadB64}.${digest}`, 'Cosy-Key': cosyKey,
      'Cosy-Date': date, 'Cosy-User': auth.uid, 'Cosy-Version': COSY_VERSION,
      'Cosy-Machineid': this.machineId, 'Cosy-Machinetoken': this.machineId,
      'Cosy-Machinetype': '5', 'Cosy-Clienttype': '5', 'Cosy-Data-Policy': 'disagree',
      'Login-Version': 'v2', 'Cosy-Scene': 'assistant', 'Cosy-Business-Product': 'cli',
      'Cosy-Business-Type': 'agent', ...(auth.organization ? { 'Cosy-Organization-Id': auth.organization } : {}) };
  }

  async complete(messages: Message[], tools: ToolDeclaration[]): Promise<Completion> {
    if (!this.model) throw new Error('Qoder model is required; list models first');
    const catalog = await this.listModels();
    const selected = catalog.find(item => this.model === item.key || this.model === item.display_name);
    if (!selected) throw new ModelError('selected model is not in the enabled Qoder account catalog');
    const auth = await this.credentials();
    const requestId = randomUUID();
    const replay = messages.map(item => {
      const copy = { ...item } as Record<string, unknown>;
      if (copy.content === null) delete copy.content;
      if (item.role === 'assistant' && item.tool_calls?.length && !copy.content) copy.content = ' ';
      return copy;
    });
    const body = Buffer.from(JSON.stringify({ request_id: requestId, request_set_id: requestId,
      chat_record_id: requestId, session_id: this.sessionId, stream: true, chat_task: 'FREE_INPUT',
      is_reply: true, is_retry: false, source: 1, version: '3', session_type: 'qodercli',
      agent_id: 'agent_common', task_id: 'common', system: '', messages: replay, tools,
      parameters: {}, model_config: selected, business: { product: 'cli', version: '1.0.0',
        type: 'agent', stage: 'start', id: requestId, name: 'glass-agent', begin_at: Date.now() } }));
    const encoded = encodeBody(body);
    const url = `${this.baseUrl}${CHAT_PATH}${CHAT_QUERY}`;
    const response = await request(this.fetcher, url, { method: 'POST', headers: {
      ...this.sign(url, encoded, auth), Accept: 'text/event-stream', 'Content-Type': 'application/json',
      'X-Model-Key': selected.key, 'X-Model-Source': selected.source ?? '',
    }, body: new Uint8Array(encoded) }, this.timeoutMs);
    return readQoderStream(response);
  }
}

export async function readQoderStream(response: Response): Promise<Completion> {
  if (!response.body) throw new ModelError('Qoder returned an empty stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '', content = '', finishReason: string | null = null, done = false, total = 0;
  const calls = new Map<number, ToolCall>();
  function line(raw: string): void {
    const text = raw.trim();
    if (text === 'event: error') throw new ModelError('Qoder stream returned an error');
    if (!text.startsWith('data:')) return;
    const data = text.slice(5).trim();
    if (data === '[DONE]') { done = true; return; }
    let envelope: Record<string, unknown>;
    try { envelope = JSON.parse(data) as Record<string, unknown>; }
    catch { throw new ModelError('Qoder returned an invalid stream event'); }
    if (envelope.statusCodeValue !== undefined && envelope.statusCodeValue !== 0 && envelope.statusCodeValue !== 200) {
      throw new ModelError('Qoder stream returned a gateway error');
    }
    let body = envelope.body;
    if (body === '[DONE]') { done = true; return; }
    try { if (typeof body === 'string') body = JSON.parse(body); }
    catch { throw new ModelError('Qoder returned an invalid stream event'); }
    if (!body || typeof body !== 'object') throw new ModelError('Qoder returned an invalid stream event');
    const event = body as Record<string, unknown>;
    if (event.error || event.code !== undefined && event.code !== 0 && event.code !== '0') {
      throw new ModelError('Qoder stream returned a model error');
    }
    const choice = (event.choices as Array<Record<string, unknown>> | undefined)?.[0];
    if (!choice) return;
    const delta = (choice.delta ?? {}) as Record<string, unknown>;
    if (typeof delta.content === 'string') content += delta.content;
    for (const part of (delta.tool_calls ?? []) as Array<Record<string, unknown>>) {
      const index = part.index;
      if (!Number.isInteger(index) || typeof index !== 'number' || index < 0 || index > 1023) {
        throw new ModelError('Qoder returned an invalid tool index');
      }
      const call = calls.get(index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
      if (typeof part.id === 'string' && part.id) {
        if (call.id && call.id !== part.id) throw new ModelError('Qoder changed an active tool call ID');
        call.id = part.id;
      }
      const func = (part.function ?? {}) as Record<string, unknown>;
      if (typeof func.name === 'string' && func.name) call.function.name = func.name;
      if (typeof func.arguments === 'string') call.function.arguments += func.arguments;
      calls.set(index, call);
    }
    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
  }
  try {
    while (!done) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > 8 * 1024 * 1024) throw new ModelError('Qoder stream is too large');
      pending += decoder.decode(next.value, { stream: true });
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        line(pending.slice(0, end));
        pending = pending.slice(end + 1);
        if (done) break;
      }
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  if (!done || !finishReason) throw new ModelError('Qoder stream ended before inference completed');
  const ordered = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => {
    let args: unknown;
    try { args = JSON.parse(call.function.arguments); }
    catch { throw new ModelError('Qoder returned incomplete tool arguments'); }
    if (!call.id || !call.function.name || !args || typeof args !== 'object' || Array.isArray(args)) {
      throw new ModelError('Qoder returned an incomplete tool call');
    }
    return call;
  });
  if (finishReason === 'tool_calls' && !ordered.length) throw new ModelError('Qoder indicated tool calls but returned none');
  if (!content.trim() && !ordered.length) throw new ModelError('Qoder returned an empty response');
  return { message: { role: 'assistant', content: content || null,
    ...(ordered.length ? { tool_calls: ordered } : {}) }, finishReason };
}
