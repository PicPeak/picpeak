/**
 * Public → Contracts Routes
 *
 * Mounted at /api/public/contracts. No login: the link in the signing
 * email identifies the contract, and an emailed one-time code proves the
 * visitor can read the customer's mailbox before anything personal is
 * shown or any action is taken. The link alone used to be enough to see
 * the customer's name, email address and the whole contract, and to sign
 * it — so a forwarded email or a logged URL was a signature.
 *
 * Surface:
 *   GET  /:token                         issuer-only shell; full view with a grant
 *   POST /:token/verification            email a code to the customer on file
 *   POST /:token/verification/confirm   body: { code } → { grant, expiresInSeconds }
 *   POST /:token/sign                    grant; body: { name, signatureDataUrl?, accepted: true }
 *   POST /:token/upload-signed-pdf       grant; multer single — wet-signed PDF
 *   GET  /:token/pdf                     grant; download the contract PDF
 *
 * The grant travels in the X-Document-Access header (see
 * routes/publicDocumentVerification.js). IP is captured for the signature
 * evidence / upload audit row.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { rateLimitKey } = require('../utils/rateLimitKey');
const { body, param } = require('express-validator');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const contractService = require('../services/contractService');
const publicDocumentViews = require('../services/publicDocumentViews');
const verification = require('../services/publicDocumentVerificationService');
const { clientIpForAudit } = require('../utils/clientIp');
const { loadActionToken, preMulterTokenGuard } = require('../utils/publicTokenGuards');
const {
  signedPdfUpload,
  uploadSignedPdfSettingGuard,
  finishSignedPdfUpload,
} = require('../utils/contractSignedPdfUpload');
const {
  mountVerification,
  requireGrant,
  sendVerificationRequired,
  tokenParam,
} = require('./publicDocumentVerification');
const { db } = require('../database/db');

const KIND = 'contract';
const TABLE = 'contract_action_tokens';

const router = express.Router();

const previewLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey,
});
const respondLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey,
});

mountVerification(router, {
  kind: KIND,
  tableName: TABLE,
  loadTarget: publicDocumentViews.contractVerificationTarget,
});

router.get(
  '/:token',
  previewLimiter,
  [tokenParam()],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const tokenRow = await loadActionToken(req, res, { tableName: TABLE, token: req.params.token });
    if (!tokenRow) return undefined;

    if (!verification.hasValidGrant(req, KIND, tokenRow, req.params.token)) {
      const target = await publicDocumentViews.contractVerificationTarget(tokenRow);
      if (!target) return res.status(404).json({ error: 'Contract not found' });
      // Before the code is confirmed the link says who sent it and where the
      // code will go, and nothing else: no number, title or status, no
      // customer name or address, no contract text, no IPs.
      return successResponse(res, {
        contract: {
          verificationRequired: true,
          language: target.language,
          emailHint: verification.maskEmail(target.recipientEmail),
          issuer: target.issuer,
        },
      });
    }

    const view = await publicDocumentViews.buildContractView(tokenRow.contract_id);
    if (!view) return res.status(404).json({ error: 'Contract not found' });
    return successResponse(res, { contract: { ...view, verificationRequired: false } });
  }),
);

// One of the contract's attachments (#1445), for the customer holding the
// signing link. The attachment must belong to this contract, its bytes must
// still match what the contract recorded, and the visitor must have
// confirmed the emailed code — the same grant the view above needs.
router.get(
  '/:token/attachments/:attachmentId',
  previewLimiter,
  [tokenParam(), param('attachmentId').isInt({ min: 1 }).toInt()],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const tokenRow = await loadActionToken(req, res, { tableName: TABLE, token: req.params.token });
    if (!tokenRow) return undefined;
    if (!verification.hasValidGrant(req, KIND, tokenRow, req.params.token)) {
      return sendVerificationRequired(res);
    }
    const attachments = require('../services/contract/attachments');
    const file = await attachments.openContractAttachment(tokenRow.contract_id, req.params.attachmentId);
    const { buildContentDisposition } = require('../utils/filenameSanitizer');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', buildContentDisposition(attachments.downloadName(file.name), 'attachment'));
    return res.send(file.buffer);
  }),
);


router.post(
  '/:token/sign',
  respondLimiter,
  [
    tokenParam(),
    body('name').isString().isLength({ min: 1, max: 255 }),
    body('accepted').isBoolean(),
    body('signatureDataUrl').optional({ nullable: true }).isString(),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const tokenRow = await loadActionToken(req, res, { tableName: TABLE, token: req.params.token });
    if (!tokenRow) return undefined;
    if (!verification.hasValidGrant(req, KIND, tokenRow, req.params.token)) {
      return sendVerificationRequired(res);
    }
    // Audit IP source: req.ip ONLY. See utils/clientIp.js for the
    // full rationale — reading X-Forwarded-For directly bypassed
    // Express's trust-proxy safety net and let direct (non-proxied)
    // POSTs spoof the audit IP, defeating the legal-evidence promise
    // of the contract signing flow. Operators whose nginx topology
    // needs different trust rules adjust `TRUST_PROXY` in server.js.
    const result = await contractService.recordCustomerSignature({
      token: req.params.token,
      name: req.body.name,
      signatureDataUrl: req.body.signatureDataUrl,
      accepted: req.body.accepted === true,
      ip: clientIpForAudit(req),
    });
    return successResponse(res, result);
  }),
);

router.post(
  '/:token/upload-signed-pdf',
  respondLimiter,
  // CRITICAL ORDERING: setting guard, token guard and the verification
  // grant all run BEFORE multer. A disabled-toggle install, an
  // expired/invalid token or an unverified visitor must not cost a disk
  // write — otherwise a captured link could be replayed to spam the disk
  // up to multer's 10 MB cap per request.
  uploadSignedPdfSettingGuard,
  preMulterTokenGuard(TABLE),
  requireGrant(KIND),
  signedPdfUpload.single('file'),
  handleAsync(async (req, res) => finishSignedPdfUpload(req, res)),
);

/**
 * PDF download — token-scoped and grant-gated. Once the customer has
 * signed, they can re-fetch the signed copy from the same link rather
 * than waiting for the contract_fully_signed email (which only arrives
 * after admin counter-sign). Streams signed_pdf_path when present,
 * falls back to pdf_path. Returns 410 once the link has expired.
 *
 * Security note: this route honours `expires_at` — expired tokens used to
 * keep allowing downloads, which turned the token into a permanent
 * unauthenticated download URL once leaked (referer headers, browser
 * history, email forward). Customers needing a post-expiry copy receive
 * the signed PDF in the `contract_fully_signed` email, OR the admin can
 * issue a fresh link via the admin detail page.
 */
