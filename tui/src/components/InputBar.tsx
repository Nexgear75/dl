import React from 'react';
import { Box, Text } from 'ink';
import type { Suggestion } from '../lib/complete';
import { truncate, width as strWidth } from '../lib/format';
import { ACCENT, DIM } from './theme';

export const MAX_SUGGESTIONS = 8;

export function suggestionsHeight(count: number): number {
  if (count === 0) return 0;
  return Math.min(count, MAX_SUGGESTIONS) + (count > MAX_SUGGESTIONS ? 1 : 0);
}

export function Suggestions({ items, sel, width }: { items: Suggestion[]; sel: number; width: number }) {
  if (items.length === 0) return null;
  const visible = Math.min(items.length, MAX_SUGGESTIONS);
  const start = Math.min(Math.max(0, sel - visible + 1), items.length - visible);
  const slice = items.slice(start, start + visible);
  return (
    <Box flexDirection="column" width={width}>
      {slice.map((s, i) => {
        const idx = start + i;
        const active = idx === sel;
        const label = truncate(s.name + (s.isDir ? '/' : ''), width - 8);
        return (
          <Box key={s.value}>
            <Text color={DIM}>{'      '}</Text>
            <Text
              color={active ? 'black' : s.isDir ? 'blueBright' : undefined}
              backgroundColor={active ? ACCENT : undefined}
              bold={s.isDir}
            >
              {' '}
              {label}{' '}
            </Text>
          </Box>
        );
      })}
      {items.length > MAX_SUGGESTIONS ? (
        <Text color={DIM}>
          {'       '}
          {sel + 1}/{items.length}
        </Text>
      ) : null}
    </Box>
  );
}

interface InputLineProps {
  label: string;
  color: string;
  value: string;
  cursor: number;
  width: number;
  tag?: { text: string; color: string } | null;
  placeholder?: string;
}

export function InputLine({ label, color, value, cursor, width, tag, placeholder }: InputLineProps) {
  const tagText = tag ? ` ${tag.text} ` : '';
  const room = Math.max(10, width - strWidth(label) - 4 - strWidth(tagText) - 1);
  // keep the cursor visible by scrolling the text horizontally
  const chars = Array.from(value);
  let start = 0;
  if (cursor > room - 1) start = cursor - room + 1;
  const visible = chars.slice(start, start + room);
  const rel = cursor - start;
  const before = visible.slice(0, rel).join('');
  const at = visible[rel] ?? ' ';
  const after = visible.slice(rel + 1).join('');
  return (
    <Box width={width}>
      <Text backgroundColor={color} color="black" bold>
        {` ${label} `}
      </Text>
      <Text color={color}> › </Text>
      <Box flexGrow={1}>
        {value === '' && placeholder ? (
          <Text>
            <Text inverse> </Text>
            <Text color={DIM}>{truncate(placeholder, room - 1)}</Text>
          </Text>
        ) : (
          <Text>
            {before}
            <Text inverse>{at}</Text>
            {after}
          </Text>
        )}
      </Box>
      {tag ? (
        <Text backgroundColor={tag.color} color="black" bold>
          {tagText}
        </Text>
      ) : null}
    </Box>
  );
}
