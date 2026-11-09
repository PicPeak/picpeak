/**
 * Public booking page API (#2440, part 2). Unauthenticated; mounted at
 * /api/public/booking and gated by the `calendarBooking` feature flag.
 *
 *   GET  /                 bookable services with their client-visible factors
 *   POST /estimate         price a service with the client's answers
 *   GET  /slots            free slots for a service between two dates
 *   POST /requests         send a booking request (holds the slot); with a
 *                          deposit (part 3) it answers with the Stripe
 *                          Checkout link and holds the slot for the checkout
 *   GET  /requests/status/:token   the client's status page
 *
 * A request writes only a booking_requests row; nothing reaches the CRM until
 * an admin accepts it. Abuse guards: per-IP rate limits, a honeypot field
 * (`website`) and a minimum fill time (`startedAt`). A bot that trips either
 * gets a 201 with no reference and nothing stored.
 */

const express = require('express');
const { body, param, query } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { rateLimitKey } = require('../utils/rateLimitKey');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const booking = require('../services/bookingService');
const pricingFactors = require('../services/pricingFactorService');

const router = express.Router();
router.use(requireFeatureFlag('calendarBooking', 'BOOKING_DISABLED'));

const limiter = (max, windowMs = 60 * 1000) => rateLimit({
  windowMs, max, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey,
});
const readLimiter = limiter(60);
const estimateLimiter = limiter(60);
const requestLimiter = limiter(5, 60 * 60 * 1000);

// A person needs a few seconds for the form; a script posting at once doesn't.
const MIN_FILL_MS = 3000;

function publicFactor(f) {
  return {
    id: f.id,
    name: f.name,
    description: f.description || null,
    inputType: f.input_type,
    unitLabel: f.unit_label || null,
    minValue: f.min_value == null ? null : Number(f.min_value),
    maxValue: f.max_value == null ? null : Number(f.max_value),
    // A number starts where the pricing starts (default, minimum, included).
    defaultValue: f.input_type === 'number'
      ? (booking.numberFactorStart(f) == null ? null : String(booking.numberFactorStart(f)))
      : f.default_value ?? null,
    // Choice labels only: zones are matched from the postcode on the server,
    // and option prices show up in the estimate, not as a price list.
    options: f.input_type === 'choice' ? f.options.map((o) => ({ id: o.id, label: o.label })) : [],
  };
}

router.get(
  '/',
  readLimiter,
  handleAsync(async (req, res) => {
    const deposits = require('../services/bookingDeposits');
    const [catalogue, settings, { timezone }, profile, stripeReady] = await Promise.all([
      booking.publicCatalogue(),
      booking.getSettings(),
      booking.workingHours(),
      db('business_profile').where({ id: 1 }).first('company_name', 'default_locale'),
      deposits.stripeReady(),
    ]);
    return successResponse(res, {
      businessName: profile?.company_name || null,
      defaultLanguage: profile?.default_locale || null,
      intro: settings.intro_text || null,
      timezone,
      leadTimeHours: settings.lead_time_hours,
      horizonDays: settings.horizon_days,
      services: await Promise.all(catalogue.map(async ({ preset, factors }) => ({
        id: preset.id,
        name: preset.name,
        description: preset.description || null,
        currency: preset.currency,
        durationMinutes: booking.durationMinutes(preset, await booking.withDurationValue(preset, {})),
        durationFactorId: preset.booking_duration_factor_id || null,
        factors: factors.map(publicFactor),
        // Part 3: shown before the client sends; only when Stripe can take it.
        deposit: stripeReady && deposits.DEPOSIT_TYPES.includes(preset.booking_deposit_type) && preset.booking_deposit_type !== 'none'
          ? {
            type: preset.booking_deposit_type,
            percent: preset.booking_deposit_percent == null ? null : Number(preset.booking_deposit_percent),
            amountMinor: preset.booking_deposit_minor == null ? null : Number(preset.booking_deposit_minor),
          }
          : null,
      }))),
    });
  })
);

const valuesValidator = body('values').optional({ nullable: true }).isObject();
const serviceIdValidator = body('serviceId').isInt({ min: 1 });

