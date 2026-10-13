/**
 * Content hash of a photo's original, for duplicate detection (issue 1733, C2).
 *
 * - photos.content_sha256: hex SHA-256 of the stored original, written when a
 *   photo arrives through an upload (admin, guest, API) and rewritten when a
 *   replacement swaps the file. NULL for everything else (watch folder,
 *   external media, S3 import, rows that predate this migration): those are
 *   never hashed here, because that would mean reading every original once.
 *   A row without a hash simply never matches.
 * - photos_content_sha256_idx: the upload asks "does this gallery already hold
 *   these bytes", so the lookup is (event_id, content_sha256). Partial, so the
 *   rows without a hash (all of them on the day this runs) cost nothing to
 *   index. Deliberately NOT unique: "upload anyway" stores a second copy on
 *   purpose, and two concurrent uploads of one file may both land.
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn('photos', 'content_sha256'))) {
    await knex.schema.alterTable('photos', (table) => {
      table.string('content_sha256', 64);
    });
  }

  // Outside the column guard, for the reason migration 193 gives: a run that
  // died between the two statements must not leave the index missing for good.
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS photos_content_sha256_idx '
    + 'ON photos (event_id, content_sha256) WHERE content_sha256 IS NOT NULL'
  );
};

exports.down = async function (knex) {
  // Index first: SQLite rebuilds the table on dropColumn, and an index over
  // the dropped column makes that rebuild fail.
  await knex.raw('DROP INDEX IF EXISTS photos_content_sha256_idx');
  if (await knex.schema.hasColumn('photos', 'content_sha256')) {
    await knex.schema.alterTable('photos', (table) => {
      table.dropColumn('content_sha256');
    });
  }
};
