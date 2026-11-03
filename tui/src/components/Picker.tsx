import React from 'react';
import { Box, Text } from 'ink';
import { padEnd, truncate } from '../lib/format';
import { ACCENT, DIM } from './theme';

export interface PickerItem {
  label: string;
  hint?: string;
}

export interface PickerProps {
  title: string;
  subtitle?: string;
  items: PickerItem[];
  multi: boolean;
  cursor: number;
  checked: boolean[];
  width: number;
  height: number;
}

function chromeHeight(hasSubtitle: boolean, multi: boolean): number {
  // border (2) + title + subtitle? + blank + status line (multi only) + hints
  return 2 + 1 + (hasSubtitle ? 1 : 0) + 1 + (multi ? 1 : 0) + 1;
}

/** Height the picker wants, capped to `max`. */
export function pickerHeight(items: number, hasSubtitle: boolean, multi: boolean, max: number): number {
  return Math.min(max, chromeHeight(hasSubtitle, multi) + items);
}

export function Picker({ title, subtitle, items, multi, cursor, checked, width, height }: PickerProps) {
  const boxWidth = Math.min(width, 90);
  const inner = boxWidth - 4;
  const chrome = chromeHeight(!!subtitle, multi);
  const visible = Math.max(1, height - chrome);
  const start = Math.min(Math.max(0, cursor - Math.floor(visible / 2)), Math.max(0, items.length - visible));
  const slice = items.slice(start, start + visible);
  const count = checked.filter(Boolean).length;
  const hints = multi
    ? '↑↓ move · space toggle · a all/none · ⏎ confirm · esc cancel'
    : '↑↓ move · ⏎ select · esc cancel';

  return (
    <Box width={width} height={height} justifyContent="center" flexShrink={0}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={ACCENT}
        width={boxWidth}
        paddingX={1}
        height={Math.min(height, chrome + slice.length)}
      >
        <Text bold color={ACCENT}>
          {truncate(title, inner)}
        </Text>
        {subtitle ? <Text color={DIM}>{truncate(subtitle, inner)}</Text> : null}
        <Text> </Text>
        {slice.map((it, i) => {
          const idx = start + i;
          const active = idx === cursor;
          const box = multi ? (checked[idx] ? '[x] ' : '[ ] ') : '';
          const hint = it.hint ?? '';
          const labelWidth = inner - 2 - box.length - hint.length - 1;
          return (
            <Box key={idx}>
              <Text color={active ? ACCENT : DIM}>{active ? '› ' : '  '}</Text>
              <Text color={multi && checked[idx] ? 'green' : DIM}>{box}</Text>
              <Text bold={active} color={active ? 'whiteBright' : undefined}>
                {padEnd(truncate(it.label, labelWidth), labelWidth)}
              </Text>
              <Text color={DIM}> {hint}</Text>
            </Box>
          );
        })}
        {multi ? (
          <Text color={DIM}>
            {count} selected{items.length > visible ? `  ·  ${cursor + 1}/${items.length}` : ''}
          </Text>
        ) : null}
        <Text color={DIM}>{truncate(hints, inner)}</Text>
      </Box>
    </Box>
  );
}
