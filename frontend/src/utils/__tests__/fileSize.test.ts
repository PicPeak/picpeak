import { describe, expect, it } from 'vitest';
import { formatBytesOneDecimal, formatBytesShort, formatFileSize } from '../fileSize';

// Each formatter keeps the exact strings of the copies it replaced, quirks
// included (no unit past TB, negatives render NaN), so every screen reads as before.
const KB = 1024;
const MB = KB ** 2;
const GB = KB ** 3;
const TB = KB ** 4;

describe('formatFileSize', () => {
  it.each([
    [0, '0 B'],
    [1, '1 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [1.5 * MB, '1.5 MB'],
    [10 * MB, '10 MB'],
    [MB - 1, '1024 KB'],
    [5 * GB, '5.0 GB'],
    [1.5 * TB, '1536 GB'],
    [-1, '0 B'],
    [Number.NaN, '0 B'],
    [null, '0 B'],
    [undefined, '0 B'],
  ])('%s -> %s', (input, expected) => {
    expect(formatFileSize(input as number | null | undefined)).toBe(expected);
  });
});

describe('formatBytesShort (backup dashboard, history, restore wizard)', () => {
  it.each([
    [0, '0 B'],
    [null, '0 B'],
    [undefined, '0 B'],
    [Number.NaN, '0 B'],
    [1, '1 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [1.5 * MB, '1.5 MB'],
    [MB - 1, '1024 KB'],
    [5 * GB, '5 GB'],
    [1.5 * TB, '1.5 TB'],
    [2048 * TB, '2 undefined'],
    [-1, 'NaN undefined'],
  ])('%s -> %s', (input, expected) => {
    expect(formatBytesShort(input as number | null | undefined)).toBe(expected);
  });
});

describe('formatBytesOneDecimal (backup coverage, per-path backup sizes)', () => {
  it.each([
    [0, '0 B'],
    [null, '0 B'],
    [undefined, '0 B'],
    [Number.NaN, '0 B'],
    [1, '1 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [1.5 * MB, '1.5 MB'],
    [MB - 1, '1024.0 KB'],
    [5 * GB, '5.0 GB'],
    [1.5 * TB, '1.5 TB'],
    [2048 * TB, '2048.0 TB'],
    [-1, 'NaN undefined'],
  ])('%s -> %s', (input, expected) => {
    expect(formatBytesOneDecimal(input as number | null | undefined)).toBe(expected);
  });
});
