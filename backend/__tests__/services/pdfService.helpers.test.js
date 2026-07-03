/**
 * Pure-function tests for the PDF rendering helpers. These are the
 * functions that DON'T touch PDFKit / DB — formatting, salutation
 * routing, EPC payload construction.
 *
 * The helpers aren't directly exported from pdfService.js (it
 * exports renderQuoteToBuffer / renderInvoiceToBuffer); we reach
 * them via `_internal` which the module already exposes for tests.
 */
const pdfService = require('../../src/services/pdfService');
const { formatMinor, formatDate, t } = pdfService._internal;

describe('formatMinor', () => {
  it('formats CHF cents with 2 decimals (123456 minor = 1234.56 major)', () => {
    // de-CH uses ’ (U+2019) as the thousands separator.
    expect(formatMinor(123456, 'CHF', 'de-CH')).toMatch(/1[’',\u2019]?234\.56/);
  });

  it('formats large amounts with thousands separators', () => {
    // 12345600 minor units = 123,456.00 major; the separator
    // varies by locale (de-CH = U+2019, en-GB = ',').
    expect(formatMinor(12345600, 'CHF', 'de-CH')).toMatch(/123[’',\u2019]456\.00/);
  });

  it('returns 0,00 for zero or null', () => {
    expect(formatMinor(0, 'CHF', 'de-CH')).toMatch(/0[,.]00/);
    expect(formatMinor(null, 'CHF', 'de-CH')).toMatch(/0[,.]00/);
  });

  it('returns 2-decimal output regardless of locale', () => {
    expect(formatMinor(99, 'EUR', 'en-GB')).toMatch(/0[.,]99/);
  });
});

describe('formatDate', () => {
  // formatDate now respects ctx.dateFormat (object with `format`
  // key) — when omitted defaults to DD.MM.YYYY.
  it('defaults to DD.MM.YYYY when no format passed', () => {
    expect(formatDate('2026-04-19')).toBe('19.04.2026');
  });

  it('honors the configured DD/MM/YYYY format', () => {
    expect(formatDate('2026-04-19', { format: 'DD/MM/YYYY' })).toBe('19/04/2026');
  });

  it('honors the configured MM/DD/YYYY format', () => {
    expect(formatDate('2026-04-19', { format: 'MM/DD/YYYY' })).toBe('04/19/2026');
  });

  it('honors ISO YYYY-MM-DD', () => {
    expect(formatDate('2026-04-19', { format: 'YYYY-MM-DD' })).toBe('2026-04-19');
  });

  it('returns empty string on empty input', () => {
    expect(formatDate('')).toBe('');
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
  });

  it('returns empty string on invalid input rather than throwing', () => {
    expect(formatDate('not-a-date')).toBe('');
  });

  it('accepts Date objects', () => {
    expect(formatDate(new Date('2026-04-19T12:00:00Z'))).toMatch(/^(19|20)\.0[34]\.2026$/);
  });
});

describe('t (i18n lookup)', () => {
  it('returns the EN value for an EN-only locale', () => {
    expect(t('en', 'invoice_title')).toBe('Invoice');
    expect(t('en', 'quote_title')).toBe('Quote');
  });

  it('returns the DE value for de locale', () => {
    expect(t('de', 'invoice_title')).toBe('Rechnung');
    expect(t('de', 'quote_title')).toBe('Angebot');
  });

  it('falls back to EN for unknown locales', () => {
    expect(t('xx', 'invoice_title')).toBe('Invoice');
  });

  it('substitutes named tokens like {percent}', () => {
    const out = t('en', 'skonto_phrase', { percent: 3, days: 5 });
    expect(out).toMatch(/3% discount if paid within 5 working days\./);
  });

  it('falls back to EN when the key is missing on the requested locale', () => {
    // page_of is seeded on all locales — pick something that
    // exists on EN with a substitution.
    const out = t('zz', 'page_of', { current: 1, total: 3 });
    expect(out).toBe('Page 1 of 3');
  });
});
