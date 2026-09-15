'use strict';

/**
 * PDF themes (#1445): read, save and resolve the theme rows in pdf_themes,
 * and render a sample document with them through the real pipeline.
 * See services/pdf/theme.js for the vocabulary and resolution order.
 */

const { db, logActivity } = require('../database/db');
const { AppError } = require('../utils/errors');
const { isUniqueViolation } = require('../utils/dbErrors');
const businessProfileService = require('./businessProfileService');
const themeModel = require('./pdf/theme');
const { availableFamilies } = require('./pdf/fonts');

async function loadRows() {
  const rows = await db('pdf_themes').select('scope', 'settings', 'updated_at');
  const byScope = {};
  const updatedAt = {};
  for (const row of rows) {
    byScope[row.scope] = themeModel.parseSettings(row.settings);
    updatedAt[row.scope] = row.updated_at || null;
  }
  return { byScope, updatedAt };
}

/** The resolved theme a document type renders with. */
async function resolveTheme(scope) {
  const { byScope } = await loadRows();
  const { profile } = await businessProfileService.getProfile();
  return themeModel.resolveTheme(scope, byScope, profile);
}

/** Every scope's stored settings and, for document types, the resolved theme. */
async function listThemes() {
  const { byScope, updatedAt } = await loadRows();
  const { profile } = await businessProfileService.getProfile();
  return {
    themes: themeModel.SCOPES.map((scope) => ({
      scope,
      settings: byScope[scope] || {},
      updatedAt: updatedAt[scope] || null,
      resolved: themeModel.resolveTheme(scope, byScope, profile),
    })),
    fontFamilies: availableFamilies(),
  };
}

function assertScope(scope) {
  if (!themeModel.SCOPES.includes(scope)) {
    throw new AppError('Unknown theme scope', 404, 'PDF_THEME_SCOPE_UNKNOWN');
  }
}

/** Replace a scope's settings. An empty object clears the scope. */
async function saveTheme(scope, settings, adminId) {
  assertScope(scope);
  const clean = themeModel.sanitizeThemeSettings(settings, { availableFamilies: availableFamilies() });
  const now = new Date();
  const values = { settings: JSON.stringify(clean), updated_by_admin_id: adminId || null, updated_at: now };
  const updated = await db('pdf_themes').where({ scope }).update(values);
  if (!updated) {
    try {
      await db('pdf_themes').insert({ scope, ...values, created_at: now });
    } catch (err) {
      // Two first saves at once: the unique scope index lets one insert win.
      if (!isUniqueViolation(err)) throw err;
      await db('pdf_themes').where({ scope }).update(values);
    }
  }
  try {
    await logActivity('pdf_theme_updated', { scope }, null, `admin:${adminId}`);
  } catch (_) { /* non-fatal */ }
  return listThemes();
}

/**
 * The theme a scope would resolve to with `settings` in place of its stored
 * row — what a preview shows before saving.
 */
async function resolveDraftTheme(scope, settings) {
  assertScope(scope);
  const clean = themeModel.sanitizeThemeSettings(settings, { availableFamilies: availableFamilies() });
  const { byScope } = await loadRows();
  const { profile } = await businessProfileService.getProfile();
  const rows = { ...byScope, [scope]: clean };
  // Previewing the default scope shows its effect on a quote.
  const docScope = scope === 'default' ? 'quote' : scope;
  return themeModel.resolveTheme(docScope, rows, profile);
}

// ---------------------------------------------------------------------
// Preview: a sample document through the real renderer
// ---------------------------------------------------------------------

const SAMPLE_CUSTOMER = {
  first_name: 'Anna', last_name: 'Muster', display_name: 'Anna Muster',
  address_line1: 'Musterstrasse 1', postal_code: '9490', city: 'Vaduz', country_code: 'LI',
  email: 'anna@example.com',
};

const SAMPLE_TEXT = {
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
  },
};

/**
 * Render a sample quote, invoice or contract with a scope's theme — the
 * stored one, or `settings` in its place when given (a preview before
 * saving). Uses the business profile's real letterhead and sample
 * recipient and lines.
 */
async function renderPreview(scope, settings) {
  const theme = settings ? await resolveDraftTheme(scope, settings) : await resolveTheme(scope === 'default' ? 'quote' : scope);
  const docType = theme.scope;
  const { profile } = await businessProfileService.getProfile();
  const { buildIssuerBlock, buildRecipientBlock } = require('./_renderContext');
  const { resolveLogoFile } = require('../utils/resolveLogoFile');
  const pdfService = require('./pdfService');
  const logoPath = await resolveLogoFile(profile);
  const locale = profile && profile.default_locale === 'en' ? 'en' : 'de';
  const text = SAMPLE_TEXT[locale];
  const currency = String((profile && profile.default_currency) || 'CHF').toUpperCase();
  const issuer = buildIssuerBlock(profile || {}, logoPath, { quoteToggles: docType === 'quote' });
  const recipient = buildRecipientBlock(profile || {}, SAMPLE_CUSTOMER);
  const issueDate = new Date().toISOString().slice(0, 10);

  const lines = [
    { quantity: 8, unit: 'hour', description: text.photography, unitPriceMinor: 15000, discountPercent: 0,
      lineTotalMinor: 120000, detailsText: text.photographyNote },
    { quantity: 1, description: text.album, unitPriceMinor: 45000, discountPercent: 0, lineTotalMinor: 45000 },
    { quantity: 1, lineKind: 'discount', description: text.discount, unitPriceMinor: -10000, discountPercent: 0,
      lineTotalMinor: -10000 },
  ];
  const totals = {
    netAmountMinor: 155000, vatRate: 8.1, vatAmountMinor: 12555, shippingAmountMinor: 0, totalAmountMinor: 167555,
  };

  if (docType === 'contract') {
    return pdfService.renderContractToBuffer({
      locale, issuer, recipient, theme,
      doc: { contractNumber: 'PREVIEW', title: '', issueDate, introText: text.intro },
      sections: [
        { section: 'scope', blocks: [{ name: text.blockName, body: text.blockBody }] },
        { section: 'commercial', blocks: [{ slug: 'quote_line_items_table', name: '', body: '' }] },
        { section: 'closing', blocks: [{ name: text.closingName, body: text.closingBody }] },
      ],
      quoteCurrency: currency,
      quoteLineItems: lines.map((li) => ({
        quantity: li.quantity, description: li.description, unit_price_minor: li.unitPriceMinor,
        discount_percent: 0, line_total_minor: li.lineTotalMinor, details_text: li.detailsText || null,
        line_kind: li.lineKind || 'item', unit: li.unit || null,
      })),
    });
  }
  const base = { locale, currency, issuer, recipient, theme, lineItems: lines, totals, qrFormat: 'none' };
  if (docType === 'invoice') {
    return pdfService.renderInvoiceToBuffer({
      ...base, doc: { invoiceNumber: 'PREVIEW', issueDate, introText: text.intro, totalAmountMinor: totals.totalAmountMinor },
    });
  }
  return pdfService.renderQuoteToBuffer({
    ...base, doc: { quoteNumber: 'PREVIEW', issueDate, introText: text.intro, totalAmountMinor: totals.totalAmountMinor },
  });
}

module.exports = {
  resolveTheme,
  listThemes,
  saveTheme,
  resolveDraftTheme,
  renderPreview,
};
