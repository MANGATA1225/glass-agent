import os from 'node:os';
import path from 'node:path';
import { redactSecrets, SECRET_LABELS, SECRET_MARKERS, TRAILING_LABELED_VALUE } from './secrets.ts';

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
  return redactSecrets(result.replace(LOCAL_PATH, '[local path]'));
}

// Hold any suffix that could still become a private path when the next delta arrives.
export class SafeOutputStream {
  private pending = '';
  private readonly paths: string[];
  private readonly workspace: string;
  private readonly emit: (text: string) => void;
  private readonly aliases: string[];
  private heldSecret = false;

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
    let secretHeld = 0;
    for (const marker of SECRET_MARKERS) {
      for (let length = 1; length < marker.length && length <= this.pending.length; length++) {
        const start = this.pending.length - length;
        if ((start === 0 || !/[A-Za-z0-9_-]/.test(this.pending[start - 1]!))
            && this.pending.endsWith(marker.slice(0, length))) secretHeld = Math.max(secretHeld, length);
      }
      const start = this.pending.lastIndexOf(marker);
      if (start >= 0 && (start === 0 || !/[A-Za-z0-9_-]/.test(this.pending[start - 1]!))
          && /^[A-Za-z0-9._~+/-]*={0,2}$/.test(this.pending.slice(start + marker.length))) {
        secretHeld = Math.max(secretHeld, this.pending.length - start);
      }
    }
    const lower = this.pending.toLowerCase();
    for (const marker of SECRET_LABELS) {
      for (let length = 1; length < marker.length && length <= lower.length; length++) {
        const start = lower.length - length;
        if ((start === 0 || !/[a-z0-9]/.test(lower[start - 1]!))
            && lower.endsWith(marker.slice(0, length))) secretHeld = Math.max(secretHeld, length);
      }
      const start = lower.lastIndexOf(marker);
      if (start >= 0 && (start === 0 || !/[a-z0-9]/.test(lower[start - 1]!))
          && /^[a-z0-9_]*["']?\s*(?:[:=]\s*(?:"[^"\r\n]*"?|'[^'\r\n]*'?|[^\s,;}\]]*))?$/.test(lower.slice(start + marker.length))) {
        secretHeld = Math.max(secretHeld, lower.length - start);
      }
    }
    const labeled = TRAILING_LABELED_VALUE.exec(this.pending);
    if (labeled) secretHeld = Math.max(secretHeld, labeled[0].length);
    this.heldSecret = secretHeld > held;
    held = Math.max(held, secretHeld);
    const ready = this.pending.slice(0, this.pending.length - held);
    this.pending = this.pending.slice(this.pending.length - held);
    if (ready) this.emit(safeOutput(ready, this.workspace, this.aliases));
  }

  finish(): void {
    if (this.pending) {
      const complete = this.paths.includes(this.pending);
      this.emit(this.heldSecret
        ? TRAILING_LABELED_VALUE.test(this.pending) || SECRET_MARKERS.some(marker => this.pending.startsWith(marker))
          ? '[REDACTED]' : safeOutput(this.pending, this.workspace, this.aliases)
        : complete ? safeOutput(this.pending, this.workspace, this.aliases) : '[local path]');
      this.pending = '';
      this.heldSecret = false;
    }
  }
}
