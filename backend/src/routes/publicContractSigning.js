'use strict';

/**
 * Public → contract signing (#1446). Mounted at /api/public/contract-signing.
 *
 *   GET  /invite/:token                 what the link is for (no customer details)
 *   POST /invite/:token/code            email a six-digit code to the signer
 *   POST /invite/:token/verify          { code } → { sessionToken }
 *   GET  /session                       the contract, for the verified signer
 *   GET  /session/pdf                   the PDF as it stands
 *   GET  /session/attachments/:id       one of the contract's attachments
 *   POST /session/sign                  { name, mode, signatureDataUrl?, accepted, idempotencyKey? }
 *   POST /session/decline               { reason? }
 *   POST /session/upload-signed-pdf     a wet-signed PDF, when uploads are allowed
 *
 * No login: the signer's own link plus the code sent to their email are the
 * proof, and then the session (header `X-Signing-Session`). Links and
 * sessions are stored as sha256; codes as bcrypt with an attempt limit.
 * Per-IP rate limits sit on top of the per-signer limits kept in the
 * database. Contracts sent before signatures v2 use /api/public/contracts.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { rateLimitKey } = require('../utils/rateLimitKey');
const { body, param } = require('express-validator');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { validateFileType, validateFileContent } = require('../utils/fileSecurityUtils');
const { buildContentDisposition } = require('../utils/filenameSanitizer');
const { clientIpForAudit } = require('../utils/clientIp');
const { getAppSetting } = require('../utils/appSettings');
const { getStoragePath } = require('../config/storage');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const signingV2 = require('../services/contract/signingV2');

const router = express.Router();
// With contracts switched off, signing is off too — same code as the admin routes.
router.use(requireFeatureFlag('contracts', 'CONTRACTS_DISABLED'));

const limiter = (windowMs, max) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey });
const viewLimiter = limiter(60 * 1000, 30);
const codeLimiter = limiter(10 * 60 * 1000, 5);
const verifyLimiter = limiter(10 * 60 * 1000, 20);
const signLimiter = limiter(60 * 1000, 10);

const tokenParam = param('token').isString().isLength({ min: 64, max: 64 }).matches(/^[a-f0-9]+$/i);
const sessionOf = (req) => String(req.get('x-signing-session') || '');

// Signing pages carry secrets in the URL or a header: never cached, never
// sent on as a referrer.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

router.get('/invite/:token', viewLimiter, [tokenParam], handleAsync(async (req, res) => {
  validateRequest(req);
  return successResponse(res, await signingV2.invitationSummary(req.params.token));
}));

router.post('/invite/:token/code', codeLimiter, [tokenParam], handleAsync(async (req, res) => {
  validateRequest(req);
  try {
    return successResponse(res, await signingV2.requestCode(req.params.token));
  } catch (err) {
    // The same answer as the quote/contract verification route (#1465), so
    // the shared step can count down to the next code.
    if (err.code === 'VERIFICATION_RATE_LIMITED') {
      res.set('Retry-After', String(err.retryAfterSeconds));
      return res.status(429).json({ error: err.message, code: err.code, retryAfterSeconds: err.retryAfterSeconds });
    }
    throw err;
  }
}));

router.post(
  '/invite/:token/verify',
  verifyLimiter,
  [tokenParam, body('code').isString().trim().isLength({ min: 6, max: 6 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    return successResponse(res, await signingV2.verifyCode(req.params.token, req.body.code));
  }),
);

router.get('/session', viewLimiter, handleAsync(async (req, res) => (
  successResponse(res, { contract: await signingV2.sessionView(sessionOf(req)) })
)));

router.get('/session/pdf', viewLimiter, handleAsync(async (req, res) => {
  const { contract, buffer } = await signingV2.sessionPdf(sessionOf(req));
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', buildContentDisposition(`${contract.contract_number}.pdf`, 'attachment'));
  return res.send(buffer);
}));

router.get(
  '/session/attachments/:attachmentId',
  viewLimiter,
  [param('attachmentId').isInt({ min: 1 }).toInt()],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const attachments = require('../services/contract/attachments');
    const file = await signingV2.sessionAttachment(sessionOf(req), req.params.attachmentId);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', buildContentDisposition(attachments.downloadName(file.name), 'attachment'));
    return res.send(file.buffer);
  }),
);

router.post(
  '/session/sign',
  signLimiter,
  [
    body('name').isString().isLength({ min: 1, max: 255 }),
    body('accepted').isBoolean(),
    body('mode').optional().isIn(['drawn', 'typed']),
    body('signatureDataUrl').optional({ nullable: true }).isString(),
    body('idempotencyKey').optional({ nullable: true }).isString().isLength({ max: 64 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const result = await signingV2.sign(
      sessionOf(req),
      { ...req.body, accepted: req.body.accepted === true },
      { ip: clientIpForAudit(req), userAgent: req.get('user-agent') || null },
    );
    return successResponse(res, result);
  }),
);

router.post(
  '/session/decline',
  signLimiter,
  [body('reason').optional({ nullable: true }).isString().isLength({ max: 1000 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    return successResponse(res, await signingV2.decline(sessionOf(req), { reason: req.body.reason }));
  }),
);

// A wet-signed PDF. The setting and the session are checked before multer
// reads the body, so a refused request never writes to disk.
const signedPdfUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(getStoragePath(), 'uploads/contracts/signed');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, `contract-signer-${req.signing.signer.id}-${Date.now()}.pdf`),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fieldArrayIndexLimit: 0 },
  fileFilter: (req, file, cb) => {
    if (validateFileType(file.originalname, file.mimetype, ['application/pdf'])) return cb(null, true);
    return cb(new Error('Only PDF files are allowed'));
  },
});

async function uploadGuards(req, res, next) {
  try {
    if ((await getAppSetting('crm_contracts_allow_pdf_upload')) === false) {
      return res.status(403).json({
        error: 'Uploading a wet-signed PDF is disabled. Please sign in your browser instead.',
        code: 'UPLOAD_DISABLED',
      });
    }
    // Whose turn it is, and whether one paper copy can stand for this
    // contract at all, is the service's rule — the same one the in-browser
    // signature goes through.
    req.signing = await signingV2.wetUploadContext(sessionOf(req));
    return next();
  } catch (err) {
    return res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code });
  }
}

router.post('/session/upload-signed-pdf', signLimiter, uploadGuards, signedPdfUpload.single('file'), handleAsync(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded', code: 'NO_FILE' });
  // The filter only saw the reported type and the file name. This upload
  // becomes the authoritative signed contract and is mailed to both parties,
  // so its bytes have to be a PDF — same check as the legacy link's upload.
  if (!(await validateFileContent(req.file.path, 'application/pdf'))) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'The uploaded file is not a PDF.', code: 'INVALID_PDF' });
  }
  const contractService = require('../services/contractService');
  const result = await contractService.attachSignedPdfUpload(req.signing.contract.id, req.file.path, 'customer');
  return successResponse(res, { status: result.status });
}));

module.exports = router;
