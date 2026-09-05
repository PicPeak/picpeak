const express = require('express');
const crypto = require('crypto');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { ValidationError } = require('../utils/errors');
const service = require('../services/productUsageService');
const { ProtocolError } = require('../usage/protocol.cjs');
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
  '/disable',
  wrap(async (_req, res) => res.json(await service.disable()))
);
router.post(
  '/retry',
  wrap(async (_req, res) => res.json(await service.tick()))
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
router.post(
  '/feedback',
  wrap(async (req, res) => {
    const body = req.body;
    if (
      !body ||
      Object.keys(body).some(
        (k) =>
          ![
            'kind',
            'title',
            'body',
            'name',
            'allow_public',
            'allow_marketing'
          ].includes(k)
      ) ||
      typeof body.title !== 'string' ||
      !body.title.trim() ||
      typeof body.body !== 'string' ||
      !body.body.trim()
    )
      throw new ValidationError('Invalid feedback');
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
  wrap(async (req, res) => res.json(await service.command('vote', req.body)))
);
router.post(
  '/portal-session',
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
