import React from 'react';
import { Box, Text } from 'ink';
import type { Global } from '../lib/types';
import { formatSpeed, tildify } from '../lib/format';
import { ACCENT, DIM } from './theme';

interface Props {
  global: Global | null;
  width: number;
  connection: 'connected' | 'reconnecting';
}

export function Header({ global, width, connection }: Props) {
  const g = global;
  return (
    <Box flexDirection="column" width={width}>
      <Box justifyContent="space-between" width={width}>
        <Box>
          <Text backgroundColor={ACCENT} color="black" bold>
            {' dl '}
          </Text>
          <Text> </Text>
          <Text color={ACCENT} bold>
            ↓ {formatSpeed(g?.down ?? 0)}
          </Text>
          <Text color={DIM}>{'   '}↑ {formatSpeed(g?.up ?? 0)}</Text>
          {g && g.limit > 0 ? <Text color="yellow">{'   '}limit {formatSpeed(g.limit)}</Text> : null}
        </Box>
        <Box>
          {connection === 'reconnecting' ? (
            <Text color="red">daemon reconnecting… </Text>
          ) : (
            <Text color={DIM}>
              {g ? `${g.active} active · ${g.total} total · ${tildify(g.download_dir)} ` : 'connecting… '}
            </Text>
          )}
        </Box>
      </Box>
      <Text color={DIM}>{'─'.repeat(Math.max(0, width))}</Text>
    </Box>
  );
}
