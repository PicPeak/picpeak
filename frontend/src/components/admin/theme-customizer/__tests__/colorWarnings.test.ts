import { describe, it, expect } from 'vitest';
import { colorWarnings } from '../colorWarnings';

const dark = {
  colorMode: 'dark' as const,
  backgroundColor: '#0d0d0d',
  surfaceColor: '#1a1a1a',
  elevatedColor: '#242424',
  surfaceBorderColor: '#2e2e2e',
  textColor: '#ebebeb',
  mutedTextColor: '#a3a3a3',
  accentColor: '#22c55e',
  accentDarkColor: '#014e4e',
};

describe('colorWarnings', () => {
  it('flags a light raised panel under light text on a dark palette', () => {
    const warnings = colorWarnings({ ...dark, elevatedColor: '#f5f5f5' });
    expect(warnings.elevatedColor?.[0]).toMatchObject({ code: 'textOnElevated', needed: 4.5 });
    expect(warnings.textColor).toBeUndefined();
  });

  it('stays quiet for a readable palette and the default status hues', () => {
    expect(colorWarnings(dark)).toEqual({});
  });

  it('flags a washed-out status hue and one that matches the accent', () => {
    const warnings = colorWarnings(dark, { warning: '#fde047', success: '#014e4f' });
    expect(warnings['status.warning']?.map((w) => w.code)).toContain('statusTooLight');
    expect(warnings['status.success']?.map((w) => w.code)).toContain('statusLikeAccent');
  });

  it('ignores half-typed values', () => {
    expect(colorWarnings({ ...dark, elevatedColor: '#f5f' })).toEqual({});
  });
});
