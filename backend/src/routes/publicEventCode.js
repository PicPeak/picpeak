/**
 * Public → event code lookup (issue 2495). Mounted at /api/public/event-code.
 * No authentication: the entry page /code sends what the guest typed and gets
 * back the gallery path the event's share link opens.
 *
 *   GET /:code   200 { path }  |  404 for every miss  |  429 when limited
 *
 * The code is a lookup, not a credential (see services/eventAccessCode.js).
 * With event codes switched off (general_event_codes_enabled), and for a
 * malformed, unknown, expired, archived, draft, paused or deleted code, the
 * answer is the same 404, so the endpoint tells a guesser nothing.
 *
 * Rate limit: only misses count against the per-IP budget, so guests behind
 * one venue address who type valid codes do not use it up. Once an address
 * has 20 misses in the window, though, EVERY lookup from it gets 429 until
 * the window ends, valid codes included. That is deliberate: letting hits
 * through past the limit would leave guessing unbounded, since a guesser
 * needs only one hit.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { rateLimitKey } = require('../utils/rateLimitKey');
const { noStoreCache } = require('../middleware/noStoreCache');
const { handleAsync } = require('../utils/routeHelpers');
const { resolveAccessCode } = require('../services/eventAccessCode');

const router = express.Router();

// 20 misses per 15 minutes per IP (per /64 on IPv6); after that the whole
// address is blocked for the rest of the window (see above).
//
// Every request is counted while it runs and refunded when it ends, unless it
// was a miss (404). The limiter's own 429s are refunded too: otherwise valid
// lookups arriving together from one venue address, briefly over the limit
// while in flight, would leave their 429s behind as misses and block the
// address with no wrong code typed. A blocked address stays blocked, as its
// 20 misses are never refunded.
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => res.statusCode !== 404,
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
