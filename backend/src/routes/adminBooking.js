/**
 * Admin → client booking (#2440, part 2). Mounted at /api/admin/booking,
 * gated by the `calendarBooking` feature flag (and `quotes`, which accepting
 * a request needs).
 *
 *   GET    /requests            list (pending first)      quotes.view
 *   GET    /requests/:id        one request               quotes.view
 *   POST   /requests/:id/accept customer + project + quote   quotes.manage
 *                                                         + customers.create
 *                                                         + events.edit
 *   POST   /requests/:id/decline                          quotes.manage
 *   GET    /blocks  POST /blocks  DELETE /blocks/:id     quotes.view / quotes.manage
 *   GET    /settings  PUT /settings                        quotes.view / quotes.manage
 *
 * Accept takes the same three permissions the manual path takes (new
 * customer, new project, new quote), so a booking request is no way around
 * any of them.
 */

const express = require('express');
const { body, param, query } = require('express-validator');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const booking = require('../services/bookingService');
const pricingFactors = require('../services/pricingFactorService');

const router = express.Router();
router.use(adminAuth);
router.use(requireFeatureFlag('calendarBooking', 'BOOKING_DISABLED'));
router.use(requireFeatureFlag('quotes', 'QUOTES_DISABLED'));

function transformRequest(r) {
  let lines = [];
  try { lines = JSON.parse(r.estimate_lines || '[]'); } catch { lines = []; }
  return {
    id: r.id,
    reference: r.reference,
    status: r.status,
    presetId: r.preset_id || null,
    serviceName: r.service_name,
    startsAt: booking.iso(r.starts_at),
    endsAt: booking.iso(r.ends_at),
    holdExpiresAt: booking.iso(r.hold_expires_at),
    name: r.name,
    email: r.email,
    phone: r.phone || null,
    company: r.company || null,
    message: r.message || null,
    language: r.language || null,
    pricingFactors: pricingFactors.parseSnapshot(r.pricing_factors),
    estimateLines: lines.map((l) => ({ description: l.description, totalMinor: Number(l.totalMinor) || 0 })),
    estimateMinor: Number(r.estimate_minor) || 0,
    currency: r.currency,
    decidedAt: booking.iso(r.decided_at),
    declineReason: r.decline_reason || null,
    customerAccountId: r.customer_account_id || null,
    projectId: r.project_id || null,
    quoteId: r.quote_id || null,
    createdAt: booking.iso(r.created_at),
  };
}

function transformSettings(s) {
  return {
    leadTimeHours: Number(s.lead_time_hours),
    horizonDays: Number(s.horizon_days),
    slotStepMinutes: Number(s.slot_step_minutes),
    bufferMinutes: Number(s.buffer_minutes),
    holdHours: Number(s.hold_hours),
    maxOpenRequests: Number(s.max_open_requests),
    introText: s.intro_text || null,
  };
}

function transformBlock(b) {
  return { id: b.id, startsAt: booking.iso(b.starts_at), endsAt: booking.iso(b.ends_at), note: b.note || null };
}

const idParam = param('id').isInt({ min: 1 });

router.get(
  '/requests',
  requirePermission('quotes.view'),
  [query('status').optional().isIn(booking.STATUSES)],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const rows = await booking.listRequests({ status: req.query.status || null });
    return successResponse(res, { requests: rows.map(transformRequest) });
  })
);

router.get(
  '/requests/:id',
  requirePermission('quotes.view'),
  [idParam],
  handleAsync(async (req, res) => {
    validateRequest(req);
    return successResponse(res, { request: transformRequest(await booking.getRequest(Number(req.params.id))) });
  })
);

router.post(
  '/requests/:id/accept',
  requirePermission(['quotes.manage', 'customers.create', 'events.edit'], { requireAll: true }),
  [idParam],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const row = await booking.acceptRequest(Number(req.params.id), req.admin.id);
    return successResponse(res, { request: transformRequest(row) });
  })
);

router.post(
  '/requests/:id/decline',
  requirePermission('quotes.manage'),
  [idParam, body('reason').optional({ values: 'falsy' }).isString().isLength({ max: 2000 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const row = await booking.declineRequest(Number(req.params.id), req.admin.id, req.body.reason);
    return successResponse(res, { request: transformRequest(row) });
  })
);

router.get(
  '/blocks',
  requirePermission('quotes.view'),
  handleAsync(async (req, res) => {
    const rows = await booking.listBlocks({ from: new Date(Date.now() - 86400000) });
    return successResponse(res, { blocks: rows.map(transformBlock) });
  })
);

router.post(
  '/blocks',
  requirePermission('quotes.manage'),
  [body('startsAt').isISO8601(), body('endsAt').isISO8601(), body('note').optional({ values: 'falsy' }).isString().isLength({ max: 255 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const row = await booking.createBlock(req.body, req.admin.id);
    return successResponse(res, { block: transformBlock(row) }, 201);
  })
);

router.delete(
  '/blocks/:id',
  requirePermission('quotes.manage'),
  [idParam],
  handleAsync(async (req, res) => {
    validateRequest(req);
    await booking.deleteBlock(Number(req.params.id));
    return successResponse(res, { deleted: true });
  })
);

router.get(
  '/settings',
  requirePermission('quotes.view'),
  handleAsync(async (req, res) => {
    const [settings, hours] = await Promise.all([booking.getSettings(), booking.workingHours()]);
    return successResponse(res, {
      settings: transformSettings(settings),
      timezone: hours.timezone,
      hasBusinessHours: Boolean(hours.schedule && Object.values(hours.schedule).some((d) => d.length)),
    });
  })
);

router.put(
  '/settings',
  requirePermission('quotes.manage'),
  [
    body('leadTimeHours').optional().isInt(),
    body('horizonDays').optional().isInt(),
    body('slotStepMinutes').optional().isInt(),
    body('bufferMinutes').optional().isInt(),
    body('holdHours').optional().isInt(),
    body('maxOpenRequests').optional().isInt(),
    body('introText').optional({ nullable: true }).isString().isLength({ max: 5000 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const saved = await booking.saveSettings({
      lead_time_hours: req.body.leadTimeHours,
      horizon_days: req.body.horizonDays,
      slot_step_minutes: req.body.slotStepMinutes,
      buffer_minutes: req.body.bufferMinutes,
      hold_hours: req.body.holdHours,
      max_open_requests: req.body.maxOpenRequests,
      intro_text: req.body.introText,
    });
    return successResponse(res, { settings: transformSettings(saved) });
  })
);

module.exports = router;
