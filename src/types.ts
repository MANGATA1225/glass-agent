export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDeclaration {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface Completion {
  message: Message;
  finishReason?: string | null;
}

export interface Model {
  model: string;
  sessionId?: string;
  complete(messages: Message[], tools: ToolDeclaration[]): Promise<Completion>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(arguments_: Record<string, unknown>): Promise<string> | string;
}

export function declaration(tool: Tool): ToolDeclaration {
  return { type: 'function', function: {
    name: tool.name, description: tool.description, parameters: tool.parameters,
  } };
}

export class AgentError extends Error {}
export class ModelError extends Error {}
export class ContextLimitExceeded extends AgentError {}
export class StepLimitExceeded extends AgentError {}
