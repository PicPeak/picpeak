/**
 * PDF theme model (#1445): the built-in look, the resolution order and the
 * settings vocabulary.
 */

const theme = require('../../src/services/pdf/theme');

const codeOf = (fn) => {
  try { fn(); return null; } catch (err) { return err.code; }
};

describe('resolveTheme', () => {
  test('with nothing stored, every document keeps the look it had', () => {
    const quote = theme.resolveTheme('quote', {}, null);
    expect(quote.colors).toEqual({
      text: '#000000', muted: '#666666', subtle: '#888888', accent: '#000000', rule: '#888888',
    });
    expect(quote.titleSize).toBe(20);
    expect(quote.footer).toEqual({ mode: 'address', text: '' });
    expect(quote.pageNumbers).toBe('bottom-right');
    expect(quote.foldingMarks).toBe('none');
    expect(quote.fontFamily).toBeNull();

    const contract = theme.resolveTheme('contract', {}, null);
    expect(contract.titleSize).toBe(18);
    expect(contract.footer.mode).toBe('none');
  });

  test('the scope row beats the default row, which beats the business profile', () => {
    const rows = {
      default: { colors: { accent: '#112233' }, titleSize: 22, foldingMarks: 'half', fontFamily: 'Inter' },
      invoice: { colors: { text: '#101010' }, titleSize: 24 },
    };
    const profile = { pdf_font_family: 'Jost', pdf_folding_marks: 'third' };

    const invoice = theme.resolveTheme('invoice', rows, profile);
    expect(invoice.colors.accent).toBe('#112233');
    expect(invoice.colors.text).toBe('#101010');
    expect(invoice.colors.rule).toBe('#888888');
    expect(invoice.titleSize).toBe(24);
    expect(invoice.foldingMarks).toBe('half');
    expect(invoice.fontFamily).toBe('Inter');

    const quote = theme.resolveTheme('quote', {}, profile);
    expect(quote.fontFamily).toBe('Jost');
    expect(quote.foldingMarks).toBe('third');

    // Contracts had no folding marks; only a theme row turns them on.
    expect(theme.resolveTheme('contract', {}, profile).foldingMarks).toBe('none');
    expect(theme.resolveTheme('contract', { contract: { foldingMarks: 'third' } }, profile).foldingMarks).toBe('third');
  });

  test('the resolved theme is frozen', () => {
    const resolved = theme.resolveTheme('quote', {}, null);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.colors)).toBe(true);
  });
});

describe('sanitizeThemeSettings', () => {
  const availableFamilies = ['Inter', 'Jost'];

  test('keeps valid values, normalises them and drops unknown keys', () => {
    expect(theme.sanitizeThemeSettings({
      colors: { accent: '#AABBCC', text: '' },
      titleSize: '22.4',
      footer: { mode: 'custom', text: '  Studio   Test  ' },
      pageNumbers: 'bottom-center',
      foldingMarks: 'both',
      fontFamily: 'Jost',
      css: 'body { color: red }',
    }, { availableFamilies })).toEqual({
      colors: { accent: '#aabbcc' },
      titleSize: 22,
      footer: { mode: 'custom', text: 'Studio Test' },
      pageNumbers: 'bottom-center',
      foldingMarks: 'both',
      fontFamily: 'Jost',
    });
  });

  test('an address or empty footer carries no text', () => {
    expect(theme.sanitizeThemeSettings({ footer: { mode: 'none', text: 'ignored' } })).toEqual({
      footer: { mode: 'none', text: '' },
    });
  });

  test.each([
    [{ colors: { text: 'red' } }],
    [{ colors: { text: 'url(https://example.com)' } }],
    [{ titleSize: 64 }],
    [{ footer: { mode: 'html' } }],
    [{ footer: { mode: 'custom', text: '' } }],
    [{ footer: { mode: 'custom', text: 'x'.repeat(201) } }],
    [{ pageNumbers: 'top' }],
    [{ foldingMarks: 'quarter' }],
    [{ fontFamily: '../../etc' }],
    [{ fontFamily: 'Comic-Sans' }],
  ])('refuses %j', (input) => {
    expect(codeOf(() => theme.sanitizeThemeSettings(input, { availableFamilies }))).toBe('PDF_THEME_INVALID');
  });
});

