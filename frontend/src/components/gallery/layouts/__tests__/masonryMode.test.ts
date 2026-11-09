import { describe, it, expect } from 'vitest';
import { masonryModeOf } from '../masonryMode';

describe('masonryModeOf (issue 2444)', () => {
  it('keeps every mode Masonry renders', () => {
    for (const mode of ['columns', 'rows', 'flickr', 'quilted']) {
      expect(masonryModeOf(mode)).toBe(mode);
    }
  });

  it('renders the "Google Photos" option as justified rows', () => {
    expect(masonryModeOf('justified')).toBe('rows');
  });

  it('falls back to columns for a missing or unknown value', () => {
    for (const value of [undefined, null, '', 'grid', 'Rows', 42]) {
      expect(masonryModeOf(value)).toBe('columns');
    }
  });
});
