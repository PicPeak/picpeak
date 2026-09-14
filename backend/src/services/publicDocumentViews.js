/**
 * Customer-facing projections of contracts and quotes, shared by the public
 * token pages (after the visitor verified with an emailed code) and the
 * customer portal (where the session already proves who the visitor is).
 *
 * Kept in one place so the two entry points cannot drift: whatever the public
 * page is allowed to show a verified visitor, the portal shows its logged-in
 * customer, and neither ever carries an action token.
 */

const { db } = require('../database/db');
const { getAppSetting } = require('../utils/appSettings');
const { toTimestamp } = require('../utils/dateNormalize');

// Normalise a Settings → Branding logo value (absolute URL, /-rooted path,
// or bare `uploads/...` filename) into a URL the public page can load.
function normalizeBrandingLogoUrl(raw) {
  const value = (raw && String(raw).trim()) || null;
  if (!value) return null;
  if (value.startsWith('/') || /^https?:\/\//i.test(value)) return value;
  return `/uploads/${value.replace(/^uploads\//, '')}`;
}

/**
 * Public-safe projection of the contract. We deliberately omit:
 *   - intro/outro text remain visible (customer-facing by design)
 *   - admin notes (none on contracts today)
 *   - admin IP + signature paths (signed_*_path is admin-only)
 *
 * The IP / signature image paths are NEVER exposed publicly even after
 * signing — they're audit evidence.
 */
function publicContractView(contract, inclusions, customer, profile, locale, brandingLogoUrl, brandingLogoUrlDark) {
  const orderedSections = ['basics', 'scope', 'privacy', 'commercial', 'nda', 'closing'];
  const blocksBySection = {};
  for (const s of orderedSections) blocksBySection[s] = [];
  for (const inc of inclusions) {
    if (!(inc.included === true || inc.included === 1 || inc.included === '1')) continue;
    const bodyEn = inc.body_text_snapshot || inc.block_body_text || '';
    const bodyDe = inc.body_text_de_snapshot || inc.block_body_text_de || '';
    // 1) Strip the leading `**Title**\n` line — the block.name is
    //    already rendered above as a bold sub-heading, so a bold
    //    first line in the body would duplicate it.
    // 2) Strip remaining `**bold**` inline markers — the React sign
    //    page renders body as plain `whitespace-pre-line` text and
    //    has no inline-bold UI. The PDF path keeps them as bold
    //    runs via pdfService.renderBodyMarkdown.
    const body = (locale === 'de' ? (bodyDe || bodyEn) : (bodyEn || bodyDe))
      .replace(/^\s*\*\*[^*\n]+\*\*\s*\n+/, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1');
    if (!blocksBySection[inc.section]) continue;
    blocksBySection[inc.section].push({
      blockId: inc.block_id,
      section: inc.section,
      position: inc.position,
      name: inc.block_name,
      body,
    });
  }
  const sections = orderedSections
    .map((s) => ({ section: s, blocks: blocksBySection[s] }))
    .filter((s) => s.blocks.length > 0);

  return {
    contractNumber: contract.contract_number,
    status: contract.status,
    language: contract.language,
    issueDate: contract.issue_date,
    validUntil: contract.valid_until,
    title: contract.title,
    introText: contract.intro_text,
    outroText: contract.outro_text,
    sentAt: contract.sent_at,
    signedByCustomerAt: contract.signed_by_customer_at,
    signedByAdminAt: contract.signed_by_admin_at,
    signedCustomerName: contract.signed_customer_name,
    signedAdminName: contract.signed_admin_name,
    // The customer's own IP is fine to surface back — it's THEIR
    // identifier on the audit trail. The admin's IP is NOT exposed
    // publicly: it's a counter-party's identifier (operator's office /
    // home network) and shouldn't reach the customer's browser.
    // Admin sees their own IP on the admin detail page; customer
    // doesn't need it.
    signedCustomerIp: contract.signed_customer_ip || null,
    // signed_pdf_path itself is admin-only; we just flag presence so
    // the public page can show a "wet-signed copy attached" hint.
    hasSignedPdf: !!contract.signed_pdf_path,
    // SHA-256 of the on-disk PDFs — surfaced so the customer can
    // re-hash their downloaded copy and confirm it matches what
    // we issued.
    pdfSha256: contract.pdf_sha256 || null,
    signedPdfSha256: contract.signed_pdf_sha256 || null,
    canSign: contract.status === 'sent',
    sections,
    recipient: customer ? {
      displayName: customer.display_name || [customer.first_name, customer.last_name].filter(Boolean).join(' '),
      companyName: customer.company_name,
      email: customer.email,
    } : null,
    issuer: profile ? {
      companyName: profile.company_name,
      addressLine1: profile.address_line1,
      postalCode: profile.postal_code,
      city: profile.city,
      email: profile.email,
      website: profile.website,
      // Light + dark branding logos (Settings → Branding), so the public
      // sign page renders the logo that reads in its resolved colour mode.
      // The print-only business_profile.logo_path is intentionally NOT
      // used here.
      logoUrl: normalizeBrandingLogoUrl(brandingLogoUrl),
      logoUrlDark: normalizeBrandingLogoUrl(brandingLogoUrlDark),
    } : null,
  };
}

function publicQuoteView(quote, lineItems, customer, profile, tosRequired, tosText, tosUrl, brandingLogoUrl, brandingLogoUrlDark) {
  return {
    quoteNumber: quote.quote_number,
    status: quote.status,
    language: quote.language,
    currency: quote.currency,
    issueDate: quote.issue_date,
    validUntil: quote.valid_until,
    eventName: quote.event_name,
    eventDate: quote.event_date,
    eventTimeStart: quote.event_time_start,
    eventTimeEnd: quote.event_time_end,
    introText: quote.intro_text,
    outroText: quote.outro_text,
    // Money — public surface.
    netAmountMinor: quote.net_amount_minor,
    vatRate: quote.vat_rate == null ? null : Number(quote.vat_rate),
    vatAmountMinor: quote.vat_amount_minor,
    shippingAmountMinor: quote.shipping_amount_minor,
    totalAmountMinor: quote.total_amount_minor,
    // Response state — drives the page UI.
    respondedAt: quote.responded_at,
    responseLockedAt: quote.response_locked_at,
    canRespond: !!(quote.status === 'sent' || (
      quote.responded_at && quote.response_locked_at &&
      new Date(quote.response_locked_at).getTime() > Date.now()
    )),
    lineItems: lineItems.map((li) => ({
      position: li.position,
      quantity: Number(li.quantity),
      description: li.description,
      unitPriceMinor: li.unit_price_minor,
      discountPercent: li.discount_percent == null ? 0 : Number(li.discount_percent),
      lineTotalMinor: li.line_total_minor,
      // Hierarchy + details (migration 119), same shape adminQuotes.js
      // projects. Omitting them here meant the customer-facing page could
      // never thread sub-items or show details text, even though the data
      // is on the rows getQuoteById already returns.
      parentLineItemId: li.parent_line_item_id || null,
      parentPosition: li.parent_position == null ? null : Number(li.parent_position),
      detailsText: li.details_text || null,
    })),
    recipient: customer ? {
      displayName: customer.display_name || [customer.first_name, customer.last_name].filter(Boolean).join(' '),
      email: customer.email,
      companyName: customer.company_name,
    } : null,
    // Terms of Service surfaced to the customer when the global
    // `crm_quotes_tos_required` flag is on. The text + URL are
    // included unconditionally so admins can opt to display them
    // without blocking acceptance; the frontend gates the checkbox.
    // Snapshot is rendered when the quote has already been accepted
    // so the customer sees exactly what they agreed to, not the
    // current ToS text (which may have changed).
    tos: {
      required: tosRequired === true,
      text: quote.tos_text_snapshot || tosText || '',
      url: tosUrl || '',
      acceptedAt: quote.tos_accepted_at || null,
    },
    issuer: profile ? {
      companyName: profile.company_name,
      email: profile.email,
      website: profile.website,
      footerLine: profile.footer_line,
      // Logo source for the web quote page is ONLY the global
      // Settings → Branding logo (`app_settings.branding_logo_url`).
      //
      // `business_profile.logo_path` is intentionally NOT consulted
      // here — it's a dedicated PDF lightmode logo (PDFs always
      // print on white paper, so admins upload a dark variant
      // there). On the web page the existing site branding already
      // serves both light + dark modes correctly, so falling back
      // to a PDF-only image would override that with a light
      // version that doesn't read in dark mode. Both light + dark
      // branding URLs are surfaced so the page can pick the one that
      // matches its resolved colour mode (see usePublicDarkMode).
      logoUrl: normalizeBrandingLogoUrl(brandingLogoUrl),
      logoUrlDark: normalizeBrandingLogoUrl(brandingLogoUrlDark),
    } : null,
  };
}

async function brandingLogos() {
  return {
    logoUrl: normalizeBrandingLogoUrl(await getAppSetting('branding_logo_url', null)),
    logoUrlDark: normalizeBrandingLogoUrl(await getAppSetting('branding_logo_url_dark', null)),
  };
}

/** Full contract view, or null when the contract no longer exists. */
async function buildContractView(contractId) {
  const contractService = require('./contractService');
  const data = await contractService.getContractById(contractId);
  if (!data) return null;
  const customer = await db('customer_accounts').where({ id: data.contract.customer_account_id }).first();
  const profile = await db('business_profile').where({ id: 1 }).first();
  // Surface the admin-tunable behaviour toggles on the view so the
  // React page can hide the upload-PDF section when disabled and
  // enforce the drawn-signature requirement client-side. The server
  // re-enforces both, so client tampering only changes the UX.
  const allowPdfUpload = (await getAppSetting('crm_contracts_allow_pdf_upload')) !== false;
  const requireDrawnSignature = (await getAppSetting('crm_contracts_require_drawn_signature')) === true;
  const view = publicContractView(
    data.contract,
    data.inclusions,
    customer,
    profile,
    data.contract.language || 'de',
    await getAppSetting('branding_logo_url', null),
    await getAppSetting('branding_logo_url_dark', null),
  );
  view.allowPdfUpload = allowPdfUpload;
  view.requireDrawnSignature = requireDrawnSignature;
  return view;
}

/** Full quote view, or null when the quote no longer exists. */
async function buildQuoteView(quoteId) {
  const quoteService = require('./quoteService');
  const data = await quoteService.getQuoteById(quoteId);
  if (!data) return null;
  const customer = await db('customer_accounts').where({ id: data.quote.customer_account_id }).first();
  const businessProfileService = require('./businessProfileService');
  const { profile } = await businessProfileService.getProfile();
  // Pull the three ToS keys via the shared helper so it works
  // regardless of how setting_value is encoded (JSON-stringified vs
  // raw). All three are optional.
  const tosRequired = await getAppSetting('crm_quotes_tos_required', false);
  const tosText = await getAppSetting('crm_quotes_tos_text', '');
  const tosUrl = await getAppSetting('crm_quotes_tos_url', '');
  return publicQuoteView(
    data.quote, data.lineItems, customer, profile, tosRequired, tosText, tosUrl,
    await getAppSetting('branding_logo_url', null),
    await getAppSetting('branding_logo_url_dark', null),
  );
}

/**
 * What the verification step needs about a document: where the code goes,
 * which language to write it in, and who sent the document. The `issuer`
 * part is the only thing an unverified visitor gets to see.
 */
async function contractVerificationTarget(tokenRow) {
  const contract = await db('contracts').where({ id: tokenRow.contract_id }).first();
  if (!contract) return null;
  const customer = await db('customer_accounts').where({ id: contract.customer_account_id }).first();
  const profile = await db('business_profile').where({ id: 1 }).first();
  return {
    language: contract.language || 'de',
    recipientEmail: customer?.email || null,
    documentNumber: contract.contract_number,
    issuerName: profile?.company_name || null,
    issuer: { companyName: profile?.company_name || null, ...(await brandingLogos()) },
  };
}

async function quoteVerificationTarget(tokenRow) {
  const quote = await db('quotes').where({ id: tokenRow.quote_id }).first();
  if (!quote) return null;
  const customer = await db('customer_accounts').where({ id: quote.customer_account_id }).first();
  const businessProfileService = require('./businessProfileService');
  const { profile } = await businessProfileService.getProfile();
  return {
    language: quote.language || 'de',
    recipientEmail: customer?.email || null,
    documentNumber: quote.quote_number,
    issuerName: profile?.company_name || null,
    issuer: { companyName: profile?.company_name || null, ...(await brandingLogos()) },
  };
}

// Expiry is compared in JS: tokens are written as ISO strings by some paths
// and as Date objects by others, and a SQL comparison against a bound Date
// behaves differently on SQLite and Postgres.
const notExpired = (row, now) => toTimestamp(row.expires_at) > now;
const newestFirst = (a, b) => toTimestamp(b.created_at) - toTimestamp(a.created_at) || b.id - a.id;

/**
 * The action token that can still sign this contract: unused and unexpired.
 * Resolved server-side for the portal, so the token itself never has to reach
 * the customer's browser.
 */
async function liveContractTokens(contractIds) {
  if (contractIds.length === 0) return new Map();
  const now = Date.now();
  const rows = (await db('contract_action_tokens').whereIn('contract_id', contractIds).whereNull('used_at'))
    .filter((row) => notExpired(row, now))
    .sort(newestFirst);
  const byContract = new Map();
  for (const row of rows) if (!byContract.has(row.contract_id)) byContract.set(row.contract_id, row);
  return byContract;
}

/**
 * The action token quoteService.recordResponse would accept for this quote:
 * unexpired. A used token still counts, because the service lets the customer
 * change their answer inside the response window with the same token.
 */
async function usableQuoteTokens(quoteIds) {
  if (quoteIds.length === 0) return new Map();
  const now = Date.now();
  const rows = (await db('quote_action_tokens').whereIn('quote_id', quoteIds))
    .filter((row) => notExpired(row, now))
    .sort(newestFirst);
  const byQuote = new Map();
  for (const row of rows) if (!byQuote.has(row.quote_id)) byQuote.set(row.quote_id, row);
  return byQuote;
}

/** Same rule as the public quote view: sent, or still inside the response window. */
function quoteAcceptsResponse(quote) {
  if (quote.status === 'sent') return true;
  return !!(quote.responded_at && quote.response_locked_at
    && toTimestamp(quote.response_locked_at) > Date.now());
}

module.exports = {
  buildContractView,
  buildQuoteView,
  contractVerificationTarget,
  quoteVerificationTarget,
  liveContractTokens,
  usableQuoteTokens,
  quoteAcceptsResponse,
};
