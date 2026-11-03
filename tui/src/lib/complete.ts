import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type CompleteMode = 'link' | 'dir';

export interface Suggestion {
  name: string;
  isDir: boolean;
  /** Full input value once this suggestion is accepted. */
  value: string;
}

const LINK_FILES = /\.(torrent|txt|md|markdown|metalink|meta4|list)$/i;

export function isPathLike(input: string): boolean {
  return /^(~|\/|\.\.?\/)/.test(input);
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function pathExists(input: string): 'file' | 'dir' | null {
  try {
    const st = fs.statSync(expandHome(input));
    return st.isDirectory() ? 'dir' : 'file';
  } catch {
    return null;
  }
}

/** Is `needle` a subsequence of `hay`? (fuzzy match) */
function subsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const c of hay) if (c === needle[i]) i++;
  return i === needle.length;
}

/**
 * Lists completions for the path being typed.
 * Ranking: prefix match, then substring, then fuzzy; directories first.
 */
export function suggest(raw: string, mode: CompleteMode): Suggestion[] {
  if (!isPathLike(raw)) return [];
  const input = raw === '~' ? '~/' : raw;
  const slash = input.lastIndexOf('/');
  const dirPart = input.slice(0, slash + 1);
  const prefix = input.slice(slash + 1);
  const lower = prefix.toLowerCase();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(expandHome(dirPart), { withFileTypes: true });
  } catch {
    return [];
  }
  const scored: { s: Suggestion; rank: number }[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.') && !prefix.startsWith('.')) continue;
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        isDir = fs.statSync(path.join(expandHome(dirPart), e.name)).isDirectory();
      } catch {
        continue;
      }
    }
    if (mode === 'dir' && !isDir) continue;
    if (mode === 'link' && !isDir && !LINK_FILES.test(e.name)) continue;
    const n = e.name.toLowerCase();
    let rank: number;
    if (lower === '' || n.startsWith(lower)) rank = 0;
    else if (n.includes(lower)) rank = 1;
    else if (subsequence(lower, n)) rank = 2;
    else continue;
    scored.push({
      s: { name: e.name, isDir, value: dirPart + e.name + (isDir ? '/' : '') },
      rank,
    });
  }
  scored.sort(
    (a, b) =>
      a.rank - b.rank ||
      Number(b.s.isDir) - Number(a.s.isDir) ||
      a.s.name.localeCompare(b.s.name, undefined, { sensitivity: 'base', numeric: true }),
  );
  return scored.map((x) => x.s);
}
