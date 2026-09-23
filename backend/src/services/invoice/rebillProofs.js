// Re-bill / passthrough proof attachments (issue #866).
//
// When a client invoice re-bills one or more captured supplier invoices
// (inbound_documents.billed_invoice_id → this invoice), the original stored
// supplier PDF can ride along on the invoice email as a SEPARATE attachment
// (the invoice PDF itself is never touched — invoice immutability). Whether a
// given proof attaches is decided at ISSUE time:
//
//   • Manual send  → the admin's per-file selection from the Send dialog
//                    (proofInboundIds), which defaults to the resolved toggle.
//   • Auto send    → (scheduler / monthly flush, no admin present) the resolved
//                    default: per-customer override (customer_accounts
//                    .rebill_attach_proof, tri-state) else the global
//                    accounting_rebill_attach_proof (default off).
//
// A selected proof whose file is missing/unreadable does NOT silently drop and
// does NOT block the send — we stamp inbound_documents.proof_attach_error so the
// re-bill row surfaces a recovery banner in CRM → Customer.
//
// Kept in its own module (not expenseService) to avoid the invoiceService ↔
// expenseService require cycle.

const fs = require('fs');
const path = require('path');
const { db } = require('../../database/db');
const logger = require('../../utils/logger');
const { isFeatureEnabled } = require('../../middleware/requireFeatureFlag');
const { assertStoredPathInside } = require('../../utils/safePath');
const { getStoragePath } = require('../../config/storage');
const { auditedUpdate } = require('../accountingHistory');

// Dispositions that re-bill/pass a supplier invoice to a client (mirrors
// expenseService.CUSTOMER_DISPOSITIONS — duplicated as a 2-item constant rather
// than imported, to keep this module free of the require cycle).
const CUSTOMER_DISPOSITIONS = ['rebill', 'durchlaufend'];

const DEFAULT_PROOF_FILENAME_FORMAT = 'Beleg-{INVOICE}';

// Render a proof attachment filename from the admin-configurable template.
// Tokens: {INVOICE} (client invoice number), {SUPPLIER}, {YEAR}, {MONTH},
// {SEQ} / {SEQ:0Nd} (per-invoice proof index). Always yields a filesystem-safe
// name ending in .pdf. When one invoice carries several proofs but the template
// has no {SEQ}, an index is appended so the filenames stay unique.
function renderProofName(format, { invoiceNumber, supplierName, seq, hasMulti, issueDate }) {
  const d = issueDate ? new Date(issueDate) : new Date();
  const year = Number.isNaN(d.getTime()) ? '' : String(d.getFullYear());
  const month = Number.isNaN(d.getTime()) ? '' : String(d.getMonth() + 1).padStart(2, '0');
  let hadSeq = false;
  let name = String(format || DEFAULT_PROOF_FILENAME_FORMAT)
    .replace(/\{INVOICE\}/g, invoiceNumber || 'invoice')
    .replace(/\{SUPPLIER\}/g, supplierName || '')
    .replace(/\{YEAR\}/g, year)
    .replace(/\{MONTH\}/g, month)
    .replace(/\{SEQ:(\d+)d\}/g, (_, p) => { hadSeq = true; return String(seq).padStart(parseInt(p, 10), '0'); })
    .replace(/\{SEQ\}/g, () => { hadSeq = true; return String(seq); });
  if (hasMulti && !hadSeq) name += `-${seq}`;
  // Filesystem-safe: drop any author-supplied extension, collapse whitespace +
  // unsafe chars to '-', trim stray separators. Some German schemes use '/'.
  name = name.replace(/\.pdf$/i, '')
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (!name) name = 'Beleg';
  return `${name}.pdf`;
}

async function readFilenameFormat() {
  try {
    const row = await db('app_settings').where({ setting_key: 'crm_rebill_proof_filename_format' }).first('setting_value');
    if (!row) return DEFAULT_PROOF_FILENAME_FORMAT;
    let v = row.setting_value;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_e) { /* keep raw */ } }
    return (typeof v === 'string' && v.trim()) ? v.trim() : DEFAULT_PROOF_FILENAME_FORMAT;
  } catch (_e) {
    return DEFAULT_PROOF_FILENAME_FORMAT;
  }
}

