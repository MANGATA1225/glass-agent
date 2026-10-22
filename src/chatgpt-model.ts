import { ChatGPTCredentials, CHATGPT_RESOURCE } from './chatgpt-auth.ts';
import { limitedText, request, transientNetworkError } from './models.ts';
import { ModelError, RetryableModelError } from './types.ts';
import type { Completion, Message, Model, ToolCall, ToolDeclaration } from './types.ts';

export interface ChatGPTModelEntry { slug: string; display_name: string }

function responseInput(messages: Message[]): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!message.tool_call_id) throw new ModelError('tool result is missing its call ID');
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content ?? '' });
    } else {
      if (message.content) input.push({ role: message.role === 'system' ? 'developer' : message.role,
        content: message.content });
      for (const call of message.tool_calls ?? []) {
        input.push({ type: 'function_call', call_id: call.id, namespace: 'workspace',
          name: call.function.name, arguments: call.function.arguments });
      }
    }
  }
  return input;
}

function responseTools(tools: ToolDeclaration[]): Record<string, unknown>[] {
  if (!tools.length) return [];
  return [{ type: 'namespace', name: 'workspace', description: 'Read-only workspace files',
    tools: tools.map(tool => ({ type: 'function', name: tool.function.name,
      description: tool.function.description, parameters: tool.function.parameters, strict: false })) }];
}

function completedResponse(response: unknown, streamedItems: Map<number, unknown>, streamedText: string): Completion {
  if (!response || typeof response !== 'object') throw new ModelError('invalid ChatGPT completed response');
  const data = response as { status?: unknown; output?: unknown };
  if (data.status !== 'completed') {
    throw new ModelError('ChatGPT response did not complete');
  }
  const outputItems = Array.isArray(data.output) && data.output.length
    ? data.output : [...streamedItems.entries()].sort(([left], [right]) => left - right).map(([, item]) => item);
  let content = '';
  const calls: ToolCall[] = [];
  for (const item of outputItems) {
    if (!item || typeof item !== 'object') continue;
    const output = item as Record<string, unknown>;
    if (output.type === 'message' && Array.isArray(output.content)) {
      for (const part of output.content) {
        if (part && typeof part === 'object' && (part as Record<string, unknown>).type === 'output_text' &&
            typeof (part as Record<string, unknown>).text === 'string') {
          content += (part as { text: string }).text;
        }
      }
    } else if (output.type === 'function_call') {
      const callId = output.call_id, name = output.name, args = output.arguments;
      if (output.namespace !== undefined && output.namespace !== 'workspace') {
        throw new ModelError('ChatGPT returned an unknown tool namespace');
      }
      if (typeof callId !== 'string' || !callId || typeof name !== 'string' || !name ||
          typeof args !== 'string') throw new ModelError('ChatGPT returned an incomplete tool call');
      let parsed: unknown;
      try { parsed = JSON.parse(args); } catch { throw new ModelError('ChatGPT returned invalid tool arguments'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ModelError('ChatGPT returned invalid tool arguments');
      }
      calls.push({ id: callId, type: 'function', function: { name, arguments: args } });
    }
  }
  if (!content && streamedText) content = streamedText;
  if (!content.trim() && !calls.length) throw new RetryableModelError('ChatGPT returned an empty response');
  return { message: { role: 'assistant', content: content || null,
    ...(calls.length ? { tool_calls: calls } : {}) }, finishReason: calls.length ? 'tool_calls' : 'stop' };
}

export async function readResponseStream(response: Response, onText?: (delta: string) => void): Promise<Completion> {
  if (!response.body) throw new RetryableModelError('ChatGPT returned an empty stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '', eventName = '', lines: string[] = [], completedResponseValue: unknown, total = 0;
  let streamedText = '';
  const streamedItems = new Map<number, unknown>();
  const doneTexts = new Map<string, string>();
  function event(): void {
    if (!lines.length) { eventName = ''; return; }
    const raw = lines.join('\n');
    lines = [];
    const type = eventName;
    eventName = '';
    if (raw === '[DONE]') return;
    let packet: Record<string, unknown>;
    try { packet = JSON.parse(raw) as Record<string, unknown>; }
    catch { throw new ModelError('ChatGPT returned an invalid stream event'); }
    const kind = typeof packet.type === 'string' ? packet.type : type;
    if (kind === 'response.output_text.delta') {
      if (typeof packet.delta !== 'string') throw new ModelError('invalid ChatGPT text delta');
      streamedText += packet.delta;
      onText?.(packet.delta);
    } else if (kind === 'response.output_text.done') {
      if (typeof packet.text === 'string' && Number.isInteger(packet.output_index) && Number.isInteger(packet.content_index)) {
        doneTexts.set(`${packet.output_index}:${packet.content_index}`, packet.text);
      }
    } else if (kind === 'response.output_item.done') {
      if (Number.isInteger(packet.output_index) && packet.item && typeof packet.item === 'object') {
        streamedItems.set(packet.output_index as number, packet.item);
      }
    } else if (kind === 'response.completed') {
      completedResponseValue = packet.response;
    } else if (kind === 'response.failed' || kind === 'response.incomplete' || kind === 'error') {
      const failure = packet.response && typeof packet.response === 'object'
        ? (packet.response as Record<string, unknown>).error : packet.error;
      const code = failure && typeof failure === 'object' ? (failure as Record<string, unknown>).code : undefined;
      const label = typeof code === 'string' && /^[a-z0-9_]+$/i.test(code) ? ` (${code})` : '';
      throw new ModelError(`ChatGPT ${kind}${label}`);
    }
  }
  function line(raw: string): void {
    const value = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!value) { event(); return; }
    if (value.startsWith('data:')) lines.push(value.slice(5).trimStart());
    else if (value.startsWith('event:')) eventName = value.slice(6).trim();
  }
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > 8 * 1024 * 1024) throw new ModelError('ChatGPT stream is too large');
      pending += decoder.decode(next.value, { stream: true });
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        line(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
    }
    pending += decoder.decode();
    if (pending) line(pending);
    if (lines.length) event();
  } catch (error) {
    if (transientNetworkError(error)) throw new RetryableModelError('ChatGPT stream connection failed');
    throw error;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  if (!completedResponseValue) throw new RetryableModelError('ChatGPT stream ended without response.completed');
  const finalizedText = [...doneTexts.entries()]
    .sort(([left], [right]) => {
      const [leftOutput, leftContent] = left.split(':').map(Number);
      const [rightOutput, rightContent] = right.split(':').map(Number);
      return (leftOutput ?? 0) - (rightOutput ?? 0) || (leftContent ?? 0) - (rightContent ?? 0);
    }).map(([, value]) => value).join('');
  return completedResponse(completedResponseValue, streamedItems, finalizedText || streamedText);
}

