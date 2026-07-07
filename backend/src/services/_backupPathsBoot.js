/**
 * Boot-time self-heal for the `backup_paths` table.
 *
 * **Why this exists**
 *
 * Knex won't re-run an applied migration, so once migration
 * 109_add_backup_paths.js has run, any later default we want to add
 * (a new subdirectory shipped by a future feature) would never reach
 * already-deployed installs. The historical fix for this kind of
 * "schema is fine, seed drifted" problem is the boot-time self-heal
 * pattern documented in [[feedback_self_heal_pattern]] — we just
 * re-apply the canonical seed on every boot with `onConflict.ignore()`
 * so admin edits stay intact and new rows trickle in.
 *
 * **Authoritative list**
 *
 * The list of defaults lives on migration 109 itself
 * (`DEFAULT_PATHS` export) — one source of truth that both the
 * migration and this seeder read. Tests assert these two stay in
 * lockstep.
 *
 * **Failure semantics**
 *
 * If the table doesn't exist yet (migrations haven't run, fresh
 * install before migration 109 lands, etc.) we no-op and log. The
 * walker has a hard-coded `LEGACY_DEFAULTS` fallback for the same
 * reason — defense in depth so "Run Backup Now" can never silently
 * ship a files-only manifest because of a seed issue. See
 * `backupService.js` getFilesToBackupInternal.
 */

const { DEFAULT_PATHS } = require('../../migrations/core/109_add_backup_paths');

let booted = false;

/**
 * Idempotently re-seed `backup_paths` with the canonical defaults.
 *
 * @param {object} db      knex instance
 * @param {object} logger  app logger (must expose .info / .warn)
 * @returns {Promise<{ seeded: string[] }>} paths newly inserted on this boot.
 */
async function seedBackupPathsAtBoot(db, logger) {
  const log = logger || { info: () => {}, warn: () => {} };
  if (booted) return { seeded: [] };

  if (!(await db.schema.hasTable('backup_paths'))) {
    log.warn('backup_paths table missing at boot — self-heal skipped (migration 109 may not have run yet)');
    return { seeded: [] };
  }

  // Diff: which canonical paths are missing from the table right now?
  // We can't easily get "what got inserted by onConflict.ignore" out of
  // knex on both backends, so we just compute the diff ourselves and log
  // it — admins benefit from seeing exactly what got auto-added when a
  // new feature ships.
  const existing = await db('backup_paths').select('path');
  const existingSet = new Set(existing.map((r) => r.path));
  const missing = DEFAULT_PATHS.filter((p) => !existingSet.has(p.path));

  if (missing.length === 0) {
    booted = true;
    return { seeded: [] };
  }

  try {
    await db('backup_paths')
      .insert(missing.map((row) => ({
        ...row,
        created_at: new Date(),
        updated_at: new Date(),
      })))
      .onConflict('path')
      .ignore();
    log.info(`backup_paths self-heal added ${missing.length} row(s): ${missing.map((m) => m.path).join(', ')}`);
  } catch (err) {
    log.warn(`backup_paths self-heal failed: ${err.message}`);
  }

  booted = true;
  return { seeded: missing.map((m) => m.path) };
}

// Test-only: reset the module-level boot flag so jest can re-exercise
// the seeder against a fresh test DB inside a single worker.
function _resetBootForTests() {
  booted = false;
}

module.exports = { seedBackupPathsAtBoot, _resetBootForTests };
