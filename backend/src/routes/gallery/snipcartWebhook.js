/** Snipcart webhooks: authenticate the request, then read the authoritative order. */
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { rateLimitKey } = require('../../utils/rateLimitKey');
const logger = require('../../utils/logger');
const snipcartSettings = require('../../modules/photoSales/snipcartSettings');
const { fetchSnipcartOrder, reconcileOrder } = require('../../modules/photoSales/snipcartOrders');
const router = express.Router();
const ORDER_EVENTS = new Set(['order.completed', 'order.paymentStatus.changed', 'order.status.changed', 'order.refund.created']);
const webhookLimiter = rateLimit({ windowMs: 60000, max: 300, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey });
/**
 * Development-only HMAC over the raw body (scripts/simulate-snipcart-
 * webhook.js). Never accepted in production: it has no timestamp and no
 * replay protection.
 */
function verifyDevelopmentSignature(rawBody, signature) {
  if (process.env.NODE_ENV === 'production') return false;
  const secret = (process.env.SNIPCART_WEBHOOK_SECRET || '').trim();
  if (!secret || !signature) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const candidate = String(signature).replace(/^hmac_/, '').trim();
  if (!candidate || expected.length !== candidate.length) return false;

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(candidate, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Snipcart v3's official webhook authentication: every request carries an
 * X-Snipcart-RequestToken that is verified against Snipcart's API with the
 * SECRET key (valid for one minute, usable once).
 */
async function verifySnipcartRequestToken(token) {
  const auth = snipcartSettings.auth(await snipcartSettings.credentials());
  if (!auth || !token) return false;
  try {
    const response = await snipcartSettings.request(
      `/requestvalidation/${encodeURIComponent(String(token))}`,
      { headers: { Authorization: auth, Accept: 'application/json' } }
    );
    return response.ok;
  } catch (error) {
    logger.warn(`Snipcart request token validation failed: ${error.type || error.name}`);
    return false;
  }
}


function orderTokenOf(payload) {
  const content = payload?.content || {};
  return content?.token || content?.orderToken || payload?.orderToken || content?.order?.token || null;
}

/** The body's order, for the development signature path only. */
function orderFromBody(payload) {
  const content = payload?.content || {};
  return content?.order || (content?.token ? content : null);
}

async function handleWebhook(req, res) {
  try {
    const requestToken = req.headers['x-snipcart-requesttoken'];
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));

    const tokenValid = await verifySnipcartRequestToken(requestToken);
    const developmentSigned = !tokenValid && verifyDevelopmentSignature(rawBody, req.headers['x-snipcart-signature']);
    if (!tokenValid && !developmentSigned) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const eventName = payload?.eventName;
    if (!ORDER_EVENTS.has(eventName)) return res.status(200).json({ ok: true });

    const orderToken = orderTokenOf(payload);
    if (!orderToken) {
      logger.warn(`Snipcart webhook ${eventName}: missing order token`);
      return res.status(400).json({ error: 'Missing order token' });
    }

    // The order as Snipcart's API knows it. A failed fetch answers 502 so
    // Snipcart delivers the webhook again.
    const order = tokenValid ? await fetchSnipcartOrder(orderToken) : orderFromBody(payload);
    if (!order && eventName === 'order.refund.created' && developmentSigned) {
      await reconcileOrder({ token: orderToken, paymentStatus: 'Refunded' });
      return res.status(200).json({ ok: true });
    }
    if (!order) return res.status(502).json({ error: 'Order could not be read from Snipcart' });
    order.token = order.token || orderToken;

    await reconcileOrder(order);
    // The body never carries the access token: Snipcart keeps webhook
    // responses in its dashboard logs.
    return res.status(200).json({ ok: true });
  } catch (error) {
    logger.error('Failed to process Snipcart order', { type: error.type || error.name });
    res.status(500).json({ error: 'Failed to process Snipcart order' });
  }
}

// Photo sales: ONE static dashboard entry serves every gallery —
// the slug-less route derives the gallery from the order's item URLs. The
// per-slug path stays for already-configured URLs and is handled the same.
router.post('/snipcart-webhook', webhookLimiter, express.raw({ type: '*/*', limit: '2mb' }), handleWebhook);
router.post('/:slug/snipcart-webhook', webhookLimiter, express.raw({ type: '*/*', limit: '2mb' }), handleWebhook);

module.exports = router;