describe('layout (#1445)', () => {
  test('margins, address window, logo, body size and line height are validated within their bounds', () => {
    expect(theme.sanitizeThemeSettings({
      layout: { margins: { left: 25, right: 15, bottom: 20 }, addressWindow: false },
      logo: { position: 'center', stack: 'inline' },
      bodySize: 11,
      lineHeight: 1.4,
    })).toEqual({
      layout: { margins: { left: 25, right: 15, bottom: 20 }, addressWindow: false },
      logo: { position: 'center', stack: 'inline' },
      bodySize: 11,
      lineHeight: 1.4,
    });
    for (const bad of [
      { layout: { margins: { left: 19 } } }, { layout: { margins: { left: 31 } } },
      { layout: { margins: { right: 9 } } }, { layout: { margins: { right: 26 } } },
      { layout: { margins: { bottom: 14 } } }, { layout: { margins: { bottom: 31 } } },
      { layout: { margins: { top: 20 } } },
      { layout: { addressWindow: 'no' } },
      { logo: { position: 'top' } }, { logo: { stack: 'behind' } },
      { bodySize: 8.5 }, { bodySize: 12.5 }, { lineHeight: 1.1 }, { lineHeight: 1.7 },
    ]) {
      const code = codeOf(() => theme.sanitizeThemeSettings(bad));
      // `top` is not a setting: it is dropped, not refused.
      if (bad.layout && bad.layout.margins && 'top' in bad.layout.margins) {
        expect(theme.sanitizeThemeSettings(bad)).toEqual({});
      } else {
        expect(code).toBe('PDF_THEME_INVALID');
      }
    }
  });

  test('the built-in layout is the old one, and a scope inherits margins key by key', () => {
    const quote = theme.resolveTheme('quote', {}, null);
    expect(quote.layout).toEqual({ margins: null, addressWindow: true });
    expect(quote.logo).toEqual({ position: 'right', stack: 'above' });
    expect(quote.bodySize).toBe(10);
    expect(quote.lineHeight).toBeNull();

    const contract = theme.resolveTheme('contract', {
      default: { layout: { margins: { left: 25, bottom: 20 } }, bodySize: 11 },
      contract: { layout: { margins: { left: 30 }, addressWindow: false } },
    }, null);
    expect(contract.layout).toEqual({ margins: { left: 30, bottom: 20 }, addressWindow: false });
    expect(contract.bodySize).toBe(11);
  });

  test('readability warnings: contrast, small text, tight lines, long lines — none for the built-in look', () => {
    expect(theme.themeWarnings(theme.resolveTheme('quote', {}, null))).toEqual([]);
    const codes = (settings) => theme.themeWarnings(theme.resolveTheme('quote', { quote: settings }, null))
      .map((w) => `${w.code}${w.key ? `:${w.key}` : ''}`);
    expect(codes({ colors: { text: '#999999' } })).toContain('CONTRAST_LOW:text');
    expect(codes({ colors: { muted: '#aaaaaa' } })).toContain('CONTRAST_LOW:muted');
    expect(codes({ colors: { accent: '#dddddd' } })).toContain('CONTRAST_LOW:accent');
    expect(codes({ colors: { accent: '#777777' } })).not.toContain('CONTRAST_LOW:accent');
    expect(codes({ bodySize: 9 })).toEqual(expect.arrayContaining(['BODY_SIZE_SMALL', 'LINE_TOO_LONG']));
    expect(codes({ lineHeight: 1.25 })).toContain('LINE_HEIGHT_TIGHT');
    expect(codes({ lineHeight: 1.4 })).toEqual([]);
    // Wider margins shorten the line again.
    expect(codes({ bodySize: 9, layout: { margins: { left: 30, right: 25 } } })).not.toContain('LINE_TOO_LONG');
  });
});
