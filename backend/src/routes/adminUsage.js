const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { ValidationError } = require('../utils/errors');
const service = require('../services/productUsageService');
const { ProtocolError, schemaForConsent } = require('../usage/protocol.cjs');
const router = express.Router();
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch((error) => {
    // instanceof, not `error.name`: ProtocolError extends Error without
    // setting `name`, so every instance reports 'Error' and this branch never
    // ran. A malformed vote or feedback payload fell through to the global
    // handler, which logs it as an unhandled programming error and answers
    // INTERNAL_ERROR in production — losing the validation code the caller
    // needs. protocol.cjs is vendored byte-identical with picpeak-usage, so
    // the fix belongs here rather than in the class.
    if (error instanceof ProtocolError)
      return res
        .status(400)
        .json({ error: 'Invalid usage request', code: error.code });
    next(error);
  });
// The three routes below are the only ones whose effect is an outbound
// request to someone else's service, carrying operator-written free text
// (title 120, body 4000, name 80). The platform's general limiter skips
// authenticated requests by design, which is right for endpoints that only
// touch this installation and wrong for a relay: without this an admin
// session can push unbounded traffic at the collector.
//
// Keyed to the installation, not the caller's IP, because the budget being
// protected is "how much this install relays", and per-process because that
// is the same store the rest of the app uses — a multi-replica deployment
// gets one budget per replica, which still bounds the shape that matters.
const outboundLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyGenerator: () => 'usage-outbound',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) =>
    res.status(429).json({
      error: 'Too many usage submissions. Try again later.',
      code: 'USAGE_RATE_LIMITED'
    })
});

router.use(adminAuth);
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
// Any authenticated admin can trigger the daily rollup; only settings editors
// see identity/packets or control consent. The route never accepts telemetry.
router.post(
  '/activity',
  wrap(async (_req, res) => {
    try {
      await service.tick();
    } catch (error) {
      if (error.code !== 'CONFLICT') throw error;
    }
    res.json({ ok: true });
  })
);
router.use(requirePermission('settings.edit'));
router.get(
  '/',
  wrap(async (_req, res) => res.json(await service.status()))
);
router.post(
  '/dismiss',
  wrap(async (_req, res) => res.json(await service.dismiss()))
);
router.post(
  '/enable',
  wrap(async (req, res) =>
    res.json(await service.enable(req.body.consent_version))
  )
);
router.post(
  '/consent',
  wrap(async (req, res) => {
    if (!req.body || Object.keys(req.body).length !== 1 || !['usage.v2', 'usage.v3', 'usage.v4'].includes(schemaForConsent(req.body.consent_version)))
      throw new ValidationError('Explicit usage consent is required');
    res.json(await service.command('consent', { consent_version: req.body.consent_version }));
  })
);
router.post(
  '/disable',
  wrap(async (_req, res) => res.json(await service.disable()))
);
// Reachable only from a withdrawal whose delete packet can never be signed;
// the service refuses in every other state. See UsageService.abandon().
router.post(
  '/abandon',
  wrap(async (_req, res) => res.json(await service.abandon()))
);
// An operator asking for a retry skips the delivery backoff — that button
// exists precisely to not wait for the next window.
router.post(
  '/retry',
  wrap(async (_req, res) => res.json(await service.tick({ force: true })))
);
router.get(
  '/preview',
  wrap(async (_req, res) => res.json(await service.preview()))
);
router.get(
  '/export',
  wrap(async (_req, res) =>
    res.attachment('picpeak-usage-packets.json').json(await service.export())
  )
);
router.put(
  '/feedback-preferences',
  wrap(async (req, res) => res.json(await service.preferences(req.body)))
);
// Every field the packet schema requires. The allowlist used to let `name`,
// `allow_public` and `allow_marketing` be omitted, and the packet schema —
// which requires all of them — then failed with a bare INVALID_PACKET instead
// of naming the missing field. The UI always sends them; anything driving the
// API directly did not, and got an error it could not act on.
const FEEDBACK_FIELDS = [
  'kind',
  'title',
  'body',
  'name',
  'allow_public',
  'allow_marketing'
];
router.post(
  '/feedback',
  outboundLimiter,
  wrap(async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object')
      throw new ValidationError('Invalid feedback');
    const unknown = Object.keys(body).filter(
      (key) => !FEEDBACK_FIELDS.includes(key)
    );
    if (unknown.length)
      throw new ValidationError(
        `Unknown feedback fields: ${unknown.join(', ')}`
      );
    for (const key of ['kind', 'title', 'body', 'name'])
      if (typeof body[key] !== 'string')
        throw new ValidationError(`Feedback field "${key}" must be a string`);
    for (const key of ['allow_public', 'allow_marketing'])
      if (typeof body[key] !== 'boolean')
        throw new ValidationError(`Feedback field "${key}" must be a boolean`);
    if (!body.title.trim() || !body.body.trim())
      throw new ValidationError('Feedback title and body are required');
    res.json(
      await service.command('feedback', {
        ...body,
        feedback_id: crypto.randomUUID()
      })
    );
  })
);
router.post(
  '/vote',
  outboundLimiter,
  wrap(async (req, res) => res.json(await service.command('vote', req.body)))
);
router.post(
  '/portal-session',
  outboundLimiter,
  wrap(async (_req, res) => {
    const result = await service.command('session', {});
    res.json({
      ...result,
      url: result.receipt?.session_token
        ? `${service.collectorUrl()}/#connect=${encodeURIComponent(result.receipt.session_token)}`
        : null
    });
  })
);
module.exports = router;
