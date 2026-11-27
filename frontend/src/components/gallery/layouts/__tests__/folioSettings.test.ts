/**
 * Gallery Folio's options from the theme JSON (issue 2617): stored as sent,
 * so anything unknown falls back, and the palettes stay readable.
 */
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../../../../utils/contrast';
import {
  FOLIO_PALETTE_COLORS,
  FOLIO_PALETTES,
  folioColumnsForWidth,
  folioPaletteStyle,
  folioSettings,
} from '../folioSettings';

describe('folioSettings', () => {
  it('defaults to a full cover, paper, classic type, regular spacing, 3 and 2 columns', () => {
    expect(folioSettings(undefined)).toEqual({
      cover: 'full', palette: 'paper', type: 'classic', spacing: 'regular',
      columns: { mobile: 2, desktop: 3 }, studioLabel: '',
    });
  });

  it('keeps known values and drops unknown ones', () => {
    expect(folioSettings({
      folioCover: 'split', folioPalette: 'charcoal', folioType: 'modern', folioSpacing: 'airy',
    })).toMatchObject({ cover: 'split', palette: 'charcoal', type: 'modern', spacing: 'airy' });
    expect(folioSettings({
      folioCover: 'diagonal', folioPalette: 'neon', folioType: 3, folioSpacing: null,
    } as never)).toMatchObject({ cover: 'full', palette: 'paper', type: 'classic', spacing: 'regular' });
  });

  it('clamps columns to 1–2 on a phone and 2–4 on a desktop', () => {
    expect(folioSettings({ folioColumns: { mobile: 5, desktop: 9 } }).columns).toEqual({ mobile: 2, desktop: 4 });
    expect(folioSettings({ folioColumns: { mobile: 0, desktop: 1 } }).columns).toEqual({ mobile: 1, desktop: 2 });
    expect(folioSettings({ folioColumns: { mobile: 'x', desktop: '3' } } as never).columns).toEqual({ mobile: 2, desktop: 3 });
  });

  it('trims the studio label to plain text of at most 60 characters', () => {
    expect(folioSettings({ folioStudioLabel: '  Studio Nord  ' }).studioLabel).toBe('Studio Nord');
    expect(folioSettings({ folioStudioLabel: 'x'.repeat(80) }).studioLabel).toHaveLength(60);
    expect(folioSettings({ folioStudioLabel: 42 } as never).studioLabel).toBe('');
  });
});

describe('folioColumnsForWidth', () => {
  it('gives a phone its own count and a tablet one column less than a desktop', () => {
    const columns = folioColumnsForWidth({ mobile: 1, desktop: 4 });
    expect([columns(390), columns(800), columns(1440)]).toEqual([1, 3, 4]);
    // Never fewer on a tablet than on a phone.
    expect(folioColumnsForWidth({ mobile: 2, desktop: 2 })(800)).toBe(2);
  });
});

describe('Folio palettes', () => {
  it.each(FOLIO_PALETTES)('%s keeps text and muted text at 4.5:1 or more', (palette) => {
    const colors = FOLIO_PALETTE_COLORS[palette];
    for (const ground of [colors.background, colors.surface, colors.elevated]) {
      expect(contrastRatio(colors.text, ground)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors.muted, ground)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('writes the palette as the theme tokens the gallery reads', () => {
    const style = folioPaletteStyle('charcoal') as Record<string, string>;
    expect(style['--color-background']).toBe('#1c1c1b');
    expect(style['--color-text']).toBe('#eeece7');
    expect(style.backgroundColor).toBe('#1c1c1b');
  });
});
