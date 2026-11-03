import React from 'react';
import { Box, Text } from 'ink';
import type { Download } from '../lib/types';
import {
  bar,
  formatBytes,
  formatEta,
  formatSpeed,
  indeterminate,
  padEnd,
  tildify,
  truncate,
  width as strWidth,
} from '../lib/format';
import { ACCENT, DIM, KIND, statusStyle } from './theme';

interface Line {
  text: string;
  color?: string;
}

const MAX_FILES = 6;

function detailLines(d: Download, w: number): Line[] {
  const out: Line[] = [];
  const max = Math.max(10, w - 6);
  const where = d.path ?? d.dir;
  if (where) out.push({ text: `path   ${truncate(tildify(where), max - 7)}` });
  if (d.url && d.kind !== 'torrent') out.push({ text: `url    ${truncate(d.url, max - 7)}` });
  if (d.kind === 'torrent') {
    out.push({ text: `peers  ${d.connections} · seeders ${d.seeders} · ↑ ${formatSpeed(d.up_speed)}` });
  } else if (d.kind === 'http') {
    out.push({ text: `conn   ${d.connections}` });
  }
  if (d.limit > 0) out.push({ text: `limit  ${formatSpeed(d.limit)}`, color: 'yellow' });
  if (d.error) out.push({ text: `error  ${truncate(d.error, max - 7)}`, color: 'red' });
  if (d.kind === 'torrent' && d.files && d.files.length > 1) {
    const prefix = d.dir.endsWith('/') ? d.dir : d.dir + '/';
    const shown = d.files.slice(0, MAX_FILES);
    for (const f of shown) {
      const name = f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path;
      const size = formatBytes(f.length);
      out.push({
        text: `${f.selected ? '■' : '□'} ${padEnd(truncate(name, max - size.length - 4), max - size.length - 3)}${size}`,
        color: f.selected ? undefined : DIM,
      });
    }
    if (d.files.length > MAX_FILES) out.push({ text: `  … ${d.files.length - MAX_FILES} more files`, color: DIM });
  }
  return out;
}

export function rowHeight(d: Download, expanded: boolean, w: number): number {
  return 3 + (expanded ? detailLines(d, w).length : 0);
}

interface Props {
  d: Download;
  selected: boolean;
  expanded: boolean;
  width: number;
  frame: number;
}

export function DownloadRow({ d, selected, expanded, width, frame }: Props) {
  const st = statusStyle(d);
  const kind = KIND[d.kind];
  const cursor = selected ? '▌' : ' ';
  const indent = 4;

  // ---- line 1: name + kind badge
  let badge = kind.label;
  if (d.kind === 'video' && d.status === 'active' && (d.phase === 'video' || d.phase === 'audio')) {
    badge = `${d.phase} · ${badge}`;
  }
  const nameWidth = Math.max(8, width - indent - badge.length - 3);
  const name = truncate(d.name, nameWidth);

  // ---- line 2: bar + stats
  const ratio = d.total > 0 ? d.done / d.total : 0;
  const pct = d.total > 0 ? `${(ratio * 100).toFixed(1)}%` : '';
  const sizes = d.total > 0 ? `${formatBytes(d.done)} / ${formatBytes(d.total)}` : d.done > 0 ? formatBytes(d.done) : '';
  let tail = '';
  let tailColor: string = st.color;
  if (d.status === 'active' && st.label === '') {
    const eta = d.speed > 0 && d.total > 0 ? formatEta((d.total - d.done) / d.speed) : '--';
    tail = `${formatSpeed(d.speed).padStart(11)}  ${eta.padStart(6)}`;
    tailColor = ACCENT;
  } else {
    tail = st.label;
  }
  const statsParts = [pct.padStart(6), sizes];
  let stats = statsParts.filter(Boolean).join('  ');
  const avail = width - indent - 2;
  // drop the size column first on narrow terminals
  if (avail - strWidth(stats) - strWidth(tail) - 4 < 12) stats = pct.padStart(6);
  const barWidth = Math.max(6, avail - strWidth(stats) - strWidth(tail) - 4);

  let barEl: React.ReactNode;
  const barColor =
    d.status === 'complete' ? 'green' : d.status === 'error' ? 'red' : d.status === 'paused' ? 'yellow' : d.status === 'active' ? ACCENT : DIM;
  if (d.total === 0 && (d.status === 'active' || d.status === 'metadata')) {
    const [a, b, c] = indeterminate(frame, barWidth);
    barEl = (
      <Text>
        <Text color={DIM}>{a}</Text>
        <Text color={barColor}>{b}</Text>
        <Text color={DIM}>{c}</Text>
      </Text>
    );
  } else {
    const [filled, empty] = bar(d.status === 'complete' ? 1 : ratio, barWidth);
    barEl = (
      <Text>
        <Text color={barColor}>{filled}</Text>
        <Text color={DIM}>{empty}</Text>
      </Text>
    );
  }

  const details = expanded ? detailLines(d, width) : [];

  return (
    <Box flexDirection="column" width={width} height={3 + details.length}>
      <Box>
        <Text color={ACCENT}>{cursor}</Text>
        <Text color={st.color}> {st.icon} </Text>
        <Box flexGrow={1}>
          <Text bold={selected} color={selected ? 'whiteBright' : undefined} wrap="truncate">
            {name}
          </Text>
        </Box>
        <Text color={kind.color} bold>
          {badge}{' '}
        </Text>
      </Box>
      <Box>
        <Text color={ACCENT}>{cursor}</Text>
        <Text>{' '.repeat(indent - 1)}</Text>
        {barEl}
        <Text>{'  '}</Text>
        <Text color={selected ? undefined : DIM}>{stats}</Text>
        <Text>{'  '}</Text>
        <Text color={tailColor}>{tail}</Text>
      </Box>
      {details.map((l, i) => (
        <Box key={i}>
          <Text color={ACCENT}>{cursor}</Text>
          <Text color={l.color ?? DIM} wrap="truncate">
            {' '.repeat(indent - 1)}
            {l.text}
          </Text>
        </Box>
      ))}
      <Text> </Text>
    </Box>
  );
}
