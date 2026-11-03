/**
 * Named favourite lists per guest per gallery (issue 2303).
 *
 * A guest's favourites (feedback_type 'favorite', the bookmark labelled
 * "Saved") can be sorted into lists they name: "Album", "Print", "Mum".
 *
 * - favorite_lists: one row per extra list. Owned by the same identity pair
 *   photo_feedback uses: guest_id for a registered guest (migration 078),
 *   guest_identifier for everyone else. Names are unique per owner, case
 *   folded, which the service checks (services/favoriteLists.js); there is no
 *   unique index because erasing a guest moves their lists from guest_id to
 *   the identifier, where it could collide with an anonymous list of the same
 *   device and fail the erasure.
 * - photo_feedback.favorite_list_id: the list a favourite sits in. NULL is the
 *   guest's default list, so every favourite written before this migration is
 *   in it without a backfill, and every reader that ignores the column keeps
 *   counting exactly what it counted before.
 * - event_feedback_settings.allow_favorite_lists: per-gallery toggle, off by
 *   default for the reason 182 gives for allow_color_labels. New events
 *   inherit `event_default_allow_favorite_lists` (services/feedbackDefaults.js).
 *
 * Deleting a list deletes the favourites in it. The foreign keys say so on
 * PostgreSQL; SQLite runs without PRAGMA foreign_keys, so the service deletes
 * the rows explicitly on both engines, and the keys are declared on
 * PostgreSQL only: adding a foreign-key column through knex makes SQLite
 * rebuild photo_feedback, for a constraint it would never enforce.
 */

const { SHARED_COLOR_LABEL_IDENTITY } = require('../../src/constants/colorLabels');

exports.up = async function (knex) {
  const isPg = knex.client.config.client === 'pg';

  if (!(await knex.schema.hasTable('favorite_lists'))) {
    await knex.schema.createTable('favorite_lists', (table) => {
      table.increments('id').primary();
      table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
      table.integer('guest_id').nullable().references('id').inTable('gallery_guests').onDelete('SET NULL');
      table.string('guest_identifier', 64).notNullable();
      table.string('name', 120).notNullable();
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      table.index(['event_id', 'guest_id'], 'favorite_lists_event_guest_idx');
      table.index(['event_id', 'guest_identifier'], 'favorite_lists_event_identifier_idx');
    });
  }

  if (!(await knex.schema.hasColumn('photo_feedback', 'favorite_list_id'))) {
    await knex.schema.alterTable('photo_feedback', (table) => {
      const column = table.integer('favorite_list_id').nullable();
      if (isPg) column.references('id').inTable('favorite_lists').onDelete('CASCADE');
    });
  }
  // Outside the column guard, as in 182: a run that died between the two
  // statements must still get its index on the re-run.
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS photo_feedback_favorite_list_idx ON photo_feedback (favorite_list_id)'
  );

  if (!(await knex.schema.hasColumn('event_feedback_settings', 'allow_favorite_lists'))) {
    await knex.schema.alterTable('event_feedback_settings', (table) => {
      table.boolean('allow_favorite_lists').defaultTo(false);
    });
  }
};

// After the rollback the photos' counters must say what the old code would
// write: favorite_count and feedback_count as feedbackService counted them
// before this migration. A photo saved only in an extra list keeps no count.
async function recountPhotos(knex, photoIds) {
  if (!photoIds.length || !(await knex.schema.hasTable('photos'))) return;
  const counters = {
    favorite_count: 'SELECT COUNT(*) FROM photo_feedback pf WHERE pf.photo_id = photos.id '
      + 'AND pf.feedback_type = \'favorite\' AND pf.is_hidden = ?',
    feedback_count: 'SELECT COUNT(DISTINCT CASE WHEN pf.guest_identifier IS NULL OR pf.guest_identifier <> ? '
      + 'THEN COALESCE(CAST(pf.guest_id AS VARCHAR), pf.guest_identifier) END) '
      + 'FROM photo_feedback pf WHERE pf.photo_id = photos.id AND pf.is_hidden = ?',
  };
  for (const [column, sql] of Object.entries(counters)) {
    if (!(await knex.schema.hasColumn('photos', column))) continue;
    const bindings = column === 'feedback_count' ? [SHARED_COLOR_LABEL_IDENTITY, false] : [false];
    for (let i = 0; i < photoIds.length; i += 500) {
      await knex('photos').whereIn('id', photoIds.slice(i, i + 500))
        .update({ [column]: knex.raw(`(${sql})`, bindings) });
    }
  }
}

exports.down = async function (knex) {
  if (await knex.schema.hasColumn('event_feedback_settings', 'allow_favorite_lists')) {
    await knex.schema.alterTable('event_feedback_settings', (table) => {
      table.dropColumn('allow_favorite_lists');
    });
  }
  // Favourites in extra lists go with the lists: back on the old schema they
  // would read as second copies in the default list, which the old duplicate
  // check toggles off as one and every counter counts twice.
  if (await knex.schema.hasColumn('photo_feedback', 'favorite_list_id')) {
    const photoIds = (await knex('photo_feedback').whereNotNull('favorite_list_id').distinct('photo_id'))
      .map((row) => row.photo_id);
    await knex('photo_feedback').whereNotNull('favorite_list_id').del();
    await recountPhotos(knex, photoIds);
  }
  // Before the column, as in 182: SQLite rebuilds the table on dropColumn and
  // a lingering index over the dropped column makes the rebuild fail.
  await knex.raw('DROP INDEX IF EXISTS photo_feedback_favorite_list_idx');
  if (await knex.schema.hasColumn('photo_feedback', 'favorite_list_id')) {
    await knex.schema.alterTable('photo_feedback', (table) => {
      table.dropColumn('favorite_list_id');
    });
  }
  await knex.schema.dropTableIfExists('favorite_lists');
};
