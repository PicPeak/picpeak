'use strict';

/**
 * Sample data for previews (#1445): a recipient, three quote lines and their
 * totals. The theme preview draws a sample document with them; the contract
 * template preview and its pre-publication check fill a template's
 * placeholders and its line table with them, so a preview reads like a real
 * contract instead of one with every customer field empty.
 */

const SAMPLE_CUSTOMER = Object.freeze({
  first_name: 'Anna', last_name: 'Muster', display_name: 'Anna Muster',
  address_line1: 'Musterstrasse 1', postal_code: '9490', city: 'Vaduz', country_code: 'LI',
  email: 'anna@example.com',
});

const SAMPLE_TEXT = Object.freeze({
  de: {
    photography: 'Fotografie vor Ort',
    photographyNote: 'Vorbereitung, Trauung und Porträts',
    album: 'Album 30×30',
    discount: 'Vereinsrabatt',
    intro: 'Vorschau mit Beispieldaten — kein echtes Dokument.',
    blockName: 'Leistungsumfang',
    blockBody: 'Die Fotografin begleitet die Hochzeit am vereinbarten Tag. **Beispieltext** für die Vorschau.',
    closingName: 'Schlussbestimmungen',
    closingBody: 'Änderungen bedürfen der Schriftform. Beispieltext für die Vorschau.',
    eventName: 'Hochzeit Anna & Ben',
  },
  en: {
    photography: 'Photography on location',
    photographyNote: 'Getting ready, ceremony and portraits',
    album: 'Album 30×30',
    discount: 'Club discount',
    intro: 'Preview with sample data — not a real document.',
    blockName: 'Scope of services',
    blockBody: 'The photographer covers the wedding on the agreed day. **Sample text** for the preview.',
    closingName: 'Closing provisions',
    closingBody: 'Changes must be made in writing. Sample text for the preview.',
    eventName: 'Wedding Anna & Ben',
  },
});

const sampleText = (locale) => SAMPLE_TEXT[locale === 'en' ? 'en' : 'de'];

/** Three quote lines in the renderer's quote/invoice shape. */
function sampleLines(locale) {
  const text = sampleText(locale);
  return [
    { quantity: 8, unit: 'hour', description: text.photography, unitPriceMinor: 15000, discountPercent: 0,
      lineTotalMinor: 120000, detailsText: text.photographyNote },
    { quantity: 1, description: text.album, unitPriceMinor: 45000, discountPercent: 0, lineTotalMinor: 45000 },
    { quantity: 1, lineKind: 'discount', description: text.discount, unitPriceMinor: -10000, discountPercent: 0,
      lineTotalMinor: -10000 },
  ];
}

const SAMPLE_TOTALS = Object.freeze({
  netAmountMinor: 155000, vatRate: 8.1, vatAmountMinor: 12555, shippingAmountMinor: 0, totalAmountMinor: 167555,
});

/**
 * The same lines as a contract's frozen quote (renderContext snapshot
 * shape: DB column names, totals as the quote states them).
 */
function sampleContractQuote(locale, currency = 'CHF') {
  return {
    number: 'Q-2026-0107',
    currency: String(currency || 'CHF').toUpperCase(),
    lineItems: sampleLines(locale).map((li, index) => ({
      position: index + 1,
      parent_position: null,
      parent_line_item_id: null,
      line_kind: li.lineKind || 'item',
      description: li.description,
      details_text: li.detailsText || null,
      unit: li.unit || null,
      quantity: li.quantity,
      unit_price_minor: li.unitPriceMinor,
      discount_percent: 0,
      line_total_minor: li.lineTotalMinor,
      is_optional: false,
      promotion_snapshot: null,
    })),
    totals: {
      netMinor: SAMPLE_TOTALS.netAmountMinor,
      vatRatePercent: SAMPLE_TOTALS.vatRate,
      vatMinor: SAMPLE_TOTALS.vatAmountMinor,
      shippingMinor: SAMPLE_TOTALS.shippingAmountMinor,
      grossMinor: SAMPLE_TOTALS.totalAmountMinor,
    },
  };
}

module.exports = {
  SAMPLE_CUSTOMER,
  SAMPLE_TEXT,
  SAMPLE_TOTALS,
  sampleText,
  sampleLines,
  sampleContractQuote,
};
