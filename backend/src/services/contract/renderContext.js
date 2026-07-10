// Extracted verbatim from contractService.js — see ../contractService.js for the
// module-level overview. Do not add behavior here without updating the entry re-exports.

const { db } = require('../../database/db');
const { getAppSetting } = require('../../utils/appSettings');
const { formatShortDate } = require('../../utils/dateFormatter');
const businessProfileService = require('../businessProfileService');
const { buildIssuerBlock, buildRecipientBlock } = require('../_renderContext');
const { ensureInt } = require('../../utils/numericHelpers');
const { SECTIONS_ORDER } = require('./helpers');


/**
 * Handlebars-lite renderer:
 *   - `{{#if var}}…{{/if}}` blocks resolved by truthiness of variables[var].
 *   - `{{var}}` substituted with the matching variable. Missing
 *     placeholders are left literally as `{{var}}` so the admin
 *     notices the unresolved field in preview.
 *
 * Mirrors safeTemplateReplace in emailProcessor.js (lines 424-461) but
 * without HTML escaping — contract bodies are rendered into PDF via
 * pdfService.drawText, which doesn't need HTML safety.
 */
function renderTemplatedBody(template, variables) {
  if (typeof template !== 'string' || template.length === 0) return template;
  const conditionalsResolved = template.replace(
    /\{\{#if\s+(\w+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, key, inner) => {
      const v = variables ? variables[key] : undefined;
      const truthy = v !== undefined && v !== null && v !== '' && v !== false && v !== 0;
      return truthy ? inner : '';
    }
  );
  return conditionalsResolved.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!variables || !Object.prototype.hasOwnProperty.call(variables, key)) return match;
    return String(variables[key]);
  });
}

/**
 * Build the variable bag used by renderTemplatedBody. Reads the
 * customer record, business profile, and (when available) the
 * customer's active payment-term defaults so block placeholders for
 * net_days / skonto_percent / etc. resolve. Returns plain strings —
 * dates formatted DD.MM.YYYY in DE-CH style, numbers as-is.
 */
async function buildPlaceholderContext(contract, customer) {
  const profile = (await businessProfileService.getProfile()).profile || {};
  const issuerCompany = profile.company_name || '';
  const issuerAddress = [profile.address_line1, profile.postal_code, profile.city]
    .filter(Boolean)
    .join(', ');

  // Resolve net_days + skonto from app_settings defaults so the
  // payment_terms_reference block has sensible numbers to substitute
  // when the admin hasn't tied the contract to a specific quote.
  const netDaysDefault = ensureInt(await getAppSetting('crm_payment_default_net_days')) || 30;
  const skontoPercentDefault = await getAppSetting('crm_invoices_skonto_percent_default');
  const skontoWithinDaysDefault = ensureInt(await getAppSetting('crm_invoices_skonto_business_days')) || 5;

  // {{source_quote_number}} placeholder — substituted into the body of
  // the `quote_line_items_table` system block (and any admin-authored
  // block that wants to reference the quote). Empty string when the
  // contract wasn't generated from a quote.
  let sourceQuoteNumber = '';
  if (contract.source_quote_id) {
    const srcQuote = await db('quotes').where({ id: contract.source_quote_id })
      .select('quote_number').first();
    if (srcQuote) sourceQuoteNumber = srcQuote.quote_number || '';
  }

  const customerName = customer
    ? (customer.company_name
        || [customer.first_name, customer.last_name].filter(Boolean).join(' ')
        || customer.display_name
        || customer.email
        || '')
    : '';
  const customerAddress = customer
    ? [customer.address_line1, customer.address_line2, customer.postal_code, customer.city]
      .filter(Boolean)
      .join(', ')
    : '';

  return {
    customer_name: customerName,
    customer_address: customerAddress,
    event_name: contract.event_name || '',
    event_date: formatShortDate(contract.event_date),
    issue_date: formatShortDate(contract.issue_date),
    contract_number: contract.contract_number || '',
    title: contract.title || '',
    net_days: String(netDaysDefault),
    skonto_percent: skontoPercentDefault == null ? '0' : String(skontoPercentDefault),
    skonto_within_days: String(skontoWithinDaysDefault),
    cancellation_30d_percent: '25',
    currency: (profile.default_currency || 'CHF').toUpperCase(),
    issuer_company_name: issuerCompany,
    issuer_address: issuerAddress,
    source_quote_number: sourceQuoteNumber,
  };
}

