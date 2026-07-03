/**
 * contractService — orchestrates the lifecycle of `contracts`, their
 * `contract_block_inclusions` (which blocks from the library make it
 * onto a given contract), and the public `contract_action_tokens` used
 * by the customer's signing link.
 *
 * Contracts are an INDEPENDENT document type alongside quotes and
 * invoices. Composition model:
 *   - Admin picks blocks from the `contract_blocks` library and toggles
 *     them on/off per section (basics → scope → privacy → commercial →
 *     nda → closing). Order within a section is admin-controlled.
 *   - On send, every included block's body is FROZEN into
 *     `body_text_snapshot` on the inclusion row, so future edits to
 *     the source block don't mutate already-sent contracts.
 *
 * Signing:
 *   1. Customer opens /contract/:token and either:
 *      a) Types name, optionally draws a signature on canvas, ticks
 *         "I have read and agree", submits → recordCustomerSignature
 *         stamps the signature into a re-rendered PDF and the system
 *         emails the admin.
 *      b) Uploads a wet-signed PDF → attachSignedPdfUpload sets the
 *         signed_pdf_path as the authoritative copy.
 *   2. Admin counter-signs (in-browser or by re-uploading the
 *      double-signed PDF) → status flips to `fully_signed`.
 *
 * Bodies support {{placeholders}} resolved at PDF/preview render time
 * using the same Handlebars-lite regex that emailProcessor.safeTemplateReplace
 * uses. We rebuild it inline here (not exported from emailProcessor) to
 * keep the dependency tree shallow and so contracts can render
 * client-side previews in the future without pulling the email
 * processor.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, withRetry, logActivity } = require('../database/db');
const logger = require('../utils/logger');
const { getAppSetting } = require('../utils/appSettings');
const { AppError } = require('../utils/errors');
const { claimNextSequence } = require('../utils/documentSequences');
const { hasColumnCached } = require('../utils/schemaCache');
const { formatShortDate } = require('../utils/dateFormatter');
const businessProfileService = require('./businessProfileService');
const { buildIssuerBlock, buildRecipientBlock } = require('./_renderContext');
const pdfService = require('./pdfService');
const pdfStampService = require('./pdfStampService');
const emailProcessor = require('./emailProcessor');
const { ensureContractEmailTemplatesSeeded } = require('./contractEmailTemplates');
const { ensureSystemBlocksSeeded } = require('./contractBlocksService');
const { getFrontendBaseUrl } = require('../utils/frontendUrl');

const SECTIONS_ORDER = ['basics', 'scope', 'privacy', 'commercial', 'nda', 'closing'];

/**
 * Build a proper {id, type, name} actor object for logActivity. The
 * db.js helper silently downgrades string actors (e.g. 'admin:1') to
 * actor_type='system' with null name, so the audit timeline showed
 * "system" for every admin-driven event. Fetching the admin's name
 * once per service call is a small read cost on a non-hot path.
 *
 * Pass `customerPublic()` for events triggered by the public token
 * (customer signing, customer wet-signed PDF upload).
 */
async function adminActor(adminId) {
  if (!adminId) return { type: 'system' };
  try {
    // admin_users only carries username + email (no first/last/name
    // columns — confirmed from db.js:265). Prefer username for the
    // audit timeline because it's the operator-chosen identifier
    // shown elsewhere in the admin UI; fall back to email when an
    // older install seeded a row without a username.
    const row = await db('admin_users')
      .where({ id: adminId })
      .select('id', 'username', 'email')
      .first();
    if (!row) return { id: adminId, type: 'admin', name: `Admin #${adminId}` };
    const displayName = row.username || row.email || `Admin #${adminId}`;
    return { id: adminId, type: 'admin', name: displayName };
  } catch (_) {
    return { id: adminId, type: 'admin', name: `Admin #${adminId}` };
  }
}

function customerPublicActor() {
  return { type: 'customer', name: 'Customer (public link)' };
}

/**
 * Fire a contract lifecycle event for the workflow engine. Best-effort:
 * resolves the customer email (so send_email actions have a recipient) and
 * never throws into the caller. No-op when the workflows flag is off (emit
 * fails closed). Mirrors quoteService.emitQuoteEvent.
 */
async function emitContractEvent(contract, status) {
  try {
    let customerEmail = null;
    if (contract.customer_account_id) {
      const c = await db('customer_accounts').where({ id: contract.customer_account_id }).first();
      customerEmail = c?.email || null;
    }
    await require('./workflows').emitWorkflowEvent(`contract.${status}`, {
      entityType: 'contract',
      entityId: contract.id,
      payload: {
        contractId: contract.id,
        contractNumber: contract.contract_number,
        customerAccountId: contract.customer_account_id || null,
        customerEmail,
        eventName: contract.event_name || null,
        title: contract.title || null,
      },
    });
  } catch (err) {
    logger.warn('Failed to emit contract workflow event', { contractId: contract.id, status, error: err.message });
  }
}

/**
 * Privacy gate for the customer/admin IP captured at signing time.
 * The `crm_contracts_store_ip` setting (default true) controls
 * whether the IP is persisted into the DB. When off, this helper
 * returns null regardless of what the route passed in — same shape
 * the rest of the code expects, just with no IP data.
 *
 * Default-true means upgrades preserve current behaviour. Operators
 * with strict data-minimisation requirements opt out in Settings →
 * CRM-Settings → Contracts.
 */
