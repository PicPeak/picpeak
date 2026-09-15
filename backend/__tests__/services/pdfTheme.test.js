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
