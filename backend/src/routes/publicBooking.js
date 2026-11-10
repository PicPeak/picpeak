/**
 * Public booking page API (#2440, part 2). Unauthenticated; mounted at
 * /api/public/booking and gated by the `calendarBooking` feature flag.
 *
 *   GET  /                 bookable services with their client-visible factors
 *   POST /estimate         price a service with the client's answers
 *   GET  /slots            free slots for a service between two dates
 *   POST /requests         send a booking request (holds the slot)
 *
 * A request writes only a booking_requests row; nothing reaches the CRM until
 * an admin accepts it. Abuse guards: per-IP rate limits, a honeypot field
 * (`website`) and a minimum fill time carried in a signed `formToken` from
 * `GET /`. A bot that trips the honeypot or posts too fast gets a 201 with no
 * reference and nothing stored; a missing or forged token is a 400.
 */

const crypto = require('crypto');
const express = require('express');
const { body, query } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { rateLimitKey } = require('../utils/rateLimitKey');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const booking = require('../services/bookingService');
const pricingFactors = require('../services/pricingFactorService');
const { isTruthyFlag } = require('../utils/lineItemTotals');

const router = express.Router();
router.use(requireFeatureFlag('calendarBooking', 'BOOKING_DISABLED'));

const limiter = (max, windowMs = 60 * 1000, extra = {}) => rateLimit({
  windowMs, max, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey, ...extra,
});
const readLimiter = limiter(60);
const estimateLimiter = limiter(60);
// Only sent requests count: a 409 for a time taken meanwhile, or a refused
// cap, must not lock a real client out. Open requests are capped per
// client in the service (bookingService.assertMayRequest).
const requestLimiter = limiter(5, 60 * 60 * 1000, { skipFailedRequests: true });

// A person needs a few seconds for the form; a script posting at once
// doesn't. The start time travels in a token the server signed when the
// page loaded, so it can neither be left out nor made up.
const MIN_FILL_MS = 3000;
const MAX_FORM_AGE_MS = 6 * 60 * 60 * 1000;

function formSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required');
  return `booking-form:${secret}`;
}
function signForm(issuedAt = Date.now()) {
  const mac = crypto.createHmac('sha256', formSecret()).update(String(issuedAt)).digest('hex');
  return `${issuedAt}.${mac}`;
}
/** 'ok', or why the token fails: 'invalid' (forged / old) or 'fast'. */
function checkForm(token, now = Date.now()) {
  const [issued, mac] = String(token || '').split('.');
  const issuedAt = Number(issued);
  if (!Number.isFinite(issuedAt) || !mac) return 'invalid';
  const expected = crypto.createHmac('sha256', formSecret()).update(String(issuedAt)).digest('hex');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return 'invalid';
  if (now - issuedAt > MAX_FORM_AGE_MS) return 'invalid';
  return now - issuedAt < MIN_FILL_MS ? 'fast' : 'ok';
}

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
    const [catalogue, settings, { timezone }, profile] = await Promise.all([
      booking.publicCatalogue(),
      booking.getSettings(),
      booking.workingHours(),
      db('business_profile').where({ id: 1 }).first('company_name', 'default_locale'),
    ]);
    return successResponse(res, {
      businessName: profile?.company_name || null,
      defaultLanguage: profile?.default_locale || null,
      intro: settings.intro_text || null,
      timezone,
      formToken: signForm(),
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
      }))),
    });
  })
);

const valuesValidator = body('values').optional({ nullable: true }).isObject();
const serviceIdValidator = body('serviceId').isInt({ min: 1 });
// The browser's language ("de-CH", "en-US") reduced to a shipped locale;
// anything else falls back to the default rather than refusing the form.
const languageSanitizer = body('language').customSanitizer((value) => {
  const base = String(value || '').toLowerCase().split(/[-_]/)[0];
  return booking.LANGUAGES.includes(base) ? base : undefined;
});

router.post(
  '/estimate',
  estimateLimiter,
  [serviceIdValidator, valuesValidator, languageSanitizer],
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
      // The length the request will be checked with: the priced values, so a
      // factor the client cannot see keeps its default here too.
      durationMinutes: booking.durationMinutes(preset, await booking.withDurationValue(preset, result.snapshot.values || {})),
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
    // Only a duration factor the client fills in takes a value from the
    // page; a hidden one keeps its default, as in the estimate.
    const durationFactor = preset.booking_duration_factor_id
      ? await db('pricing_factors').where({ id: preset.booking_duration_factor_id }).first('client_visible')
      : null;
    const visible = durationFactor && isTruthyFlag(durationFactor.client_visible);
    const values = visible && req.query.duration
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
    languageSanitizer,
    body('website').optional({ values: 'falsy' }).isString().isLength({ max: 500 }),
    body('formToken').isString().isLength({ min: 10, max: 200 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const form = checkForm(req.body.formToken);
    if (form === 'invalid') {
      // Forged, or a page left open for hours: reload to get a fresh one.
      return res.status(400).json({ error: 'The form has expired. Please reload the page.', code: 'BOOKING_FORM_EXPIRED' });
    }
    if (req.body.website || form === 'fast') {
      logger.info('Booking request dropped by the spam guard', { honeypot: Boolean(req.body.website) });
      return successResponse(res, { reference: null, status: 'pending' }, 201);
    }
    const request = await booking.createRequest({
      serviceId: req.body.serviceId,
      values: req.body.values || {},
      start: req.body.start,
      name: req.body.name,
      email: req.body.email,
      phone: req.body.phone,
      company: req.body.company,
      message: req.body.message,
      language: req.body.language,
      clientKey: rateLimitKey(req),
    });
    return successResponse(res, {
      reference: request.reference,
      status: request.status,
      startsAt: booking.iso(request.starts_at),
      endsAt: booking.iso(request.ends_at),
      holdExpiresAt: booking.iso(request.hold_expires_at),
      estimateMinor: Number(request.estimate_minor),
      currency: request.currency,
    }, 201);
  })
);

module.exports = router;
