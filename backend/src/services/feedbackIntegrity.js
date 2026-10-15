/**
 * Repairs migration 309 makes to photo_feedback and photos, shared with the
 * .picpeak restore.
 *
 * One visible rating per guest and photo (issue 2075).
 *
 * Two partial unique indexes: one keyed on guest_id for registered guests, one
 * on a non-empty guest_identifier for the rest (an empty one is no identity to
 * the service either). Hidden rows stay out of both: they are the
 * admin's moderation record, and the service already scopes every rating write
 * to visible rows.
 *
 * Lives here rather than in migration 309 because a .picpeak restore needs it
 * too: the archive carries photo_feedback verbatim, so a backup taken before
 * 309 can hold the duplicates the migration removes and would otherwise hit
 * the indexes mid-restore and roll the whole restore back. Likewise its
 * photos.comment_count, which nothing wrote before 309 (issue 2071).
 */
const BY_GUEST_ID = 'photo_feedback_rating_guest_id_unique';
const BY_IDENTIFIER = 'photo_feedback_rating_guest_identifier_unique';

// Copy of feedbackService's lastMutatedFirst: a migration must not load the
// service (and its db connection) to pick a survivor.
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

// The columns both indexes are built over.
async function ratingIndexesSupported(knex) {
  if (!(await knex.schema.hasTable('photo_feedback'))) return false;
  for (const column of ['guest_id', 'guest_identifier', 'is_hidden']) {
    if (!(await knex.schema.hasColumn('photo_feedback', column))) return false;
  }
  return true;
}

/**
 * Collapse duplicate visible ratings: the row mutated last survives, the same
 * rule the readers apply. Recomputes average_rating for the touched photos,
 * the one counter a removed duplicate had skewed. Returns the rows removed.
 */
async function dedupeRatings(trx) {
  const rows = Array.from(await trx('photo_feedback')
    .where({ feedback_type: 'rating', is_hidden: false })
    .select('id', 'photo_id', 'guest_id', 'guest_identifier', 'created_at', 'updated_at'));

  const groups = new Map();
  for (const row of rows) {
    let key;
    if (row.guest_id !== null && row.guest_id !== undefined) key = `g:${row.photo_id}:${row.guest_id}`;
    // An empty identifier is no identity, here as in the service and the index.
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

  if (photos.size && await trx.schema.hasColumn('photos', 'average_rating')) {
    for (const photoId of photos) {
      const stats = await trx('photo_feedback')
        .where({ photo_id: photoId, feedback_type: 'rating', is_hidden: false })
        .avg({ average: 'rating' })
        .first();
      await trx('photos').where('id', photoId).update({ average_rating: Number(stats && stats.average) || 0 });
    }
  }
  return doomed.length;
}

async function createRatingIndexes(knex) {
  await knex.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${BY_GUEST_ID} ON photo_feedback (photo_id, guest_id) `
    + 'WHERE feedback_type = \'rating\' AND NOT is_hidden AND guest_id IS NOT NULL',
  );
  await knex.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${BY_IDENTIFIER} ON photo_feedback (photo_id, guest_identifier) `
    + 'WHERE feedback_type = \'rating\' AND NOT is_hidden AND guest_id IS NULL '
    + 'AND guest_identifier IS NOT NULL AND guest_identifier <> \'\'',
  );
}

async function dropRatingIndexes(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${BY_GUEST_ID}`);
  await knex.raw(`DROP INDEX IF EXISTS ${BY_IDENTIFIER}`);
}

/**
 * photos.comment_count as updatePhotoFeedbackStats keeps it: approved,
 * visible comments.
 */
async function backfillCommentCounts(knex) {
  if (!(await knex.schema.hasTable('photo_feedback'))) return;
  if (!(await knex.schema.hasColumn('photo_feedback', 'is_hidden'))) return;
  if (!(await knex.schema.hasColumn('photo_feedback', 'is_approved'))) return;
  if (!(await knex.schema.hasTable('photos'))) return;
  if (!(await knex.schema.hasColumn('photos', 'comment_count'))) return;
  await knex.raw(
    'UPDATE photos SET comment_count = ('
    + 'SELECT COUNT(*) FROM photo_feedback f WHERE f.photo_id = photos.id '
    + 'AND f.feedback_type = \'comment\' AND f.is_approved = ? AND f.is_hidden = ?)',
    [true, false],
  );
}

module.exports = {
  BY_GUEST_ID,
  BY_IDENTIFIER,
  ratingIndexesSupported,
  dedupeRatings,
  createRatingIndexes,
  dropRatingIndexes,
  backfillCommentCounts,
};
