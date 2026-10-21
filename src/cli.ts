import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { Agent } from './agent.ts';
import { ChatCompletionsModel } from './models.ts';
import { OFFICIAL_ENDPOINTS, QoderModel } from './qoder.ts';
import { withRetry } from './retry.ts';
import { SessionStore } from './session.ts';
import { workspaceTools } from './tools.ts';

const HELP = `glass-agent: read-only workspace agent

Usage: npm start -- [options] [question]

Options:
  --workspace PATH       Workspace directory (default: current directory)
  --provider NAME        openai or qoder (default: openai)
  --model NAME           Model key or name
  --base-url URL         OpenAI API root or official Qoder endpoint
  --list-models          List enabled Qoder models
  --max-steps N          Maximum model calls per question (default: 8)
  --max-retries N        Retries for transient model failures (default: 2; 0 disables)
  --context-budget N     Approximate character budget (default: 120000)
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
    'base-url': { type: 'string' }, 'list-models': { type: 'boolean' },
    'max-steps': { type: 'string' }, 'max-retries': { type: 'string' }, 'context-budget': { type: 'string' },
    save: { type: 'boolean' }, session: { type: 'string' }, continue: { type: 'boolean' },
    'no-save': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { process.stdout.write(HELP); return 0; }
  const sessionOptions = [values.save, values.session !== undefined, values.continue, values['no-save']]
    .filter(Boolean).length;
  if (sessionOptions > 1) throw new Error('choose only one session option');
  const provider = values.provider ?? process.env.GLASS_PROVIDER ?? 'openai';
  if (provider !== 'openai' && provider !== 'qoder') throw new Error('provider must be openai or qoder');
  const workspace = path.resolve(values.workspace ?? process.cwd());
  const modelName = values.model ?? process.env.GLASS_MODEL;
  const maxSteps = positiveInteger(values['max-steps'], 8, '--max-steps');
  const maxRetries = nonNegativeInteger(values['max-retries'], 2, '--max-retries');
  const onRetry = (attempt: number, delayMs: number, error: Error): void => {
    process.stderr.write(`retry ${attempt}/${maxRetries} in ${Math.ceil(delayMs)} ms: ${error.message}\n`);
  };
  const contextBudget = positiveInteger(values['context-budget'], 120000, '--context-budget');
  const model = provider === 'qoder'
    ? new QoderModel(process.env.QODER_PERSONAL_ACCESS_TOKEN ?? '', modelName,
      values['base-url'] ?? process.env.QODER_BASE_URL ?? OFFICIAL_ENDPOINTS[0])
    : new ChatCompletionsModel(process.env.OPENAI_API_KEY ?? '', modelName,
      values['base-url'] ?? process.env.GLASS_BASE_URL ?? 'https://api.openai.com/v1');
  if (values['list-models']) {
    if (!(model instanceof QoderModel)) throw new Error('--list-models is supported only for Qoder');
    for (const item of await withRetry(() => model.listModels(), { maxRetries, onRetry })) {
      process.stdout.write(`${item.key}\t${item.display_name ?? ''}\n`);
    }
    return 0;
  }
  if (provider === 'qoder' && !modelName) throw new Error('Qoder requires --model; run --provider qoder --list-models');
  const agent = new Agent(model, await workspaceTools(workspace), { maxSteps, maxRetries, onRetry, contextBudget });
  if (values.save || values.session || values.continue) {
    const file = values.continue ? await SessionStore.latestPath(workspace)
      : values.session ?? await SessionStore.newPath(workspace);
    const store = await SessionStore.create(file, workspace, provider, model.model);
    await store.load(agent);
    agent.onChange = current => store.save(current);
    process.stderr.write(`session: ${store.file}\n`);
  }
  if (positionals.length) {
    process.stdout.write(`${await agent.run(positionals.join(' '))}\n`);
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
      try { process.stdout.write(`${await agent.run(prompt)}\n`); }
      catch (error) { process.stderr.write(`error: ${error instanceof Error ? error.message : 'unknown error'}\n`); }
    }
  } finally { readline.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
