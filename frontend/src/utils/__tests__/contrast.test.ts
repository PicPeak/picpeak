import { describe, expect, it } from 'vitest';
import { getReadableForeground, relativeLuminance } from '../contrast';

describe('getReadableForeground', () => {
  describe('against the legacy hardcoded #ffffff fallback', () => {
    it('returns white for missing/empty/null input', () => {
      expect(getReadableForeground(undefined)).toBe('#ffffff');
      expect(getReadableForeground(null)).toBe('#ffffff');
      expect(getReadableForeground('')).toBe('#ffffff');
    });

    it('returns white for unparseable input (legacy behaviour preserved)', () => {
      expect(getReadableForeground('not-a-hex')).toBe('#ffffff');
      expect(getReadableForeground('#xyz')).toBe('#ffffff');
      expect(getReadableForeground('#12')).toBe('#ffffff');
    });
  });

  describe('chooses the higher-contrast foreground', () => {
    it('picks white on saturated mid-tone accents (typical UI accent)', () => {
      expect(getReadableForeground('#5C8762')).toBe('#ffffff'); // PicPeak default green
      expect(getReadableForeground('#22c55e')).toBe('#ffffff'); // tailwind green-500
      expect(getReadableForeground('#3b82f6')).toBe('#ffffff'); // tailwind blue-500
      expect(getReadableForeground('#ec4899')).toBe('#ffffff'); // tailwind pink-500
    });

    it('picks black on pale accents (the WCAG risk in PR #401 review)', () => {
      expect(getReadableForeground('#fef9c3')).toBe('#000000'); // tailwind yellow-100
      expect(getReadableForeground('#fde68a')).toBe('#000000'); // tailwind amber-200
      expect(getReadableForeground('#bfdbfe')).toBe('#000000'); // tailwind blue-200
      expect(getReadableForeground('#ffffff')).toBe('#000000'); // pure white
    });

    it('picks white on near-black accents', () => {
      expect(getReadableForeground('#000000')).toBe('#ffffff'); // pure black
      expect(getReadableForeground('#171717')).toBe('#ffffff'); // tailwind neutral-900
      expect(getReadableForeground('#1e293b')).toBe('#ffffff'); // tailwind slate-800
    });
  });

  describe('input format flexibility', () => {
    it('accepts #RGB shorthand', () => {
      expect(getReadableForeground('#fff')).toBe('#000000');
      expect(getReadableForeground('#000')).toBe('#ffffff');
    });

    it('accepts hex without leading #', () => {
      expect(getReadableForeground('5C8762')).toBe('#ffffff');
      expect(getReadableForeground('fff')).toBe('#000000');
    });

    it('is case-insensitive', () => {
      expect(getReadableForeground('#5c8762')).toBe('#ffffff');
      expect(getReadableForeground('#5C8762')).toBe('#ffffff');
    });
  });
});

describe('relativeLuminance', () => {
  it('returns 0 for black, 1 for white (WCAG anchors)', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 6);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 6);
  });

  it('returns 0 for unparseable input (defensive)', () => {
    expect(relativeLuminance('not-a-hex')).toBe(0);
  });
});
