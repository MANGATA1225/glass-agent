import { ModelError } from './types.ts';
import type { Completion, Message, Model, ToolDeclaration } from './types.ts';

export type Fetcher = typeof fetch;

export async function request(fetcher: Fetcher, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    const response = await fetcher(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new ModelError(`model endpoint returned HTTP ${response.status}`);
    return response;
  } catch (error) {
    if (error instanceof ModelError) throw error;
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
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
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

  async complete(messages: Message[], tools: ToolDeclaration[]): Promise<Completion> {
    const body = { model: this.model, messages, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) };
    const response = await request(this.fetcher, this.url, { method: 'POST', headers: {
      Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify(body) }, this.timeoutMs);
    let data: unknown;
    try { data = JSON.parse(await limitedText(response)); }
    catch { throw new ModelError('model API returned invalid JSON'); }
    const choice = (data as { choices?: Array<{ message?: Message; finish_reason?: string }> }).choices?.[0];
    if (!choice?.message || typeof choice.message !== 'object') throw new ModelError('model API returned an invalid response');
    return { message: choice.message, finishReason: choice.finish_reason };
  }
}
