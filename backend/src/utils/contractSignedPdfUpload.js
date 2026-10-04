/**
 * The customer's wet-signed PDF upload, shared by the public signing page and
 * the customer portal so both enforce the same setting, the same file checks
 * and the same token bookkeeping.
 *
 * Callers must attach the contract's action token row as `req.publicTokenRow`
 * BEFORE `signedPdfUpload.single('file')` runs, so a rejected request never
 * costs a disk write.
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const { validateFileType, validateFileContent } = require('./fileSecurityUtils');
const { validatePdf } = require('./pdfValidation');
const { AppError, ValidationError } = require('./errors');
const { getAppSetting } = require('./appSettings');
const { clientIpForAudit } = require('./clientIp');

const { getStoragePath } = require('../config/storage');

// Multer's cap and the content check's cap are one number.
const MAX_SIGNED_PDF_BYTES = 10 * 1024 * 1024;

const signedPdfUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = path.join(getStoragePath(), 'uploads/contracts/signed');
      fs.mkdirSync(uploadDir, { recursive: true });
      cb(null, uploadDir);
    },
    // Named by contract id, not by the token: the filename ends up in the
    // contracts row and admin views, which are no place for a bearer secret.
    // The random part keeps two uploads in the same millisecond apart. They
    // shared one file, and the request that lost the compare-and-set in
    // attachSignedPdfUpload then deleted the winner's PDF with its cleanup.
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.pdf';
      cb(null, `contract-${Number(req.publicTokenRow?.contract_id) || 'unknown'}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    },
  }),
  // CVE-2026-82333: single unnamed `file` field only — no legitimate
  // array-indexed field names, so reject any bracket-index field name.
  // The route reads no text fields. Without fields/parts caps busboy accepts
  // an unbounded number of ~1 MiB text parts and multer keeps every one in
  // memory before the handler runs — one part, the PDF, and nothing else.
  limits: {
    fileSize: MAX_SIGNED_PDF_BYTES, files: 1, fields: 0, fieldSize: 1024, parts: 1, fieldArrayIndexLimit: 0,
  },
  fileFilter: (req, file, cb) => {
    if (validateFileType(file.originalname, file.mimetype, ['application/pdf'])) return cb(null, true);
    return cb(new Error('Only PDF files are allowed'));
  },
});

/**
 * `upload.single('file')` with multer's limit errors answered as 400s. A
 * MulterError carries no statusCode, and middleware/errorHandler maps only
 * the size and array-index limits, so a refused extra field or part would
 * otherwise surface as a 500.
 */
function singlePdf(upload) {
  const single = upload.single('file');
  return (req, res, next) => single(req, res, (err) => {
    if (err instanceof multer.MulterError) return next(new ValidationError(err.message));
    return next(err);
  });
}
const signedPdfSingle = singlePdf(signedPdfUpload);

// Server-side guard for the "allow PDF upload" toggle. When the admin
// turns it off in Settings → CRM behaviour → Contracts the sign page
// hides the upload section, but a hand-crafted POST would still hit the
// route — refuse here too BEFORE multer reads the body so a disabled-toggle
// install never writes attacker bytes to disk.
async function uploadSignedPdfSettingGuard(req, res, next) {
  const allowPdfUpload = (await getAppSetting('crm_contracts_allow_pdf_upload')) !== false;
  if (!allowPdfUpload) {
    return res.status(403).json({
      error: 'Uploading a wet-signed PDF is disabled for this installation. Please sign in your browser instead.',
      code: 'UPLOAD_DISABLED',
    });
  }
  return next();
}

/**
 * The content checks every signer-uploaded PDF goes through before it can
 * become the authoritative signed contract. Responds and removes the file on
 * refusal; resolves `true` when the upload may proceed.
 *
 * The filter only saw the reported type and the file name, so the bytes are
 * checked on disk: first the signature, then a full parse in a worker thread
 * (utils/pdfValidation) that refuses active content — JavaScript, launch and
 * submit actions, embedded files, XFA, rich media — encryption, and files
 * that expand past the inflate budget. The upload is mailed to both parties
 * and rendered inline in the admin's browser, so it must be a plain document.
 * The original bytes are kept: a paper copy may carry a digital signature
 * that re-serialising would break. Checked before the token is spent, so the
 * customer can retry.
 */
async function checkSignedPdfUpload(req, res) {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded', code: 'NO_FILE' });
    return false;
  }
  if (!(await validateFileContent(req.file.path, 'application/pdf'))) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    res.status(400).json({ error: 'The uploaded file is not a PDF.', code: 'INVALID_PDF' });
    return false;
  }
  try {
    const info = await validatePdf(await fs.promises.readFile(req.file.path), { maxBytes: MAX_SIGNED_PDF_BYTES });
    // Because the original bytes are kept, the scan has to agree with what
    // a viewer resolves: a file that defines an object twice, with the
    // cross-reference table pointing at a definition the scan did not keep,
    // could carry active content the check never saw (pdfInspect.js).
    if (info.ambiguousObjects) {
      throw new AppError('The PDF defines objects ambiguously and cannot be verified. Please export it again.', 400, 'PDF_AMBIGUOUS_OBJECTS');
    }
  } catch (err) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    res.status(err.statusCode || 400).json({ error: err.message, code: err.code || 'INVALID_PDF' });
    return false;
  }
  return true;
}

/**
 * Attach the uploaded file and spend the token. Responds itself. `actor` is
 * the uploader the accounting change history records: the customer portal
 * passes the signed-in customer, the public link leaves it to the service.
 */
async function finishSignedPdfUpload(req, res, { actor = null } = {}) {
  const tokenRow = req.publicTokenRow;
  if (!(await checkSignedPdfUpload(req, res))) return undefined;
  // The token is spent by the service, in the transaction that moves the
  // contract, so the link can't be re-played and two requests holding it
  // can't both complete the contract.
  // IP storage is gated by the crm_contracts_store_ip setting so
  // privacy-strict operators can opt out — same toggle that gates
  // the in-browser-sign IP captures. See utils/clientIp.js for
  // why we trust req.ip only.
  const storeIpEnabled = (await getAppSetting('crm_contracts_store_ip')) !== false;
  const contractService = require('../services/contractService');
  const result = await contractService.attachSignedPdfUpload(tokenRow.contract_id, req.file.path, 'customer', actor, {
    actionToken: { id: tokenRow.id, ip: storeIpEnabled ? clientIpForAudit(req) : null },
  });
  // The status only: where the server keeps the file is not the signer's business.
  return res.json({ status: result.status });
}

module.exports = {
  signedPdfUpload, signedPdfSingle, singlePdf, uploadSignedPdfSettingGuard, checkSignedPdfUpload, finishSignedPdfUpload,
};
