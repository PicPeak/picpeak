import { describe, expect, it } from 'vitest';
import { contrastRatio, getReadableForeground, isDarkBackground, readableAccentText, relativeLuminance } from '../contrast';

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

describe('contrastRatio', () => {
  it('is 1 for the same colour and 21 for black on white, in either order', () => {
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBe(1);
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
  });

  it('matches a known mid-tone pair', () => {
    // tailwind blue-600 on white, as published by WebAIM's checker.
    expect(contrastRatio('#2563EB', '#FFFFFF')).toBeCloseTo(5.17, 2);
  });
});

describe('readableAccentText', () => {
  it('keeps an accent that already reads', () => {
    expect(readableAccentText('#017C7C', '#FFFFFF')).toBe('#017C7C');
  });

  it('darkens a pastel accent on a light card until it reads, keeping its hue', () => {
    const text = readableAccentText('#E8B4A0', '#FFFFFF');
    expect(contrastRatio(text, '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    expect(text).not.toBe('#000000');
  });

  it('lightens a dark accent on a dark panel', () => {
    const text = readableAccentText('#014E4E', '#262626');
    expect(contrastRatio(text, '#262626')).toBeGreaterThanOrEqual(4.5);
    expect(relativeLuminance(text)).toBeGreaterThan(relativeLuminance('#014E4E'));
  });

  it('returns unparseable input unchanged', () => {
    expect(readableAccentText('var(--x)', '#FFFFFF')).toBe('var(--x)');
  });
});

describe('the black/white crossover (review of PR 1896)', () => {
  it('moves a failing accent toward black on a mid grey, where black reads better', () => {
    // #8a9a8a: luminance 0.30 — under 0.5, yet black gives 7.07:1 and white 2.97:1.
    const text = readableAccentText('#9aaa9a', '#8a9a8a');
    expect(contrastRatio(text, '#8a9a8a')).toBeGreaterThanOrEqual(4.5);
  });

  it('calls a background dark only when white reads better on it', () => {
    expect(isDarkBackground('#8a9a8a')).toBe(false);
    expect(isDarkBackground('#1a1a1a')).toBe(true);
    expect(isDarkBackground('#ffffff')).toBe(false);
  });
});
