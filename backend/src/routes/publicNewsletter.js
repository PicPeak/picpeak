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
function page(title, message, formAction) {
  const action = formAction
    ? `
    <form method="POST" action="${escapeHtml(formAction)}" style="margin-top:20px;">
      <button type="submit" style="background:#5C8762;color:#fff;border:0;border-radius:6px;
        padding:12px 24px;font-size:14px;cursor:pointer;">Yes, unsubscribe me</button>
    </form>`
    : '';
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
    <p>${escapeHtml(message)}</p>${action}
  </div>
</body>
</html>`;
}

const OK_TITLE = 'You have been unsubscribed';
const OK_MESSAGE = 'You will no longer receive newsletters from us. '
  + 'Transactional emails about your galleries, quotes and invoices are not affected.';

const CONFIRM_TITLE = 'Unsubscribe from our newsletter?';
const CONFIRM_MESSAGE = 'Confirm below and you will no longer receive newsletters from us. '
  + 'Transactional emails about your galleries, quotes and invoices are not affected.';

// The GET only ASKS. Mail-security scanners, link prefetchers and corporate
// gateways follow every URL in a message before a human ever sees it — a GET
// that mutated consent would unsubscribe much of a campaign's recipient list
// automatically, and the recipients would never know why the mail stopped.
// The state change lives on the POST below, which needs a real click.
router.get(
  '/unsubscribe/:token',
  unsubscribeLimiter,
  [param('token').isString().isLength({ min: 1, max: 512 })],
  (req, res) => {
    // Rendered for ANY token, valid or not — see the file header. A scanner
    // and a real recipient must not be able to tell the difference.
    const action = `/api/public/newsletter/unsubscribe/${encodeURIComponent(req.params.token)}`;
    return res
      .status(200)
      .type('html')
      .set('Cache-Control', 'no-store')
      .set('X-Robots-Tag', 'noindex, nofollow')
      .send(page(CONFIRM_TITLE, CONFIRM_MESSAGE, action));
  }
);

router.post(
  '/unsubscribe/:token',
  unsubscribeLimiter,
  [param('token').isString().isLength({ min: 1, max: 512 })],
  async (req, res) => {
    // Every branch answers identically — the anti-enumeration property.
    const respond = () => res
      .status(200)
      .type('html')
      .set('Cache-Control', 'no-store')
      .set('X-Robots-Tag', 'noindex, nofollow')
      .send(page(OK_TITLE, OK_MESSAGE));

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
      // identical-response rule removes — the failure goes to the log.
      logger.error('Newsletter unsubscribe failed', { error: error.message });
      return respond();
    }
  }
);

module.exports = router;
