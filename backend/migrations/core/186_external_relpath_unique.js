/**
 * Migration 186: one row per external file per event (#1162).
 *
 * The import route checked for an existing external_relpath and then inserted,
 * with an fs.stat and a sharp().metadata() call sitting in between — a window
 * wide enough that two overlapping imports of the same folder each see "not
 * there" and both insert. Nothing at the storage layer stopped them: 041
 * created only a NON-unique (event_id, source_origin) index. A reporter's
 * event ended up holding 8004 rows for 6012 distinct paths.
 *
 * So this does two things: clear the duplicates that already exist, and add
 * the constraint that makes the race unwinnable from here on.
 *
 * Survivor rule: the lowest id that has a thumbnail_path, else the lowest id.
 * Thumbnails are generated per row during import (adminExternalMedia.js), so
 * on a duplicated pair usually both have one and the tie-break never fires —
 * but an import killed mid-flight leaves rows without, and dropping the one
 * that HAS the thumbnail would blank a tile in the grid for no reason.
 *
 * Irreversible by design: down() drops the index but cannot resurrect the
 * deleted rows. They were never distinct data — the same file counted twice —
 * and everything hanging off them (feedback, faces, marks, transfer entries)
 * cascades from photos, so the survivor keeps its own copy of all of it.
 *
 * What it does NOT do is delete the duplicates' thumbnail files. Those are
 * `ext<id>_<name>` keys under the thumbnail root, and a migration is the wrong
 * place to reach into storage — the backend may be pointed at S3, and a failed
 * object delete must not fail the schema change. They are left behind as
 * unreferenced bytes; the storage figures on the dashboard count them, which
 * is the correct answer to "what is on the disk".
 */

const CHUNK = 400; // SQLite caps a statement at 999 bound parameters.

async function repointHeroes(knex, table, doomedToSurvivor) {
  if (!(await knex.schema.hasTable(table))) return;
  if (!(await knex.schema.hasColumn(table, 'hero_photo_id'))) return;

  // Left alone, the FK is ON DELETE SET NULL, so an event whose hero happened
  // to be the duplicate would silently lose its hero image — a visible
  // regression caused entirely by the cleanup. The survivor is the same file.
  for (const [doomed, survivor] of doomedToSurvivor) {
    await knex(table).where('hero_photo_id', doomed).update({ hero_photo_id: survivor });
  }
}

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('photos'))) return;
  if (!(await knex.schema.hasColumn('photos', 'external_relpath'))) return;

  // Which events have duplicates at all. Usually none, and on the installs
  // that do it is one event — so the per-event pass below stays cheap and
  // never pulls a whole photos table into memory.
  const dupKeys = await knex('photos')
    .whereNotNull('external_relpath')
    .select('event_id')
    .count('* as c')
    .groupBy('event_id', 'external_relpath')
    .havingRaw('count(*) > 1');

  const eventIds = [...new Set(dupKeys.map((r) => r.event_id))];

  const doomed = [];
  const doomedToSurvivor = new Map();

  for (const eventId of eventIds) {
    const rows = await knex('photos')
      .where('event_id', eventId)
      .whereNotNull('external_relpath')
      .select('id', 'external_relpath', 'thumbnail_path')
      .orderBy('id', 'asc');

    const byPath = new Map();
    for (const row of rows) {
      const group = byPath.get(row.external_relpath);
      if (group) group.push(row);
      else byPath.set(row.external_relpath, [row]);
    }

    for (const group of byPath.values()) {
      if (group.length < 2) continue;
      const survivor = group.find((r) => r.thumbnail_path) || group[0];
      for (const row of group) {
        if (row.id === survivor.id) continue;
        doomed.push(row.id);
        doomedToSurvivor.set(row.id, survivor.id);
      }
    }
  }

  if (doomed.length) {
    await repointHeroes(knex, 'events', doomedToSurvivor);
    await repointHeroes(knex, 'photo_categories', doomedToSurvivor);

    for (let i = 0; i < doomed.length; i += CHUNK) {
      await knex('photos').whereIn('id', doomed.slice(i, i + CHUNK)).del();
    }
    console.log(`186_external_relpath_unique: removed ${doomed.length} duplicate external photo row(s)`);
  }

  // Partial, so the millions of MANAGED rows carrying NULL are not indexed at
  // all. Both engines treat NULLs as distinct in a unique index, so a plain
  // one would also be correct — but it would carry every managed photo for no
  // query that ever uses it.
  const sql = 'CREATE UNIQUE INDEX IF NOT EXISTS photos_event_external_relpath_uniq '
    + 'ON photos (event_id, external_relpath) WHERE external_relpath IS NOT NULL';
  try {
    await knex.raw(sql);
  } catch (e) {
    // Never fail the whole migration chain over the index: an install that
    // somehow still holds a duplicate stays functional, just unprotected, and
    // the route's own conflict handling still converges.
    console.log('186_external_relpath_unique: unique index not created:', e.message);
  }
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('photos'))) return;
  try {
    await knex.raw('DROP INDEX IF EXISTS photos_event_external_relpath_uniq');
  } catch (e) {
    console.log('186_external_relpath_unique rollback: index drop skipped:', e.message);
  }
};
