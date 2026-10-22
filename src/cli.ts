import { createInterface } from 'node:readline/promises';
import { realpath } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { Agent } from './agent.ts';
import { ChatGPTCredentials } from './chatgpt-auth.ts';
import { ChatGPTModel } from './chatgpt-model.ts';
import { ChatCompletionsModel } from './models.ts';
import { OFFICIAL_ENDPOINTS, QoderModel } from './qoder.ts';
import { withRetry } from './retry.ts';
import { SessionStore } from './session.ts';
import { workspaceTools } from './tools.ts';

const HELP = `glass-agent: read-only workspace agent

Usage: npm start -- [options] [question]

Options:
  --workspace PATH       Workspace directory (default: current directory)
  --provider NAME        chatgpt, openai, or qoder (default: chatgpt)
  --login                Authorize ChatGPT plan access in your browser
  --model NAME           Model key or name
  --base-url URL         API-key OpenAI root or official Qoder endpoint
  --list-models          List enabled ChatGPT or Qoder models
  --max-steps N          Maximum model calls per question (default: 8)
  --max-retries N        Retries for transient model failures (default: 2; 0 disables)
  --context-budget N     Approximate character budget (default: 120000)
  --stream               Print answer text as it arrives
  --no-stream            Wait for the complete answer (default for one-shot mode)
  --save                 Create a persistent session
  --session PATH         Resume or create this session file
  --continue             Resume latest workspace session
  --no-save              Keep conversation only in memory (default)
  --help                 Show this help

Omit the question for interactive mode; type exit to quit.
`;

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
  return number;
}

function nonNegativeInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer`);
  return number;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    workspace: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' },
    'base-url': { type: 'string' }, 'list-models': { type: 'boolean' }, login: { type: 'boolean' },
    'max-steps': { type: 'string' }, 'max-retries': { type: 'string' }, 'context-budget': { type: 'string' },
    save: { type: 'boolean' }, session: { type: 'string' }, continue: { type: 'boolean' },
    'no-save': { type: 'boolean' }, stream: { type: 'boolean' },
    'no-stream': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { process.stdout.write(HELP); return 0; }
  if (values.stream && values['no-stream']) throw new Error('choose only one streaming option');
  const sessionOptions = [values.save, values.session !== undefined, values.continue, values['no-save']]
    .filter(Boolean).length;
  if (sessionOptions > 1) throw new Error('choose only one session option');
  const provider = values.provider ?? process.env.GLASS_PROVIDER ?? 'chatgpt';
  if (!['chatgpt', 'openai', 'qoder'].includes(provider)) throw new Error('provider must be chatgpt, openai, or qoder');
  if (provider === 'chatgpt' && values['base-url']) throw new Error('--base-url is unavailable for ChatGPT plan credentials');
  if (values.login) {
    if (provider !== 'chatgpt' || values['list-models'] || positionals.length) throw new Error('--login is only for ChatGPT and cannot include a question');
    const session = await new ChatGPTCredentials().login();
    process.stderr.write(`ChatGPT authorized${session.email ? ` for ${session.email}` : ''}. Credentials saved outside the workspace.\n`);
    return 0;
  }
  const workspace = path.resolve(values.workspace ?? process.cwd());
  if (provider === 'chatgpt' && !values['list-models']) {
    const relativeCredential = path.relative(workspace, new ChatGPTCredentials().file);
    if (relativeCredential && !relativeCredential.startsWith(`..${path.sep}`) && relativeCredential !== '..' &&
        !path.isAbsolute(relativeCredential) && relativeCredential.split(path.sep).every(part => !part.startsWith('.'))) {
      throw new Error('ChatGPT credential file must be outside the agent-readable workspace');
    }
  }
  const modelName = values.model ?? process.env.GLASS_MODEL;
  const maxSteps = positiveInteger(values['max-steps'], 8, '--max-steps');
  const maxRetries = nonNegativeInteger(values['max-retries'], 2, '--max-retries');
  const onRetry = (attempt: number, delayMs: number, error: Error): void => {
    process.stderr.write(`retry ${attempt}/${maxRetries} in ${Math.ceil(delayMs)} ms: ${error.message}\n`);
  };
  const contextBudget = positiveInteger(values['context-budget'], 120000, '--context-budget');
  const streaming = values.stream || !values['no-stream'] && positionals.length === 0;
  let printed = false;
  const onText = streaming ? (delta: string): void => {
    printed = true;
    process.stdout.write(delta);
  } : undefined;
  const model = provider === 'chatgpt'
    ? new ChatGPTModel(new ChatGPTCredentials(), modelName ?? (values['list-models'] ? '__catalog__' : ''))
    : provider === 'qoder'
      ? new QoderModel(process.env.QODER_PERSONAL_ACCESS_TOKEN ?? '', modelName,
        values['base-url'] ?? process.env.QODER_BASE_URL ?? OFFICIAL_ENDPOINTS[0])
      : new ChatCompletionsModel(process.env.OPENAI_API_KEY ?? '', modelName,
        values['base-url'] ?? process.env.GLASS_BASE_URL ?? 'https://api.openai.com/v1');
  if (values['list-models']) {
    if (model instanceof QoderModel) {
      for (const item of await withRetry(() => model.listModels(), { maxRetries, onRetry })) {
        process.stdout.write(`${item.key}\t${item.display_name ?? ''}\n`);
      }
    } else if (model instanceof ChatGPTModel) {
      for (const item of await withRetry(() => model.listModels(), { maxRetries, onRetry })) {
        process.stdout.write(`${item.slug}\t${item.display_name}\n`);
      }
    } else throw new Error('--list-models is supported for ChatGPT and Qoder');
    return 0;
  }
  if (provider === 'qoder' && !modelName) throw new Error('Qoder requires --model; run --provider qoder --list-models');
  const workspaceRoot = await realpath(workspace);
  const systemPrompt = `You are a helpful read-only workspace assistant. The current workspace root is ${JSON.stringify(workspaceRoot)}. `
    + 'You can inspect visible workspace files with list_files and read_file. '
    + 'For questions about files or code, use those tools before claiming the files are unavailable. '
    + 'Only describe file contents you have actually read. Never modify files or run commands.';
  const agent = new Agent(model, await workspaceTools(workspaceRoot), {
    maxSteps, maxRetries, onRetry, onText, contextBudget, systemPrompt,
  });
  if (values.save || values.session || values.continue) {
    const file = values.continue ? await SessionStore.latestPath(workspace)
      : values.session ?? await SessionStore.newPath(workspace);
    const store = await SessionStore.create(file, workspace, provider, model.model);
    await store.load(agent);
    agent.onChange = current => store.save(current);
    process.stderr.write(`session: ${store.file}\n`);
  }
  if (positionals.length) {
    printed = false;
    try {
      const answer = await agent.run(positionals.join(' '));
      process.stdout.write(streaming ? '\n' : `${answer}\n`);
    } catch (error) {
      if (printed) process.stdout.write('\n');
      throw error;
    }
    return 0;
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      let prompt: string;
      try { prompt = await readline.question('glass> '); }
      catch { return 0; }
      if (['exit', 'quit'].includes(prompt.trim().toLowerCase())) return 0;
      if (!prompt.trim()) continue;
      printed = false;
      try {
        const answer = await agent.run(prompt);
        process.stdout.write(streaming ? '\n' : `${answer}\n`);
      } catch (error) {
        if (printed) process.stdout.write('\n');
        process.stderr.write(`error: ${error instanceof Error ? error.message : 'unknown error'}\n`);
      }
    }
  } finally { readline.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
