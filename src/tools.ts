import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Tool } from './types.ts';

const issuedTools = new WeakSet<Tool>();
const names = new Set(['list_files', 'read_file']);

export function isWorkspaceReadTool(tool: Tool): boolean {
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

export async function workspaceTools(workspace: string): Promise<Tool[]> {
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
    return found.join('\n') + (found.length >= 100 ? '\n[only first 100 files shown]' : '');
  }

  async function readFile(arguments_: Record<string, unknown>): Promise<string> {
    if (typeof arguments_.path !== 'string') throw new Error('path must be a string');
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
      if (stat.size > 65536) throw new Error('file is larger than 64 KiB');
      const bytes = await handle.readFile();
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } finally {
      await handle.close();
    }
  }

  const tools: Tool[] = [
    { name: 'list_files', description: 'List up to 100 visible workspace files.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: listFiles },
    { name: 'read_file', description: 'Read one visible UTF-8 workspace file, up to 64 KiB.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      execute: readFile },
  ];
  for (const tool of tools) {
    issuedTools.add(tool);
    Object.freeze(tool);
  }
  return tools;
}
