import { describe, expect, it } from 'vitest';
import { sentBytes } from '../transfers.service';

describe('sentBytes', () => {
  it('counts a finished multipart body as exactly its file bytes', () => {
    // 98,566,145 file bytes in a 98,566,345-byte body: scaling loaded/total
    // can land a hair below the file size in floating point.
    expect(sentBytes(98_566_145, 98_566_345, 98_566_345)).toBe(98_566_145);
  });

  it('scales a body still in flight and reports nothing without a total', () => {
    expect(sentBytes(1000, 50, 100)).toBe(500);
    expect(sentBytes(1000, 50, undefined)).toBe(0);
    expect(sentBytes(1000, 50, 0)).toBe(0);
  });
});
