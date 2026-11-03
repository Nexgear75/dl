import stringWidth from 'string-width';
import os from 'node:os';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Base-1024 sizes: 1536 → "1.5 KB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  let i = 0;
  let v = n;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 ? 0 : v < 10 ? 2 : v < 100 ? 1 : 0;
  return `${v.toFixed(digits)} ${UNITS[i]}`;
}

export function formatSpeed(n: number): string {
  return `${formatBytes(n)}/s`;
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d`;
}

/** Truncates to a display width (handles wide/CJK chars and emoji). */
export function truncate(s: string, width: number): string {
  if (width <= 0) return '';
  if (stringWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = stringWidth(ch);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

export function padEnd(s: string, width: number): string {
  const w = stringWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

export function width(s: string): number {
  return stringWidth(s);
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

/** Returns [filled, empty] strings of exactly `w` cells. */
export function bar(ratio: number, w: number): [string, string] {
  if (w <= 0) return ['', ''];
  const r = Math.max(0, Math.min(1, ratio));
  const cells = r * w;
  const full = Math.floor(cells);
  const rest = Math.floor((cells - full) * 8);
  let filled = '█'.repeat(full);
  if (full < w && rest > 0) filled += EIGHTHS[rest];
  const used = full + (full < w && rest > 0 ? 1 : 0);
  return [filled, '─'.repeat(w - used)];
}

/** Bouncing block for downloads of unknown size. */
export function indeterminate(frame: number, w: number): [string, string, string] {
  if (w <= 0) return ['', '', ''];
  const size = Math.max(3, Math.floor(w / 8));
  const span = Math.max(1, w - size);
  const t = frame % (span * 2);
  const pos = t < span ? t : span * 2 - t;
  return ['─'.repeat(pos), '█'.repeat(Math.min(size, w)), '─'.repeat(Math.max(0, w - pos - size))];
}

export function tildify(p: string): string {
  const home = os.homedir();
  return p === home ? '~' : p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

/** "2M" / "500k" / "1.5 MB" / "0" → bytes (base 1024), null if invalid. */
export function parseSize(input: string): number | null {
  const s = input.trim().toUpperCase().replace(/\/S$/, '').replace(/I?B$/, '');
  if (s === '' || s === '0') return 0;
  const m = /^(\d+(?:\.\d+)?)\s*([KMG]?)$/.exec(s);
  if (!m) return null;
  const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2] as '' | 'K' | 'M' | 'G'];
  return Math.floor(parseFloat(m[1]) * mult);
}
