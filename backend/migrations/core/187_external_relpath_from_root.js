/**
 * Migration 187: external_relpath becomes relative to EXTERNAL_MEDIA_ROOT (#1163).
 *
 * It used to be relative to events.external_path, which every import
 * overwrites — so importing a second folder into an event rebased every photo
 * already in it onto the new folder. Nothing errored. Thumbnails are written to
 * local storage during the import while the base path is still correct, so the
 * grid kept rendering and only the things that need the ORIGINAL broke: preview
 * generation, the lightbox, downloads. The reporter had 7547 of 8004 rows
 * resolving to files that do not exist, and spent a while chasing it as a CPU
 * problem.
 *
 * The work — including the on-disk repair of events that have already been
 * rebased, and why it refuses to guess below current behaviour — lives in
 * services/externalRelpathFold.js, because a .picpeak restore has to run it
 * too: knex_migrations is excluded from the archive, so a pre-#1163 backup
 * lands base-relative rows on an instance that has already migrated.
 */

const { foldExternalRelpaths } = require('../../src/services/externalRelpathFold');

exports.up = async function(knex) {
  try {
    await foldExternalRelpaths(knex, (msg) => console.log(`187_external_relpath_from_root: ${msg}`));
  } catch (err) {
    // Re-thrown WITHOUT the driver's error code. run-migrations-safe.js treats
    // 23505 / 42P07 / 42701 / 42710 as "schema already exists" and marks the
    // migration applied (run-migrations-safe.js:138) — so a unique-violation
    // rolling this fold back would be recorded as a success, leaving every
    // external path in the old format under a resolver that reads them
    // differently, with nothing to trigger a retry.
    throw new Error(
      `187_external_relpath_from_root failed and was rolled back: ${err.message}. `
      + 'External photo paths are unchanged; resolve the cause and re-run the migration.'
    );
  }
};

/**
 * Irreversible by design, and a deliberate no-op rather than a partial undo.
 *
 * The base each row was folded with is not recorded anywhere:
 * events.external_path holds whatever the LAST import set, which for a
 * repaired row is the wrong answer and is exactly what broke these installs.
 * Stripping it back off would re-break them.
 *
 * The idempotency marker stays for the same reason — clearing it would let
 * up() run a second time and fold every path twice.
 */
exports.down = async function() {
  console.log('187_external_relpath_from_root: rollback is a no-op (see header)');
};
