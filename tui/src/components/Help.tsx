import React from 'react';
import { Box, Text } from 'ink';
import { ACCENT, DIM } from './theme';

const SECTIONS: [string, [string, string][]][] = [
  [
    'Navigation',
    [
      ['↓ ↑  j / k', 'move'],
      ['home end  gg G', 'top / bottom'],
      ['pgdn pgup  ^d ^u', 'page down / up'],
      ['⏎  → / ←', 'details · torrent files / close'],
    ],
  ],
  [
    'Downloads',
    [
      ['i  a', 'add a link, magnet or file'],
      ['p  space', 'pause / resume'],
      ['P', 'pause / resume all'],
      ['⌫  dd  x', 'remove (cancel deletes partial data)'],
      ['r', 'retry a failed download'],
      ['l / L', 'speed limit: selected / global'],
      ['c', 'clear finished'],
      ['o', 'reveal in Finder'],
      ['y', 'copy path / url'],
    ],
  ],
  [
    'Input',
    [
      ['tab  →', 'accept completion'],
      ['↑ ↓  ctrl-p/n', 'browse completions'],
      ['ctrl-w / ctrl-u', 'delete word / line'],
      ['esc', 'back to normal mode'],
    ],
  ],
  [
    'App',
    [
      ['?', 'this help'],
      ['q', 'quit (downloads continue)'],
      ['Q', 'quit and stop the daemon'],
    ],
  ],
];

function Section({ title, rows, last }: { title: string; rows: [string, string][]; last?: boolean }) {
  return (
    <Box flexDirection="column" marginBottom={last ? 0 : 1} flexShrink={0}>
      <Text bold>{title}</Text>
      {rows.map(([k, v]) => (
        <Box key={k} flexShrink={0}>
          <Box width={18} flexShrink={0}>
            <Text color={ACCENT}>{k}</Text>
          </Box>
          <Text color={DIM} wrap="truncate">
            {v}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

export function Help({ width, height }: { width: number; height: number }) {
  const wide = width >= 96;
  const [nav, downloads, input, app] = SECTIONS;
  return (
    <Box width={width} height={height} justifyContent="center" overflow="hidden">
      <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={2} width={Math.min(width, wide ? 96 : 60)}>
        <Box justifyContent="space-between" flexShrink={0}>
          <Text bold color={ACCENT}>
            Keys
          </Text>
          <Text color={DIM}>any key to close</Text>
        </Box>
        {wide ? (
          <Box>
            <Box flexDirection="column" width="50%" paddingRight={2}>
              <Section title={nav[0]} rows={nav[1]} />
              <Section title={input[0]} rows={input[1]} />
              <Section title={app[0]} rows={app[1]} last />
            </Box>
            <Box flexDirection="column" width="50%" paddingRight={2}>
              <Section title={downloads[0]} rows={downloads[1]} last />
            </Box>
          </Box>
        ) : (
          SECTIONS.map(([t, r], i) => <Section key={t} title={t} rows={r} last={i === SECTIONS.length - 1} />)
        )}
      </Box>
    </Box>
  );
}
