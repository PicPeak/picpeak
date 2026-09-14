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
const { validateFileType } = require('./fileSecurityUtils');
const { getAppSetting } = require('./appSettings');
const { clientIpForAudit } = require('./clientIp');
const { db } = require('../database/db');

const getStoragePath = () => process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');

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
  limits: { fileSize: 10 * 1024 * 1024, fieldArrayIndexLimit: 0 }, // 10 MB
  fileFilter: (req, file, cb) => {
    if (validateFileType(file.originalname, file.mimetype, ['application/pdf'])) return cb(null, true);
    return cb(new Error('Only PDF files are allowed'));
  },
});

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

/** Attach the uploaded file and spend the token. Responds itself. */
async function finishSignedPdfUpload(req, res) {
  const tokenRow = req.publicTokenRow;
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded', code: 'NO_FILE' });
  }
  const contractService = require('../services/contractService');
  const result = await contractService.attachSignedPdfUpload(tokenRow.contract_id, req.file.path, 'customer');
  // Mark the token as used so the link can't be re-played.
  // IP storage is gated by the crm_contracts_store_ip setting so
  // privacy-strict operators can opt out — same toggle that gates
  // the in-browser-sign IP captures. See utils/clientIp.js for
  // why we trust req.ip only.
  const storeIpEnabled = (await getAppSetting('crm_contracts_store_ip')) !== false;
  await db('contract_action_tokens').where({ id: tokenRow.id }).update({
    used_at: new Date().toISOString(),
    used_action: 'uploaded_signed_pdf',
    used_ip: storeIpEnabled ? clientIpForAudit(req) : null,
  });
  return res.json(result);
}

module.exports = { signedPdfUpload, uploadSignedPdfSettingGuard, finishSignedPdfUpload };
