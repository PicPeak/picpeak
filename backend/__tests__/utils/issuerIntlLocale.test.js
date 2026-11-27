'use strict';

jest.mock('../../src/database/db', () => ({ db: jest.fn() }));
const { issuerIntlLocale, languageIntlLocale } = require('../../src/utils/issuerIntlLocale');
const { _internal: { formatVatRate } } = require('../../src/services/taxReportService');

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

  test('the tax report formats a pt VAT rate with a decimal comma', () => {
    expect(formatVatRate(7.7, 'pt')).toBe('7,7 %');
    expect(formatVatRate(7.7, 'en')).toBe('7.7 %');
  });
});
