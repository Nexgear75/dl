import type { Download } from '../lib/types';

export const ACCENT = 'cyan';
export const DIM = 'gray';

export const KIND: Record<Download['kind'], { label: string; color: string }> = {
  http: { label: 'HTTP', color: 'blue' },
  torrent: { label: 'TORRENT', color: 'magenta' },
  video: { label: 'VIDEO', color: 'redBright' },
};

export interface StatusStyle {
  icon: string;
  color: string;
  label: string;
}

export function statusStyle(d: Download): StatusStyle {
  switch (d.status) {
    case 'active':
      if (d.phase === 'merging') return { icon: '⚙', color: 'yellow', label: 'merging' };
      if (d.phase === 'starting') return { icon: '↓', color: ACCENT, label: 'starting' };
      return { icon: '↓', color: ACCENT, label: '' };
    case 'waiting':
      return { icon: '·', color: DIM, label: 'queued' };
    case 'paused':
      return { icon: '‖', color: 'yellow', label: 'paused' };
    case 'complete':
      return { icon: '✓', color: 'green', label: 'done' };
    case 'error':
      return { icon: '✗', color: 'red', label: 'failed' };
    case 'selecting':
      return { icon: '◆', color: 'magenta', label: 'choose files  ⏎' };
    case 'metadata':
      return { icon: '⋯', color: 'blue', label: 'fetching metadata' };
    default:
      return { icon: '?', color: DIM, label: d.status };
  }
}
