import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets } from './secrets.ts';
import type { Tool } from './types.ts';

const issuedTools = new WeakSet<Tool>();
const names = new Set(['list_files', 'read_file', 'current_date']);

export function isAllowedReadTool(tool: Tool): boolean {
  return names.has(tool.name) && issuedTools.has(tool);
}

function visibleRelative(root: string, requested: string): string {
  if (!requested || path.isAbsolute(requested) || requested.split(/[\\/]/).some(p => p.startsWith('.'))) {
    throw new Error('path must be a visible file inside the workspace');
  }
  const candidate = path.resolve(root, requested);
  const relative = path.relative(root, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('path leaves the workspace');
  }
  return candidate;
}

export async function workspaceTools(workspace: string, now: () => Date = () => new Date()): Promise<Tool[]> {
  const root = await realpath(workspace);
  if (!(await lstat(root)).isDirectory()) throw new Error('workspace must be a directory');

  async function listFiles(): Promise<string> {
    const found: string[] = [];
    async function visit(directory: string): Promise<void> {
      const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!['node_modules', '__pycache__', 'venv'].includes(entry.name)) await visit(full);
        } else if (entry.isFile()) {
          found.push(path.relative(root, full).split(path.sep).join('/'));
          if (found.length >= 100) return;
        }
        if (found.length >= 100) return;
      }
    }
    await visit(root);
    if (!found.length) return '(no visible files)';
    return redactSecrets(found.join('\n')) + (found.length >= 100 ? '\n[only first 100 files shown]' : '');
  }

  async function readFile(arguments_: Record<string, unknown>): Promise<string> {
    if (typeof arguments_.path !== 'string') throw new Error('path must be a string');
    const offset = arguments_.offset ?? 0;
    const limit = arguments_.limit ?? 6000;
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('offset must be a non-negative character position');
    }
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 6000) {
      throw new Error('limit must be between 1 and 6000 characters');
    }
    const candidate = visibleRelative(root, arguments_.path);
    const resolved = await realpath(candidate);
    const relative = path.relative(root, resolved);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
        || relative.split(path.sep).some(part => part.startsWith('.'))) {
      throw new Error('path leaves the visible workspace');
    }
    const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('file not found');
      if (stat.size > 1024 * 1024) throw new Error('file is larger than 1 MiB');
      const bytes = await handle.readFile();
      const content = redactSecrets(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (offset >= content.length) return `(no content at offset ${offset}; file has ${content.length} characters)`;
      const end = Math.min(content.length, offset + limit);
      const excerpt = content.slice(offset, end);
      return offset === 0 && end === content.length ? excerpt
        : `${excerpt}\n[Showing characters ${offset}-${end} of ${content.length}; ${end < content.length ? `continue with offset ${end}` : 'end of file'}]`;
    } finally {
      await handle.close();
    }
  }

  const tools: Tool[] = [
    { name: 'list_files', description: 'List up to 100 visible workspace files.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: listFiles },
    { name: 'read_file', description: 'Read up to 6000 characters from one visible UTF-8 file (max 1 MiB). Use offset to continue from the displayed character position.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['path'], additionalProperties: false },
      execute: readFile },
    { name: 'current_date', description: 'Get the current calendar date and weekday in the Asia/Shanghai time zone. Use this for questions about today or the current date.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => {
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
        }).formatToParts(now());
        const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find(part => part.type === type)?.value ?? '';
        return `${get('year')}-${get('month')}-${get('day')} (${get('weekday')}), time zone: Asia/Shanghai`;
      } },
  ];
  for (const tool of tools) {
    issuedTools.add(tool);
    Object.freeze(tool);
  }
  return tools;
}
