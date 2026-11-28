/**
 * Public website API (issue 2618), mounted at /api/public/website.
 *
 *   POST /contact   the contact form block. A plain HTML form (multipart, the
 *                   one body type the /api CSRF gate lets a form send), so
 *                   the answer is a 303 back to the published page with an
 *                   anchor the page shows as a note: #contact-sent-<block> or
 *                   #contact-error-<block>. The target is built from the
 *                   published document, never from the request.
 *
 * Gated by the `websiteBuilder` flag and an active, published site.
 */
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { rateLimitKey } = require('../utils/rateLimitKey');
const logger = require('../utils/logger');
const { mutationOriginAllowed } = require('../utils/requestOrigin');
const websiteService = require('../services/website/service');
const contact = require('../services/website/contact');
const { pageHref } = require('../services/website/renderer');

const router = express.Router();

// Fields only: six text inputs, two hidden ones and the captcha's answer. Multer counts bytes; the
// longest field (the message, MESSAGE_MAX characters) may take four bytes a
// character in UTF-8. Characters are checked in validateSubmission.
// No bracket-indexed field names (fieldArrayIndexLimit, as the upload
// routes): a huge index would have the field parser walk a sparse array
// synchronously, before any other check.
const formFields = multer({
  limits: { fields: 12, fieldSize: 4 * contact.MESSAGE_MAX, files: 0, parts: 12, fieldNameSize: 40, fieldArrayIndexLimit: 0 },
}).none();

function back(res, page, blockId, outcome) {
  // Anchors and page paths come from the published document only.
  const target = page ? `${pageHref(page)}#contact-${outcome}-${blockId}` : '/';
  res.redirect(303, target);
}

// Count every attempt, per sender (an IPv6 /64 is one, rateLimitKey): a
// visitor sends a handful of messages, not ten an hour, and no sender fills
// the studio's daily cap (contact.DAILY_CAP) alone.
const senderLimit = (windowMs, max) => rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  handler: (req, res) => res.redirect(303, '/'),
});
const hourly = senderLimit(60 * 60 * 1000, 5);
const daily = senderLimit(24 * 60 * 60 * 1000, 20);

// The site must be live before its form is even parsed.
const whileLive = (req, res, next) => websiteService.isWebsiteActive()
  .then((active) => (active ? next() : res.status(404).type('text/plain').send('Not found')))
  .catch(next);

router.post('/contact', daily, hourly, whileLive, (req, res, next) => {
  formFields(req, res, (err) => {
    if (!err) return next();
    // Bracket-indexed field names: never from the form, a plain 400.
    if (err.code === 'LIMIT_FIELD_ARRAY_INDEX') return res.status(400).type('text/plain').send('Invalid form');
    // Over the parser's limits: the visitor gets the form's own error note
    // when the fields before the overflow name it, else a plain 400.
    return contact.findForm(String(req.body?.page || ''), String(req.body?.block || ''))
      .then((form) => (form ? back(res, form.page, form.block.id, 'error') : res.status(400).type('text/plain').send('Invalid form')))
      .catch(() => res.status(400).type('text/plain').send('Invalid form'));
  });
}, async (req, res) => {
  try {
    // Another site must not post into the studio's inbox through a
    // visitor's browser; a same-origin form passes (Sec-Fetch-Site).
    if (!mutationOriginAllowed(req)) return res.status(403).type('text/plain').send('Cross-site request rejected');
    const body = req.body || {};
    const form = await contact.findForm(String(body.page || ''), String(body.block || ''));
    if (!form) return res.status(404).type('text/plain').send('Not found');

    const checked = contact.validateSubmission(body);
    if (!checked.ok) {
      if (checked.reason === 'spam') {
        logger.info('Website contact form: dropped by the honeypot');
        return back(res, form.page, form.block.id, 'sent');
      }
      return back(res, form.page, form.block.id, 'error');
    }
    // The spam check, when it is on: checked with the provider, every time.
    const captcha = await require('../services/website/contactSettings').activeCaptcha();
    if (captcha && captcha.unusable) {
      // Chosen but impossible to check: refused, never taken unchecked.
      logger.warn('Website contact form: the spam check cannot be checked (key missing or unreadable); message refused', { provider: captcha.provider });
      return back(res, form.page, form.block.id, 'error');
    }
    if (captcha && !(await require('../services/website/captcha').verifyAnswer(captcha, body, { ip: req.ip }))) {
      return back(res, form.page, form.block.id, 'captcha');
    }
    const outcome = await contact.storeSubmission(checked.values, form.page);
    if (outcome === 'stored') {
      await contact.sendMails(checked.values, form.page, { captchaOn: Boolean(captcha) })
        .catch((error) => logger.error('Website contact form: the mails were not queued', { error: error.message }));
    }
    return back(res, form.page, form.block.id, outcome === 'stored' ? 'sent' : 'error');
  } catch (error) {
    logger.error('Website contact form failed', { error: error.message });
    return res.status(500).type('text/plain').send('Internal server error');
  }
});

module.exports = router;
module.exports._internal = { hourly, daily };
