// Extracted verbatim from contractService.js — see ../contractService.js for the
// module-level overview. Do not add behavior here without updating the entry re-exports.

const { db } = require('../../database/db');
const { getAppSetting } = require('../../utils/appSettings');
const { formatShortDate } = require('../../utils/dateFormatter');
const businessProfileService = require('../businessProfileService');
const { buildIssuerBlock, buildRecipientBlock } = require('../_renderContext');
const { ensureInt, ensureNumber } = require('../../utils/numericHelpers');
const { countedLineItems } = require('../../utils/lineItemTotals');
const { SECTIONS_ORDER } = require('./helpers');
const { canonicalSha256 } = require('../../utils/canonicalJson');
const content = require('./content');


/**
 * Handlebars-lite renderer:
 *   - `{{#if var}}…{{/if}}` blocks resolved by truthiness of variables[var].
 *   - `{{var}}` substituted with the matching variable. Missing
 *     placeholders are left literally as `{{var}}` so the admin
 *     notices the unresolved field in preview.
 *
 * Mirrors safeTemplateReplace in emailProcessor.js. Values are escaped for
 * `output` (utils/placeholders.escapeValue): a contract body is `markdown` —
 * the PDF reads `**bold**` in it — so a value can't switch formatting on;
 * `text` leaves values as they are. Substitution is one pass: a value that
 * contains `{{…}}` is printed, never expanded.
 */
