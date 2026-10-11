import { describe, expect, it } from 'vitest';
import { parseWholeNumber } from '../wholeNumber';

describe('parseWholeNumber', () => {
  it('reads the whole text, not a prefix', () => {
    expect(parseWholeNumber('300')).toBe(300);
    expect(parseWholeNumber(' 40 ')).toBe(40);
    // What a number input accepts for one hundred; parseInt made it 1.
    expect(parseWholeNumber('1e2')).toBe(100);
  });

  it('is null for anything that is not a whole number', () => {
    for (const text of ['', '  ', '2.5', 'abc', '12abc', '1e-1']) expect(parseWholeNumber(text)).toBeNull();
  });
});