router.post(
  '/estimate',
  estimateLimiter,
  [serviceIdValidator, valuesValidator, body('language').optional({ values: 'falsy' }).isString().isLength({ max: 8 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const preset = await booking.bookableService(req.body.serviceId);
    const result = await pricingFactors.priceWithFactors(preset.id, {
      values: req.body.values || {}, language: req.body.language || 'en', clientOnly: true,
    });
    return successResponse(res, {
      currency: result.currency,
      totalMinor: result.totalMinor,
      lines: result.lines.map((l) => ({ description: l.description, totalMinor: l.totalMinor })),
      unmatched: result.unmatched,
      depositMinor: (await require('../services/bookingDeposits').stripeReady())
        ? require('../services/bookingDeposits').depositFor(preset, result.totalMinor) : 0,
      durationMinutes: booking.durationMinutes(preset, await booking.withDurationValue(preset, req.body.values || {})),
    });
  })
);

router.get(
  '/slots',
  readLimiter,
  [
    query('serviceId').isInt({ min: 1 }),
    query('from').matches(/^\d{4}-\d{2}-\d{2}$/),
    query('to').matches(/^\d{4}-\d{2}-\d{2}$/),
    // The duration factor's value (hours), when the service has one.
    query('duration').optional({ values: 'falsy' }).isFloat({ min: 0, max: 24 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const preset = await booking.bookableService(req.query.serviceId);
    const values = preset.booking_duration_factor_id && req.query.duration
      ? { [preset.booking_duration_factor_id]: Number(req.query.duration) }
      : {};
    const result = await booking.availableSlots(preset, { from: req.query.from, to: req.query.to, values });
    return successResponse(res, result);
  })
);

router.post(
  '/requests',
  requestLimiter,
  [
    serviceIdValidator,
    valuesValidator,
    body('start').isISO8601(),
    body('name').isString().trim().isLength({ min: 1, max: 160 }),
    body('email').isEmail().isLength({ max: 255 }),
    body('phone').optional({ values: 'falsy' }).isString().isLength({ max: 40 }),
    body('company').optional({ values: 'falsy' }).isString().isLength({ max: 160 }),
    body('message').optional({ values: 'falsy' }).isString().isLength({ max: 5000 }),
    body('language').optional({ values: 'falsy' }).isString().isLength({ max: 8 }),
    body('website').optional({ values: 'falsy' }).isString().isLength({ max: 500 }),
    body('startedAt').optional({ values: 'falsy' }).isInt({ min: 0 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const filledTooFast = req.body.startedAt && Date.now() - Number(req.body.startedAt) < MIN_FILL_MS;
    if (req.body.website || filledTooFast) {
      logger.info('Booking request dropped by the spam guard', { honeypot: Boolean(req.body.website) });
      return successResponse(res, { reference: null, status: 'pending' }, 201);
    }
    const { request, checkoutUrl, statusToken } = await booking.createRequest({
      serviceId: req.body.serviceId,
      values: req.body.values || {},
      start: req.body.start,
      name: req.body.name,
      email: req.body.email,
      phone: req.body.phone,
      company: req.body.company,
      message: req.body.message,
      language: req.body.language,
    });
    return successResponse(res, {
      reference: request.reference,
      status: request.status,
      // Part 3: pay the deposit there; the status page follows the request.
      checkoutUrl: checkoutUrl || null,
      statusToken: statusToken || null,
      depositMinor: Number(request.deposit_minor || 0),
      startsAt: booking.iso(request.starts_at),
      endsAt: booking.iso(request.ends_at),
      holdExpiresAt: booking.iso(request.hold_expires_at),
      estimateMinor: Number(request.estimate_minor),
      currency: request.currency,
    }, 201);
  })
);

// The client's status page (part 3): the token from the request answer,
// stored hashed. Coming back from Checkout, a still-open payment is looked up
// at Stripe once, so the page does not wait for the webhook.
router.get(
  '/requests/status/:token',
  readLimiter,
  [param('token').isHexadecimal().isLength({ min: 48, max: 48 }), query('cancelled').optional().isIn(['1'])],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const deposits = require('../services/bookingDeposits');
    let request = await db('booking_requests').where({ status_token_hash: deposits.hashToken(req.params.token) }).first();
    if (!request) return res.status(404).json({ error: 'Booking request not found', code: 'BOOKING_NOT_FOUND' });
    // Stripe first: a payment that is in must count before any expiry runs.
    request = req.query.cancelled === '1'
      ? await deposits.cancelCheckout(request)
      : await deposits.refreshFromStripe(request);
    await booking.expireStaleHolds();
    request = await db('booking_requests').where({ id: request.id }).first();
    const { timezone } = await booking.workingHours();
    return successResponse(res, {
      reference: request.reference,
      status: request.status,
      serviceName: request.service_name,
      startsAt: booking.iso(request.starts_at),
      endsAt: booking.iso(request.ends_at),
      holdExpiresAt: booking.iso(request.hold_expires_at),
      estimateMinor: Number(request.estimate_minor),
      depositMinor: Number(request.deposit_minor || 0),
      depositStatus: request.deposit_status || 'none',
      currency: request.currency,
      timezone,
    });
  })
);

module.exports = router;
