'use strict';

/**
 * What the customer-facing signing page shows (#1445, #1446): the contract as
 * sent — clauses from the frozen snapshot, in the contract's language,
 * placeholders filled in — with the issuer's branding. Shared by the
 * per-contract link route (contracts sent before signatures v2) and the
 * signers' session route.
 */

const { db } = require('../../database/db');
const { AppError } = require('../../utils/errors');
const { getAppSetting } = require('../../utils/appSettings');

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
 *   - admin notes (none on contracts today)
 *   - admin IP + signature paths (signed_*_path is admin-only)
 *
 * The IP / signature image paths are NEVER exposed publicly even after
 * signing — they're audit evidence.
 */
function publicContractView(contract, display, customer, profile, brandingLogoUrl, brandingLogoUrlDark) {
  // The clauses as the contract shows them (#1445): from the sent snapshot,
  // in the contract's language, placeholders filled in — the same content
  // as the PDF. The signing page renders plain `whitespace-pre-line` text,
  // so inline `**bold**` markers are dropped (the PDF keeps them as bold).
  const sections = display.sections.map((s) => ({
    section: s.section,
    blocks: s.blocks.map((b) => ({
      blockId: b.blockId,
      section: s.section,
      position: b.position,
      name: b.name,
      body: String(b.body || '').replace(/\*\*([^*]+)\*\*/g, '$1'),
    })),
  }));

  return {
    contractNumber: contract.contract_number,
    status: contract.status,
    language: contract.language,
    issueDate: contract.issue_date,
    validUntil: contract.valid_until,
    title: display.title || contract.title,
    introText: display.introText,
    outroText: display.outroText,
    sentAt: contract.sent_at,
    signedByCustomerAt: contract.signed_by_customer_at,
    signedByAdminAt: contract.signed_by_admin_at,
    signedCustomerName: contract.signed_customer_name,
    signedAdminName: contract.signed_admin_name,
    // The customer's own IP is fine to surface back — it's THEIR
    // identifier on the audit trail. The admin's IP is NOT exposed
    // publicly: it's a counter-party's identifier (operator's office /
    // home network) and shouldn't reach the customer's browser via
    // a token-only-secret endpoint. Admin sees their own IP on the
    // admin detail page; customer doesn't need it.
    signedCustomerIp: contract.signed_customer_ip || null,
    // signed_pdf_path itself is admin-only; we just flag presence so
    // the public page can show a "wet-signed copy attached" hint.
    hasSignedPdf: !!contract.signed_pdf_path,
    // SHA-256 of the on-disk PDFs — surfaced so the customer can
    // re-hash their downloaded copy and confirm it matches what
    // we issued. Audit-trail evidence #1 from the maintainer plan.
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
      // Mirrors publicQuotes — the print-only business_profile.logo_path is
      // intentionally NOT used here.
      logoUrl: normalizeBrandingLogoUrl(brandingLogoUrl),
      logoUrlDark: normalizeBrandingLogoUrl(brandingLogoUrlDark),
    } : null,
  };
}

/** The issuer's name and logos, for a link that isn't verified yet. */
async function issuerSummary(profile) {
  if (!profile) return null;
  return {
    companyName: profile.company_name || null,
    logoUrl: normalizeBrandingLogoUrl(await getAppSetting('branding_logo_url', null)),
    logoUrlDark: normalizeBrandingLogoUrl(await getAppSetting('branding_logo_url_dark', null)),
  };
}

/** The full public view of a contract, with its attachments and the signing toggles. */
async function buildPublicView(contractId) {
  const contractService = require('../contractService');
  const data = await contractService.getContractById(contractId);
  if (!data) throw new AppError('Contract not found', 404);
  const customer = await db('customer_accounts').where({ id: data.contract.customer_account_id }).first();
  const profile = await db('business_profile').where({ id: 1 }).first();
  // Surface the admin-tunable behaviour toggles on the view so the
  // React page can hide the upload-PDF section when disabled and
  // enforce the drawn-signature requirement client-side. The server
  // re-enforces both, so client tampering only changes the UX.
  const allowPdfUpload = (await getAppSetting('crm_contracts_allow_pdf_upload')) !== false;
  const requireDrawnSignature = (await getAppSetting('crm_contracts_require_drawn_signature')) === true;
  const brandingLogoUrl = await getAppSetting('branding_logo_url', null);
  const brandingLogoUrlDark = await getAppSetting('branding_logo_url_dark', null);
  const display = await require('./renderContext').resolveDisplayContent(
    data.contract, data.inclusions, data.textSections || [], data.contract.language || 'de', { customer },
  );
  const view = publicContractView(data.contract, display, customer, profile, brandingLogoUrl, brandingLogoUrlDark);
  // Attachments (#1445): merged ones are inside the PDF; separate ones
  // download on their own.
  view.attachments = (data.attachments || []).map((a) => ({
    id: a.attachment_id, name: a.name, delivery: a.delivery, pages: Number(a.page_count),
  }));
  view.allowPdfUpload = allowPdfUpload;
  view.requireDrawnSignature = requireDrawnSignature;
  // What the contract costs (#1445). The PDF printed the line table and the
  // totals; the page a signer reads before signing showed neither, so "what
  // you see is what you sign" stopped short of the price. Taken from the
  // frozen snapshot only — a contract sent before format 2 has no frozen
  // commercial terms, and re-reading the live quote here would show a signer
  // figures that are not the ones in the document they are signing.
  const snapshot = require('./renderContext').parseContentSnapshot(data.contract.rendered_content);
  view.commercial = snapshot && snapshot.quote ? {
    sourceQuoteNumber: snapshot.quote.number || null,
    currency: snapshot.quote.currency,
    lineItems: (snapshot.quote.lineItems || []).map((li) => ({
      position: li.position,
      parentPosition: li.parent_position,
      kind: li.line_kind,
      description: li.description,
      details: li.details_text,
      unit: li.unit,
      quantity: li.quantity,
      unitPriceMinor: li.unit_price_minor,
      discountPercent: li.discount_percent,
      lineTotalMinor: li.line_total_minor,
    })),
    totals: snapshot.quote.totals,
  } : null;
  return view;
}

module.exports = {
  normalizeBrandingLogoUrl,
  publicContractView,
  issuerSummary,
  buildPublicView,
};
