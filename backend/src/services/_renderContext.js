/**
 * Shared render-context helpers for the three document services
 * (quoteService, invoiceService, contractService).
 *
 * **Why this file exists**
 *
 * The audit flagged that the issuer + recipient blocks of
 * `buildRenderContext` were copy-pasted across all three services and
 * had already drifted (contractService's recipient gated `attentionLine`
 * on `trimmedCompany` while quote/invoice fire it whenever a person
 * name is present). The PDF renderer happens to gate on `hasCompany`
 * downstream, so neither variant produced wrong output — but the drift
 * is a maintenance trap and any future renderer change relying on the
 * raw string would fail surprisingly on one document type.
 *
 * Two helpers live here:
 *
 *   - `buildIssuerBlock(profile, resolvedLogoPath, options?)` — the
 *     full issuer shape consumed by pdfService.drawIssuerBlock. Honors
 *     the existing pdf_show_logo / pdf_show_company_name visibility
 *     toggles, logo-height, folding-marks, etc. `options.quoteToggles`
 *     adds the two quote-only fields (`quoteShowNetDays`,
 *     `quoteShowSkonto`) — they are silently dropped for invoice and
 *     contract callers so the same helper serves all three doc types.
 *
 *   - `buildRecipientBlock(profile, customer)` — the recipient address
 *     block. Honors the maintainer spec: companies bold the company
 *     name on line 1 + "z. Hd. <person>" on line 2; private customers
 *     bold the person name on line 1 with no z.Hd. line at all. The
 *     attentionLine string is always populated when a person+salutation
 *     exists (the downstream renderer gates emission on hasCompany);
 *     keeping the string non-empty preserves the back-pointer for
 *     audit/debug surfaces that read the context directly.
 *
 * **What stayed in each service**
 *
 * Doc-type-specific fields (line items, totals, payment-term resolution,
 * Skonto fallback chain, doc/title block, contract signatures + audit
 * trail, source-quote line-items table) all stay where they are. Only
 * the issuer + recipient blocks are extracted, since those are
 * verbatim duplicates across all three services.
 */

/**
 * Build the `issuer` field for a render context. The shape mirrors the
 * legacy inline construction exactly so existing callers + the
 * pdfService.drawIssuerBlock consumer don't need to change.
 *
 * @param {object} profile          business_profile row (may be empty)
 * @param {string|null} logoPath    pre-resolved absolute logo path (see resolveLogoFile)
 * @param {object} [options]
 * @param {boolean} [options.quoteToggles]  include pdf_quote_show_net_days
 *                                          + pdf_quote_show_skonto fields
 * @returns {object}
 */
function buildIssuerBlock(profile, logoPath, options = {}) {
  if (!profile) return {};
  const base = {
    companyName: profile.company_name,
    addressLine1: profile.address_line1,
    addressLine2: profile.address_line2,
    postalCode: profile.postal_code,
    city: profile.city,
    state: profile.state,
    countryCode: profile.country_code,
    phone: profile.phone,
    mobile: profile.mobile,
    email: profile.email,
    website: profile.website,
    footerLine: profile.footer_line,
    vatId: profile.vat_id,
    // Steuernummer (migration 139). Rendered alongside VAT-ID on the
    // PDF issuer block — §14 UStG requires one or both on every
    // invoice. Kleinunternehmer without a USt-IdNr. carry only this.
    taxId: profile.tax_id || null,
    // VAT-line label on the totals block (e.g. "MwSt.", "VAT"). Falls back to
    // the per-locale default in pdfService when blank. Configured under
    // Settings → Accounting.
    vatLabel: profile.vat_label || null,
    // pre-resolved absolute path; renderer never re-resolves.
    logoPath,
    pdfFontTtfPath: profile.pdf_font_ttf_path,
    // Bundled fonts dropdown (migration 121). When set, pdfService loads
    // <family>/400.ttf + <family>/700.ttf from backend/assets/fonts/.
    // Priority: pdfFontTtfPath wins if both are present.
    pdfFontFamily: profile.pdf_font_family || null,
    // Free-text country name override (migration 107).
    countryName: profile.country_name || null,
    // Visibility toggles (migration 106). Default true when the column
    // is missing on older installs that haven't migrated yet — keeps
    // the previously implicit "always show" behavior pinned.
    showLogo: profile.pdf_show_logo == null ? true
      : (profile.pdf_show_logo === true || profile.pdf_show_logo === 1 || profile.pdf_show_logo === '1'),
    showCompanyName: profile.pdf_show_company_name == null ? true
      : (profile.pdf_show_company_name === true || profile.pdf_show_company_name === 1 || profile.pdf_show_company_name === '1'),
    // Layout customisation (migration 108).
    logoHeight: profile.pdf_logo_height == null ? 56 : Number(profile.pdf_logo_height),
    companyNameInline: profile.pdf_company_name_inline === true || profile.pdf_company_name_inline === 1 || profile.pdf_company_name_inline === '1',
    foldingMarks: profile.pdf_folding_marks || 'none',
  };
  if (options.quoteToggles) {
    // Quote payment-block toggles (migration 110). Quote-only — invoices
    // ignore these and always show the payment block. Default FALSE
    // when the column is missing (a quote is an offer, not a demand
    // for payment; admins opt IN via the Business profile UI).
    base.quoteShowNetDays = profile.pdf_quote_show_net_days === true
      || profile.pdf_quote_show_net_days === 1 || profile.pdf_quote_show_net_days === '1';
    base.quoteShowSkonto = profile.pdf_quote_show_skonto === true
      || profile.pdf_quote_show_skonto === 1 || profile.pdf_quote_show_skonto === '1';
  }
  return base;
}