export class ChatGPTModel implements Model {
  readonly model: string;
  private readonly credentials: ChatGPTCredentials;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private known = false;
  constructor(credentials: ChatGPTCredentials, model: string, fetcher: typeof fetch = fetch, timeoutMs = 120_000) {
    if (!model) throw new Error('ChatGPT requires --model; run --provider chatgpt --list-models');
    this.credentials = credentials;
    this.model = model;
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
  }

  async listModels(): Promise<ChatGPTModelEntry[]> {
    const token = await this.credentials.accessToken();
    const response = await request(this.fetcher, `${CHATGPT_RESOURCE}/models`, { method: 'GET',
      headers: { Authorization: `Bearer ${token}` } }, 30_000);
    let catalog: unknown;
    try { catalog = JSON.parse(await limitedText(response, 4 * 1024 * 1024)); }
    catch { throw new ModelError('invalid ChatGPT model catalog'); }
    const models = (catalog as { models?: unknown })?.models;
    if (!Array.isArray(models)) throw new ModelError('invalid ChatGPT model catalog');
    return models.filter(item => item && item.visibility === 'list' && typeof item.slug === 'string')
      .map(item => ({ slug: item.slug as string,
        display_name: typeof item.display_name === 'string' ? item.display_name : item.slug as string }));
  }

  async complete(messages: Message[], tools: ToolDeclaration[], onText?: (delta: string) => void): Promise<Completion> {
    if (!this.known) {
      const catalog = await this.listModels();
      if (!catalog.some(item => item.slug === this.model)) {
        throw new ModelError('selected model is not in the ChatGPT account catalog');
      }
      this.known = true;
    }
    const token = await this.credentials.accessToken();
    const body = { model: this.model, input: responseInput(messages), store: false, stream: true,
      ...(tools.length ? { tools: responseTools(tools) } : {}) };
    const response = await request(this.fetcher, `${CHATGPT_RESOURCE}/responses`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body) }, this.timeoutMs);
    return readResponseStream(response, onText);
  }
}
