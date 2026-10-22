import os from 'node:os';
import path from 'node:path';

const LOCAL_ROOTS = ['Users', 'home', 'private', 'var', 'tmp', 'Volumes', 'etc', 'opt', 'System', 'Library', 'Applications'];
const LOCAL_PATH = /\/(?:Users|home|private|var|tmp|Volumes|etc|opt|System|Library|Applications)(?:\/[^\s<>"'`),;]*)?/g;
const TRAILING_LOCAL_PATH = /\/(?:Users|home|private|var|tmp|Volumes|etc|opt|System|Library|Applications)(?:\/[^\s<>"'`),;]*)?$/;

function replacements(workspace: string, aliases: string[] = []): Array<[string, string]> {
  const root = path.resolve(workspace);
  const home = path.resolve(os.homedir());
  return [[root, path.basename(root)], ...aliases.map(alias => [path.resolve(alias), path.basename(root)]), [home, '~']]
    .filter(([source], index, all) => source !== path.sep && all.findIndex(([other]) => other === source) === index)
    .sort(([left], [right]) => right.length - left.length) as Array<[string, string]>;
}

export function safeOutput(text: string, workspace: string, aliases: string[] = []): string {
  let result = text;
  for (const [source, replacement] of replacements(workspace, aliases)) {
    result = result.replaceAll(source, replacement);
  }
  return result.replace(LOCAL_PATH, '[local path]');
}

// Hold any suffix that could still become a private path when the next delta arrives.
export class SafeOutputStream {
  private pending = '';
  private readonly paths: string[];
  private readonly workspace: string;
  private readonly emit: (text: string) => void;
  private readonly aliases: string[];

  constructor(workspace: string, emit: (text: string) => void, aliases: string[] = []) {
    this.workspace = workspace;
    this.emit = emit;
    this.aliases = aliases;
    this.paths = [...replacements(workspace, aliases).map(([source]) => source),
      ...LOCAL_ROOTS.map(root => `/${root}`)];
  }

  write(delta: string): void {
    this.pending += delta;
    let held = 0;
    for (const source of this.paths) {
      for (let length = 1; length < source.length && length <= this.pending.length; length++) {
        if (this.pending.endsWith(source.slice(0, length))) held = Math.max(held, length);
      }
    }
    const local = TRAILING_LOCAL_PATH.exec(this.pending);
    if (local) held = Math.max(held, local[0].length);
    const ready = this.pending.slice(0, this.pending.length - held);
    this.pending = this.pending.slice(this.pending.length - held);
    if (ready) this.emit(safeOutput(ready, this.workspace, this.aliases));
  }

  finish(): void {
    if (this.pending) {
      const complete = this.paths.includes(this.pending);
      this.emit(complete ? safeOutput(this.pending, this.workspace, this.aliases) : '[local path]');
      this.pending = '';
    }
  }
}
