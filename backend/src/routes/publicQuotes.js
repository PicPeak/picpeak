/**
 * Public → Quotes Routes
 *
 * Mounted at /api/public/quotes. No login: the link in the quote email
 * identifies the quote, and an emailed one-time code proves the visitor
 * can read the customer's mailbox before the customer's details, the
 * prices or the accept/decline buttons are available. The link alone used
 * to be enough to see all of it and to answer the quote. The route layer
 * must also:
 *   - never leak admin-only fields (internal_notes, etc.)
 *   - rate-limit by IP/token to soften brute-force token guessing
 *   - honour the 15-min re-toggle window enforced at the service layer
 *
 * Surface:
 *   GET  /:token                         issuer-only shell; full view with a grant
 *   POST /:token/verification            email a code to the customer on file
 *   POST /:token/verification/confirm   body: { code } → { grant, expiresInSeconds }
 *   GET  /:token/totals                  grant; the totals for a set of add-ons
 *   POST /:token/respond                 grant; body: { action: 'accept' | 'decline' }
 */

const express = require('express');
const { body, query } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { rateLimitKey } = require('../utils/rateLimitKey');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const quoteService = require('../services/quoteService');
const publicDocumentViews = require('../services/publicDocumentViews');
const verification = require('../services/publicDocumentVerificationService');
const { clientIpForAudit } = require('../utils/clientIp');
const { loadActionToken } = require('../utils/publicTokenGuards');
const { mountVerification, sendVerificationRequired, tokenParam } = require('./publicDocumentVerification');

const KIND = 'quote';
const TABLE = 'quote_action_tokens';

const router = express.Router();

// Rate-limit: 30 token previews per IP per minute, 10 responses.
const previewLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey,
});
const respondLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey,
});

mountVerification(router, {
  kind: KIND,
  tableName: TABLE,
  loadTarget: publicDocumentViews.quoteVerificationTarget,
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
      const target = await publicDocumentViews.quoteVerificationTarget(tokenRow);
      if (!target) return res.status(404).json({ error: 'Quote not found' });
      // Before the code is confirmed the link says who sent it and where the
      // code will go, and nothing else: no number, status or amounts, no
      // customer name or address, no line items.
      return successResponse(res, {
        quote: {
          verificationRequired: true,
          language: target.language,
          emailHint: verification.maskEmail(target.recipientEmail),
          issuer: target.issuer,
        },
      });
    }

    const view = await publicDocumentViews.buildQuoteView(tokenRow.quote_id);
    if (!view) return res.status(404).json({ error: 'Quote not found' });
    return successResponse(res, { quote: { ...view, verificationRequired: false } });
  }),
);

// Live totals for a set of add-ons (#1451): the page shows what the customer's
// choice costs, and the accept call sends the total back for the server to
// re-check. Behind the grant, like the view itself.
router.get(
  '/:token/totals',
  previewLimiter,
  [
    tokenParam(),
    query('selected').optional().isString().isLength({ max: 1000 }).matches(/^(\d{1,6}(,\d{1,6}){0,199})?$/),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const tokenRow = await loadActionToken(req, res, { tableName: TABLE, token: req.params.token });
    if (!tokenRow) return undefined;
    if (!verification.hasValidGrant(req, KIND, tokenRow, req.params.token)) {
      return sendVerificationRequired(res);
    }
    const selected = req.query.selected ? String(req.query.selected).split(',').map(Number) : [];
    const totals = await quoteService.previewOptionalSelection(tokenRow.quote_id, selected);
    return successResponse(res, totals);
  }),
);

router.post(
  '/:token/respond',
  respondLimiter,
  [
    tokenParam(),
    body('action').isIn(['accept', 'decline']),
    // ToS box: optional flag, only meaningful when the global
    // `crm_quotes_tos_required` setting is on. Service enforces.
    body('tosAccepted').optional().isBoolean(),
    // Optional add-ons (#1451): the chosen positions and the total the page
    // showed. The service recomputes and refuses a mismatch.
    body('selectedOptional').optional().isArray({ max: 200 }),
    body('selectedOptional.*').isInt({ min: 1 }).toInt(),
    body('expectedTotalMinor').optional().isInt().toInt(),
    // A message to the business, sent with the acceptance.
    body('customerMessage').optional({ nullable: true }).isString().isLength({ max: 2000 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const tokenRow = await loadActionToken(req, res, { tableName: TABLE, token: req.params.token });
    if (!tokenRow) return undefined;
    if (!verification.hasValidGrant(req, KIND, tokenRow, req.params.token)) {
      return sendVerificationRequired(res);
    }
    try {
      // See utils/clientIp.js — trust req.ip (configured via Express
      // trust-proxy), never read X-Forwarded-For directly.
      const result = await quoteService.recordResponse({
        token: req.params.token,
        action: req.body.action,
        ip: clientIpForAudit(req),
        tosAccepted: req.body.tosAccepted === true,
        selectedOptional: req.body.selectedOptional,
        expectedTotalMinor: req.body.expectedTotalMinor,
        customerMessage: req.body.customerMessage,
      });
      return successResponse(res, { status: result.status, lockedAt: result.lockedAt });
    } catch (err) {
      // The add-on choice was priced against a total that has since changed:
      // the page shows the new one and asks the customer to accept again.
      if (err.code === 'TOTAL_MISMATCH') {
        return res.status(err.statusCode || 409).json({
          error: err.message, code: err.code, totalAmountMinor: err.totalAmountMinor,
        });
      }
      if (err.code === 'RESPONSE_LOCKED') {
        return res.status(423).json({
          error: err.message,
          code: 'RESPONSE_LOCKED',
          currentStatus: err.currentStatus,
          lockedAt: err.lockedAt,
        });
      }
      throw err;
    }
  }),
);

module.exports = router;
