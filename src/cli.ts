import { createInterface } from 'node:readline/promises';
import { realpath } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { Agent } from './agent.ts';
import { ChatGPTCredentials } from './chatgpt-auth.ts';
import { ChatGPTModel } from './chatgpt-model.ts';
import { ChatCompletionsModel } from './models.ts';
import { safeOutput, SafeOutputStream } from './output.ts';
import { OFFICIAL_ENDPOINTS, QoderModel } from './qoder.ts';
import { withRetry } from './retry.ts';
import { SessionStore } from './session.ts';
import { DEFAULT_SLACK_CONFIG, initSlackConfig, loadSlackConfig, SlackBot } from './slack.ts';
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
  --slack-init           Create private Slack config template and show its path
  --slack                Run a Slack bot through Socket Mode (ChatGPT provider)
  --slack-config PATH    Slack config file (default: ~/.config/glass-agent/slack.env)
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
    slack: { type: 'boolean' }, 'slack-init': { type: 'boolean' }, 'slack-config': { type: 'string' },
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
  const workspace = path.resolve(values.workspace ?? process.cwd());
  const slackConfigFile = path.resolve(values['slack-config'] ?? DEFAULT_SLACK_CONFIG);
  if (values['slack-init']) {
    if (values.slack || values.login || values['list-models'] || positionals.length) {
      throw new Error('--slack-init cannot be combined with a run or question');
    }
    const relative = path.relative(workspace, slackConfigFile);
    if (relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' &&
        !path.isAbsolute(relative) && relative.split(path.sep).every(part => !part.startsWith('.'))) {
      throw new Error('Slack config must be outside the agent-readable workspace');
    }
    process.stdout.write(`Slack config template created: ${safeOutput(await initSlackConfig(slackConfigFile), workspace)}\n`);
    return 0;
  }
  if (values.slack && (provider !== 'chatgpt' || values.login || values['list-models'] || positionals.length ||
      values.save || values.session || values.continue)) {
    throw new Error('--slack requires ChatGPT, a model, and no question or persistent-session option');
  }
  if (provider === 'chatgpt' && values['base-url']) throw new Error('--base-url is unavailable for ChatGPT plan credentials');
  if (values.login) {
    if (provider !== 'chatgpt' || values['list-models'] || positionals.length) throw new Error('--login is only for ChatGPT and cannot include a question');
    const session = await new ChatGPTCredentials().login();
    process.stderr.write(`ChatGPT authorized${session.email ? ` for ${session.email}` : ''}. Credentials saved outside the workspace.\n`);
    return 0;
  }
  if (values.slack) {
    const relative = path.relative(workspace, slackConfigFile);
    if (relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' &&
        !path.isAbsolute(relative) && relative.split(path.sep).every(part => !part.startsWith('.'))) {
      throw new Error('Slack config must be outside the agent-readable workspace');
    }
  }
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
  let displayWorkspace = workspace;
  const onRetry = (attempt: number, delayMs: number, error: Error): void => {
    process.stderr.write(`retry ${attempt}/${maxRetries} in ${Math.ceil(delayMs)} ms: ${safeOutput(error.message, displayWorkspace, [workspace])}\n`);
  };
  const contextBudget = positiveInteger(values['context-budget'], 120000, '--context-budget');
  const streaming = values.stream || !values['no-stream'] && positionals.length === 0;
  let printed = false;
  let outputStream: SafeOutputStream | undefined;
  const onText = streaming ? (delta: string): void => {
    printed = true;
    outputStream?.write(delta);
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
  displayWorkspace = workspaceRoot;
  const systemPrompt = `You are a helpful read-only workspace assistant. The current workspace is named ${JSON.stringify(path.basename(workspaceRoot))}. `
    + 'You can inspect visible workspace files with list_files and read_file. '
    + 'For questions about files or code, use those tools before claiming the files are unavailable. '
    + 'Use workspace-relative file paths in answers; never reveal absolute local path prefixes. '
    + 'Only describe file contents you have actually read. Never modify files or run commands.';
  const tools = await workspaceTools(workspaceRoot);
  if (values.slack) {
    await new ChatGPTCredentials().load();
    const config = await loadSlackConfig(slackConfigFile);
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      process.stderr.write(`Slack workspace files: ${path.basename(workspaceRoot)}\n`);
      await new SlackBot(config, () => new Agent(model, tools, {
        maxSteps, maxRetries, onRetry, contextBudget, systemPrompt,
      }), fetch, text => safeOutput(text, workspaceRoot, [workspace])).run(controller.signal);
      return 0;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  }
  const agent = new Agent(model, tools, {
    maxSteps, maxRetries, onRetry, onText, contextBudget, systemPrompt,
  });
  if (values.save || values.session || values.continue) {
    const file = values.continue ? await SessionStore.latestPath(workspace)
      : values.session ?? await SessionStore.newPath(workspace);
    const store = await SessionStore.create(file, workspace, provider, model.model);
    await store.load(agent);
    agent.onChange = current => store.save(current);
    process.stderr.write(`session: ${safeOutput(store.file, workspaceRoot, [workspace])}\n`);
  }
  if (positionals.length) {
    printed = false;
    outputStream = streaming ? new SafeOutputStream(workspaceRoot, text => process.stdout.write(text), [workspace]) : undefined;
    try {
      const answer = await agent.run(positionals.join(' '));
      outputStream?.finish();
      process.stdout.write(streaming ? '\n' : `${safeOutput(answer, workspaceRoot, [workspace])}\n`);
    } catch (error) {
      outputStream?.finish();
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
      outputStream = streaming ? new SafeOutputStream(workspaceRoot, text => process.stdout.write(text), [workspace]) : undefined;
      try {
        const answer = await agent.run(prompt);
        outputStream?.finish();
        process.stdout.write(streaming ? '\n' : `${safeOutput(answer, workspaceRoot, [workspace])}\n`);
      } catch (error) {
        outputStream?.finish();
        if (printed) process.stdout.write('\n');
        process.stderr.write(`error: ${safeOutput(error instanceof Error ? error.message : 'unknown error', workspaceRoot, [workspace])}\n`);
      }
    }
  } finally { readline.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`error: ${safeOutput(error instanceof Error ? error.message : 'unknown error', process.cwd())}\n`);
    process.exitCode = 1;
  });
}
