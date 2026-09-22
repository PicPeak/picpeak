const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { buildCookieOptionsWithExpiry } = require('./tokenUtils');
const { db } = require('../database/db');
const logger = require('./logger');

const COOKIE_NAME = 'picpeak_feedback';
const ISSUER = 'picpeak-feedback';
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;

// Anonymous feedback needs a browser identity stable across User-Agent/IP
// changes. It is not proof of a unique person; the separate IP budget bounds
// clients that discard cookies. Identified guests retain their existing UUID.
async function anonymousFeedbackIdentifier(req) {
  if (req.anonymousFeedbackIdentifier) return req.anonymousFeedbackIdentifier;
  let subject;
  try {
    const decoded = jwt.verify(req.cookies?.[COOKIE_NAME], process.env.JWT_SECRET, {
      issuer: ISSUER, algorithms: ['HS256']
    });
    if (decoded.type === 'feedback' && typeof decoded.sub === 'string'
      && /^[a-f0-9]{32}$/.test(decoded.sub)) subject = decoded.sub;
  } catch { /* absent, expired, or invalid: issue a fresh identity */ }
  const isNewIdentity = !subject;
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
  const identifier = crypto.createHmac('sha256', process.env.JWT_SECRET)
    .update(`feedback:${eventId}:${subject}`).digest('hex');
  req.anonymousFeedbackIdentifier = identifier;

  // One-time adoption (picpeak#1584). Before this cookie existed (#1571),
  // anonymous guests were identified by sha256("ip:userAgent"). A guest who
  // is only now getting a cookie for the first time may be a returning
  // guest whose likes/ratings/favourites are still stored under that old
  // hash — re-key them onto the new identity so they aren't a stranger to
  // their own feedback. Safe to drop this block a release or two after
  // #1584 ships, once returning guests have re-adopted.
  if (isNewIdentity) {
    await adoptLegacyFeedbackIdentity(req, eventId, identifier);
  }

  return identifier;
}

async function adoptLegacyFeedbackIdentity(req, eventId, newIdentifier) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const userAgent = req.headers?.['user-agent'] || 'unknown';
  const legacyIdentifier = crypto.createHash('sha256').update(`${ip}:${userAgent}`).digest('hex');

  try {
    await db.transaction(async (trx) => {
      const legacyRows = await trx('photo_feedback')
        .where({ event_id: eventId, guest_identifier: legacyIdentifier })
        .select('id', 'photo_id', 'feedback_type');
      for (const row of legacyRows) {
        // Comments are never deduplicated by (photo, type, identifier) — see
        // feedbackService.submitFeedback — so re-key them unconditionally.
        // Every other feedback type keeps at most one live row per
        // guest/photo/type; skip a legacy row that would collide with one
        // the new identity already holds rather than merge or overwrite it
        // — that decision belongs to submitFeedback's own duplicate
        // handling, not to a one-time identity migration.
        if (row.feedback_type !== 'comment') {
          const collision = await trx('photo_feedback')
            .where({
              event_id: eventId,
              photo_id: row.photo_id,
              feedback_type: row.feedback_type,
              guest_identifier: newIdentifier
            })
            .first('id');
          if (collision) continue;
        }
        await trx('photo_feedback').where('id', row.id)
          .update({ guest_identifier: newIdentifier, updated_at: new Date().toISOString() });
      }
    });
  } catch (error) {
    // Best-effort — feedback must still work even if adoption fails.
    logger.error('Legacy feedback identity adoption failed', { error: error.message, eventId });
  }
}

module.exports = { anonymousFeedbackIdentifier };
