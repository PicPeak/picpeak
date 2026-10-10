import { describe, expect, it } from 'vitest';
import { uploadMultipartBudget } from '../uploadMultipartBudget';

describe('upload multipart framing budget', () => {
  it('leaves room for framing under both the default and lower proxy limits', () => {
    expect(uploadMultipartBudget()).toBe(95 * 1024 * 1024 - 128 * 1024);
    expect(uploadMultipartBudget(2 * 1024 * 1024)).toBe(2 * 1024 * 1024 - 128 * 1024);
    expect(uploadMultipartBudget(1024)).toBe(768);
  });
  it('cannot raise the default raw server limit through a settings-only change', () => {
    expect(uploadMultipartBudget(500 * 1024 * 1024)).toBe(uploadMultipartBudget());
    for (const invalid of [NaN, Infinity, 0, -1]) expect(uploadMultipartBudget(invalid)).toBe(uploadMultipartBudget());
  });
});