async function maybeStoreIp(ip) {
  if (!ip) return null;
  const enabled = await getAppSetting('crm_contracts_store_ip');
  // Default true: only block when EXPLICITLY opted out. The audit
  // flagged that `enabled === false` missed legacy installs where
  // app_settings stored the toggle as a string ('false', '0') — those
  // would slip through and the IP would still get persisted despite
  // the operator's intent. Cover string/number/bool variants
  // defensively. Anything else (null, undefined, true) preserves
  // the default-on behavior.
  if (enabled === false) return null;
  if (enabled === 0 || enabled === '0') return null;
  if (typeof enabled === 'string' && enabled.toLowerCase() === 'false') return null;
  return ip;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

// D.2 — `ensureInt` consolidated into utils/numericHelpers.
const { ensureInt } = require('../utils/numericHelpers');

function formatNumberInTemplate(format, year, seq) {
  return format
    .replace(/\{YEAR\}/g, String(year))
    .replace(/\{MONTH\}/g, String(new Date().getMonth() + 1).padStart(2, '0'))
    .replace(/\{SEQ:(\d+)d\}/g, (_, pad) => String(seq).padStart(parseInt(pad, 10), '0'))
    .replace(/\{SEQ\}/g, String(seq));
}

/**
 * Gap-free per-year contract number sequence. See
 * utils/documentSequences.js for the locking story; migration 132
 * created the underlying table. Atomic against concurrent admin
 * creates — the previous SELECT-MAX-then-INSERT raced and could
 * emit `C-2026-AB12C3` after 5 retries.
 */
async function nextContractNumber(trx) {
  // Read through `trx` when present — getAppSetting on the global db inside an
  // open transaction deadlocks the single-connection SQLite pool (the booking
  // flow's prepare_contract action runs createFromQuote unattended).
  const format = (await getAppSetting('crm_contracts_number_format', null, trx || db)) || 'C-{YEAR}-{SEQ:04d}';
  const year = new Date().getFullYear();
  const seq = await claimNextSequence('contract', year, trx);
  return formatNumberInTemplate(format, year, seq);
}

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

/**
 * SHA-256 hex digest of a Buffer or file path. Used at every PDF
 * write so we can persist a content hash alongside the path —
 * either party can later re-hash the PDF they hold and prove (or
 * disprove) it matches what we issued.
 */
function sha256OfBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
function sha256OfFile(filePath) {
  try {
    return sha256OfBuffer(fs.readFileSync(filePath));
  } catch (_) {
    return null;
  }
}

/**
 * Write a contract PDF to disk and return both the path AND the
 * SHA-256 hash of the buffer we just wrote. Callers persist BOTH on
 * the contracts row so audit defence is single-query: SELECT
 * pdf_path, pdf_sha256 FROM contracts WHERE id = ? then re-hash the
 * file on disk and compare.
 *
 * History-preserving (per requirement #6): every write appends a
 * deterministic suffix so old versions stay on disk. The contract
 * row's `pdf_path` / `signed_pdf_path` always points at the most
 * recent one; earlier versions remain available for forensic
 * comparison.
 */
async function persistContractPdf(contract, buffer, suffix = '') {
  if (!contract.contract_number) return { filePath: null, sha256: null };
  const year = (contract.issue_date ? new Date(contract.issue_date) : new Date()).getFullYear();
  const root = path.join(process.cwd(), 'storage', 'business-docs', 'contract', String(year));
  fs.mkdirSync(root, { recursive: true });
  // Always append a millisecond timestamp to the filename so writes
  // never overwrite an earlier version on disk. Forensic preservation.
  // Example filenames:
  //   C-2026-0001_2026-05-19T1830-22-413.pdf                  (unsigned)
  //   C-2026-0001_signed-by-customer_2026-05-19T1845-10-002.pdf
  //   C-2026-0001_fully-signed_2026-05-19T1912-44-877.pdf
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = suffix
    ? `${contract.contract_number}_${suffix}_${stamp}.pdf`
    : `${contract.contract_number}_${stamp}.pdf`;
  const filePath = path.join(root, fileName);
  fs.writeFileSync(filePath, buffer);
  return { filePath, sha256: sha256OfBuffer(buffer) };
}

// Maximum decoded signature image size. Defends against a customer
// (or attacker holding a captured signing token) POSTing a multi-MB
// signature data URL to fill the disk. A typical signature_pad PNG
// is 10–80 KB; even with retina upscaling we don't expect to see
// 1 MB. The cap is enforced on the BASE64 length before decoding so
// we never allocate the full Buffer for an oversized payload.
//
// The frontend (ContractResponsePage) downscales the canvas to a
// fixed max width before exporting via `toDataURL`, so well-behaved
// clients land well under this cap. This server-side check is the
// authoritative guard.
const MAX_SIGNATURE_BASE64_BYTES = 1024 * 1024; // 1 MB of base64 → ~750 KB decoded

async function persistSignatureImage(contract, role, dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  if (dataUrl.length > MAX_SIGNATURE_BASE64_BYTES + 100 /* prefix slack */) {
    throw new AppError(
      `Signature image exceeds the ${Math.round(MAX_SIGNATURE_BASE64_BYTES / 1024)} KB cap`,
      413, 'SIGNATURE_TOO_LARGE',
    );
  }
  const match = dataUrl.match(/^data:image\/(png|jpeg);base64,(.+)$/);
  if (!match) {
    throw new AppError('Signature must be a base64-encoded PNG or JPEG data URL', 400, 'BAD_SIGNATURE_FORMAT');
  }
  if (match[2].length > MAX_SIGNATURE_BASE64_BYTES) {
    throw new AppError(
      `Signature image exceeds the ${Math.round(MAX_SIGNATURE_BASE64_BYTES / 1024)} KB cap`,
      413, 'SIGNATURE_TOO_LARGE',
    );
  }
  const ext = match[1] === 'jpeg' ? 'jpg' : 'png';
  const root = path.join(
    process.cwd(),
    'storage',
    'business-docs',
    'contract',
    'signatures',
    String(contract.id),
  );
  fs.mkdirSync(root, { recursive: true });
  // Filename already carries Date.now() so re-stamping a signature
  // never overwrites an earlier capture — forensic preservation.
  // Per role, the contract row's signed_*_signature_path always
  // points at the most recent; older files stay alongside.
  const filePath = path.join(root, `${role}-${Date.now()}.${ext}`);
  fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'));
  return filePath;
}

/**
 * Build the stamp sequence the pdf-lib stamp service expects from a
 * single contract row. Customer first, admin second — provenance
 * order matches the visual order on the signature page.
 *
 * Used by the recovery paths (rerenderAndResend, restampSignatures).
 * The hot path (recordCustomerSignature / recordAdminCountersignature)
 * stamps incrementally so it constructs the stamp inline.
 */
function buildSignatureStamps(contract) {
  const locale = contract.language || 'de';
  const nameLabel = 'Name';
  const dateLabel = locale === 'de' ? 'Datum' : 'Date';
  const stamps = [];
  if (contract.signed_customer_signature_path) {
    stamps.push({
      signaturePngPath: contract.signed_customer_signature_path,
      role: 'customer',
      caption: {
        name: contract.signed_customer_name || '',
        signedAt: contract.signed_by_customer_at,
        nameLabel,
        dateLabel,
      },
    });
  }
  if (contract.signed_admin_signature_path) {
    stamps.push({
      signaturePngPath: contract.signed_admin_signature_path,
      role: 'admin',
      caption: {
        name: contract.signed_admin_name || '',
        signedAt: contract.signed_by_admin_at,
        nameLabel,
        dateLabel,
      },
    });
  }
  return stamps;
}

/**
 * Build the audit-certificate context expected by
 * pdfStampService.renderAuditCertificate from a fully-signed
 * contract row. Returns null when the contract isn't signed enough
 * to warrant a certificate (no customer + no admin signature data).
 */
function buildAuditCertContext(contract) {
  const hasCustomerSig = contract.signed_by_customer_at || contract.signed_customer_name;
  const hasAdminSig = contract.signed_by_admin_at || contract.signed_admin_name;
  if (!hasCustomerSig && !hasAdminSig) return null;
  return {
    contract: {
      contract_number: contract.contract_number,
      sent_at: contract.sent_at,
      pdf_sha256: contract.pdf_sha256 || null,
      signed_pdf_sha256: contract.signed_pdf_sha256 || null,
    },
    customer: hasCustomerSig ? {
      name: contract.signed_customer_name,
      signedAt: contract.signed_by_customer_at,
      ip: contract.signed_customer_ip,
    } : null,
    admin: hasAdminSig ? {
      name: contract.signed_admin_name,
      signedAt: contract.signed_by_admin_at,
      ip: contract.signed_admin_ip,
    } : null,
    locale: contract.language || 'de',
  };
}

/**
 * Generate the audit certificate PDF, write it to disk under the same
 * year directory as the contract PDFs (suffix `audit`), and return
 * its file path. Returns null when there's nothing to certify or when
 * rendering fails (the email still goes out without the cert — the
 * stamped PDF alone remains delivered).
 */
async function persistAuditCertificate(contract) {
  const ctx = buildAuditCertContext(contract);
  if (!ctx) return null;
  try {
    const { buffer } = await pdfStampService.renderAuditCertificate(ctx);
    const year = (contract.issue_date ? new Date(contract.issue_date) : new Date()).getFullYear();
    const root = path.join(process.cwd(), 'storage', 'business-docs', 'contract', String(year));
    fs.mkdirSync(root, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(root, `${contract.contract_number}_audit_${stamp}.pdf`);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  } catch (err) {
    logger.error('Failed to render audit certificate', {
      contractId: contract.id,
      contractNumber: contract.contract_number,
      message: err.message,
    });
    return null;
  }
}

function ensureCustomerActive(customer) {
  if (!customer) throw new AppError('Customer not found', 404);
  if (customer.is_active === false || customer.is_active === 0) {
    throw new AppError('Customer is deactivated', 409);
  }
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
  const { resolveLogoFile } = require('../utils/resolveLogoFile');
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

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

async function listContracts({ filters = {}, sort = 'issue_desc', page = 1, pageSize = 25 } = {}) {
  return await withRetry(async () => {
    let query = db('contracts')
      .leftJoin('customer_accounts', 'contracts.customer_account_id', 'customer_accounts.id')
      .select(
        'contracts.*',
        'customer_accounts.email as customer_email',
        'customer_accounts.display_name as customer_display_name',
        'customer_accounts.first_name as customer_first_name',
        'customer_accounts.last_name as customer_last_name',
        'customer_accounts.company_name as customer_company_name',
      );

    if (Array.isArray(filters.status) && filters.status.length > 0) {
      query = query.whereIn('contracts.status', filters.status);
    }
    if (filters.customerAccountId) {
      query = query.where('contracts.customer_account_id', filters.customerAccountId);
    }
    if (filters.q && String(filters.q).trim()) {
      const term = `%${String(filters.q).trim()}%`;
      query = query.andWhere(function() {
        this.where('contracts.contract_number', 'like', term)
          .orWhere('contracts.title', 'like', term)
          .orWhere('customer_accounts.email', 'like', term)
          .orWhere('customer_accounts.company_name', 'like', term);
      });
    }

    const countQuery = query.clone().clearSelect().clearOrder().count('contracts.id as total').first();
    const totalRow = await countQuery;
    const total = ensureInt(totalRow?.total || 0);

    switch (sort) {
      case 'oldest':
        query = query.orderBy('contracts.created_at', 'asc').orderBy('contracts.id', 'asc');
        break;
      case 'issue_asc':
        query = query.orderBy('contracts.issue_date', 'asc').orderBy('contracts.id', 'asc');
        break;
      case 'issue_desc':
        query = query.orderBy('contracts.issue_date', 'desc').orderBy('contracts.id', 'desc');
        break;
      case 'customer_asc':
        query = query
          .orderByRaw('COALESCE(customer_accounts.company_name, customer_accounts.last_name, customer_accounts.email) asc')
          .orderBy('contracts.id', 'desc');
        break;
      case 'customer_desc':
        query = query
          .orderByRaw('COALESCE(customer_accounts.company_name, customer_accounts.last_name, customer_accounts.email) desc')
          .orderBy('contracts.id', 'desc');
        break;
      case 'newest':
      default:
        query = query.orderBy('contracts.created_at', 'desc').orderBy('contracts.id', 'desc');
        break;
    }

    const offset = Math.max(0, (page - 1) * pageSize);
    query = query.offset(offset).limit(pageSize);
    const rows = await query;
    return { rows, total, page, pageSize };
  });
}

async function getContractById(id) {
  return await withRetry(async () => {
    const contract = await db('contracts')
      .leftJoin('customer_accounts', 'contracts.customer_account_id', 'customer_accounts.id')
      .where('contracts.id', id)
      .select(
        'contracts.*',
        'customer_accounts.email as customer_email',
        'customer_accounts.display_name as customer_display_name',
        'customer_accounts.first_name as customer_first_name',
        'customer_accounts.last_name as customer_last_name',
        'customer_accounts.company_name as customer_company_name',
        'customer_accounts.preferred_language as customer_preferred_language',
      )
      .first();
    if (!contract) return null;

    const inclusions = await db('contract_block_inclusions as inc')
      .leftJoin('contract_blocks as blk', 'blk.id', 'inc.block_id')
      .where('inc.contract_id', id)
      .orderByRaw(`
        CASE inc.section
          WHEN 'basics' THEN 1
          WHEN 'scope' THEN 2
          WHEN 'privacy' THEN 3
          WHEN 'commercial' THEN 4
          WHEN 'nda' THEN 5
          WHEN 'closing' THEN 6
          ELSE 99
        END
      `)
      .orderBy('inc.position', 'asc')
      .select(
        'inc.*',
        'blk.slug as block_slug',
        'blk.name as block_name',
        'blk.description as block_description',
        'blk.body_text as block_body_text',
        'blk.body_text_de as block_body_text_de',
        // Migration 131 — locale variants. Pulled with column-existence
        // guard so installs that haven't run migration 131 still load
        // contracts (just without the new columns).
        ...(await hasColumnCached('contract_blocks', 'body_text_ru')
          ? ['blk.body_text_ru as block_body_text_ru'] : []),
        ...(await hasColumnCached('contract_blocks', 'body_text_pt')
          ? ['blk.body_text_pt as block_body_text_pt'] : []),
        ...(await hasColumnCached('contract_blocks', 'body_text_nl')
          ? ['blk.body_text_nl as block_body_text_nl'] : []),
        ...(await hasColumnCached('contract_blocks', 'body_text_fr')
          ? ['blk.body_text_fr as block_body_text_fr'] : []),
        'blk.is_system as block_is_system',
      );
    return { contract, inclusions };
  });
}

/**
 * Create a draft contract. Pre-populates `contract_block_inclusions`
 * with every active system block toggled ON so the admin sees a
 * sensible starting point and just toggles off what they don't need.
 *
 * Custom (non-system) blocks are NOT auto-included — admin opts in to
 * those explicitly so a runaway block library doesn't pollute every
 * new contract.
 */
async function createContract(payload, adminId) {
  // Self-heal: ensure runtime-seeded system blocks (e.g. the
  // quote_line_items_table added after migration 131 was deployed)
  // exist before we copy active system blocks into the new contract's
  // inclusion list. Idempotent — only fires if rows are missing.
  await ensureSystemBlocksSeeded();

  const customer = await db('customer_accounts').where({ id: payload.customerAccountId }).first();
  ensureCustomerActive(customer);

  const profile = (await businessProfileService.getProfile()).profile;
  const language = payload.language || customer.preferred_language || profile?.default_locale || 'de';
  const validDays = ensureInt(await getAppSetting('crm_contracts_default_valid_days')) || 30;
  const issueDate = payload.issueDate || new Date().toISOString().slice(0, 10);
  const validUntil = payload.validUntil || new Date(Date.now() + validDays * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  // Schema-drift guard for the event-snapshot columns added as
  // in-place migration 130 edits. We only write them when the DB
  // actually has them; older dev installs that haven't re-migrated
  // simply skip these fields (contract still saves successfully).
  const hasEventCols = await hasColumnCached('contracts', 'event_name');

  return await db.transaction(async (trx) => {
    // Pass trx so the sequence claim joins our outer transaction —
    // SQLite deadlocks otherwise (1-connection default).
    const contractNumber = await nextContractNumber(trx);
    const row = {
      contract_number: contractNumber,
      customer_account_id: payload.customerAccountId,
      status: 'draft',
      language,
      issue_date: issueDate,
      valid_until: validUntil,
      title: payload.title || null,
      intro_text: payload.introText || null,
      outro_text: payload.outroText || null,
      // Migration 140 — standalone contract is a deal root; mint a
      // fresh UUID. The createFromQuote path (line ~1557) sets this
      // from the source quote's deal_uuid instead.
      deal_uuid: crypto.randomUUID(),
      created_by_admin_id: adminId,
      created_at: new Date(),
      updated_at: new Date(),
    };
    if (hasEventCols) {
      row.event_name = payload.eventName || null;
      row.event_date = payload.eventDate || null;
      row.event_time_start = payload.eventTimeStart || null;
      row.event_time_end = payload.eventTimeEnd || null;
    }
    // Migration 121 — optional link to a Project Overview project.
    if (payload.projectId !== undefined && await hasColumnCached('contracts', 'project_id')) {
      row.project_id = payload.projectId || null;
    }
    const inserted = await trx('contracts').insert(row).returning('id');
    if (row.project_id && row.deal_uuid) {
      await require('./projectService').linkDealToProject(row.deal_uuid, row.project_id, trx);
    }
    const contractId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

    // Seed with every active system block, toggled on. Per-section
    // position = display_order from the source block.
    //
    // D.3 — batched insert. Previously this loop fired one INSERT per
    // block (12+ round-trips inside the transaction on a fresh contract).
    // Batched into a single `.insert(rows)` since the row count is
    // bounded (system block count) and the inserts are independent.
    const systemBlocks = await trx('contract_blocks')
      .where({ is_system: true, is_active: true })
      .orderBy(['section', 'display_order']);
    const sectionCounters = {};
    const inclusionRows = systemBlocks.map((block) => {
      sectionCounters[block.section] = (sectionCounters[block.section] || 0) + 1;
      return {
        contract_id: contractId,
        block_id: block.id,
        section: block.section,
        position: sectionCounters[block.section],
        body_text_snapshot: null,
        body_text_de_snapshot: null,
        included: true,
        created_at: new Date(),
        updated_at: new Date(),
      };
    });
    if (inclusionRows.length > 0) {
      await trx('contract_block_inclusions').insert(inclusionRows);
    }

    try {
      await logActivity('contract_created', { contractId, contractNumber, customerAccountId: payload.customerAccountId }, null, await adminActor(adminId));
    } catch (_) { /* logging is best-effort */ }

    logger.info('Contract created', { adminId, contractId, contractNumber });
    return contractId;
  });
}

/**
 * Update a draft contract. Editing a sent contract is refused — admin
 * must cancel + create a fresh one (avoids invalidating the customer's
 * signed copy).
 *
 * payload.blocks is an array of `{ blockId, included, position }`
 * tuples; the service rewrites the contract_block_inclusions rows
 * accordingly.
 */
async function updateContract(id, payload, adminId) {
  const existing = await db('contracts').where({ id }).first();
  if (!existing) throw new AppError('Contract not found', 404);
  if (existing.status !== 'draft') {
    throw new AppError(
      `Cannot edit a contract with status '${existing.status}'. Cancel and create a new contract for amendments.`,
      409,
      'CONTRACT_LOCKED',
    );
  }

  const hasEventCols = await hasColumnCached('contracts', 'event_name');

  return await db.transaction(async (trx) => {
    const updates = { updated_at: new Date() };
    const map = {
      title: 'title',
      introText: 'intro_text',
      outroText: 'outro_text',
      language: 'language',
      validUntil: 'valid_until',
      issueDate: 'issue_date',
    };
    // Event-snapshot fields only flow through when the DB has them
    // (in-place migration 130 edit). Guarded so dev installs that
    // haven't re-migrated don't crash the update.
    if (hasEventCols) {
      Object.assign(map, {
        eventName: 'event_name',
        eventDate: 'event_date',
        eventTimeStart: 'event_time_start',
        eventTimeEnd: 'event_time_end',
      });
    }
    for (const [api, col] of Object.entries(map)) {
      if (api in payload) updates[col] = payload[api] || null;
    }
    // Migration 121 — optional Project Overview link.
    if ('projectId' in payload && await hasColumnCached('contracts', 'project_id')) {
      updates.project_id = payload.projectId || null;
    }
    await trx('contracts').where({ id }).update(updates);

    // Cascade across the deal lineage (linked quote / event / invoices).
    if (updates.project_id) {
      const dealRow = await trx('contracts').where({ id }).select('deal_uuid').first();
      await require('./projectService').linkDealToProject(dealRow && dealRow.deal_uuid, updates.project_id, trx);
    }

    // Replace inclusions only when the caller sent an explicit list.
    // (Editor's "save" sends every row; an inline "toggle" save could
    // send a partial update — current frontend always sends full list.)
    if (Array.isArray(payload.blocks)) {
      await trx('contract_block_inclusions').where({ contract_id: id }).del();
      // Recompute per-section position so we don't trust caller order
      // for ordering integrity; caller controls only the section
      // sequence via the order of items in payload.blocks.
      //
      // Previously this loop did one SELECT per block to look up its
      // section. On a contract with 12 included blocks that's 12
      // round-trips inside the transaction — pure N+1. Batch the
      // lookup into a single WHERE…IN, build a Map, and read it in
      // the loop. The insert itself stays sequential because the
      // editor's payload size is bounded (<30 blocks in practice) and
      // a single batch insert would lose row-by-row insert ordering
      // guarantees we don't actually need.
      const blockIds = [
        ...new Set(payload.blocks.map((e) => e.blockId).filter((id) => Number.isFinite(id))),
      ];
      const blocksFound = blockIds.length > 0
        ? await trx('contract_blocks').whereIn('id', blockIds).select('id', 'section')
        : [];
      const sectionByBlockId = new Map(blocksFound.map((b) => [b.id, b.section]));
      const sectionCounters = {};
      for (const entry of payload.blocks) {
        const section = sectionByBlockId.get(entry.blockId);
        if (!section) continue;
        sectionCounters[section] = (sectionCounters[section] || 0) + 1;
        await trx('contract_block_inclusions').insert({
          contract_id: id,
          block_id: entry.blockId,
          section,
          position: ensureInt(entry.position) || sectionCounters[section],
          body_text_snapshot: null,
          body_text_de_snapshot: null,
          included: entry.included === false ? false : true,
          created_at: new Date(),
          updated_at: new Date(),
        });
      }
    }

    try {
      await logActivity('contract_updated', { contractId: id }, null, await adminActor(adminId));
    } catch (_) { /* logging is best-effort */ }
    return id;
  });
}

/**
 * Render PDF for a saved contract (preview before send, or re-render
 * after signing).
 */
async function renderContractPdfBuffer(contractId) {
  const data = await getContractById(contractId);
  if (!data) throw new AppError('Contract not found', 404);
  const ctx = await buildRenderContext(data.contract, data.inclusions);
  return await pdfService.renderContractToBuffer(ctx);
}

/**
 * Send the contract: snapshot every included block's body, render PDF,
 * persist, mint a signing token, queue the customer email.
 */
async function sendContract(id, adminId) {
  // Self-heal: dev installs that ran migration 130 BEFORE we added
  // contract_fully_signed to the seed list won't have all three
  // contract templates in email_templates. Insert any missing rows
  // before we queue the email. Idempotent + module-cached.
  await ensureContractEmailTemplatesSeeded(db, logger);

  const data = await getContractById(id);
  if (!data) throw new AppError('Contract not found', 404);
  const { contract, inclusions } = data;

  if (!['draft'].includes(contract.status)) {
    throw new AppError(`Cannot send a contract with status '${contract.status}'`, 409);
  }

  const customer = await db('customer_accounts').where({ id: contract.customer_account_id }).first();
  ensureCustomerActive(customer);

  // Snapshot every included block's body into the inclusion row so
  // future block edits don't mutate the sent contract.
  await db.transaction(async (trx) => {
    for (const inc of inclusions) {
      if (!(inc.included === true || inc.included === 1 || inc.included === '1')) continue;
      await trx('contract_block_inclusions').where({ id: inc.id }).update({
        body_text_snapshot: inc.block_body_text || null,
        body_text_de_snapshot: inc.block_body_text_de || null,
        updated_at: new Date(),
      });
    }
  });

  // Re-fetch with snapshots populated so the renderer uses the frozen
  // bodies (matches post-send reads).
  const refreshed = await getContractById(id);
  const ctx = await buildRenderContext(refreshed.contract, refreshed.inclusions);
  const buffer = await pdfService.renderContractToBuffer(ctx);
  const { filePath: pdfPath, sha256: pdfSha256 } = await persistContractPdf(refreshed.contract, buffer);

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = contract.valid_until
    ? new Date(new Date(contract.valid_until).getTime() + 14 * 24 * 60 * 60 * 1000)
    : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

  // Schema-drift guard for the new pdf_sha256 column (migration 130
  // in-place edit). Dev installs that haven't re-migrated skip the
  // hash write; the send still succeeds.
  const hasPdfSha = await hasColumnCached('contracts', 'pdf_sha256');

  await db.transaction(async (trx) => {
    await trx('contract_action_tokens').insert({
      contract_id: id,
      token,
      expires_at: expiresAt,
      created_at: new Date(),
    });
    const updates = {
      status: 'sent',
      sent_at: new Date(),
      pdf_path: pdfPath,
      updated_at: new Date(),
    };
    if (hasPdfSha) updates.pdf_sha256 = pdfSha256;
    await trx('contracts').where({ id }).update(updates);
  });

  const frontendUrl = (await getFrontendBaseUrl()) || 'http://localhost:3000';
  const responseUrl = `${frontendUrl}/contract/${token}`;
  // Honour the admin's "Attach contract PDF to email" toggle. Default
  // ON; an admin who prefers a link-only email turns it off and the
  // customer reaches the PDF via the public sign page instead.
  const attachPdf = await getAppSetting('crm_contracts_pdf_attachment_enabled');
  await emailProcessor.queueEmail(null, customer.email, 'contract_sent', {
    contract_number: contract.contract_number,
    customer_name: customer.display_name
      || [customer.first_name, customer.last_name].filter(Boolean).join(' ')
      || customer.email.split('@')[0],
    response_url: responseUrl,
    title: contract.title || '',
    event_name: contract.event_name || '',
    valid_until: formatShortDate(contract.valid_until),
    attachments: (attachPdf !== false && pdfPath) ? [{
      filename: `${contract.contract_number}.pdf`,
      contentPath: pdfPath,
      contentType: 'application/pdf',
    }] : undefined,
  });

  try {
    await logActivity('contract_sent', { contractId: id, token }, null, await adminActor(adminId));
  } catch (_) { /* logging is best-effort */ }

  await emitContractEvent(contract, 'sent');

  logger.info('Contract sent', { adminId, contractId: id });
  return { token, pdfPath };
}

/**
 * Record a customer's in-browser signature (canvas + typed name +
 * "I accept" checkbox). Validates the token, persists the signature
 * PNG, re-renders the PDF with the signature stamped, flips status
 * to `signed_by_customer`, and queues the admin notification email.
 */
async function recordCustomerSignature({ token, name, ip, signatureDataUrl, accepted }) {
  // Self-heal contract email templates. The contract_signed_admin_notification
  // email fires from this function — if its row is missing, the admin
  // never learns the customer signed.
  await ensureContractEmailTemplatesSeeded(db, logger);

  if (accepted !== true) {
    throw new AppError('You must confirm that you have read and agree to the terms.', 400, 'TOS_REQUIRED');
  }
  if (!name || !String(name).trim()) {
    throw new AppError('Your name is required.', 400, 'NAME_REQUIRED');
  }
  // Server-side guard for the "require drawn signature" admin toggle.
  // The public sign page also enforces this client-side, but the
  // server is the source of truth — a malicious caller posting
  // directly to /sign with a blank signatureDataUrl would otherwise
  // bypass the requirement.
  const requireDrawn = await getAppSetting('crm_contracts_require_drawn_signature');
  if (requireDrawn === true && (!signatureDataUrl || !String(signatureDataUrl).trim())) {
    throw new AppError(
      'A drawn signature is required for this contract — typing your name alone is not sufficient.',
      400, 'SIGNATURE_REQUIRED',
    );
  }
  const tokenRow = await db('contract_action_tokens').where({ token }).first();
  if (!tokenRow) throw new AppError('Token not found', 404);
  if (tokenRow.expires_at && new Date(tokenRow.expires_at).getTime() < Date.now()) {
    throw new AppError('This signing link has expired', 410);
  }
  if (tokenRow.used_at) {
    throw new AppError('This contract has already been signed', 410, 'TOKEN_ALREADY_USED');
  }

  const contract = await db('contracts').where({ id: tokenRow.contract_id }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  if (!['sent'].includes(contract.status)) {
    throw new AppError(`Contract cannot be signed in status '${contract.status}'`, 409);
  }

  const signaturePath = signatureDataUrl
    ? await persistSignatureImage(contract, 'customer', signatureDataUrl)
    : null;

  const now = new Date();
  // Resolve the IP gate ONCE before the transaction so both writes
  // (contracts row + tokens row) agree. Setting flip mid-transaction
  // can't happen anyway, but doing it upfront keeps the data
  // consistent and saves a redundant read.
  const persistedIp = await maybeStoreIp(ip);
  try {
  await db.transaction(async (trx) => {
    await trx('contracts').where({ id: contract.id }).update({
      status: 'signed_by_customer',
      signed_by_customer_at: now,
      signed_customer_name: String(name).trim(),
      signed_customer_ip: persistedIp,
      signed_customer_signature_path: signaturePath,
      updated_at: now,
    });
    await trx('contract_action_tokens').where({ id: tokenRow.id }).update({
      used_at: now,
      used_action: 'signed_by_customer',
      used_ip: persistedIp,
    });
  });
  } catch (txErr) {
    // C.7 — clean up the orphan signature PNG we wrote before the
    // transaction. The DB rollback already undid the contract +
    // token writes; the file would otherwise sit forever in
    // storage/business-docs/contract/.../signatures/. Best-effort
    // unlink — if the cleanup itself fails, log and re-throw the
    // original transaction error so the caller still sees the real
    // failure cause.
    if (signaturePath) {
      try {
        if (fs.existsSync(signaturePath)) fs.unlinkSync(signaturePath);
      } catch (cleanupErr) {
        logger.warn('Orphan signature PNG cleanup failed', {
          path: signaturePath, message: cleanupErr.message,
        });
      }
    }
    throw txErr;
  }

  // Stamp the customer's signature onto the UNSIGNED PDF on disk.
  // Byte-immutable approach (see pdfStampService): we read pdf_path
  // (the immutable as-sent PDF), stamp the customer's signature PNG
  // at the fixed coordinates on the signature page, save as a new
  // timestamped file, and update signed_pdf_path. Original file
  // stays untouched on disk.
  const refreshed = await getContractById(contract.id);
  try {
    if (!refreshed.contract.pdf_path || !fs.existsSync(refreshed.contract.pdf_path)) {
      throw new Error(`Unsigned PDF missing on disk at ${refreshed.contract.pdf_path}`);
    }
    const originalPdfBuffer = fs.readFileSync(refreshed.contract.pdf_path);
    const stampedBuffer = await pdfStampService.stampSignature({
      pdfBuffer: originalPdfBuffer,
      signaturePngPath: signaturePath,
      role: 'customer',
      caption: {
        name: String(name).trim(),
        signedAt: now,
        nameLabel: refreshed.contract.language === 'de' ? 'Name' : 'Name',
        dateLabel: refreshed.contract.language === 'de' ? 'Datum' : 'Date',
      },
    });
    const { filePath: signedPath, sha256: signedSha256 } = await persistContractPdf(
      refreshed.contract, stampedBuffer, 'signed-by-customer',
    );
    const hasSignedPdfSha = await hasColumnCached('contracts', 'signed_pdf_sha256');
    const updates = {
      signed_pdf_path: signedPath,
      updated_at: new Date(),
    };
    if (hasSignedPdfSha) updates.signed_pdf_sha256 = signedSha256;
    // Migration 136 — clear any pre-existing render-failed marker; the
    // most recent stamp attempt just succeeded.
    if (await hasColumnCached('contracts', 'signed_pdf_render_failed_at')) {
      updates.signed_pdf_render_failed_at = null;
      updates.signed_pdf_render_error = null;
    }
    await db('contracts').where({ id: contract.id }).update(updates);
  } catch (err) {
    // Signature recorded; PDF re-render is best-effort. The admin can
    // re-render manually from the detail page if this fails. Logged as
    // error (not warn) so persistent failures surface in monitoring.
    logger.error('Failed to re-render contract PDF after customer signature', {
      contractId: contract.id,
      message: err.message,
      stack: err.stack,
    });
    // Migration 136 — surface the failure on the contract row so the
    // admin detail page can render a recovery banner instead of the
    // admin only discovering this through monitoring. err.message is
    // truncated to 2 KB; the full stack stays in server logs.
    try {
      if (await hasColumnCached('contracts', 'signed_pdf_render_failed_at')) {
        await db('contracts').where({ id: contract.id }).update({
          signed_pdf_render_failed_at: new Date(),
          signed_pdf_render_error: String(err.message || 'Unknown error').slice(0, 2048),
          updated_at: new Date(),
        });
      }
    } catch (markErr) {
      // Marker write itself failed — log + swallow so the customer
      // sign response still succeeds. The orphan stays orphan but
      // we've at least surfaced both errors.
      logger.error('Failed to record signed_pdf_render_failed marker', {
        contractId: contract.id, message: markErr.message,
      });
    }
  }

  // Notify admin.
  const customer = await db('customer_accounts').where({ id: contract.customer_account_id }).first();
  const frontendUrl = (await getFrontendBaseUrl()) || 'http://localhost:3000';
  try {
    await emailProcessor.queueEmail(null, null, 'contract_signed_admin_notification', {
      contract_number: contract.contract_number,
      customer_email: customer?.email || '',
      signed_customer_name: String(name).trim(),
      admin_dashboard_url: `${frontendUrl}/admin/clients/contracts/${contract.id}`,
    });
  } catch (err) {
    logger.warn('Failed to queue admin notification after customer signature', {
      contractId: contract.id, error: err.message,
    });
  }

  try {
    await logActivity('contract_signed_by_customer', { contractId: contract.id, token }, null, customerPublicActor());
  } catch (_) { /* logging is best-effort */ }

  return { status: 'signed_by_customer', signedAt: now };
}

/**
 * Admin counter-signature. Bumps status to `fully_signed` (or
 * `signed_by_admin` if the customer hasn't signed yet — edge case
 * where admin signs first, e.g. issuer-side framework agreement).
 */
async function recordAdminCountersignature(contractId, { name, ip, signatureDataUrl }, adminId) {
  // Self-heal: ensure the contract_fully_signed template exists
  // before we counter-sign. The dual-party send fires from this
  // function on the fully_signed transition; without the template
  // it silently fails and the customer never receives the PDF.
  await ensureContractEmailTemplatesSeeded(db, logger);

  if (!name || !String(name).trim()) {
    throw new AppError('Your name is required.', 400, 'NAME_REQUIRED');
  }
  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  if (!['signed_by_customer', 'sent'].includes(contract.status)) {
    throw new AppError(`Cannot counter-sign a contract with status '${contract.status}'`, 409);
  }

  const signaturePath = signatureDataUrl
    ? await persistSignatureImage(contract, 'admin', signatureDataUrl)
    : null;

  const now = new Date();
  const newStatus = contract.status === 'signed_by_customer' ? 'fully_signed' : 'signed_by_admin';
  const persistedAdminIp = await maybeStoreIp(ip);
  try {
  await db('contracts').where({ id: contract.id }).update({
    status: newStatus,
    signed_by_admin_at: now,
    signed_admin_name: String(name).trim(),
    signed_admin_ip: persistedAdminIp,
    signed_admin_signature_path: signaturePath,
    updated_at: now,
  });
  } catch (updateErr) {
    // C.7 — clean up the orphan signature PNG if the contract row
    // update threw. Best-effort; log on cleanup failure and re-throw
    // the original update error.
    if (signaturePath) {
      try {
        if (fs.existsSync(signaturePath)) fs.unlinkSync(signaturePath);
      } catch (cleanupErr) {
        logger.warn('Orphan admin signature PNG cleanup failed', {
          path: signaturePath, message: cleanupErr.message,
        });
      }
    }
    throw updateErr;
  }

  // Stamp the admin's signature ON TOP of whatever signed_pdf_path
  // currently holds (the customer-stamped PDF, in the normal flow)
  // — or directly onto the unsigned pdf_path if the admin is the
  // first to sign (edge case). Byte-immutable: each prior PDF stays
  // on disk; the new file is a fresh timestamped version.
  const refreshed = await getContractById(contract.id);
  let signedPath = null;
  let signedSha256 = null;
  try {
    const baseFile = (refreshed.contract.signed_pdf_path && fs.existsSync(refreshed.contract.signed_pdf_path))
      ? refreshed.contract.signed_pdf_path
      : refreshed.contract.pdf_path;
    if (!baseFile || !fs.existsSync(baseFile)) {
      throw new Error(`Contract base PDF missing on disk for stamping (signed_pdf_path=${refreshed.contract.signed_pdf_path}, pdf_path=${refreshed.contract.pdf_path})`);
    }
    const baseBuffer = fs.readFileSync(baseFile);
    const stampedBuffer = await pdfStampService.stampSignature({
      pdfBuffer: baseBuffer,
      signaturePngPath: signaturePath,
      role: 'admin',
      caption: {
        name: String(name).trim(),
        signedAt: now,
        nameLabel: refreshed.contract.language === 'de' ? 'Name' : 'Name',
        dateLabel: refreshed.contract.language === 'de' ? 'Datum' : 'Date',
      },
    });
    const suffix = newStatus === 'fully_signed' ? 'fully-signed' : 'signed-by-admin';
    const persisted = await persistContractPdf(refreshed.contract, stampedBuffer, suffix);
    signedPath = persisted.filePath;
    signedSha256 = persisted.sha256;
    const hasSignedPdfSha = await hasColumnCached('contracts', 'signed_pdf_sha256');
    const updates = {
      signed_pdf_path: signedPath,
      updated_at: new Date(),
    };
    if (hasSignedPdfSha) updates.signed_pdf_sha256 = signedSha256;
    if (await hasColumnCached('contracts', 'signed_pdf_render_failed_at')) {
      updates.signed_pdf_render_failed_at = null;
      updates.signed_pdf_render_error = null;
    }
    await db('contracts').where({ id: contract.id }).update(updates);
  } catch (err) {
    logger.error('Failed to stamp contract PDF after admin signature', {
      contractId: contract.id,
      newStatus,
      message: err.message,
      stack: err.stack,
    });
    // Migration 136 — mirror the customer-sign branch: persist a
    // recovery marker so the admin detail page can surface a banner.
    try {
      if (await hasColumnCached('contracts', 'signed_pdf_render_failed_at')) {
        await db('contracts').where({ id: contract.id }).update({
          signed_pdf_render_failed_at: new Date(),
          signed_pdf_render_error: String(err.message || 'Unknown error').slice(0, 2048),
          updated_at: new Date(),
        });
      }
    } catch (markErr) {
      logger.error('Failed to record signed_pdf_render_failed marker (admin sign)', {
        contractId: contract.id, message: markErr.message,
      });
    }
  }

  // When the admin's signature is what FINALISED the contract (i.e.
  // status flipped to fully_signed), email a copy of the freshly
  // re-rendered PDF to both parties. We send two separate queueEmail
  // calls so each recipient gets the email rendered with their own
  // greeting + name. The admin BCC is delivered as "to the issuer"
  // so it lands in the same inbox the contract_sent email originated
  // from.
  if (newStatus === 'fully_signed') {
    try {
      // Pick the best available PDF as the attachment, in priority
      // order: this counter-sign's freshly-rendered signed copy →
      // the customer-only signed copy we wrote earlier → the
      // original unsigned PDF. Falling all the way through to no
      // attachment is acceptable; the email still goes out with the
      // contract number so the customer knows it's binding.
      const refetched = await db('contracts').where({ id: contract.id }).first();
      const attachmentPath = signedPath
        || refetched?.signed_pdf_path
        || refetched?.pdf_path
        || null;

      const customer = await db('customer_accounts').where({ id: contract.customer_account_id }).first();
      const profile = (await businessProfileService.getProfile()).profile || {};
      const adminRow = await db('admin_users').where({ id: adminId }).first();
      const customerName = customer?.display_name
        || [customer?.first_name, customer?.last_name].filter(Boolean).join(' ')
        || customer?.email?.split('@')[0]
        || '';
      // Generate the audit certificate as a SIBLING document (separate
      // PDF) and attach it alongside the stamped contract. Audit cert
      // captures timestamps, IPs, names, and SHA-256 hashes — the legal
      // provenance record. Reproducible from contract data so safe to
      // regenerate on demand; we still persist a copy to disk for the
      // forensic trail.
      const auditCertPath = await persistAuditCertificate(refetched || refreshed.contract);

      const attachments = [];
      if (attachmentPath) {
        attachments.push({
          filename: `${refreshed.contract.contract_number}-signed.pdf`,
          contentPath: attachmentPath,
          contentType: 'application/pdf',
        });
      }
      if (auditCertPath) {
        attachments.push({
          filename: `${refreshed.contract.contract_number}-audit.pdf`,
          contentPath: auditCertPath,
          contentType: 'application/pdf',
        });
      }
      const attachmentsArg = attachments.length > 0 ? attachments : undefined;

      // 1. Customer copy
      if (customer?.email) {
        await emailProcessor.queueEmail(null, customer.email, 'contract_fully_signed', {
          contract_number: refreshed.contract.contract_number,
          customer_name: customerName,
          title: refreshed.contract.title || '',
          attachments: attachmentsArg,
        });
      }
      // 2. Admin copy. Prefer business_profile.email (the inbox the
      // contract was sent FROM); fall back to the counter-signing
      // admin's account email so the audit trail still reaches a
      // human even on installs where business_profile.email is blank.
      const adminEmail = profile.email || adminRow?.email;
      if (adminEmail && adminEmail !== customer?.email) {
        await emailProcessor.queueEmail(null, adminEmail, 'contract_fully_signed', {
          contract_number: refreshed.contract.contract_number,
          customer_name: profile.company_name || adminRow?.first_name || 'Team',
          title: refreshed.contract.title || '',
          attachments: attachmentsArg,
        });
      }
    } catch (err) {
      logger.error('Failed to send contract_fully_signed emails', {
        contractId: contract.id,
        message: err.message,
        stack: err.stack,
      });
    }
  }

  try {
    await logActivity(`contract_${newStatus}`, { contractId: contract.id }, null, await adminActor(adminId));
  } catch (_) { /* logging is best-effort */ }

  // The binding moment — fire contract.signed once the contract is fully signed
  // (matches the editor's trigger). Best-effort / fail-closed.
  if (newStatus === 'fully_signed') await emitContractEvent(contract, 'signed');

  return { status: newStatus, signedAt: now };
}

/**
 * Attach a wet-signed PDF as the authoritative signed copy. Either
 * party can upload (admin via admin route, customer via public token
 * route). When the customer uploads, status flips to `fully_signed`
 * because the wet signature is treated as a full agreement (admin
 * would normally also sign the wet copy before sending it to the
 * customer).
 */
async function attachSignedPdfUpload(contractId, filePath, uploaderRole) {
  // Self-heal contract email templates — same reason as the
  // sendContract + recordAdminCountersignature paths.
  await ensureContractEmailTemplatesSeeded(db, logger);

  if (!filePath) throw new AppError('No file uploaded', 400);
  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  if (['cancelled', 'draft'].includes(contract.status)) {
    throw new AppError(`Cannot attach a signed PDF to a contract in status '${contract.status}'`, 409);
  }

  const now = new Date();
  const updates = {
    signed_pdf_path: filePath,
    status: 'fully_signed',
    updated_at: now,
  };
  // Migration 135 — durable wet-upload discriminator. Persists the
  // "this row holds an authoritative wet upload, do not auto-overwrite"
  // signal as a column rather than inferring from the file path. See
  // the migration body for the full rationale.
  if (await hasColumnCached('contracts', 'signed_pdf_is_wet_upload')) {
    updates.signed_pdf_is_wet_upload = true;
  }
  // Hash the uploaded PDF on disk so we can later prove it wasn't
  // tampered with after upload. Multer wrote the file synchronously
  // before this handler runs, so reading it here is safe.
  if (await hasColumnCached('contracts', 'signed_pdf_sha256')) {
    updates.signed_pdf_sha256 = sha256OfFile(filePath);
  }
  if (uploaderRole === 'customer' && !contract.signed_by_customer_at) {
    updates.signed_by_customer_at = now;
  }
  if (uploaderRole === 'admin' && !contract.signed_by_admin_at) {
    updates.signed_by_admin_at = now;
  }
  await db('contracts').where({ id: contractId }).update(updates);

  // attachSignedPdfUpload always transitions to fully_signed (see
  // updates.status above), so the dual-party send fires here too —
  // same pattern as recordAdminCountersignature. The uploaded PDF
  // IS the authoritative copy so we attach it directly.
  try {
    const refreshedContract = await db('contracts').where({ id: contractId }).first();
    const customer = await db('customer_accounts').where({ id: refreshedContract.customer_account_id }).first();
    const profile = (await businessProfileService.getProfile()).profile || {};
    const customerName = customer?.display_name
      || [customer?.first_name, customer?.last_name].filter(Boolean).join(' ')
      || customer?.email?.split('@')[0]
      || '';
    const attachments = [{
      filename: `${refreshedContract.contract_number}-signed.pdf`,
      contentPath: filePath,
      contentType: 'application/pdf',
    }];
    // Sibling audit certificate — same legal-provenance record as the
    // in-browser sign path. Best-effort; missing cert doesn't block the
    // wet-signed PDF from reaching the parties.
    const auditCertPath = await persistAuditCertificate(refreshedContract);
    if (auditCertPath) {
      attachments.push({
        filename: `${refreshedContract.contract_number}-audit.pdf`,
        contentPath: auditCertPath,
        contentType: 'application/pdf',
      });
    }
    if (customer?.email) {
      await emailProcessor.queueEmail(null, customer.email, 'contract_fully_signed', {
        contract_number: refreshedContract.contract_number,
        customer_name: customerName,
        title: refreshedContract.title || '',
        attachments,
      });
    }
    if (profile.email && profile.email !== customer?.email) {
      await emailProcessor.queueEmail(null, profile.email, 'contract_fully_signed', {
        contract_number: refreshedContract.contract_number,
        customer_name: profile.company_name || 'Team',
        title: refreshedContract.title || '',
        attachments,
      });
    }
  } catch (err) {
    logger.warn('Failed to send contract_fully_signed emails after PDF upload', {
      contractId, error: err.message,
    });
  }

  try {
    await logActivity('contract_signed_pdf_uploaded', { contractId, uploaderRole }, null,
      uploaderRole === 'admin' ? { type: 'admin', name: 'Admin (PDF upload)' } : customerPublicActor());
  } catch (_) { /* logging is best-effort */ }

  await emitContractEvent(contract, 'signed');

  return { status: 'fully_signed', signedPdfPath: filePath };
}

/**
 * Convert an accepted quote into a fresh draft contract, pre-populating
 * the customer, language, title, valid-until window, and source_quote_id
 * back-pointer. Idempotent — if the quote already has a linked contract
 * (quote.converted_contract_id set), returns that contract's id without
 * creating a duplicate.
 *
 * Does NOT flip quote.status — the quote stays 'accepted' while the
 * contract is the active deliverable. The quote→event / quote→invoice
 * paths are gated against the converted_contract_id back-pointer so an
 * admin can't accidentally double-spend the quote.
 */
async function createFromQuote(quoteId, adminId) {
  // Same self-heal as createContract — the quote-conversion path seeds
  // the contract with every active system block, and the new
  // quote_line_items_table block needs to be present for it to land
  // in the default inclusion list.
  await ensureSystemBlocksSeeded();

  const quote = await db('quotes').where({ id: quoteId }).first();
  if (!quote) throw new AppError('Quote not found', 404);
  if (quote.status !== 'accepted') {
    throw new AppError(`Cannot convert a quote with status '${quote.status}'`, 409, 'QUOTE_NOT_ACCEPTED');
  }
  if (quote.converted_contract_id) {
    return { contractId: quote.converted_contract_id, alreadyConverted: true };
  }
  if (quote.converted_event_id) {
    throw new AppError(
      'This quote was already converted to an event. Create the contract from the event instead.',
      409, 'ALREADY_CONVERTED_TO_EVENT',
    );
  }

  const customer = await db('customer_accounts').where({ id: quote.customer_account_id }).first();
  ensureCustomerActive(customer);

  const profile = (await businessProfileService.getProfile()).profile;
  const validDays = ensureInt(await getAppSetting('crm_contracts_default_valid_days')) || 30;
  const issueDate = new Date().toISOString().slice(0, 10);
  const validUntil = new Date(Date.now() + validDays * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  const title = quote.event_name
    ? `Contract — ${quote.event_name}`
    : `Contract from quote ${quote.quote_number}`;

  // Schema-drift safety: the lineage columns landed in migration 130
  // as in-place edits. Dev installs that ran 130 BEFORE that edit
  // won't have these columns yet. hasColumn() lets us skip the
  // affected writes instead of crashing with a generic 500.
  const hasContractSourceQuote = await hasColumnCached('contracts', 'source_quote_id');
  const hasQuoteContractBackPointer = await hasColumnCached('quotes', 'converted_contract_id');
  const hasContractEventCols = await hasColumnCached('contracts', 'event_name');

  // Resolve the actor BEFORE opening the transaction — adminActor reads
  // admin_users via the global db, which deadlocks the single-connection
  // SQLite pool if evaluated inside the trx (prepare_contract runs unattended).
  const actor = await adminActor(adminId);

  return await db.transaction(async (trx) => {
    // Pass trx so the sequence claim joins our outer transaction —
    // SQLite deadlocks otherwise (1-connection default).
    const contractNumber = await nextContractNumber(trx);
    const contractRow = {
      contract_number: contractNumber,
      customer_account_id: quote.customer_account_id,
      status: 'draft',
      language: quote.language || customer.preferred_language || profile?.default_locale || 'de',
      issue_date: issueDate,
      valid_until: validUntil,
      title,
      intro_text: quote.intro_text || null,
      outro_text: quote.outro_text || null,
      created_by_admin_id: adminId,
      created_at: new Date(),
      updated_at: new Date(),
    };
    if (hasContractSourceQuote) contractRow.source_quote_id = quote.id;
    // Migration 140 — contract from quote inherits the quote's
    // deal_uuid so both documents belong to the same deal chain.
    // Falls back to a fresh UUID only if the source quote predates the
    // backfill (shouldn't happen on a migrated install, but defensive).
    contractRow.deal_uuid = quote.deal_uuid || crypto.randomUUID();
    // Propagate the quote's event snapshot — same fields the quote
    // already carries (set by createQuote). Means contract-from-quote
    // chains preserve "this contract is for the Wedding Doe / Müller"
    // labelling all the way through to the resulting invoice's
    // event_name field.
    if (hasContractEventCols) {
      contractRow.event_name = quote.event_name || null;
      contractRow.event_date = quote.event_date || null;
      contractRow.event_time_start = quote.event_time_start || null;
      contractRow.event_time_end = quote.event_time_end || null;
    }
    const inserted = await trx('contracts').insert(contractRow).returning('id');
    const contractId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

    // Seed every active system block. Same shape as createContract.
    // D.3 — batched insert (one DB round-trip vs N).
    const systemBlocks = await trx('contract_blocks')
      .where({ is_system: true, is_active: true })
      .orderBy(['section', 'display_order']);
    const sectionCounters = {};
    const inclusionRows = systemBlocks.map((block) => {
      sectionCounters[block.section] = (sectionCounters[block.section] || 0) + 1;
      return {
        contract_id: contractId,
        block_id: block.id,
        section: block.section,
        position: sectionCounters[block.section],
        body_text_snapshot: null,
        body_text_de_snapshot: null,
        included: true,
        created_at: new Date(),
        updated_at: new Date(),
      };
    });
    if (inclusionRows.length > 0) {
      await trx('contract_block_inclusions').insert(inclusionRows);
    }

    // Back-pointer so the quote detail page can deep-link to its
    // resulting contract and the convert-to-event/invoice paths know
    // to refuse double conversion. Skipped silently when the column
    // hasn't migrated — the contract is still created cleanly.
    if (hasQuoteContractBackPointer) {
      await trx('quotes').where({ id: quote.id }).update({
        converted_contract_id: contractId,
        updated_at: new Date(),
      });
    }

    try {
      // Pass `trx` so the audit insert rides the transaction's connection;
      // the global db here deadlocks the single-connection SQLite pool.
      await logActivity('contract_created_from_quote',
        { contractId, contractNumber, quoteId: quote.id, quoteNumber: quote.quote_number },
        null, actor, trx);
    } catch (_) { /* logging is best-effort */ }
    logger.info('Contract created from quote', { adminId, contractId, contractNumber, quoteId: quote.id });
    return { contractId, alreadyConverted: false };
  });
}

/**
 * Convert a fully-signed contract into an event + scheduled invoices.
 * Delegates to quoteService.convertToEvent using the contract's
 * source_quote_id so the line items + payment plan come from the
 * original quote. The quote MUST still be in 'accepted' status (i.e.
 * not previously converted) — createFromQuote keeps it that way.
 *
 * On success the contract's converted_event_id is set (back-pointer)
 * and the source quote flips to 'converted'.
 */
async function convertToEvent(contractId, adminId) {
  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  if (contract.status !== 'fully_signed') {
    throw new AppError(
      `Cannot convert a contract with status '${contract.status}'. The contract must be fully signed by both parties first.`,
      409, 'CONTRACT_NOT_FULLY_SIGNED',
    );
  }
  if (contract.converted_event_id) {
    return { eventId: contract.converted_event_id, alreadyConverted: true };
  }

  const hasContractConvertedEvent = await hasColumnCached('contracts', 'converted_event_id');

  // Path A: source quote present → delegate to quoteService which
  // replays the full installment schedule into invoices alongside
  // the event row.
  if (contract.source_quote_id) {
    const quoteService = require('./quoteService');
    const result = await quoteService.convertToEvent(contract.source_quote_id, adminId, { fromContract: true });
    if (hasContractConvertedEvent) {
      await db('contracts').where({ id: contractId }).update({
        converted_event_id: result.eventId,
        updated_at: new Date(),
      });
    }
    try {
      await logActivity('contract_converted_to_event',
        { contractId, eventId: result.eventId, quoteId: contract.source_quote_id },
        result.eventId, await adminActor(adminId));
    } catch (_) { /* logging is best-effort */ }
    return result;
  }

  // Path B: standalone contract → mint an empty placeholder event
  // row the admin fleshes out from the events admin page. Same
  // column-introspection trick quoteService uses so installs with
  // old/new host_*/customer_* column variants both work.
  const customer = await db('customer_accounts').where({ id: contract.customer_account_id }).first();
  ensureCustomerActive(customer);
  const adminRow = await db('admin_users').where({ id: adminId }).first();
  const today = new Date();
  const oneYearFromNow = new Date(today.getTime());
  oneYearFromNow.setFullYear(today.getFullYear() + 1);

  const fullName = [customer.first_name, customer.last_name].filter(Boolean).join(' ')
    || customer.display_name || customer.company_name || contract.contract_number;
  const customerEmail = customer.email || `${contract.contract_number.toLowerCase()}@picpeak.local`;
  const adminEmail = adminRow?.email || customer.email || 'admin@picpeak.local';
  const placeholderHash = crypto.randomBytes(32).toString('hex');
  const shareToken = crypto.randomBytes(32).toString('hex');

  const eventCols = await db('events').columnInfo();
  const candidate = {
    slug: `contract-${contract.contract_number.toLowerCase()}-${crypto.randomBytes(3).toString('hex')}`,
    // Prefer the contract's event_name snapshot (set on the contract
    // editor or inherited from the source quote) over the contract
    // title. Falls back to a deterministic placeholder so the event
    // row never has a blank name.
    event_name: contract.event_name || contract.title || `Event ${contract.contract_number}`,
    event_date: contract.event_date || contract.issue_date,
    host_name: fullName,
    host_email: customerEmail,
    customer_name: fullName,
    customer_email: customerEmail,
    customer_phone: customer.phone,
    admin_email: adminEmail,
    event_type: 'wedding',
    password_hash: placeholderHash,
    share_link: shareToken,
    share_token: shareToken,
    expires_at: oneYearFromNow,
    is_active: true,
    is_archived: false,
    is_draft: true,
    created_by: adminId,
    quote_id: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
  const eventRow = {};
  for (const [k, v] of Object.entries(candidate)) {
    if (Object.prototype.hasOwnProperty.call(eventCols, k)) eventRow[k] = v;
  }
  const inserted = await db('events').insert(eventRow).returning('id');
  const eventId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

  // Link the customer so they see the event on their portal once
  // the admin activates it. Best-effort — older installs without
  // the junction table still get the event row.
  try {
    if (await db.schema.hasTable('event_customer_assignments')) {
      await db('event_customer_assignments').insert({
        event_id: eventId,
        customer_account_id: customer.id,
        assigned_by_admin_id: adminId,
        assigned_at: new Date(),
      });
    }
  } catch (_) { /* best-effort */ }

  if (hasContractConvertedEvent) {
    await db('contracts').where({ id: contractId }).update({
      converted_event_id: eventId,
      updated_at: new Date(),
    });
  }

  try {
    await logActivity('contract_converted_to_empty_event',
      { contractId, eventId }, eventId, await adminActor(adminId));
  } catch (_) { /* logging is best-effort */ }

  return { eventId, alreadyConverted: false };
}

/**
 * Convert a fully-signed contract directly into invoice(s) without
 * creating an event row. Same delegation pattern as convertToEvent.
 */
async function convertToInvoiceOnly(contractId, adminId) {
  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  if (contract.status !== 'fully_signed') {
    throw new AppError(
      `Cannot convert a contract with status '${contract.status}'. The contract must be fully signed by both parties first.`,
      409, 'CONTRACT_NOT_FULLY_SIGNED',
    );
  }

  // Schema-drift guard — the lineage columns are in-place edits to
  // migration 130. Skip the back-pointer update silently when the
  // column hasn't migrated yet.
  const hasInvoiceContractBackPointer = await hasColumnCached('invoices', 'source_contract_id');

  // Path A: contract has a source quote → replay its line items +
  // payment plan via quoteService (full installment schedule).
  if (contract.source_quote_id) {
    const quoteService = require('./quoteService');
    const result = await quoteService.convertToInvoiceOnly(contract.source_quote_id, adminId, { fromContract: true });
    if (hasInvoiceContractBackPointer) {
      await db('invoices')
        .where({ source_quote_id: contract.source_quote_id })
        .whereNull('source_contract_id')
        .update({ source_contract_id: contractId });
    }
    try {
      await logActivity('contract_converted_to_invoices',
        { contractId, quoteId: contract.source_quote_id, installments: result.installmentsCreated },
        null, await adminActor(adminId));
    } catch (_) { /* logging is best-effort */ }
    return result;
  }

  // Path B: standalone contract (no source quote) → direct DB insert
  // of an empty draft. We deliberately bypass invoiceService.createInvoice
  // because that runs ensureCustomerCanBill, which throws if the
  // customer doesn't have feature_bills enabled. Admin clicking
  // "Convert to invoice" on the contract detail page IS the
  // authorisation; the admin will fill in line items manually before
  // sending.
  const customer = await db('customer_accounts').where({ id: contract.customer_account_id }).first();
  ensureCustomerActive(customer);

  const invoiceService = require('./invoiceService');
  const profile = (await businessProfileService.getProfile()).profile || {};
  const currency = (profile.default_currency || 'CHF').toUpperCase();
  const language = contract.language || customer.preferred_language || profile.default_locale || 'de';
  const issueDate = new Date().toISOString().slice(0, 10);
  const netDays = ensureInt(await getAppSetting('crm_payment_default_net_days')) || 30;
  const dueDate = new Date(Date.now() + netDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Pre-resolve which event-snapshot columns the invoices table has
  // (migration 123) so we can copy contract.event_name etc onto the
  // new invoice. Falls back to contract.title when event_name is
  // empty — gives standalone contracts a useful label even when
  // the admin didn't fill out the event field.
  const invoiceHasEventName = await hasColumnCached('invoices', 'event_name');
  const eventNameSnapshot = (contract.event_name || contract.title || null);

  const invoiceNumber = await invoiceService.nextInvoiceNumber();
  const invoiceRow = {
    invoice_number: invoiceNumber,
    customer_account_id: contract.customer_account_id,
    source_quote_id: null,
    event_id: null,
    language,
    currency,
    issue_date: issueDate,
    due_date: dueDate,
    installment_index: 0,
    installment_total: 1,
    status: 'scheduled',
    net_amount_minor: 0,
    vat_rate: 0,
    vat_amount_minor: 0,
    shipping_amount_minor: 0,
    total_amount_minor: 0,
    paid_amount_minor: 0,
    reminder_level: 0,
    late_fee_amount_minor: 0,
    created_by_admin_id: adminId,
    created_at: new Date(),
    updated_at: new Date(),
  };
  if (hasInvoiceContractBackPointer) invoiceRow.source_contract_id = contractId;
  // Migration 140 — invoice inherits the contract's deal_uuid so the
  // contract + invoice belong to the same deal chain. Fresh UUID if
  // the contract predates the backfill (defensive).
  invoiceRow.deal_uuid = contract.deal_uuid || crypto.randomUUID();
  // Snapshot the contract's event fields onto the invoice so the
  // BillDetailPage + customer portal show the same "Wedding Doe /
  // Müller" label that the contract carries. event_name is also the
  // field the dunning emails reference in their templates.
  if (invoiceHasEventName) {
    invoiceRow.event_name = eventNameSnapshot;
    invoiceRow.event_date = contract.event_date || null;
    invoiceRow.event_time_start = contract.event_time_start || null;
    invoiceRow.event_time_end = contract.event_time_end || null;
  }
  const inserted = await db('invoices').insert(invoiceRow).returning('id');
  const invoiceId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

  try {
    await logActivity('contract_converted_to_empty_invoice',
      { contractId, invoiceId, invoiceNumber }, null, await adminActor(adminId));
  } catch (_) { /* logging is best-effort */ }

  // Match the result shape of the source-quote path so the frontend
  // toast can use the same translation key. `installmentsCreated` is
  // always 1 here (single empty invoice).
  return { installmentsCreated: 1, invoiceId };
}

/**
 * Recovery helper: re-render the signed PDF + resend the
 * contract_fully_signed email to both parties. Used by the admin
 * detail page when:
 *   - a previous render silently failed (signed_pdf_path is empty
 *     on a fully_signed contract)
 *   - the customer reports they didn't receive the email
 *   - the bodies of the seeded blocks were updated post-signing and
 *     the admin wants the latest text on file
 *
 * Only available on fully_signed contracts. The wet-signed PDF path
 * is preserved: when signed_pdf_path already points at an uploaded
 * file (not a re-render path) we DO NOT overwrite — the uploaded PDF
 * is the authoritative copy. We still resend the email with that
 * uploaded PDF as the attachment.
 */
async function rerenderAndResend(contractId, adminId) {
  // Self-heal contract email templates. This is the most likely
  // recovery path the admin reaches when a prior dual-party send
  // failed silently — including when the failure was caused by the
  // template being missing in the first place.
  const newlySeeded = await ensureContractEmailTemplatesSeeded(db, logger);
  if (newlySeeded.length > 0) {
    logger.warn('rerenderAndResend self-healed missing email templates', {
      contractId, seeded: newlySeeded,
    });
  }

  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  if (contract.status !== 'fully_signed') {
    throw new AppError(
      `Re-send is only available on fully-signed contracts (status: ${contract.status})`,
      409, 'NOT_FULLY_SIGNED',
    );
  }

  let attachmentPath = contract.signed_pdf_path || null;
  // Migration 135 — `signed_pdf_is_wet_upload` is the durable
  // authoritative-source discriminator. It's set TRUE only by
  // attachSignedPdfUpload, so any non-wet path here is a system
  // stamp safe to replace. We still null-check the path so missing
  // (re-stamp recovery) cases trigger the re-stamp branch below.
  const hasWetFlagColumn = await hasColumnCached('contracts', 'signed_pdf_is_wet_upload');
  const isWetSignedUpload = hasWetFlagColumn
    ? (contract.signed_pdf_is_wet_upload === true || contract.signed_pdf_is_wet_upload === 1)
    // Fallback ONLY for installs where the migration hasn't applied yet:
    // preserve the historical substring rule so we don't accidentally
    // overwrite uploads on an un-migrated DB.
    : !!(attachmentPath && attachmentPath.includes('uploads/contracts/signed'));
  if (!attachmentPath || !isWetSignedUpload) {
    // Stamp signatures onto the immutable unsigned pdf_path using
    // pdf-lib (NOT a full re-render). This preserves the exact bytes
    // the customer originally agreed to and side-steps the silent re-
    // render failure that left signed_pdf_path NULL on prior contracts.
    const refreshed = await getContractById(contract.id);
    if (!refreshed.contract.pdf_path || !fs.existsSync(refreshed.contract.pdf_path)) {
      throw new AppError(
        `Unsigned PDF missing on disk at ${refreshed.contract.pdf_path}; cannot re-stamp.`,
        500, 'UNSIGNED_PDF_MISSING',
      );
    }
    const originalBuffer = fs.readFileSync(refreshed.contract.pdf_path);
    const stamps = buildSignatureStamps(refreshed.contract);
    const { buffer: stampedBuffer, sha256: signedSha256 } =
      await pdfStampService.stampSignatures(originalBuffer, stamps);
    const persisted = await persistContractPdf(refreshed.contract, stampedBuffer, 'fully-signed');
    attachmentPath = persisted.filePath;
    const hasSignedPdfSha = await hasColumnCached('contracts', 'signed_pdf_sha256');
    const updates = {
      signed_pdf_path: attachmentPath,
      updated_at: new Date(),
    };
    if (hasSignedPdfSha) updates.signed_pdf_sha256 = signedSha256;
    // Migration 136 — this branch is a recovery path; clear any
    // existing failed-render marker.
    if (await hasColumnCached('contracts', 'signed_pdf_render_failed_at')) {
      updates.signed_pdf_render_failed_at = null;
      updates.signed_pdf_render_error = null;
    }
    await db('contracts').where({ id: contract.id }).update(updates);
  }

  // Resend the dual-party email with the now-guaranteed attachment.
  const refetched = await db('contracts').where({ id: contract.id }).first();
  const customer = await db('customer_accounts').where({ id: refetched.customer_account_id }).first();
  const profile = (await businessProfileService.getProfile()).profile || {};
  const adminRow = await db('admin_users').where({ id: adminId }).first();
  const customerName = customer?.display_name
    || [customer?.first_name, customer?.last_name].filter(Boolean).join(' ')
    || customer?.email?.split('@')[0]
    || '';
  // Sibling audit certificate (timestamps + IPs + hashes). Best-effort:
  // missing certificate doesn't block the email — the stamped contract
  // alone is the primary attachment.
  const auditCertPath = await persistAuditCertificate(refetched);

  const attachments = [{
    filename: `${refetched.contract_number}-signed.pdf`,
    contentPath: attachmentPath,
    contentType: 'application/pdf',
  }];
  if (auditCertPath) {
    attachments.push({
      filename: `${refetched.contract_number}-audit.pdf`,
      contentPath: auditCertPath,
      contentType: 'application/pdf',
    });
  }

  if (customer?.email) {
    await emailProcessor.queueEmail(null, customer.email, 'contract_fully_signed', {
      contract_number: refetched.contract_number,
      customer_name: customerName,
      title: refetched.title || '',
      attachments,
    });
  }
  const adminEmail = profile.email || adminRow?.email;
  if (adminEmail && adminEmail !== customer?.email) {
    await emailProcessor.queueEmail(null, adminEmail, 'contract_fully_signed', {
      contract_number: refetched.contract_number,
      customer_name: profile.company_name || adminRow?.first_name || 'Team',
      title: refetched.title || '',
      attachments,
    });
  }

  try {
    await logActivity('contract_resent_signed', { contractId }, null, await adminActor(adminId));
  } catch (_) { /* logging is best-effort */ }

  return { signedPdfPath: attachmentPath, resent: true };
}

/**
 * Recovery helper: admin re-stamps signatures (customer and/or admin)
 * on a contract whose signature_path columns are null/broken because
 * the original sign happened before the canvas worked correctly.
 *
 * The admin draws BOTH signatures on the detail page — the customer's
 * signature is admin-attested in this flow (the customer already
 * agreed via the original sign; this just makes the PDF show
 * something). Original signed_by_*_at + signed_*_name + signed_*_ip
 * stay untouched; only the *_signature_path columns + the rendered
 * PDF get refreshed.
 *
 * Available on contracts in status:
 *   signed_by_customer (re-stamp customer, optionally admin too)
 *   signed_by_admin    (re-stamp admin, optionally customer too)
 *   fully_signed       (re-stamp either or both)
 */
async function restampSignatures(contractId, { customerSignatureDataUrl, adminSignatureDataUrl }, adminId) {
  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  if (!['signed_by_customer', 'signed_by_admin', 'fully_signed'].includes(contract.status)) {
    throw new AppError(
      `Cannot re-stamp signatures on a contract in status '${contract.status}'.`,
      409, 'WRONG_STATUS',
    );
  }
  if (!customerSignatureDataUrl && !adminSignatureDataUrl) {
    throw new AppError('At least one signature data URL must be provided.', 400, 'NO_SIGNATURE');
  }

  const updates = { updated_at: new Date() };
  if (customerSignatureDataUrl) {
    updates.signed_customer_signature_path = await persistSignatureImage(contract, 'customer', customerSignatureDataUrl);
  }
  if (adminSignatureDataUrl) {
    updates.signed_admin_signature_path = await persistSignatureImage(contract, 'admin', adminSignatureDataUrl);
  }
  await db('contracts').where({ id: contract.id }).update(updates);

  // Re-stamp signature images onto the immutable unsigned pdf_path
  // using pdf-lib (NOT a full re-render). This is the recovery path
  // for contracts where signature images existed on disk but the
  // earlier re-render approach failed silently and left signed_pdf_path
  // NULL or pointing at a stale file. We always rebuild the stamp from
  // pdf_path (the as-sent bytes) so the result is reproducible from
  // the audit record.
  //
  // Wet-signed PDF uploads remain authoritative — if signed_pdf_path
  // already points at an uploaded PDF we still produce a stamped copy
  // on disk for the audit trail, but signed_pdf_path is not updated.
  const refreshed = await getContractById(contract.id);
  if (!refreshed.contract.pdf_path || !fs.existsSync(refreshed.contract.pdf_path)) {
    throw new AppError(
      `Unsigned PDF missing on disk at ${refreshed.contract.pdf_path}; cannot re-stamp.`,
      500, 'UNSIGNED_PDF_MISSING',
    );
  }
  const originalBuffer = fs.readFileSync(refreshed.contract.pdf_path);
  const stamps = buildSignatureStamps(refreshed.contract);
  const { buffer: stampedBuffer, sha256: signedSha256 } =
    await pdfStampService.stampSignatures(originalBuffer, stamps);
  const { filePath: signedPath } = await persistContractPdf(refreshed.contract, stampedBuffer,
    contract.status === 'fully_signed' ? 'fully-signed' : 'partially-signed');

  // Migration 135 — read the discriminator column. Fall back to the
  // historical substring rule only when the column is absent (un-
  // migrated install) so we never accidentally overwrite a wet upload.
  const hasWetFlagColumn = await hasColumnCached('contracts', 'signed_pdf_is_wet_upload');
  const isWetSignedUpload = hasWetFlagColumn
    ? (contract.signed_pdf_is_wet_upload === true || contract.signed_pdf_is_wet_upload === 1)
    : !!(contract.signed_pdf_path
      && contract.signed_pdf_path.includes('uploads/contracts/signed'));
  if (!isWetSignedUpload) {
    const hasSignedPdfSha = await hasColumnCached('contracts', 'signed_pdf_sha256');
    const updates = {
      signed_pdf_path: signedPath,
      updated_at: new Date(),
    };
    if (hasSignedPdfSha) updates.signed_pdf_sha256 = signedSha256;
    // Migration 136 — restamp is a recovery path; clear the marker.
    if (await hasColumnCached('contracts', 'signed_pdf_render_failed_at')) {
      updates.signed_pdf_render_failed_at = null;
      updates.signed_pdf_render_error = null;
    }
    await db('contracts').where({ id: contract.id }).update(updates);
  }

  try {
    await logActivity('contract_signatures_restamped', {
      contractId,
      stamped: {
        customer: !!customerSignatureDataUrl,
        admin: !!adminSignatureDataUrl,
      },
    }, null, await adminActor(adminId));
  } catch (_) { /* logging is best-effort */ }

  return {
    signedPdfPath: isWetSignedUpload ? contract.signed_pdf_path : signedPath,
    stamped: {
      customer: !!customerSignatureDataUrl,
      admin: !!adminSignatureDataUrl,
    },
  };
}

/**
 * Read the chronological audit trail for a contract from activity_logs.
 * Matches every `contract_*` activity_type where metadata.contractId
 * equals this contract's id. Ordered oldest → newest so the UI can
 * render a vertical timeline. Read-only; used by the admin detail
 * page's AuditTrailCard.
 */
async function getAuditTrail(contractId) {
  if (!(await db.schema.hasTable('activity_logs'))) return [];
  // Push the metadata.contractId filter into SQL instead of fetching
  // every contract_* row and filtering in JS. The previous shape
  // scanned the entire history every time the detail page loaded —
  // O(rows-since-CRM-launch) per request. Both Postgres and SQLite
  // store metadata as a JSON-encoded string here, so we match on
  // a literal substring that covers either compact or whitespaced
  // JSON encodings — `"contractId":<n>` or `"contractId": <n>` —
  // bounded by the activity_type prefix so the search hits the
  // contract_* slice of the index.
  //
  // The substring patterns intentionally don't anchor on word
  // boundaries; activity_logs.metadata never contains a contractId
  // key collision with another id-shaped value because logActivity
  // serialises only what callers pass.
  const id = Number(contractId);
  if (!Number.isFinite(id)) return [];
  const rows = await db('activity_logs')
    .where('activity_type', 'like', 'contract_%')
    .andWhere(function () {
      this.where('metadata', 'like', `%"contractId":${id}%`)
        .orWhere('metadata', 'like', `%"contractId": ${id}%`);
    })
    .orderBy('created_at', 'asc')
    .select('id', 'activity_type', 'actor_type', 'actor_id', 'actor_name', 'metadata', 'created_at');

  return rows.map((r) => {
    let meta = r.metadata;
    if (typeof meta === 'string') {
      try { meta = JSON.parse(meta); } catch { meta = {}; }
    }
    return { ...r, metadata: meta || {} };
  });
}

/**
 * Re-hash the two on-disk PDFs and compare against the stored hashes
 * (pdf_sha256 / signed_pdf_sha256 from migration 131). Lets the admin
 * confirm that backups, manual moves, or storage corruption haven't
 * silently altered the issued document.
 *
 * Each leg of the response carries:
 *   - `path`: the stored path string (so the UI can show what was
 *     checked even when it's missing)
 *   - `present`: file exists on disk
 *   - `expected`: the SHA-256 column value (null if never persisted)
 *   - `actual`: the freshly-computed hash, or null when file missing
 *   - `match`: true iff both hashes exist AND they're equal
 *
 * The customer already has both expected hashes via the audit
 * certificate the signing flow ships as a second email attachment, so
 * they can verify independently with `shasum -a 256`. This endpoint
 * is the admin-side equivalent — single click instead of dropping to
 * a shell.
 */
async function verifyIntegrity(id) {
  const contract = await db('contracts')
    .where({ id })
    .select('id', 'pdf_path', 'pdf_sha256', 'signed_pdf_path', 'signed_pdf_sha256')
    .first();
  if (!contract) throw new AppError('Contract not found', 404);

  const checkLeg = (filePath, expected) => {
    const present = !!filePath && fs.existsSync(filePath);
    const actual = present ? sha256OfFile(filePath) : null;
    return {
      path: filePath || null,
      present,
      expected: expected || null,
      actual,
      match: !!(expected && actual && expected === actual),
    };
  };

  return {
    unsigned: checkLeg(contract.pdf_path, contract.pdf_sha256),
    signed: checkLeg(contract.signed_pdf_path, contract.signed_pdf_sha256),
  };
}

async function cancelContract(id, adminId) {
  const contract = await db('contracts').where({ id }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  if (!['draft', 'sent'].includes(contract.status)) {
    throw new AppError(`Cannot cancel a contract with status '${contract.status}'`, 409);
  }
  await db('contracts').where({ id }).update({
    status: 'cancelled',
    updated_at: new Date(),
  });
  // Invalidate any outstanding tokens.
  await db('contract_action_tokens').where({ contract_id: id, used_at: null }).update({
    expires_at: new Date(),
  });
  try {
    await logActivity('contract_cancelled', { contractId: id }, null, await adminActor(adminId));
  } catch (_) { /* logging is best-effort */ }
  return { status: 'cancelled' };
}

module.exports = {
  listContracts,
  getContractById,
  createContract,
  updateContract,
  sendContract,
  renderContractPdfBuffer,
  recordCustomerSignature,
  recordAdminCountersignature,
  attachSignedPdfUpload,
  cancelContract,
  createFromQuote,
  convertToEvent,
  convertToInvoiceOnly,
  rerenderAndResend,
  restampSignatures,
  getAuditTrail,
  verifyIntegrity,
  // Exported for tests + the public-route preview endpoint.
  _internal: {
    nextContractNumber,
    renderTemplatedBody,
    buildPlaceholderContext,
    buildRenderContext,
    SECTIONS_ORDER,
  },
};
