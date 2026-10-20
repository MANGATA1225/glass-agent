import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, readdir, realpath, rename, stat, lstat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Agent } from './agent.ts';
import type { Message } from './types.ts';

function expanded(input: string): string {
  return path.resolve(input.startsWith('~/') ? path.join(os.homedir(), input.slice(2)) : input);
}

async function checkLinks(file: string): Promise<void> {
  for (let current = file; ; current = path.dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('session path must not contain a symbolic link'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (current === path.dirname(current)) break;
  }
}

export class SessionStore {
  readonly file: string;
  readonly workspace: string;
  readonly provider: string;
  readonly model: string;
  private constructor(file: string, workspace: string, provider: string, model: string) {
    this.file = expanded(file);
    this.workspace = workspace;
    this.provider = provider;
    this.model = model;
  }

  static async create(file: string, workspace: string, provider: string, model: string): Promise<SessionStore> {
    return new SessionStore(file, await realpath(workspace), provider, model);
  }

  static async newPath(workspace: string): Promise<string> {
    return path.join(await realpath(workspace), '.glass-agent', 'sessions', `${randomUUID()}.json`);
  }

  static async latestPath(workspace: string): Promise<string> {
    const directory = path.join(await realpath(workspace), '.glass-agent', 'sessions');
    await checkLinks(directory);
    let names: string[];
    try { names = (await readdir(directory)).filter(name => name.endsWith('.json')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('no saved session in this workspace');
      throw error;
    }
    const candidates = await Promise.all(names.map(async name => {
      const file = path.join(directory, name);
      const info = await lstat(file);
      return info.isFile() ? { file, time: info.mtimeMs } : null;
    }));
    const latest = candidates.filter((item): item is { file: string; time: number } => item !== null)
      .sort((a, b) => b.time - a.time)[0];
    if (!latest) throw new Error('no saved session in this workspace');
    return latest.file;
  }

  async load(agent: Agent): Promise<void> {
    await checkLinks(this.file);
    let info;
    try { info = await stat(this.file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (info.size > 64 * 1024 * 1024) throw new Error('session file is too large');
    const state = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, unknown>;
    if (state.version !== 1 || state.workspace !== this.workspace || state.provider !== this.provider
        || state.model !== this.model) throw new Error('session workspace, provider, or model does not match');
    const history = state.history;
    const kept = state.first_kept_index;
    if (!Array.isArray(history) || !history.every(item => item && typeof item === 'object')
        || typeof state.summary !== 'string' || !Number.isInteger(kept) || typeof kept !== 'number'
        || kept < 0 || kept > history.length || kept < history.length && history[kept]?.role !== 'user') {
      throw new Error('session file has an invalid conversation');
    }
    if (state.remote_session_id !== undefined && agent.model.sessionId !== undefined) {
      if (typeof state.remote_session_id !== 'string' || !state.remote_session_id) {
        throw new Error('session file has an invalid remote session ID');
      }
      agent.model.sessionId = state.remote_session_id;
    }
    agent.history = history as Message[];
    agent.summary = state.summary;
    agent.firstKeptIndex = kept;
  }

  async save(agent: Agent): Promise<void> {
    await checkLinks(this.file);
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await checkLinks(this.file);
    const state = { version: 1, workspace: this.workspace, provider: this.provider, model: this.model,
      history: agent.history, summary: agent.summary, first_kept_index: agent.firstKeptIndex,
      ...(agent.model.sessionId ? { remote_session_id: agent.model.sessionId } : {}) };
    const temporary = path.join(path.dirname(this.file), `.session-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      await rename(temporary, this.file);
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }
}
