/**
 * Public → Newsletter unsubscribe (issue #1264, Part B).
 *
 * Mounted at /api/public/newsletter. No authentication — the signed token in
 * the email footer is the only credential, and it must work from a mail
 * client with no session, on any device, forever.
 *
 * The security property this file exists to hold: **the response is identical
 * whether or not the id exists.** A valid token, a tampered token, an unknown
 * customer and an already-unsubscribed customer all render the same page with
 * the same status. There is no lookup by email and no table of tokens, so the
 * endpoint offers nothing to enumerate.
 *
 * Deliberately NOT behind the `newsletters` feature flag: turning the feature
 * off must not break the unsubscribe links in mail that already went out.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { param } = require('express-validator');

const logger = require('../utils/logger');
const newsletterService = require('../services/newsletterService');

const router = express.Router();

// Own bucket — a shared limiter with the other public routes would let a
// scraper here eat the quote-preview budget, and vice versa.
const unsubscribeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * A single self-contained page — no scripts, no external assets, no branding
 * lookup. A confirmation page that needs the API to be healthy in order to
 * render is a confirmation page that fails when it matters.
 */
function confirmationPage(title, message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#f5f5f5; color:#333;
         font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif; }
  .card { max-width:480px; margin:20px; padding:40px 32px; background:#fff; border-radius:8px;
          text-align:center; box-shadow:0 1px 3px rgba(0,0,0,.08); }
  h1 { margin:0 0 12px; font-size:20px; }
  p { margin:0; font-size:14px; line-height:22px; color:#666; }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
}

const OK_TITLE = 'You have been unsubscribed';
const OK_MESSAGE = 'You will no longer receive newsletters from us. '
  + 'Transactional emails about your galleries, quotes and invoices are not affected.';

router.get(
  '/unsubscribe/:token',
  unsubscribeLimiter,
  [param('token').isString().isLength({ min: 1, max: 512 })],
  async (req, res) => {
    // Every branch below returns THIS response. The work differs; the answer
    // does not — that is the whole anti-enumeration property.
    const respond = () => res
      .status(200)
      .type('html')
      .set('Cache-Control', 'no-store')
      .set('X-Robots-Tag', 'noindex, nofollow')
      .send(confirmationPage(OK_TITLE, OK_MESSAGE));

    try {
      const customerId = newsletterService.verifyUnsubscribeToken(req.params.token);
      if (customerId === null) {
        logger.debug('Newsletter unsubscribe: token rejected');
        return respond();
      }
      await newsletterService.setMarketingOptOut(customerId, true, 'link', {
        type: 'customer', id: customerId,
      });
      return respond();
    } catch (error) {
      // Even a DB failure answers the same way. Telling the visitor "an error
      // occurred" for one id and "done" for another is exactly the oracle the
      // identical-response rule is there to remove — the failure goes to the
      // log, where it belongs.
      logger.error('Newsletter unsubscribe failed', { error: error.message });
      return respond();
    }
  }
);

module.exports = router;
