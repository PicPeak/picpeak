/**
 * The emailed-code step shared by the public contract and quote routes.
 *
 * `mountVerification(router, options)` adds
 *   POST /:token/verification           send a 6-digit code to the customer
 *   POST /:token/verification/confirm   body { code } → { grant, expiresInSeconds }
 * and `requireGrant(kind)` guards every route that shows or changes the
 * document. The grant travels in the X-Document-Access header.
 */

const rateLimit = require('express-rate-limit');
const { body, param } = require('express-validator');
const { handleAsync, validateRequest } = require('../utils/routeHelpers');
const { loadActionToken } = require('../utils/publicTokenGuards');
const verification = require('../services/publicDocumentVerificationService');

const tokenParam = () => param('token').isString().isLength({ min: 64, max: 64 }).matches(/^[a-f0-9]+$/i);

// Per IP, on top of the per-token throttle and attempt limit in the service.
const verificationLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
});

function sendVerificationRequired(res) {
  return res.status(401).json({
    error: 'Please confirm the code we emailed you before continuing.',
    code: 'VERIFICATION_REQUIRED',
  });
}

/**
 * Middleware: the request must carry a grant for the token row already
 * attached as req.publicTokenRow. Refuses with 401 VERIFICATION_REQUIRED.
 */
function requireGrant(kind) {
  return (req, res, next) => {
    if (verification.hasValidGrant(req, kind, req.publicTokenRow, req.params.token)) return next();
    return sendVerificationRequired(res);
  };
}

/**
 * @param {import('express').Router} router
 * @param {object} options
 * @param {'contract'|'quote'} options.kind
 * @param {string} options.tableName  contract_action_tokens | quote_action_tokens
 * @param {(tokenRow: object) => Promise<object|null>} options.loadTarget
 */
function mountVerification(router, { kind, tableName, loadTarget }) {
  router.post(
    '/:token/verification',
    verificationLimiter,
    [tokenParam()],
    handleAsync(async (req, res) => {
      validateRequest(req);
      const tokenRow = await loadActionToken(req, res, { tableName, token: req.params.token });
      if (!tokenRow) return undefined;
      const target = await loadTarget(tokenRow);
      if (!target) return res.status(404).json({ error: 'Not found' });
      if (!target.recipientEmail) {
        return res.status(409).json({
          error: 'There is no email address on file to send a code to. Please contact the sender.',
          code: 'NO_RECIPIENT_EMAIL',
        });
      }
      let wait;
      try {
        ({ retryAfterSeconds: wait } = await verification.sendCode({
          kind,
          tokenRow,
          recipientEmail: target.recipientEmail,
          documentNumber: target.documentNumber,
          issuerName: target.issuerName,
          language: target.language,
        }));
      } catch (err) {
        if (err.code === 'EMAIL_UNAVAILABLE') {
          return res.status(503).json({ error: err.message, code: err.code });
        }
        throw err;
      }
      // The throttle is checked inside sendCode, together with writing the
      // new code, so parallel requests cannot all get past it.
      if (wait > 0) {
        res.set('Retry-After', String(wait));
        return res.status(429).json({
          error: 'A code was sent recently. Please wait before requesting another one.',
          code: 'VERIFICATION_RATE_LIMITED',
          retryAfterSeconds: wait,
        });
      }
      return res.status(202).json({
        sent: true,
        emailHint: verification.maskEmail(target.recipientEmail),
        resendAfterSeconds: 60,
      });
    }),
  );

  router.post(
    '/:token/verification/confirm',
    verificationLimiter,
    [tokenParam(), body('code').isString().matches(/^\d{6}$/)],
    handleAsync(async (req, res) => {
      validateRequest(req);
      const tokenRow = await loadActionToken(req, res, { tableName, token: req.params.token });
      if (!tokenRow) return undefined;
      const result = await verification.confirmCode(kind, tokenRow.id, req.body.code);
      if (result.ok) {
        return res.json({
          grant: verification.issueGrant(kind, tokenRow, req.params.token),
          expiresInSeconds: verification.GRANT_TTL_SECONDS,
        });
      }
      if (result.reason === 'invalid') {
        return res.status(400).json({
          error: 'That code is not correct.',
          code: 'VERIFICATION_CODE_INVALID',
          attemptsRemaining: result.attemptsRemaining,
        });
      }
      if (result.reason === 'too_many_attempts') {
        return res.status(429).json({
          error: 'Too many wrong codes. Please request a new code.',
          code: 'VERIFICATION_TOO_MANY_ATTEMPTS',
        });
      }
      return res.status(410).json({
        error: 'This code has expired. Please request a new code.',
        code: 'VERIFICATION_CODE_EXPIRED',
      });
    }),
  );
}

module.exports = { mountVerification, requireGrant, sendVerificationRequired, tokenParam };
