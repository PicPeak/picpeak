// Extracted verbatim from contractService.js — see ../contractService.js for the
// module-level overview. Do not add behavior here without updating the entry re-exports.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/errors');
const pdfStampService = require('../pdfStampService');


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
module.exports = {
  sha256OfBuffer,
  sha256OfFile,
  persistContractPdf,
  MAX_SIGNATURE_BASE64_BYTES,
  persistSignatureImage,
  buildSignatureStamps,
  buildAuditCertContext,
  persistAuditCertificate,
};
