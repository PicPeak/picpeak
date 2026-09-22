const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { buildCookieOptionsWithExpiry } = require('./tokenUtils');

const COOKIE_NAME = 'picpeak_feedback';
const ISSUER = 'picpeak-feedback';
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;

// Anonymous feedback needs a browser identity stable across User-Agent/IP
// changes. It is not proof of a unique person; the separate IP budget bounds
// clients that discard cookies. Identified guests retain their existing UUID.
function anonymousFeedbackIdentifier(req) {
  if (req.anonymousFeedbackIdentifier) return req.anonymousFeedbackIdentifier;
  let subject;
  try {
    const decoded = jwt.verify(req.cookies?.[COOKIE_NAME], process.env.JWT_SECRET, {
      issuer: ISSUER, algorithms: ['HS256']
    });
    if (decoded.type === 'feedback' && typeof decoded.sub === 'string'
      && /^[a-f0-9]{32}$/.test(decoded.sub)) subject = decoded.sub;
  } catch { /* absent, expired, or invalid: issue a fresh identity */ }
  if (!subject) {
    subject = crypto.randomBytes(16).toString('hex');
    const token = jwt.sign({ type: 'feedback' }, process.env.JWT_SECRET, {
      subject, issuer: ISSUER, algorithm: 'HS256', expiresIn: MAX_AGE / 1000
    });
    if (!req.res?.cookie) throw new Error('Feedback identity requires an HTTP response');
    req.res.cookie(COOKIE_NAME, token, {
      ...buildCookieOptionsWithExpiry(req.res, MAX_AGE), path: '/api/gallery'
    });
  }
  const eventId = req.event?.id;
  if (!eventId) throw new Error('Feedback identity requires authenticated event context');
  req.anonymousFeedbackIdentifier = crypto.createHmac('sha256', process.env.JWT_SECRET)
    .update(`feedback:${eventId}:${subject}`).digest('hex');
  return req.anonymousFeedbackIdentifier;
}

module.exports = { anonymousFeedbackIdentifier };
