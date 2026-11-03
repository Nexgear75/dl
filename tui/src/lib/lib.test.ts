import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bar, formatBytes, formatEta, parseSize, truncate, width } from './format';
import { isPathLike, suggest } from './complete';

describe('format', () => {
  test('bytes (base 1024)', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(12.4 * 1024 * 1024)).toBe('12.4 MB');
    expect(formatBytes(512 * 1024 * 1024)).toBe('512 MB');
  });
  test('eta', () => {
    expect(formatEta(42)).toBe('42s');
    expect(formatEta(125)).toBe('2m05s');
    expect(formatEta(3720)).toBe('1h02m');
    expect(formatEta(Infinity)).toBe('--');
  });
  test('bar always fills its width', () => {
    for (const r of [0, 0.13, 0.5, 0.999, 1]) {
      const [a, b] = bar(r, 37);
      expect(width(a + b)).toBe(37);
    }
  });
  test('truncate handles wide chars', () => {
    expect(width(truncate('日本語のタイトルです', 9))).toBeLessThanOrEqual(9);
    expect(truncate('short', 10)).toBe('short');
  });
  test('parseSize', () => {
    expect(parseSize('2M')).toBe(2 * 1024 * 1024);
    expect(parseSize('500k')).toBe(500 * 1024);
    expect(parseSize('1.5 MB')).toBe(1572864);
    expect(parseSize('')).toBe(0);
    expect(parseSize('fast')).toBeNull();
  });
});

describe('complete', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-complete-'));
  fs.mkdirSync(path.join(root, 'Movies'));
  fs.mkdirSync(path.join(root, 'music'));
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.writeFileSync(path.join(root, 'links.txt'), '');
  fs.writeFileSync(path.join(root, 'ubuntu.torrent'), '');
  fs.writeFileSync(path.join(root, 'photo.jpg'), '');

  test('path detection', () => {
    expect(isPathLike('~/x')).toBe(true);
    expect(isPathLike('./x')).toBe(true);
    expect(isPathLike('https://x')).toBe(false);
  });
  test('link mode lists dirs first and only useful files', () => {
    const names = suggest(root + '/', 'link').map((s) => s.name);
    expect(names).toEqual(['Movies', 'music', 'links.txt', 'ubuntu.torrent']);
  });
  test('dir mode lists only directories', () => {
    expect(suggest(root + '/', 'dir').map((s) => s.name)).toEqual(['Movies', 'music']);
  });
  test('case-insensitive prefix then fuzzy', () => {
    expect(suggest(root + '/mu', 'dir')[0].name).toBe('music');
    expect(suggest(root + '/ubt', 'link').map((s) => s.name)).toEqual(['ubuntu.torrent']);
  });
  test('hidden files only when asked', () => {
    expect(suggest(root + '/.h', 'dir').map((s) => s.name)).toEqual(['.hidden']);
  });
  test('accepted value appends a slash to dirs', () => {
    expect(suggest(root + '/Mov', 'dir')[0].value).toBe(root + '/Movies/');
  });
});

import { splitBurst } from './keys';

describe('key bursts', () => {
  test('splits text, enter and ctrl keys', () => {
    expect(splitBurst('j\r\x15/tmp', {})).toEqual([
      ['j', {}],
      ['', { return: true }],
      ['u', { ctrl: true }],
      ['/tmp', {}],
    ]);
  });
  test('leaves plain input alone', () => {
    expect(splitBurst('abc', {})).toEqual([['abc', {}]]);
    expect(splitBurst('d', { ctrl: true })).toEqual([['d', { ctrl: true }]]);
  });
});
