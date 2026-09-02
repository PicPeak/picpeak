/**
 * `events.archive_size` — the archive zip's own byte size, recorded once at
 * archive time.
 *
 * The archives list showed a Size column produced by a per-row `fs.stat` run
 * AFTER pagination, so the number was only ever known for the 20 rows on
 * screen. That made a server-side "sort by size" impossible without statting
 * every archive on every request, and the sort fell back to
 * `SUM(photos.size_bytes)` — the archived *content* size, a different number
 * from the one in the column. Rows whose zip is missing or whose compression
 * ratio differs sorted by a value the admin was not looking at.
 *
 * With the size on the row, the sorted number and the displayed number are the
 * same number, and the list stops touching the filesystem at all.
 *
 * bigInteger, not integer: a real wedding archive crosses int4's 2.1 GB
 * ceiling routinely — that limit is why the restore path had to move off
 * adm-zip. Read it back through `Number()`, the pg driver hands bigints out as
 * strings.
 */

const fs = require('fs').promises;
const path = require('path');

exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn('events', 'archive_size'))) {
    await knex.schema.alterTable('events', (table) => {
      table.bigInteger('archive_size');
    });
  }

  // Backfill deliberately OUTSIDE the column guard: a run that died after the
  // alterTable but partway through the stats would leave the column present
  // and half the rows empty, and the re-run would skip both. `whereNull` makes
  // this idempotent and self-healing.
  //
  // Same storage-root resolution the routes use, so the migration reads the
  // files the app writes.
  const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');
  const rows = await knex('events')
    .whereNotNull('archive_path')
    .whereNull('archive_size')
    .select('id', 'archive_path');

  for (const row of rows) {
    try {
      const stats = await fs.stat(path.join(storagePath, row.archive_path));
      await knex('events').where('id', row.id).update({ archive_size: stats.size });
    } catch (_) {
      // Zip gone, or on a storage backend this process cannot stat (S3). Left
      // NULL, which the list renders and orders as 0 — exactly what the per-row
      // fs.stat this replaces already did for a file it could not read.
    }
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasColumn('events', 'archive_size')) {
    await knex.schema.alterTable('events', (table) => {
      table.dropColumn('archive_size');
    });
  }
};
