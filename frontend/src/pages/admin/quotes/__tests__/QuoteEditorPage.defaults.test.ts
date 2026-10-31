/**
 * What a new quote starts with. It used to be German and CHF whatever the
 * business: the editor has no language field, so every quote went out in
 * German, and a customer's preferred language never applied because the
 * form's 'de' always won. Now the currency is the business's own, and the
 * language is the customer's, else left for the server to fill in with the
 * business's.
 */
import { describe, it, expect } from 'vitest';
import { buildPayload, newQuoteForm, languageForCustomer } from '../QuoteEditorPage';

describe('a new quote', () => {
  it('starts in the business\'s currency', () => {
    expect(newQuoteForm({ defaultCurrency: 'usd' }).currency).toBe('USD');
  });

  it('starts in CHF when the business has no currency set, as before', () => {
    expect(newQuoteForm(null).currency).toBe('CHF');
  });

  it('carries no language of its own, so the server picks the customer\'s or the business\'s', () => {
    expect(buildPayload(newQuoteForm({ defaultCurrency: 'USD' })).language).toBeFalsy();
  });
});

describe('picking a customer', () => {
  it('takes the customer\'s preferred language', () => {
    expect(languageForCustomer(newQuoteForm(null).language, { preferredLanguage: 'en' })).toBe('en');
  });

  it('keeps a language the quote already has', () => {
    expect(languageForCustomer('fr', { preferredLanguage: 'en' })).toBe('fr');
  });

  it('leaves it to the server when the customer has none either', () => {
    expect(languageForCustomer('', { preferredLanguage: null })).toBe('');
  });
});
