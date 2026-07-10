/**
 * Public → Invoice payment-check Routes
 *
 * Mounted at /api/public/payment-check. NO authentication — the
 * admin's email link carries a 64-char hex token; that's the only
 * gate. The page at /payment-check/:token uses these endpoints to:
 *
 *   GET  /:token              read invoice summary for the page
 *   POST /:token              record the admin's selection:
 *                               action: 'paid_full' | 'partial' | 'unpaid'
 *                               amountMinor: optional, for 'partial'
 *
 * Mirrors the publicQuotes.js shape (rate limits, token format
 * validation, error code surface) so the same defensive patterns
 * apply.
 */

const express = require('express');
const { body, param } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const invoiceService = require('../services/invoiceService');

const router = express.Router();

// 30 reads / minute / IP; 10 records / minute / IP.
const previewLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
});
const recordLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
});

router.get(
  '/:token',
  previewLimiter,
  [param('token').isString().isLength({ min: 64, max: 64 }).matches(/^[a-f0-9]+$/i)],
  handleAsync(async (req, res) => {
    validateRequest(req);
    try {
      const view = await invoiceService.getPaymentCheckByToken(req.params.token);

      // Branding block — same shape `publicQuotes.js` returns so the
      // frontend can render a consistent header (logo + company
      // name) and respect the admin's branding colour palette. Web
      // pages use the global Settings → Branding logo, NOT the
      // dedicated PDF logo (business_profile.logo_path is print-
      // only).
      const { db } = require('../database/db');
      const { getAppSetting } = require('../utils/appSettings');
      const profile = await db('business_profile').where({ id: 1 }).first();
      const brandingLogoUrl = await getAppSetting('branding_logo_url', null);
      const brandingLogoUrlDark = await getAppSetting('branding_logo_url_dark', null);
      const toUrl = (raw) => {
        const value = (raw && String(raw).trim()) || null;
        if (!value) return null;
        if (value.startsWith('/') || /^https?:\/\//i.test(value)) return value;
        return `/uploads/${value.replace(/^uploads\//, '')}`;
      };
      const issuer = profile ? {
        companyName: profile.company_name || '',
        email: profile.email || '',
        website: profile.website || '',
        // Light + dark branding logos — the page picks per its colour mode.
        logoUrl: toUrl(brandingLogoUrl),
        logoUrlDark: toUrl(brandingLogoUrlDark),
      } : null;

      return successResponse(res, { invoice: view, issuer });
    } catch (err) {
      if (err.code === 'TOKEN_ALREADY_USED') {
        return res.status(410).json({
          error: err.message,
          code: err.code,
          usedAt: err.usedAt,
          usedAction: err.usedAction,
        });
      }
      throw err;
    }
  })
);

router.post(
  '/:token',
  recordLimiter,
  [
    param('token').isString().isLength({ min: 64, max: 64 }).matches(/^[a-f0-9]+$/i),
    body('action').isIn(['paid_full', 'paid_with_skonto', 'partial', 'unpaid']),
    body('amountMinor').optional({ values: 'falsy' }).isInt({ min: 1 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const result = await invoiceService.recordPaymentCheckAction({
      token: req.params.token,
      action: req.body.action,
      amountMinor: req.body.amountMinor,
      ip: req.ip,
      adminId: null,
    });
    return successResponse(res, result);
  })
);

module.exports = router;
