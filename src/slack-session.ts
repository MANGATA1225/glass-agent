import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { Agent } from './agent.ts';
import { SessionStore } from './session.ts';

export class SlackSessions {
  private readonly workspace: string;
  private readonly model: string;

  private constructor(workspace: string, model: string) {
    this.workspace = workspace;
    this.model = model;
  }

  static async create(workspace: string, model: string): Promise<SlackSessions> {
    return new SlackSessions(await realpath(workspace), model);
  }

  fileFor(conversation: string): string {
    const id = createHash('sha256').update(conversation).digest('hex');
    return path.join(this.workspace, '.glass-agent', 'sessions', 'slack', `${id}.json`);
  }

  private async store(conversation: string): Promise<SessionStore> {
    return SessionStore.create(this.fileFor(conversation), this.workspace, 'chatgpt', this.model,
      { redactSecrets: true });
  }

  async open(conversation: string, makeAgent: () => Agent): Promise<Agent> {
    const agent = makeAgent();
    const store = await this.store(conversation);
    await store.load(agent);
    agent.onChange = current => store.save(current);
    return agent;
  }

  async reset(conversation: string): Promise<void> {
    await (await this.store(conversation)).archive();
  }
}
