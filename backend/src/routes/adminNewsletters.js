/**
 * Admin → Newsletter campaigns (issue #1264, Part B).
 *
 * Mounted at /api/admin/newsletters. Every route is behind, in order:
 *   adminAuth → requireFeatureFlag('newsletters') → requirePermission(...)
 *
 * The flag gate sits ahead of the permission gate on purpose: with the
 * feature off, the answer is "this feature is disabled", not "you may not",
 * and no permission configuration should change that.
 *
 * `newsletters.send` is separate from `newsletters.view` because mass mail is
 * the one CRM action that cannot be undone once the queue drains.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { body, param, query } = require('express-validator');

const { db } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const {
  handleAsync, validateRequest, successResponse, getPagination, paginatedResponse,
} = require('../utils/routeHelpers');
const newsletterService = require('../services/newsletterService');

const router = express.Router();

router.use(adminAuth, requireFeatureFlag('newsletters'));

// A test send goes straight out over SMTP with no queue in between, so it is
// the one route here that can be turned into an outbound mail cannon. Own
// bucket, per admin.
const testLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `newsletter-test:${req.admin?.id || req.ip}`,
});

/** DB shape → API shape. Narrow, so a new column can't leak by accident. */
function transformCampaign(c) {
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    subject: c.subject,
    bodyHtml: c.body_html || '',
    bodyCss: c.body_css || '',
    language: c.language || 'en',
    status: c.status,
    recipientMode: c.recipient_mode,
    customerIds: parseCustomerIds(c.recipient_filter),
    recipientCount: Number(c.recipient_count || 0),
    sentCount: Number(c.sent_count || 0),
    failedCount: Number(c.failed_count || 0),
    sendRatePerMinute: Number(c.send_rate_per_minute || 20),
    createdByAdminId: c.created_by_admin_id,
    testSentAt: c.test_sent_at,
    queuedAt: c.queued_at,
    completedAt: c.completed_at,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

function parseCustomerIds(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const ids = Array.isArray(parsed) ? parsed : parsed?.customerIds;
    return Array.isArray(ids) ? ids : [];
  } catch (_) {
    return [];
  }
}

function transformRecipient(r) {
  return {
    id: r.id,
    customerAccountId: r.customer_account_id,
    email: r.email,
    status: r.status,
    errorMessage: r.error_message || null,
    sentAt: r.sent_at,
    createdAt: r.created_at,
  };
}

// ---- list / read ----------------------------------------------------------

router.get(
  '/',
  requirePermission('newsletters.view'),
  [query('status').optional().isIn(newsletterService.VALID_STATUSES)],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const q = db('email_campaigns').orderBy('created_at', 'desc').orderBy('id', 'desc');
    if (req.query.status) q.where('status', req.query.status);
    const rows = await q;
    return successResponse(res, { campaigns: rows.map(transformCampaign) });
  })
);

router.get(
  '/:id',
  requirePermission('newsletters.view'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const campaign = await newsletterService.getCampaign(req.params.id);
    const summary = await db('email_campaign_recipients')
      .where({ campaign_id: campaign.id })
      .select('status')
      .count({ count: '*' })
      .groupBy('status');
    return successResponse(res, {
      campaign: transformCampaign(campaign),
      recipientSummary: summary.reduce((acc, r) => {
        acc[r.status] = Number(r.count);
        return acc;
      }, {}),
    });
  })
);

router.get(
  '/:id/recipients',
  requirePermission('newsletters.view'),
  [
    param('id').isInt({ min: 1 }),
    query('status').optional().isString().isLength({ max: 20 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    await newsletterService.getCampaign(req.params.id); // 404s for an unknown id
    const { page, limit, offset } = getPagination(req, { limit: 50 });

    const base = () => {
      const q = db('email_campaign_recipients').where({ campaign_id: req.params.id });
      if (req.query.status) q.andWhere('status', req.query.status);
      return q;
    };
    const [{ count }] = await base().count({ count: '*' });
    const rows = await base()
      .orderBy('id', 'asc')
      .limit(limit)
      .offset(offset);

    return res.json(paginatedResponse(rows.map(transformRecipient), Number(count), page, limit));
  })
);

// ---- write ----------------------------------------------------------------

// Shared body validators. The service re-validates and does the sanitizing —
// these exist to reject obvious garbage with a 400 before it gets there.
const campaignBodyValidators = [
  body('name').optional().isString().isLength({ min: 1, max: 120 }),
  body('subject').optional().isString().isLength({ min: 1, max: newsletterService.MAX_SUBJECT_LENGTH }),
  body('bodyHtml').optional({ values: 'falsy' }).isString()
    .isLength({ max: newsletterService.MAX_BODY_BYTES }),
  body('bodyCss').optional({ values: 'falsy' }).isString().isLength({ max: 100 * 1024 }),
  body('language').optional({ values: 'falsy' }).isString().isLength({ max: 8 }),
  body('recipientMode').optional().isIn(newsletterService.VALID_RECIPIENT_MODES),
  body('customerIds').optional().isArray(),
  body('sendRatePerMinute').optional().isInt({
    min: newsletterService.MIN_RATE_PER_MINUTE,
    max: newsletterService.MAX_RATE_PER_MINUTE,
  }),
];

router.post(
  '/',
  requirePermission('newsletters.send'),
  [
    body('name').isString().isLength({ min: 1, max: 120 }),
    body('subject').isString().isLength({ min: 1, max: newsletterService.MAX_SUBJECT_LENGTH }),
    ...campaignBodyValidators,
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const campaign = await newsletterService.createCampaign(req.body, req.admin.id);
    return successResponse(res, { campaign: transformCampaign(campaign) }, 201, 'Campaign created');
  })
);

