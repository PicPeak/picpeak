const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { buildCookieOptionsWithExpiry } = require('./tokenUtils');
const { db } = require('../database/db');
const logger = require('./logger');
const { isUniqueViolation } = require('./dbErrors');

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
  // anonymous guests were identified by sha256("ip:userAgent"). A guest whose
  // subject has never been through this path may be a returning guest whose
  // likes/ratings/favourites are still stored under that old hash — re-key
  // them onto the new identity so they aren't a stranger to their own
  // feedback. Gated on the subject (feedback_identity_adoptions), not on
  // isNewIdentity: a guest who picked up a cookie between #1571 shipping and
  // this adoption logic shipping already has a "not new" identity forever,
  // and would otherwise never be migrated. Safe to drop this block a release
  // or two after #1584 ships, once returning guests have re-adopted.
  await adoptLegacyFeedbackIdentity(req, subject, eventId, identifier);

  return identifier;
}

// Claims the one-time adoption attempt for `subject`. Returns true if this
// call won the claim (no prior attempt recorded), false if adoption was
// already attempted — by an earlier request, or by a concurrent racer that
// won the insert. The insert's uniqueness on `subject` is the lock: two
// concurrent first-contact requests for the same subject (e.g. two tabs
// sharing one freshly-set cookie) can only have one winner.
async function claimIdentityAdoptionAttempt(subject) {
  try {
    await db('feedback_identity_adoptions').insert({ subject, adopted_at: new Date().toISOString() });
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    // Table missing (pre-migration) or another transient error: don't block
    // feedback from working over a failed claim. Treat as "already handled"
    // so we skip adoption rather than skip feedback.
    logger.error('Feedback identity adoption claim failed', { error: error.message });
    return false;
  }
}

async function adoptLegacyFeedbackIdentity(req, subject, eventId, newIdentifier) {
  try {
    const claimed = await claimIdentityAdoptionAttempt(subject);
    if (!claimed) return;

    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const userAgent = req.headers?.['user-agent'] || 'unknown';
    const legacyIdentifier = crypto.createHash('sha256').update(`${ip}:${userAgent}`).digest('hex');

    await db.transaction(async (trx) => {
      const legacyRows = await trx('photo_feedback')
        .where({ event_id: eventId, guest_identifier: legacyIdentifier })
        .select('id', 'photo_id', 'feedback_type');
      if (legacyRows.length === 0) return;

      // Comments are never deduplicated by (photo, type, identifier) — see
      // feedbackService.submitFeedback — so re-key them unconditionally.
      // Every other feedback type keeps at most one live row per
      // guest/photo/type; skip a legacy row that would collide with one the
      // new identity already holds rather than merge or overwrite it — that
      // decision belongs to submitFeedback's own duplicate handling, not to
      // a one-time identity migration. Gathered as two batch queries (not a
      // SELECT+UPDATE loop) since a guest's legacy row count is unbounded.
      const nonCommentPhotoIds = [...new Set(
        legacyRows.filter((row) => row.feedback_type !== 'comment').map((row) => row.photo_id)
      )];
      let collisionKeys = new Set();
      if (nonCommentPhotoIds.length > 0) {
        const existing = await trx('photo_feedback')
          .where({ event_id: eventId, guest_identifier: newIdentifier })
          .whereIn('photo_id', nonCommentPhotoIds)
          .select('photo_id', 'feedback_type');
        collisionKeys = new Set(existing.map((row) => `${row.photo_id}:${row.feedback_type}`));
      }

      const idsToRekey = legacyRows
        .filter((row) => row.feedback_type === 'comment' || !collisionKeys.has(`${row.photo_id}:${row.feedback_type}`))
        .map((row) => row.id);
      if (idsToRekey.length === 0) return;

      // Atomic conditional update (compare-and-swap): only rows still
      // carrying the legacy identifier get re-keyed. Guards against a
      // concurrent first-contact request for a *different* new subject (a
      // second browser tab with no cookie yet racing this one) re-keying the
      // same legacy row twice — whichever UPDATE commits first wins, the
      // loser's WHERE clause no longer matches and affects zero rows.
      await trx('photo_feedback')
        .whereIn('id', idsToRekey)
        .andWhere({ guest_identifier: legacyIdentifier })
        .update({ guest_identifier: newIdentifier, updated_at: new Date().toISOString() });
    });
  } catch (error) {
    // Best-effort — feedback must still work even if adoption fails.
    logger.error('Legacy feedback identity adoption failed', { error: error.message, eventId });
  }
}

module.exports = { anonymousFeedbackIdentifier };
