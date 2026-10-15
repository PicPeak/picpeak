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
 * 2. photos.comment_count was never written, so the admin "Has comments"
 *    filter was always empty. Backfilled to approved, visible comments, the
 *    same count updatePhotoFeedbackStats keeps from now on.
 *
 * Additive and re-runnable: the dedupe finds nothing the second time, the
 * indexes are IF NOT EXISTS, and the backfill is a recount.
 */
const BY_GUEST_ID = 'photo_feedback_rating_guest_id_unique';
const BY_IDENTIFIER = 'photo_feedback_rating_guest_identifier_unique';

function feedbackTime(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  const text = typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)
    ? `${value.replace(' ', 'T')}Z` : value;
  return new Date(text).getTime() || 0;
}

function lastMutatedFirst(a, b) {
  return (feedbackTime(b.updated_at) || feedbackTime(b.created_at)) - (feedbackTime(a.updated_at) || feedbackTime(a.created_at))
    || feedbackTime(b.created_at) - feedbackTime(a.created_at)
    || Number(b.id) - Number(a.id);
}

async function dedupeRatings(trx) {
  const rows = Array.from(await trx('photo_feedback')
    .where({ feedback_type: 'rating', is_hidden: false })
    .select('id', 'photo_id', 'guest_id', 'guest_identifier', 'created_at', 'updated_at'));

  const groups = new Map();
  for (const row of rows) {
    let key;
    if (row.guest_id !== null && row.guest_id !== undefined) key = `g:${row.photo_id}:${row.guest_id}`;
    else if (row.guest_identifier) key = `i:${row.photo_id}:${row.guest_identifier}`;
    else continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const doomed = [];
  const photos = new Set();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort(lastMutatedFirst);
    for (const row of group.slice(1)) doomed.push(row.id);
    photos.add(group[0].photo_id);
  }

  for (let i = 0; i < doomed.length; i += 500) {
    await trx('photo_feedback').whereIn('id', doomed.slice(i, i + 500)).delete();
  }

  // The average is the one counter a removed duplicate had skewed.
  if (await trx.schema.hasColumn('photos', 'average_rating')) {
    for (const photoId of photos) {
      const stats = await trx('photo_feedback')
        .where({ photo_id: photoId, feedback_type: 'rating', is_hidden: false })
        .avg({ average: 'rating' })
        .first();
      await trx('photos').where('id', photoId).update({ average_rating: Number(stats && stats.average) || 0 });
    }
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('photo_feedback'))) return;

  const hasGuestId = await knex.schema.hasColumn('photo_feedback', 'guest_id');
  const hasIdentifier = await knex.schema.hasColumn('photo_feedback', 'guest_identifier');
  const hasHidden = await knex.schema.hasColumn('photo_feedback', 'is_hidden');
  const hasApproved = await knex.schema.hasColumn('photo_feedback', 'is_approved');

  if (hasGuestId && hasIdentifier && hasHidden) {
    await knex.transaction(async (trx) => {
      await dedupeRatings(trx);
      await trx.raw(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${BY_GUEST_ID} ON photo_feedback (photo_id, guest_id) `
        + 'WHERE feedback_type = \'rating\' AND NOT is_hidden AND guest_id IS NOT NULL',
      );
      await trx.raw(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${BY_IDENTIFIER} ON photo_feedback (photo_id, guest_identifier) `
        + 'WHERE feedback_type = \'rating\' AND NOT is_hidden AND guest_id IS NULL AND guest_identifier IS NOT NULL',
      );
    });
  }

  if (hasHidden && hasApproved
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
  await knex.raw(`DROP INDEX IF EXISTS ${BY_GUEST_ID}`);
  await knex.raw(`DROP INDEX IF EXISTS ${BY_IDENTIFIER}`);
};