// ---------------------------------------------------------------------
// Render-context builder + PDF helpers
// ---------------------------------------------------------------------

/**
 * Build the data shape pdfService.renderContractToBuffer expects.
 * Sections are emitted in canonical SECTIONS_ORDER; blocks within a
 * section are emitted in `position` order. Bodies are run through
 * renderTemplatedBody so {{placeholders}} are substituted.
 *
 * When the contract has been sent, `body_text_snapshot` is used (so
 * later edits to the source block don't mutate the rendered document).
 * Before send (preview from editor) the live `contract_blocks.body_text`
 * is used so the admin can iterate on block bodies and see the result.
 */
async function buildRenderContext(contract, inclusions) {
  const customer = await db('customer_accounts').where({ id: contract.customer_account_id }).first();
  const profile = (await businessProfileService.getProfile()).profile || {};
  const placeholders = await buildPlaceholderContext(contract, customer);

  // Pull source-quote line items when this contract was generated from a
  // quote. Surfaced on the render context so the renderer can draw a real
  // table at the location of the `quote_line_items_table` system block.
  // Sub-items keep their parent's position via the LEFT JOIN so the
  // renderer can indent them with a `↳` prefix.
  let quoteLineItems = [];
  let quoteCurrency = null;
  let quoteNumber = null;
  if (contract.source_quote_id) {
    const srcQuote = await db('quotes').where({ id: contract.source_quote_id })
      .select('quote_number', 'currency').first();
    if (srcQuote) {
      quoteCurrency = srcQuote.currency;
      quoteNumber = srcQuote.quote_number;
      quoteLineItems = await db('quote_line_items as li')
        .leftJoin('quote_line_items as parent', 'parent.id', 'li.parent_line_item_id')
        .where('li.quote_id', contract.source_quote_id)
        .orderBy('li.position', 'asc')
        .select('li.*', 'parent.position as parent_position');
    }
  }

  const locale = contract.language || customer?.preferred_language || profile.default_locale || 'de';

  // Group inclusions by section + render each block body.
  const blocksBySection = {};
  for (const section of SECTIONS_ORDER) blocksBySection[section] = [];
  const sortedInclusions = [...inclusions]
    .filter((row) => row.included === true || row.included === 1 || row.included === '1')
    .sort((a, b) => {
      const sa = SECTIONS_ORDER.indexOf(a.section);
      const sb = SECTIONS_ORDER.indexOf(b.section);
      if (sa !== sb) return sa - sb;
      return (a.position || 0) - (b.position || 0);
    });

  for (const row of sortedInclusions) {
    if (!blocksBySection[row.section]) continue;
    // The inclusion row carries the JOINED block columns aliased with
    // a `block_` prefix (see getContractById). Pre-send drafts have
    // null snapshots, so fall through to the live block body.
    // Migration 131 added ru/pt/nl/fr columns. The body resolver
    // picks the locale-matching column first, falls back through
    // DE → EN, so an admin can stage translations one locale at a
    // time without breaking contracts in other languages.
    const bodyEn = row.body_text_snapshot || row.block_body_text || '';
    const bodyDe = row.body_text_de_snapshot || row.block_body_text_de || '';
    const bodyRu = row.block_body_text_ru || '';
    const bodyPt = row.block_body_text_pt || '';
    const bodyNl = row.block_body_text_nl || '';
    const bodyFr = row.block_body_text_fr || '';
    const localeBody = ({
      de: bodyDe,
      ru: bodyRu,
      pt: bodyPt,
      nl: bodyNl,
      fr: bodyFr,
    })[locale] || '';
    const sourceBody = localeBody || bodyEn || bodyDe;
    // Substitute placeholders, then strip any leading `**Title**\n`
    // line — the block's `name` field is already rendered as a bold
    // sub-heading by the PDF/public layouts, so a bold first line in
    // the body produces a duplicated title. Inline `**bold**` markers
    // elsewhere in the body are preserved (the PDF renders them as
    // actual bold via renderBodyMarkdown; the public route strips
    // them since the React page has no inline-bold UI).
    const rendered = renderTemplatedBody(sourceBody, placeholders)
      .replace(/^\s*\*\*[^*\n]+\*\*\s*\n+/, '');
    blocksBySection[row.section].push({
      slug: row.block_slug || null,
      name: row.block_name,
      section: row.section,
      body: rendered,
    });
  }

  // Use the same robust logo resolver quote/invoice use — checks
  // business_profile.logo_path → app_settings.branding_logo_path →
  // app_settings.branding_logo_url, with ~7 disk-location candidates
  // before giving up.
  const { resolveLogoFile } = require('../../utils/resolveLogoFile');
  const resolvedLogoPath = await resolveLogoFile(profile);

  // Global date format from Settings → General (general_date_format).
  let dateFormat = null;
  try {
    const raw = await getAppSetting('general_date_format');
    if (raw && typeof raw === 'object' && raw.format) dateFormat = raw;
    else if (typeof raw === 'string' && raw.trim()) dateFormat = { format: raw.trim() };
  } catch (_) { /* fall back to default */ }

  return {
    locale,
    dateFormat,
    // Mirror the quote/invoice issuer shape EXACTLY so drawIssuerBlock
    // honours the same business-profile toggles (pdf_show_logo,
    // pdf_show_company_name, pdf_logo_height, pdf_company_name_inline,
    // pdf_folding_marks) across all three document types. Per maintainer:
    // contracts reuse the same toggles — no contract-specific knobs.
    // Shared issuer + recipient builders. Contracts use the base toggle
    // set (no quote-only payment-block fields). The renderer-aware
    // recipient gating means contractService's previously-drifted
    // local attentionLine logic now matches quote + invoice exactly.
    issuer: buildIssuerBlock(profile, resolvedLogoPath),
    recipient: buildRecipientBlock(profile, customer),
    doc: {
      contractNumber: contract.contract_number,
      title: contract.title || '',
      issueDate: contract.issue_date,
      validUntil: contract.valid_until,
      introText: contract.intro_text ? renderTemplatedBody(contract.intro_text, placeholders) : null,
      outroText: contract.outro_text ? renderTemplatedBody(contract.outro_text, placeholders) : null,
    },
    // Blocks grouped + ordered by canonical section order.
    sections: SECTIONS_ORDER
      .map((section) => ({ section, blocks: blocksBySection[section] }))
      .filter((s) => s.blocks.length > 0),
    // Source-quote line items, surfaced at the top level so the PDF
    // renderer can draw a formatted table where the
    // `quote_line_items_table` system block is included. Empty array
    // when the contract has no source quote.
    quoteLineItems,
    quoteCurrency,
    quoteSourceNumber: quoteNumber,
    // Signature evidence (used by the PDF renderer to stamp signatures
    // into the closing section when present).
    signatures: {
      customer: contract.signed_customer_name ? {
        name: contract.signed_customer_name,
        signedAt: contract.signed_by_customer_at,
        ip: contract.signed_customer_ip,
        signaturePath: contract.signed_customer_signature_path,
      } : null,
      admin: contract.signed_admin_name ? {
        name: contract.signed_admin_name,
        signedAt: contract.signed_by_admin_at,
        ip: contract.signed_admin_ip,
        signaturePath: contract.signed_admin_signature_path,
      } : null,
    },
    // Audit-trail evidence appended to the rendered PDF as a final
    // page (issue #3). The renderer skips the page when this is null
    // OR when the contract isn't signed yet, so unsigned PDFs stay
    // unchanged. Hashes are best-effort: pdfSha256 may be null on
    // installs that haven't migrated to the new schema column yet —
    // the page still renders the rest of the evidence.
    audit: (contract.signed_customer_name || contract.signed_admin_name) ? {
      contractNumber: contract.contract_number,
      issuedAt: contract.sent_at,
      pdfSha256: contract.pdf_sha256 || null,
      signedPdfSha256: contract.signed_pdf_sha256 || null,
    } : null,
  };
}
module.exports = {
  renderTemplatedBody,
  buildPlaceholderContext,
  buildRenderContext,
};
