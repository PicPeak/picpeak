// Extracted verbatim from contractService.js — see ../contractService.js for the
// module-level overview. Do not add behavior here without updating the entry re-exports.

const crypto = require('crypto');
const { getStoragePath } = require('../../config/storage');
const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/errors');
const pdfStampService = require('../pdfStampService');
const documentArtifactService = require('../documentArtifactService');
const { resolveStoredPath } = require('../../utils/storedPath');


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
async function persistContractPdf(contract, buffer, suffix = '', meta = {}) {
  if (!contract.contract_number) return { filePath: null, storedPath: null, sha256: null };
  const year = (contract.issue_date ? new Date(contract.issue_date) : new Date()).getFullYear();
  // Always append a millisecond timestamp to the filename so writes
  // never overwrite an earlier version on disk. Forensic preservation.
  // Example filenames:
  //   C-2026-0001_2026-05-19T1830-22-413-9f3a1c.pdf                  (unsigned)
  //   C-2026-0001_signed-by-customer_2026-05-19T1845-10-002-04be7d.pdf
  //   C-2026-0001_fully-signed_2026-05-19T1912-44-877-c21f90.pdf
  // The random part keeps two renders in the same millisecond apart: two
  // concurrent stamps of one contract wrote one file, so the PDF on record
  // could hold the other request's signatures.
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const fileName = suffix
    ? `${contract.contract_number}_${suffix}_${stamp}.pdf`
    : `${contract.contract_number}_${stamp}.pdf`;
  // Written and recorded in generated_documents (#1445).
  const stored = await documentArtifactService.persist({
    docType: 'contract',
    docId: contract.id,
    kind: meta.kind || (suffix ? 'signed' : 'unsigned'),
    buffer,
    fileName,
    year,
    theme: meta.theme,
    issuer: meta.issuer,
    manifest: meta.manifest,
    templateVersionId: meta.templateVersionId,
    // Inside a transaction the record has to go through it (SQLite has one writer).
    conn: meta.conn,
  });
  // Every contract PDF this app writes passes through here, so this is the
  // one place the activity log can record that an artifact was generated
  // (#1445): which contract, which file, what it hashes to, the content and
  // template version behind it. The `generated_documents` row is the record;
  // this is what makes it visible on the contract's audit trail.
  await logArtifact(contract, stored, meta);
  // filePath to use the file now; storedPath is what the contract row records.
  return { filePath: stored.path, storedPath: stored.storedPath, sha256: stored.sha256 };
}

/** Best-effort: a failed log line must never cost a contract its PDF. */
async function logArtifact(contract, stored, meta) {
  try {
    const { logActivity } = require('../../database/db');
    await logActivity('contract_document_generated', {
      contractId: contract.id,
      generatedDocumentId: stored.id,
      kind: meta.kind || null,
      pdfSha256: stored.sha256,
      // The caller's value when it has one: on a send the contract row is
      // only marked sent — and given its content hash — after this PDF
      // exists, so reading it off the row here would always be null.
      contentSha256: meta.contentSha256 || contract.rendered_content_sha256 || null,
      templateVersionId: meta.templateVersionId || null,
      rendererVersion: documentArtifactService.RENDERER_VERSION,
    }, null, meta.actor || { type: 'system' }, meta.conn);
  } catch (err) {
    logger.warn('Could not log a generated contract document', { contractId: contract.id, message: err.message });
  }
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
    getStoragePath(),
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
  // The random suffix keeps two captures in the same millisecond apart:
  // concurrent signing requests wrote one file, and the request that lost
  // the compare-and-set then deleted the winner's signature image with its
  // own cleanup.
  const filePath = path.join(root, `${role}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`);
  fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'));
  return filePath;
}

/**
 * Build the stamp sequence the pdf-lib stamp service expects from a
 * single contract row. Customer first, admin second — provenance
 * order matches the visual order on the signature page.
 *
 * Used by the countersignature and the recovery paths
 * (recordAdminCountersignature, rerenderAndResend, restampSignatures).
 * The customer signature is always the first stamp, so
 * recordCustomerSignature constructs it inline.
 */
function buildSignatureStamps(contract) {
  const locale = contract.language || 'de';
  const nameLabel = 'Name';
  const dateLabel = locale === 'de' ? 'Datum' : 'Date';
  const stamps = [];
  if (contract.signed_customer_signature_path) {
    stamps.push({
      signaturePngPath: resolveStoredPath(contract.signed_customer_signature_path),
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
      signaturePngPath: resolveStoredPath(contract.signed_admin_signature_path),
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
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // Recorded with its sha256 like every other generated PDF (#1445).
    const stored = await documentArtifactService.persist({
      docType: 'contract',
      docId: contract.id,
      kind: 'audit',
      buffer,
      fileName: `${contract.contract_number}_audit_${stamp}.pdf`,
      year,
    });
    return stored.path;
  } catch (err) {
    logger.error('Failed to render audit certificate', {
      contractId: contract.id,
      contractNumber: contract.contract_number,
      message: err.message,
    });
    return null;
  }
}
/**
 * The signing certificate a contract was issued, for download (#1446).
 *
 * Both signing flows record it as the `audit` artifact of the contract —
 * signatures v2 through `signingV2.issueCertificate`, the flow before it
 * through `persistAuditCertificate` above — so the newest one of that kind
 * is the certificate whichever flow signed it. Until this existed the file
 * only ever reached anyone as an email attachment; a lost email meant a lost
 * certificate.
 */
async function readCertificate(contractId) {
  const { db } = require('../../database/db');
  const { assertContractPdfPath } = require('../../utils/safePath');
  const contract = await db('contracts').where({ id: contractId }).first('id', 'contract_number');
  if (!contract) throw new AppError('Contract not found', 404);
  const row = await db('generated_documents')
    .where({ doc_type: 'contract', doc_id: contractId, kind: 'audit' })
    .orderBy('id', 'desc')
    .first('path');
  if (!row || !row.path) {
    throw new AppError('This contract has no signing certificate yet', 404, 'CERTIFICATE_MISSING');
  }
  // The same containment the contract PDF routes apply: the stored path is
  // written by this service, but a bad row must not turn a download into an
  // arbitrary-file read.
  const file = assertContractPdfPath(row.path);
  if (!fs.existsSync(file)) {
    throw new AppError('The signing certificate is missing from disk', 404, 'CERTIFICATE_MISSING_ON_DISK');
  }
  return { fileName: `${contract.contract_number}-certificate.pdf`, buffer: fs.readFileSync(file) };
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
  readCertificate,
};
