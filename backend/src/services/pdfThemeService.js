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
const uploadedFonts = require('./pdf/uploadedFonts');

/** Bundled families plus the active uploaded ones (`upload-<id>`). */
async function allFamilies() {
  return [...availableFamilies(), ...(await uploadedFonts.uploadedFamilies()).map((f) => f.family)];
}

/**
 * A resolved theme with its uploaded font's files attached (#1445): the
 * renderer runs in a worker without a database, so an `upload-<id>` family
 * reaches it as server-resolved paths. An archived or missing font resolves
 * to nothing, and the document falls back to Helvetica.
 */
async function withFontFiles(theme) {
  if (!theme || !uploadedFonts.idOfFamily(theme.fontFamily)) return theme;
  const fontFiles = await uploadedFonts.fontFilesFor(theme.fontFamily);
  return fontFiles ? Object.freeze({ ...theme, fontFiles: Object.freeze(fontFiles) }) : theme;
}

async function loadRows() {
  const rows = await db('pdf_themes').select('scope', 'settings', 'updated_at');
  const byScope = {};
  const updatedAt = {};
  // Stored rows are checked again on read (theme.sanitizeStoredSettings).
  for (const row of rows) {
    byScope[row.scope] = themeModel.sanitizeStoredSettings(row.settings);
    updatedAt[row.scope] = row.updated_at || null;
  }
  return { byScope, updatedAt };
}

/** The resolved theme a document type renders with. */
async function resolveTheme(scope) {
  const { byScope } = await loadRows();
  const { profile } = await businessProfileService.getProfile();
  return withFontFiles(themeModel.resolveTheme(scope, byScope, profile));
}

/** Every scope's stored settings and, for document types, the resolved theme. */
async function listThemes() {
  const { byScope, updatedAt } = await loadRows();
  const { profile } = await businessProfileService.getProfile();
  return {
    themes: themeModel.SCOPES.map((scope) => {
      const resolved = themeModel.resolveTheme(scope, byScope, profile);
      return {
        scope,
        settings: byScope[scope] || {},
        updatedAt: updatedAt[scope] || null,
        resolved,
        // Readability warnings (#1445): shown next to the form, never enforced.
        warnings: themeModel.themeWarnings(resolved),
      };
    }),
    fontFamilies: availableFamilies(),
    // Uploaded fonts a theme may use, `[{ family: 'upload-<id>', name }]`.
    uploadedFonts: await uploadedFonts.uploadedFamilies(),
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
  const clean = themeModel.sanitizeThemeSettings(settings, { availableFamilies: await allFamilies() });
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
  const clean = themeModel.sanitizeThemeSettings(settings, { availableFamilies: await allFamilies() });
  const { byScope } = await loadRows();
  const { profile } = await businessProfileService.getProfile();
  const rows = { ...byScope, [scope]: clean };
  // Previewing the default scope shows its effect on a quote.
  const docScope = scope === 'default' ? 'quote' : scope;
  return withFontFiles(themeModel.resolveTheme(docScope, rows, profile));
}

// ---------------------------------------------------------------------
// Preview: a sample document through the real renderer
// ---------------------------------------------------------------------

const { SAMPLE_CUSTOMER, SAMPLE_TOTALS, sampleText, sampleLines } = require('./pdf/sampleData');

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
  const text = sampleText(locale);
  const currency = String((profile && profile.default_currency) || 'CHF').toUpperCase();
  const issuer = buildIssuerBlock(profile || {}, logoPath, { quoteToggles: docType === 'quote' });
  const recipient = buildRecipientBlock(profile || {}, SAMPLE_CUSTOMER);
  const issueDate = new Date().toISOString().slice(0, 10);

  const lines = sampleLines(locale);
  const totals = { ...SAMPLE_TOTALS };

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
