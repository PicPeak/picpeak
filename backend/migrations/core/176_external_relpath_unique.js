/**
 * Migration 176: one row per external file per event (#1162).
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
 * The work — which row survives, what happens to the guest feedback and admin
 * marks hanging off the loser, and why the dependent rows are deleted by hand
 * rather than left to ON DELETE CASCADE — lives in
 * services/externalPhotoDedupe.js, because a .picpeak restore has to run it
 * too: the archive carries the photos table verbatim, so a pre-#1162 backup
 * would otherwise hit the unique index mid-restore and roll the whole thing
 * back.
 *
 * Irreversible by design: down() drops the index but cannot resurrect the
 * deleted rows. They were never distinct data — the same file counted twice.
 *
 * What it does NOT do is delete the duplicates' thumbnail files. Those are
 * `ext<id>_<name>` keys under the thumbnail root, and a migration is the wrong
 * place to reach into storage — the backend may be pointed at S3, and a failed
 * object delete must not fail the schema change. They are left behind as
 * unreferenced bytes; the storage figures on the dashboard count them, which
 * is the correct answer to "what is on the disk".
 */

const {
  dedupeExternalPhotos,
  createExternalRelpathIndex,
  dropExternalRelpathIndex,
} = require('../../src/services/externalPhotoDedupe');

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('photos'))) return;
  if (!(await knex.schema.hasColumn('photos', 'external_relpath'))) return;

  const removed = await dedupeExternalPhotos(knex);
  if (removed) {
    console.log(`176_external_relpath_unique: removed ${removed} duplicate external photo row(s)`);
  }

  // Deliberately unguarded. Recording this migration as applied without the
  // index would leave the install permanently racy — the in-flight set only
  // covers one process, and the route's unique-violation path cannot converge
  // without a constraint to violate — with nothing to trigger a retry. A
  // failure here means the dedupe above did not achieve uniqueness, which is
  // worth stopping the upgrade for.
  await createExternalRelpathIndex(knex);
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('photos'))) return;
  await dropExternalRelpathIndex(knex);
};