router.get(
  '/:token/pdf',
  previewLimiter,
  [tokenParam()],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const tokenRow = await loadActionToken(req, res, { tableName: TABLE, token: req.params.token });
    if (!tokenRow) return undefined;
    if (!verification.hasValidGrant(req, KIND, tokenRow, req.params.token)) {
      return sendVerificationRequired(res);
    }
    const contract = await db('contracts').where({ id: tokenRow.contract_id }).first();
    if (!contract) return res.status(404).json({ error: 'Contract not found' });

    const fs = require('fs');
    const path = require('path');
    const { resolveStoredPathStrict, contractPdfRoots } = require('../utils/safePath');
    // Defence-in-depth, symlinks followed: a stored path outside the contract
    // storage roots throws AppError 403, which the error middleware returns
    // as is. Only a file that is simply missing falls back to rendering.
    const filePath = resolveStoredPathStrict(contract.signed_pdf_path || contract.pdf_path, contractPdfRoots());
    // Content-Disposition: attachment + Referrer-Policy: no-referrer
    // so the long-lived contract token doesn't leak via referer
    // headers if the customer opens the PDF in an external viewer
    // that loads remote resources.
    res.set('Referrer-Policy', 'no-referrer');
    if (!filePath) {
      // Render on-demand so the link works even if the on-disk
      // file was wiped (cleanup, S3 sync, etc.).
      const buf = await contractService.renderContractPdfBuffer(contract.id);
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `attachment; filename="${contract.contract_number}.pdf"`);
      return res.send(buf);
    }
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    return fs.createReadStream(filePath).pipe(res);
  }),
);

module.exports = router;
