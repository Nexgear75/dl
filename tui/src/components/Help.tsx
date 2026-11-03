import React from 'react';
import { Box, Text } from 'ink';
import { ACCENT, DIM } from './theme';

const SECTIONS: [string, [string, string][]][] = [
  [
    'Navigation',
    [
      ['j / k  ↓ ↑', 'move'],
      ['gg / G', 'top / bottom'],
      ['ctrl-d / ctrl-u', 'half page down / up'],
      ['⏎', 'details · pick torrent files'],
    ],
  ],
  [
    'Downloads',
    [
      ['i  a', 'add a link, magnet or file'],
      ['p  space', 'pause / resume'],
      ['P', 'pause / resume all'],
      ['dd  x', 'remove (cancel deletes partial data)'],
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

export function Help({ width, height }: { width: number; height: number }) {
  return (
    <Box width={width} height={height} justifyContent="center">
      <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={2} width={Math.min(width, 64)}>
        <Text bold color={ACCENT}>
          Keys
        </Text>
        {SECTIONS.map(([title, rows]) => (
          <Box key={title} flexDirection="column" marginTop={1}>
            <Text bold>{title}</Text>
            {rows.map(([k, v]) => (
              <Box key={k}>
                <Box width={20}>
                  <Text color={ACCENT}>{k}</Text>
                </Box>
                <Text color={DIM}>{v}</Text>
              </Box>
            ))}
          </Box>
        ))}
        <Box marginTop={1}>
          <Text color={DIM}>any key to close</Text>
        </Box>
      </Box>
    </Box>
  );
}
