/**
 * Removing a gallery guest: the guest's own "forget me"
 * (DELETE /gallery/:slug/guest/me) and the admin's delete
 * (DELETE /admin/events/:eventId/guests/:guestId) run the same steps, in the
 * same order. The order matters, and so do the second passes: see the notes
 * on each step.
 */

const { db } = require('../database/db');
const feedbackService = require('./feedbackService');
const selectionSubmissions = require('./selectionSubmissions');
const { clearGuestCredits } = require('./photoCredit');

/**
 * Anonymise and soft-delete one guest.
 *
 * `guest` needs `id`, `event_id` and `email`, the fields
 * downloadJobNotifier.forgetGuest reads. The two callers hand over different
 * shapes: the guest route builds `{ id, event_id, email }` from req.guest
 * (whose own event field is the camelCase `eventId`) and req.event, the admin
 * route passes the full gallery_guests row. Both carry those three fields.
 *
 * Returns `{ feedback, creditsCleared }`: what anonymizeGuestFeedback
 * reported (`{ anonymized, photos }`) and the number of photos whose guest
 * credit was cleared.
 */
async function removeGuest(guest) {
  const guestId = guest.id;

  const feedback = await feedbackService.anonymizeGuestFeedback(guestId);

  await db('gallery_guests')
    .where({ id: guestId })
    .update({
      is_deleted: true,
      name: 'Removed',
      email: null,
      last_seen_at: db.fn.now(),
    });
  // Their views and downloads once more, now that the guest is marked
  // removed (issue 2503): a row written while the anonymisation above
  // ran still named the guest. A row written after this sees the mark
  // (guestAuth.settleLoggedGuest).
  await db('access_logs').where('guest_id', guestId).update({ guest_id: null });
  // Their "mail me when the download is ready" requests (issue 1733).
  await require('./downloadJobNotifier').forgetGuest(guest);
  // The denormalised uploader name must not outlive the guest (#1561).
  // After the soft delete: an upload still in flight checks for it once
  // its row is in (photoCredit.settleGuestCredit).
  const creditsCleared = await clearGuestCredits(guestId);
  // Again after the soft delete, for the same reason: a hand-over that got
  // in before it was stored with the guest's name (issue 1733).
  await selectionSubmissions.anonymizeGuest(guestId);

  return { feedback, creditsCleared };
}

module.exports = { removeGuest };
