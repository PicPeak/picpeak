/**
 * Reveal and reset a gallery's password: the logic behind the admin routes
 * (adminEvents/passwordRecovery.js, adminEvents/resets.js) and their API-token
 * twins in routes/v1/events.js (issue 2326). The callers do the auth,
 * ownership and archived checks and shape their own responses; everything
 * that touches the hash, the recoverable copy, the mail and the activity log
 * lives here, so both surfaces behave the same.
 *
 * `audit` is merged into the activity metadata. The v1 routes pass the
 * token's id and name there; it must never carry a token value or a password.
 */

const bcrypt = require('bcrypt');
const { db, logActivity } = require('../database/db');
const { queueEmail } = require('./emailProcessor');
const { galleryPasswordColumns, readGalleryPassword, dropCopiesIfStorageOff } = require('../utils/galleryPasswordVault');
const { credentialChangeColumns, sameAsStored } = require('../utils/galleryCredentialCutoff');
const { validatePasswordInContext, getBcryptRounds } = require('../utils/passwordValidation');
const logger = require('../utils/logger');
const { buildShareLinkVariants } = require('./shareLinkService');
const { passwordKnownColumns, galleryLinkFor } = require('./galleryNotificationService');

/**
 * The stored copies of the gallery and client password (#1271), or nulls when
 * recoverable storage is off or nothing was saved. A reveal of a real
 * password is written to the activity log; an empty answer reveals nothing.
 */
async function revealGalleryPassword(id, event, actor, audit = {}) {
  const stored = await readGalleryPassword(id);
  if (stored.password || stored.clientPassword) {
    await logActivity('gallery_password_viewed',
      { eventName: event.event_name, galleryPassword: Boolean(stored.password), clientPassword: Boolean(stored.clientPassword), ...audit },
      id,
      actor);
  }
  return stored;
}

/**
 * Set a new gallery password on `event` (a full events row): the supplied one
 * when given, otherwise a generated one. Returns `{ rejected }` (a 400 body)
 * when the supplied password fails the strength rules, else
 * `{ newPassword, emailSent }`.
 */
async function resetGalleryPassword(id, event, { password: clientPassword, sendEmail }, actor, audit = {}) {
  // Use the admin-supplied password when provided; otherwise auto-generate
  // (preserves the previous one-click behaviour for callers/cron that don't
  // pass a body). Validation matches the create-event flow so the same
  // strength rules apply both ways.
  let newPassword;
  if (typeof clientPassword === 'string' && clientPassword.length > 0) {
    const passwordValidation = await validatePasswordInContext(clientPassword, 'gallery', {
      eventName: event.event_name
    });
    if (!passwordValidation.valid) {
      return {
        rejected: {
          error: 'Password does not meet security requirements',
          details: passwordValidation.errors,
          score: passwordValidation.score,
          feedback: passwordValidation.feedback
        }
      };
    }
    newPassword = clientPassword;
  } else {
    const { generateReadablePassword } = require('../utils/passwordGenerator');
    newPassword = generateReadablePassword();
  }
  const passwordHash = await bcrypt.hash(newPassword, getBcryptRounds());
  // The admin sees this password in the response, so it is no longer the
  // generated one nobody knows (migration 264).
  const copyColumns = { ...(await galleryPasswordColumns({ password: newPassword })), ...(await passwordKnownColumns()) };
  // An admin-chosen password equal to the current one is not a change; it
  // keeps the hash only while the stored hash is still the one compared.
  // A generated password is always new. #1271 — the copy is written in the
  // same statement as the hash, so it can never disagree with it.
  const keptHash = newPassword === clientPassword
    && await sameAsStored(newPassword, event.password_hash)
    && await db('events').where({ id, password_hash: event.password_hash })
      .update(Object.keys(copyColumns).length ? copyColumns : { updated_at: new Date().toISOString() });
  if (!keptHash) {
    await db('events')
      .where('id', id)
      .update({
        password_hash: passwordHash,
        ...copyColumns,
        // Guests who got in with the old password must log in again.
        ...(await credentialChangeColumns('gallery')),
      });
  }
  await dropCopiesIfStorageOff(id);

  // Queue email notification if requested. The event may have no address
  // (optional at creation, clearable since issue 1733): then nothing is
  // queued and the response says so, instead of reporting a mail that
  // never existed.
  let emailSent = false;
  if (sendEmail) {
    const recipientEmail = event.customer_email || event.host_email;
    const recipientName = event.customer_name || event.host_name || (recipientEmail ? recipientEmail.split('@')[0] : null);
    // event.share_link is the path-only form (`/gallery/<slug>/<token>`).
    // Use the full URL so customers can click straight from the email.
    const { shareUrl } = await buildShareLinkVariants({ slug: event.slug, shareToken: event.share_token });

    // The password is already changed above; a queue failure must not
    // turn that into a 500 without the audit row below.
    try {
      emailSent = await queueEmail(id, recipientEmail, 'gallery_created', {
        customer_name: recipientName,
        customer_email: recipientEmail,
        host_name: recipientName,
        event_name: event.event_name,
        event_date: event.event_date,  // Pass raw date - will be formatted by email processor
        gallery_link: await galleryLinkFor(event, recipientEmail, shareUrl),
        gallery_password: newPassword,
        expiry_date: event.expires_at  // Pass raw date - will be formatted by email processor
      }) === true;
    } catch (queueError) {
      logger.error('Password reset: could not queue the notification email', { eventId: id, error: queueError.message });
      emailSent = false;
    }
  }

  // Log activity
  await logActivity('password_reset',
    { eventName: event.event_name, emailSent, ...audit },
    id,
    actor
  );

  return { newPassword, emailSent };
}

module.exports = { revealGalleryPassword, resetGalleryPassword };
