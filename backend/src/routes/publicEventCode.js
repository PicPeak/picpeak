/**
 * Public → event code lookup (issue 2495). Mounted at /api/public/event-code.
 * No authentication: the entry page /code sends what the guest typed and gets
 * back the gallery path the event's share link opens.
 *
 *   GET /:code   200 { path }  |  404 for every miss  |  429 when limited
 *
 * The code is a lookup, not a credential (see services/eventAccessCode.js).
 * A malformed, unknown, expired, archived, draft, paused or deleted code all
 * answer the same 404, so the endpoint tells a guesser nothing. Only misses
 * count against the per-IP budget: a venue's guests behind one address who
 * type valid codes never lock each other out, while guessing stops after a
 * handful of tries.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { rateLimitKey } = require('../utils/rateLimitKey');
const { noStoreCache } = require('../middleware/noStoreCache');
const { handleAsync } = require('../utils/routeHelpers');
const { resolveAccessCode } = require('../services/eventAccessCode');

const router = express.Router();

// 10 misses per 15 minutes per IP (per /64 on IPv6).
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  handler: (req, res) => res.status(429).json({
    error: 'Too many attempts. Please try again later.',
    code: 'EVENT_CODE_RATE_LIMITED',
  }),
});

router.get('/:code', noStoreCache, lookupLimiter, handleAsync(async (req, res) => {
  const path = await resolveAccessCode(req.params.code);
  if (!path) return res.status(404).json({ error: 'Code not found', code: 'EVENT_CODE_NOT_FOUND' });
  res.json({ path });
}));

module.exports = router;