function renderTemplatedBody(template, variables, { output = 'markdown' } = {}) {
  if (typeof template !== 'string' || template.length === 0) return template;
  // One grammar, owned by utils/placeholders: the publish check accepted
  // `{{ customer_name }}` with spaces while this substituted only the tight
  // form, so a template could be published with a placeholder that printed
  // literally on every contract.
  const { PLACEHOLDER_PATTERN, renderConditionals, escapeValue } = require('../../utils/placeholders');
  return renderConditionals(template, variables || {})
    .replace(PLACEHOLDER_PATTERN, (match, key) => {
      if (!variables || !Object.prototype.hasOwnProperty.call(variables, key)) return match;
      return escapeValue(String(variables[key]), output);
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

const isIncluded = (row) => row.included === true || row.included === 1 || row.included === '1';

/**
 * A contract's clauses in reading order, each with its texts by language
 * (#1445):
 *   - a contract made from a template follows the template's order —
 *     positions run 1..n across the whole contract;
 *   - a contract from before templates keeps the fixed section order, then
 *     each block's position within its section.
 * A block reads its frozen text where it has any (a template's snapshot, or
 * what was frozen at send) and the live library text for a language the
 * snapshot doesn't carry; a per-contract override wins over either, language
 * by language. That per-language fallback matters for contracts sent before
 * migration 222 added the fr/nl/pt/ru snapshot columns: those are empty, and
 * taking the frozen map whole would render an RU contract in English.
 */
function orderedClauses(contract, inclusions, textSections = []) {
  const clauses = [
    ...inclusions.filter(isIncluded).map((row) => {
      const frozen = content.inclusionSnapshot(row);
      const base = { ...content.blockBodies(row, 'block_'), ...frozen };
      return {
        kind: 'block',
        blockId: row.block_id || null,
        section: row.section,
        position: ensureInt(row.position),
        slug: row.block_slug || null,
        name: row.block_name || null,
        body: content.mergeLocaleMaps(base, row.body_override),
      };
    }),
    ...textSections.map((row) => ({
      kind: 'text',
      blockId: null,
      section: row.section,
      position: ensureInt(row.position),
      slug: null,
      name: row.heading || null,
      body: content.parseLocaleMap(row.body),
    })),
  ];
  if (contract.template_version_id) return clauses.sort((a, b) => a.position - b.position);
  const rank = (section) => {
    const i = SECTIONS_ORDER.indexOf(section);
    return i === -1 ? SECTIONS_ORDER.length : i;
  };
  return clauses.sort((a, b) => rank(a.section) - rank(b.section) || a.position - b.position);
}

/** Consecutive clauses of one section share a heading, as the renderer expects. */
function groupSections(clauses, render) {
  const sections = [];
  for (const clause of clauses) {
    const last = sections[sections.length - 1];
    const block = render(clause);
    if (last && last.section === clause.section) last.blocks.push(block);
    else sections.push({ section: clause.section, blocks: [block] });
  }
  return sections;
}

function parseContentSnapshot(value) {
  if (!value) return null;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && Array.isArray(parsed.clauses) ? parsed : null;
  } catch (_) {
    return null;
  }
}

/** The current snapshot format. See buildContentSnapshot. */
const SNAPSHOT_FORMAT = 2;

/**
 * The columns of a quote line the contract renderer reads, coerced to the
 * shapes JSON round-trips identically on both engines.
 *
 * The DB column names are kept rather than an API shape: `buildRenderContext`
 * hands these rows to exactly the mapper it already uses for live rows
 * (pdfService's `quote_line_items_table` branch), so a frozen contract and a
 * live one go through one code path.
 *
 * The coercion is not cosmetic. `*_minor` are bigint columns and
 * `quantity` / `discount_percent` are decimals: PostgreSQL hands those back
 * as strings and SQLite as numbers, so freezing them raw would give the same
 * contract a different `rendered_content_sha256` on the two engines — and the
 * hash is what a signature is bound to.
 */
function snapshotLineItem(li) {
  return {
    position: ensureInt(li.position),
    parent_position: li.parent_position == null || li.parent_position === '' ? null : ensureInt(li.parent_position),
    parent_line_item_id: li.parent_line_item_id == null ? null : ensureInt(li.parent_line_item_id),
    line_kind: li.line_kind || 'item',
    description: li.description == null ? '' : String(li.description),
    details_text: li.details_text == null ? null : String(li.details_text),
    unit: li.unit == null ? null : String(li.unit),
    quantity: ensureNumber(li.quantity, 0),
    unit_price_minor: ensureInt(li.unit_price_minor),
    discount_percent: ensureNumber(li.discount_percent, 0),
    line_total_minor: ensureInt(li.line_total_minor),
    is_optional: li.is_optional === true || li.is_optional === 1 || li.is_optional === '1',
    promotion_snapshot: li.promotion_snapshot == null ? null : String(li.promotion_snapshot),
  };
}

/**
 * The commercial terms a contract prints, as they stood when it was sent.
 *
 * The contract's own text was frozen from the start; the price was not. The
 * `quote_line_items_table` block re-read `quote_line_items` on every render,
 * so `rendered_content_sha256` — the hash a signature is bound to — covered
 * the words and not the amounts. Editing the source quote after sending
 * changed nothing a signer could see (a sent contract opens its stored PDF),
 * but it did mean the hash never stood for the commercial terms.
 *
 * Totals are read from the quote row rather than recomputed: those are the
 * amounts the quote itself states and the customer accepted, and re-deriving
 * them here would let a later change to, say, the rounding setting disagree
 * with the document that was sent.
 */
async function buildQuoteSnapshot(contract) {
  if (!contract.source_quote_id) return null;
  const quote = await db('quotes').where({ id: contract.source_quote_id }).first();
  if (!quote) return null;
  const rows = await db('quote_line_items as li')
    .leftJoin('quote_line_items as parent', 'parent.id', 'li.parent_line_item_id')
    .where('li.quote_id', contract.source_quote_id)
    .orderBy('li.position', 'asc')
    .select('li.*', 'parent.position as parent_position');
  return {
    number: quote.quote_number || null,
    currency: (quote.currency || 'CHF').toUpperCase(),
    // Unselected optional add-ons aren't part of the deal (#1451), so they
    // are not part of what is signed either.
    lineItems: countedLineItems(rows).map(snapshotLineItem),
    totals: {
      netMinor: ensureInt(quote.net_amount_minor),
      vatRatePercent: ensureNumber(quote.vat_rate, 0),
      vatMinor: ensureInt(quote.vat_amount_minor),
      shippingMinor: ensureInt(quote.shipping_amount_minor),
      grossMinor: ensureInt(quote.total_amount_minor),
    },
  };
}

/**
 * What a contract says at the moment it's sent (#1445): its clauses in
 * reading order with their texts in every language, the title, intro and
 * outro, the placeholder values of that moment — and, since format 2, the
 * quote line items and totals it prints. sendContract stores it with its
 * sha256; from then on the PDF, the signing page and any re-render read this
 * instead of live data, whatever changes later in the library, the template,
 * the customer record or the source quote.
 *
 * `quote` is frozen whenever the contract has a source quote, whether or not
 * the `quote_line_items_table` block is included: what is frozen is the
 * commercial basis of the contract, and which blocks print it is a question
 * for the renderer.
 */
async function buildContentSnapshot(contract, inclusions, textSections = []) {
  const customer = await db('customer_accounts').where({ id: contract.customer_account_id }).first();
  const quote = await buildQuoteSnapshot(contract);
  const snapshot = {
    format: SNAPSHOT_FORMAT,
    title: contract.title || '',
    introText: contract.intro_text || '',
    outroText: contract.outro_text || '',
    placeholders: await buildPlaceholderContext(contract, customer),
    clauses: orderedClauses(contract, inclusions, textSections),
    ...(quote ? { quote } : {}),
  };
  return { snapshot, sha256: canonicalSha256(snapshot) };
}

/**
 * The title, intro, outro and sections a contract shows in a language,
 * placeholders filled in: from the sent snapshot when there is one, else
 * from the live draft. Shared by the PDF and the customer's signing page.
 */
async function resolveDisplayContent(contract, inclusions, textSections, locale, { customer, placeholders: extra } = {}) {
  const snapshot = parseContentSnapshot(contract.rendered_content);
  const placeholders = snapshot
    ? snapshot.placeholders
    : {
      ...(await buildPlaceholderContext(contract, customer !== undefined
        ? customer
        : await db('customer_accounts').where({ id: contract.customer_account_id }).first())),
      ...(extra || {}),
    };
  const clauses = snapshot ? snapshot.clauses : orderedClauses(contract, inclusions, textSections || []);
  const intro = snapshot ? snapshot.introText : contract.intro_text;
  const outro = snapshot ? snapshot.outroText : contract.outro_text;
  return {
    title: snapshot ? snapshot.title : (contract.title || ''),
    introText: intro ? renderTemplatedBody(intro, placeholders) : null,
    outroText: outro ? renderTemplatedBody(outro, placeholders) : null,
    // Placeholders filled in, then a leading `**Title**` line dropped: the
    // clause name is already printed as its heading. Inline `**bold**`
    // stays for the PDF (the signing page strips it).
    sections: groupSections(clauses, (clause) => ({
      blockId: clause.blockId,
      position: clause.position,
      kind: clause.kind,
      slug: clause.slug,
      name: clause.name,
      section: clause.section,
      body: renderTemplatedBody(content.pickLocale(clause.body, locale), placeholders)
        .replace(/^\s*\*\*[^*\n]+\*\*\s*\n+/, ''),
    })),
  };
}

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
async function buildRenderContext(contract, inclusions, textSections = [], options = {}) {
  // `options.customer` / `options.quote` stand in for the customer row and
  // the frozen quote: the template preview renders with sample data (#1445).
  const customer = options.customer !== undefined
    ? options.customer
    : await db('customer_accounts').where({ id: contract.customer_account_id }).first();
  const profile = (await businessProfileService.getProfile()).profile || {};

  // The line items and totals the contract prints. A contract sent with a
  // format-2 snapshot reads them from it and never touches `quote_line_items`
  // again: editing the source quote afterwards must not change what was sent,
  // and `rendered_content_sha256` — the hash a signature is bound to — covers
  // these values.
  //
  // A contract sent before format 2 keeps the live read. Its commercial terms
  // were never frozen and cannot be reconstructed; its stored PDF is what
  // opens anyway, and re-deriving is the closest thing to the truth left.
  const snapshot = parseContentSnapshot(contract.rendered_content);
  let quoteLineItems = [];
  let quoteCurrency = null;
  let quoteNumber = null;
  let quoteTotals = null;
  if (options.quote) {
    quoteLineItems = options.quote.lineItems || [];
    quoteCurrency = options.quote.currency || null;
    quoteNumber = options.quote.number || null;
    quoteTotals = options.quote.totals || null;
  } else if (snapshot && ensureInt(snapshot.format) >= 2 && snapshot.quote) {
    quoteLineItems = snapshot.quote.lineItems || [];
    quoteCurrency = snapshot.quote.currency || null;
    quoteNumber = snapshot.quote.number || null;
    quoteTotals = snapshot.quote.totals || null;
  } else if (contract.source_quote_id) {
    const srcQuote = await db('quotes').where({ id: contract.source_quote_id })
      .select('quote_number', 'currency').first();
    if (srcQuote) {
      quoteCurrency = srcQuote.currency;
      quoteNumber = srcQuote.quote_number;
      // Unselected optional add-ons aren't part of the deal (#1451).
      quoteLineItems = countedLineItems(await db('quote_line_items as li')
        .leftJoin('quote_line_items as parent', 'parent.id', 'li.parent_line_item_id')
        .where('li.quote_id', contract.source_quote_id)
        .orderBy('li.position', 'asc')
        .select('li.*', 'parent.position as parent_position'));
    }
  }

  const locale = contract.language || customer?.preferred_language || profile.default_locale || 'de';

  // Clauses in reading order with placeholders filled in — from the sent
  // snapshot once there is one (#1445), else live. The locale picks each
  // clause's text in that language, then English, then German.
  const display = await resolveDisplayContent(contract, inclusions, textSections, locale,
    { customer, placeholders: options.placeholders });

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
    // PDF theme (#1445): font family, colours, footer, folding marks.
    theme: await require('../pdfThemeService').resolveTheme('contract'),
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
      title: display.title,
      issueDate: contract.issue_date,
      validUntil: contract.valid_until,
      introText: display.introText,
      outroText: display.outroText,
    },
    sections: display.sections,
    // Source-quote line items, surfaced at the top level so the PDF
    // renderer can draw a formatted table where the
    // `quote_line_items_table` system block is included. Empty array
    // when the contract has no source quote.
    quoteLineItems,
    quoteCurrency,
    quoteSourceNumber: quoteNumber,
    // Present only for a contract sent with a format-2 snapshot; the renderer
    // draws the totals row under the line table from it.
    quoteTotals,
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
  SNAPSHOT_FORMAT,
  renderTemplatedBody,
  buildPlaceholderContext,
  buildRenderContext,
  buildContentSnapshot,
  buildQuoteSnapshot,
  resolveDisplayContent,
  orderedClauses,
  parseContentSnapshot,
};