async function readGlobalDefault() {
  try {
    const row = await db('app_settings').where({ setting_key: 'accounting_rebill_attach_proof' }).first('setting_value');
    if (!row) return false;
    let v = row.setting_value;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_e) { /* keep raw */ } }
    return v === true || v === 1 || v === '1';
  } catch (_e) {
    return false; // app_settings absent in some test harnesses → off
  }
}

// Tri-state resolution: per-customer override wins; NULL/undefined inherits the
// global default.
function resolveDefaultAttach(customer, globalOn) {
  const ov = customer ? customer.rebill_attach_proof : null;
  if (ov === null || ov === undefined) return !!globalOn;
  return ov === true || ov === 1;
}

/**
 * Build the proof attachments for an invoice being issued, and persist per-row
 * failure markers. Returns an array of nodemailer-style attachment descriptors
 * ({ filename, contentPath, contentType }) — possibly empty. Never throws into
 * the send path.
 *
 * @param invoice          the invoice row (needs id, invoice_number)
 * @param customer         the customer_accounts row (for the tri-state override)
 * @param proofInboundIds  optional explicit selection (manual send). When
 *                         omitted, the resolved default decides all-or-none.
 * @param actor            who is sending, for the accounting change history
 */
async function collectRebillProofAttachments(invoice, customer, proofInboundIds, actor = null) {
  // Backend flag gate — no proof handling at all when incoming-invoices is off.
  if (!(await isFeatureEnabled('incomingInvoices'))) return [];

  let rebillRows;
  try {
    rebillRows = await db('inbound_documents')
      .where({ billed_invoice_id: invoice.id })
      .whereIn('disposition', CUSTOMER_DISPOSITIONS)
      .select('id', 'file_path', 'supplier_name', 'original_filename');
  } catch (_e) {
    return []; // table absent (older install / test harness)
  }
  if (!rebillRows || rebillRows.length === 0) return [];

  // Decide the set to attach.
  let selected;
  if (Array.isArray(proofInboundIds)) {
    // Manual send: attach exactly the admin's picks that actually belong to
    // this invoice's re-bill set (ignore anything foreign).
    const wanted = new Set(proofInboundIds.map((n) => parseInt(n, 10)).filter(Number.isInteger));
    selected = rebillRows.filter((r) => wanted.has(r.id));
  } else {
    // Auto send: all-or-none per the resolved default.
    const globalOn = await readGlobalDefault();
    selected = resolveDefaultAttach(customer, globalOn) ? rebillRows : [];
  }
  if (selected.length === 0) return [];

  const businessDocs = path.join(getStoragePath(), 'business-docs');
  const format = await readFilenameFormat();
  const multi = selected.length > 1;
  const attachments = [];

  for (let i = 0; i < selected.length; i += 1) {
    const row = selected[i];
    let markerErr = null;
    if (!row.file_path) {
      markerErr = 'proof file missing (no stored PDF on the supplier invoice)';
    } else {
      try {
        const safe = assertStoredPathInside(row.file_path, [businessDocs]);
        if (!fs.existsSync(safe)) {
          markerErr = 'proof file not found on disk at issue time';
        } else {
          attachments.push({
            filename: renderProofName(format, {
              invoiceNumber: invoice.invoice_number,
              supplierName: row.supplier_name,
              seq: i + 1,
              hasMulti: multi,
              issueDate: invoice.issue_date,
            }),
            contentPath: safe,
            contentType: 'application/pdf',
          });
        }
      } catch (e) {
        markerErr = `proof path rejected: ${e.message}`;
      }
    }
    // Persist / clear the failure marker (best-effort; never blocks the send).
    try {
      // eslint-disable-next-line no-await-in-loop
      await auditedUpdate(db, 'inbound_documents', { id: row.id },
        { proof_attach_error: markerErr, updated_at: new Date() },
        { actor, source: 'invoice.send.proofMarker' });
    } catch (_e) { /* marker column may be absent pre-migration — ignore */ }
    if (markerErr) logger.warn?.(`rebillProofs: invoice ${invoice.invoice_number} inbound ${row.id}: ${markerErr}`);
  }

  return attachments;
}

module.exports = { collectRebillProofAttachments, resolveDefaultAttach, renderProofName };