/**
 * Build the `recipient` field for a render context. Maintainer spec:
 *
 *   - customer.company_name set → bold company on line 1, then
 *     "z. Hd. <person>" on line 2 (rendered by pdfService when
 *     hasCompany is true).
 *   - else → bold person/display_name/email on line 1, NO z.Hd. line
 *     (avoids "Luca Bresch / z. Hd. Luca Bresch" duplication).
 *
 * Empty-string trim guard: customer rows saved with company_name = ""
 * (not NULL) used to engage the company-header path with a blank line
 * before the trim was added.
 *
 * @param {object} profile     business_profile row (may be empty)
 * @param {object} customer    customer_accounts row (may be null)
 * @returns {object}
 */
function buildRecipientBlock(profile, customer) {
  const trimmedCompany = (customer?.company_name || '').trim();
  const personFull = [customer?.first_name, customer?.last_name]
    .map((s) => (s || '').trim()).filter(Boolean).join(' ');
  const headerWithCompany = !!trimmedCompany;
  const header = trimmedCompany
    || personFull
    || (customer?.display_name || '').trim()
    || customer?.email
    || '';
  // Always populate the attention string when we have a person —
  // pdfService.drawRecipientBlock gates emission on hasCompany so the
  // dead-data case (no company, has person) doesn't end up on the
  // PDF, but having the string available means audit views can show
  // it. This unifies the previously-drifted contractService and
  // quote/invoice behavior under the renderer-aware contract.
  const attentionParts = [customer?.salutation, personFull].filter(Boolean);
  const attentionLine = attentionParts.length > 0
    ? `z. Hd. ${attentionParts.join(' ')}`
    : '';
  return {
    issuerLine: profile?.company_name
      ? `${profile.company_name} * ${profile.address_line1 || ''} * ${profile.postal_code || ''} ${profile.city || ''}`
      : '',
    companyName: header,
    hasCompany: headerWithCompany,
    attentionLine,
    // Honorific + last name for personalised salutation
    // ("Sehr geehrter Herr Bresch,"). Renderer requires BOTH.
    salutation: customer?.salutation || null,
    lastName: (customer?.last_name || '').trim() || null,
    addressLine1: customer?.address_line1,
    addressLine2: customer?.address_line2,
    postalCode: customer?.postal_code,
    city: customer?.city,
    // Country name override (migration 107); falls back to the
    // locale-aware COUNTRY_NAMES lookup on countryCodeIso in pdfService.
    country: customer?.country_name || null,
    countryCodeIso: customer?.country_code,
  };
}

module.exports = {
  buildIssuerBlock,
  buildRecipientBlock,
};