router.put(
  '/:id',
  requirePermission('newsletters.send'),
  [param('id').isInt({ min: 1 }), ...campaignBodyValidators],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const campaign = await newsletterService.updateCampaign(req.params.id, req.body, req.admin.id);
    return successResponse(res, { campaign: transformCampaign(campaign) }, 200, 'Campaign updated');
  })
);

router.delete(
  '/:id',
  requirePermission('newsletters.send'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    return successResponse(res, await newsletterService.deleteCampaign(req.params.id, req.admin.id));
  })
);

// ---- preview / dry run ----------------------------------------------------

router.post(
  '/:id/preview',
  requirePermission('newsletters.view'),
  [
    param('id').isInt({ min: 1 }),
    body('customerId').optional({ nullable: true }).isInt({ min: 1 }),
    body('language').optional({ values: 'falsy' }).isString().isLength({ max: 8 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const campaign = await newsletterService.getCampaign(req.params.id);

    let customer = null;
    if (req.body.customerId) {
      customer = await db('customer_accounts').where({ id: req.body.customerId }).first();
    }
    // Sample data when no real customer is named, so the variables render as
    // something legible instead of leaving `{{first_name}}` on screen.
    const subject = campaign.subject;
    const rendered = await newsletterService.renderForRecipient(
      req.body.language ? { ...campaign, language: req.body.language } : campaign,
      customer || {
        id: null,
        email: 'alex@example.com',
        salutation: 'Ms.',
        first_name: 'Alex',
        last_name: 'Sample',
        display_name: 'Alex Sample',
        company_name: 'Sample & Co',
        preferred_language: req.body.language || campaign.language,
      },
      { unsubscribeUrl: '#preview-unsubscribe' }
    );

    return successResponse(res, {
      subject: rendered.subject || subject,
      html: rendered.html,
      language: rendered.language,
      isSample: !customer,
    });
  })
);

router.post(
  '/:id/recipients/resolve',
  requirePermission('newsletters.view'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const campaign = await newsletterService.getCampaign(req.params.id);
    const { recipients, skippedOptOut, skippedNoEmail } =
      await newsletterService.resolveRecipients(campaign);
    // Counts only — the composer needs the number, not 2 000 email addresses.
    return successResponse(res, {
      recipientCount: recipients.length,
      skippedOptOut,
      skippedNoEmail,
      sendRatePerMinute: newsletterService.clampRate(campaign.send_rate_per_minute),
      estimatedMinutes: Math.ceil(
        recipients.length / newsletterService.clampRate(campaign.send_rate_per_minute)
      ),
    });
  })
);

// ---- send -----------------------------------------------------------------

router.post(
  '/:id/test',
  requirePermission('newsletters.send'),
  testLimiter,
  [param('id').isInt({ min: 1 }), body('to').isEmail()],
  handleAsync(async (req, res) => {
    validateRequest(req);
    return successResponse(res,
      await newsletterService.sendTest(req.params.id, req.body.to, req.admin.id));
  })
);

router.post(
  '/:id/queue',
  requirePermission('newsletters.send'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    return successResponse(res,
      await newsletterService.queueCampaign(req.params.id, req.admin.id), 200, 'Campaign queued');
  })
);

router.post(
  '/:id/cancel',
  requirePermission('newsletters.send'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    return successResponse(res,
      await newsletterService.cancel(req.params.id, req.admin.id), 200, 'Campaign cancelled');
  })
);

module.exports = router;
