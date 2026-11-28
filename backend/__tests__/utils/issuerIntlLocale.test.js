'use strict';

jest.mock('../../src/database/db', () => ({ db: jest.fn() }));
const { issuerIntlLocale, languageIntlLocale } = require('../../src/utils/issuerIntlLocale');
const { _internal: { formatVatRate } } = require('../../src/services/taxReportService');
const { _internal: { localeForIntl, formatMinor } } = require('../../src/services/pdfService');

// pt documents and emails are Brazilian Portuguese, so they write 1.000,00
// instead of falling back to en-GB's 1,000.00 (issue 2617).
describe('Intl locale for documents', () => {
  test('a document language picks its number format', () => {
    expect(languageIntlLocale('de')).toBe('de-CH');
    expect(languageIntlLocale('pt')).toBe('pt-BR');
    expect(languageIntlLocale('en')).toBe('en-GB');
    expect(languageIntlLocale('fr')).toBe('en-GB');
    expect(languageIntlLocale(undefined)).toBe('en-GB');
  });

  test('a Brazilian business writes Brazilian numbers whatever the document language', () => {
    expect(issuerIntlLocale('BR')).toBe('pt-BR');
    expect(issuerIntlLocale('br')).toBe('pt-BR');
    expect(issuerIntlLocale('CH')).toBe('de-CH');
    expect(issuerIntlLocale('FR')).toBeNull();
  });

  test('a pt PDF writes amounts the way the pt email and the frontend do', () => {
    expect(localeForIntl('pt', null)).toBe('pt-BR');
    // pt-PT leaves a four-digit amount ungrouped: "1234,50".
    expect(formatMinor(123450, 'EUR', localeForIntl('pt', null))).toBe('1.234,50');
  });

  // The PDF renderer and the emails do not share one table. They agree on
  // en, de and pt; a French, Dutch or Russian PDF keeps its own format while
  // the matching email falls back to en-GB. Pinned so that stays a decision.
  test.each([
    ['en', 'en-GB', 'en-GB'],
    ['de', 'de-CH', 'de-CH'],
    ['pt', 'pt-BR', 'pt-BR'],
    ['fr', 'fr-CH', 'en-GB'],
    ['nl', 'nl-NL', 'en-GB'],
    ['ru', 'ru-RU', 'en-GB'],
  ])('%s: PDF %s, email %s', (language, pdf, email) => {
    expect(localeForIntl(language, null)).toBe(pdf);
    expect(languageIntlLocale(language)).toBe(email);
  });

  test('the tax report formats a pt VAT rate with a decimal comma', () => {
    expect(formatVatRate(7.7, 'pt')).toBe('7,7 %');
    expect(formatVatRate(7.7, 'en')).toBe('7.7 %');
  });
});
