/**
 * One visible rating per guest and photo, and a real photos.comment_count
 * (issues 2075 and 2071).
 *
 * 1. Concurrent first ratings from one guest passed the check-then-insert in
 *    feedbackService together and each added a row, skewing the average.
 *    Duplicates are collapsed here (the row mutated last survives, the same
 *    rule the readers apply) and a partial unique index closes the race: one
 *    keyed on guest_id for registered guests, one on guest_identifier for the
 *    rest. Hidden rows stay out of both: they are the admin's moderation
 *    record, and the service already scopes every rating write to visible rows.
 *    The work lives in services/ratingUniqueness.js, because a .picpeak
 *    restore of a pre-309 backup has to run it too.
 * 2. photos.comment_count was never written, so the admin "Has comments"
 *    filter was always empty. Backfilled to approved, visible comments, the
 *    same count updatePhotoFeedbackStats keeps from now on.
 *
 * Additive and re-runnable: the dedupe finds nothing the second time, the
 * indexes are IF NOT EXISTS, and the backfill is a recount.
 */
const {
  ratingIndexesSupported,
  dedupeRatings,
  createRatingIndexes,
  dropRatingIndexes,
} = require('../../src/services/ratingUniqueness');

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('photo_feedback'))) return;

  if (await ratingIndexesSupported(knex)) {
    await knex.transaction(async (trx) => {
      await dedupeRatings(trx);
      await createRatingIndexes(trx);
    });
  }

  if (await knex.schema.hasColumn('photo_feedback', 'is_hidden')
    && await knex.schema.hasColumn('photo_feedback', 'is_approved')
    && await knex.schema.hasTable('photos')
    && await knex.schema.hasColumn('photos', 'comment_count')) {
    await knex.raw(
      'UPDATE photos SET comment_count = ('
      + 'SELECT COUNT(*) FROM photo_feedback f WHERE f.photo_id = photos.id '
      + 'AND f.feedback_type = \'comment\' AND f.is_approved = ? AND f.is_hidden = ?)',
      [true, false],
    );
  }
};

// Irreversible by design for the data: the collapsed duplicates and the
// recounted comment_count are corrections. Only the indexes are dropped.
exports.down = async function down(knex) {
  await dropRatingIndexes(knex);
};
