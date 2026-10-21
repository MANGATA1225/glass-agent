import { ModelError, RetryableModelError } from './types.ts';
import type { Completion, Message, Model, ToolCall, ToolDeclaration } from './types.ts';

export type Fetcher = typeof fetch;

function retryAfterMs(headers: Headers): number | undefined {
  const milliseconds = headers.get('retry-after-ms');
  if (milliseconds !== null) {
    const value = Number(milliseconds);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  const header = headers.get('retry-after');
  if (header === null) return undefined;
  const seconds = Number(header);
  const value = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function transientNetworkError(error: unknown): boolean {
  return error instanceof TypeError || error instanceof Error && error.name === 'TimeoutError';
}

export async function request(fetcher: Fetcher, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    const response = await fetcher(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      const message = `model endpoint returned HTTP ${response.status}`;
      const override = response.headers.get('x-should-retry');
      if (override === 'true' || override !== 'false' &&
          ([408, 409, 429].includes(response.status) || response.status >= 500)) {
        throw new RetryableModelError(message, retryAfterMs(response.headers));
      }
      throw new ModelError(message);
    }
    return response;
  } catch (error) {
    if (error instanceof ModelError) throw error;
    if (transientNetworkError(error)) throw new RetryableModelError(`model request failed: ${(error as Error).name}`);
    throw new ModelError(`model request failed: ${error instanceof Error ? error.name : 'unknown error'}`);
  }
}

export async function limitedText(response: Response, limit = 8 * 1024 * 1024): Promise<string> {
  if (!response.body) throw new ModelError('model returned an empty response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new ModelError('model response is too large');
      chunks.push(value);
    }
  } catch (error) {
    if (transientNetworkError(error)) throw new RetryableModelError(`model response stream failed: ${(error as Error).name}`);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

export async function readChatStream(response: Response, onText?: (delta: string) => void): Promise<Completion> {
  if (!response.body) throw new RetryableModelError('model returned an empty stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const calls = new Map<number, ToolCall>();
  let pending = '', content = '', finishReason: string | null = null, done = false, total = 0;
  let dataLines: string[] = [], eventType = '';
  function event(): void {
    if (eventType === 'error') throw new ModelError('model stream returned an error');
    if (!dataLines.length) return;
    const data = dataLines.join('\n');
    dataLines = [];
    eventType = '';
    if (data === '[DONE]') { done = true; return; }
    let packet: { choices?: Array<{ delta?: { content?: unknown; tool_calls?: Array<{
      index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } }> }; finish_reason?: string | null }> };
    try { packet = JSON.parse(data) as typeof packet; }
    catch { throw new ModelError('model returned an invalid stream event'); }
    const choice = packet.choices?.[0];
    if (!choice) return;
    const delta = choice.delta;
    if (typeof delta?.content === 'string' && delta.content) {
      content += delta.content;
      onText?.(delta.content);
    }
    for (const part of delta?.tool_calls ?? []) {
      const index = part.index;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 1023) {
        throw new ModelError('model returned an invalid tool index');
      }
      const call = calls.get(index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
      if (typeof part.id === 'string') call.id = part.id;
      if (typeof part.function?.name === 'string') call.function.name = part.function.name;
      if (typeof part.function?.arguments === 'string') call.function.arguments += part.function.arguments;
      calls.set(index, call);
    }
    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
  }
  function line(raw: string): void {
    const value = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!value) { event(); return; }
    if (value.startsWith('data:')) dataLines.push(value.slice(5).trimStart());
    else if (value.startsWith('event:')) eventType = value.slice(6).trim();
  }
  try {
    while (!done) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > 8 * 1024 * 1024) throw new ModelError('model stream is too large');
      pending += decoder.decode(next.value, { stream: true });
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        line(pending.slice(0, end));
        pending = pending.slice(end + 1);
        if (done) break;
      }
    }
  } catch (error) {
    if (transientNetworkError(error)) throw new RetryableModelError(`model stream failed: ${(error as Error).name}`);
    throw error;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  if (!done || !finishReason) throw new RetryableModelError('model stream ended before inference completed');
  const ordered = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => {
    if (!call.id || !call.function.name) throw new ModelError('model returned an incomplete tool call');
    try {
      const args = JSON.parse(call.function.arguments);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error();
    } catch { throw new ModelError('model returned incomplete tool arguments'); }
    return call;
  });
  if (finishReason === 'tool_calls' && !ordered.length) throw new ModelError('model indicated tool calls but returned none');
  if (!content.trim() && !ordered.length) throw new RetryableModelError('model returned an empty response');
  return { message: { role: 'assistant', content: content || null,
    ...(ordered.length ? { tool_calls: ordered } : {}) }, finishReason };
}

export class ChatCompletionsModel implements Model {
  readonly model: string;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly fetcher: Fetcher;
  private readonly timeoutMs: number;
  constructor(apiKey: string, model = 'gpt-4.1-mini', baseUrl = 'https://api.openai.com/v1',
              fetcher: Fetcher = fetch, timeoutMs = 60000) {
    if (!apiKey) throw new Error('OPENAI_API_KEY is required');
    if (timeoutMs <= 0) throw new Error('timeout must be positive');
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:'
        && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) {
      throw new Error('base URL must use HTTPS (HTTP is allowed for localhost)');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('base URL must not contain credentials, query, or fragment');
    }
    this.model = model;
    this.url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    this.apiKey = apiKey;
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
  }

  async complete(messages: Message[], tools: ToolDeclaration[], onText?: (delta: string) => void): Promise<Completion> {
    const body = { model: this.model, messages, ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
      ...(onText ? { stream: true } : {}) };
    const response = await request(this.fetcher, this.url, { method: 'POST', headers: {
      Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify(body) }, this.timeoutMs);
    if (onText) return readChatStream(response, onText);
    const text = await limitedText(response);
    let data: unknown;
    try { data = JSON.parse(text); }
    catch { throw new ModelError('model API returned invalid JSON'); }
    const choice = (data as { choices?: Array<{ message?: Message; finish_reason?: string }> }).choices?.[0];
    if (!choice?.message || typeof choice.message !== 'object') throw new ModelError('model API returned an invalid response');
    return { message: choice.message, finishReason: choice.finish_reason };
  }
}
