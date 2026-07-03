/**
 * Boot-time self-heal for restore-meta settings.
 *
 * **Why this exists**
 *
 * `restore_allow_force` gates whether the Restore wizard accepts a
 * `force: true` payload. The flag exists to add admin friction
 * before letting a restore override safety warnings (e.g. "1 active
 * admin user — restoring would clobber the current install").
 *
 * In practice the friction lands at the worst possible moment: a
 * fresh install (no app_settings row yet OR `restore_allow_force =
 * false` by default) hits the wall on its very FIRST restore. The
 * admin is mid disaster-recovery, panicked, and gets:
 *
 *   "Force restore is not allowed by system settings"
 *
 * They then have to hand-craft SQL like
 *
 *   INSERT INTO app_settings (setting_key, setting_value, ...)
 *   VALUES ('restore_allow_force', 'true', 'restore', NOW())
 *   ON CONFLICT ... SET setting_value = 'true';
 *
 * before they can recover their data. This isn't security — the
 * admin who could run that SQL could also flip the setting via the
 * UI. It's just a sharp edge that bites every new install once.
 *
 * Cure: seed the default ON at boot via `INSERT ... ON CONFLICT
 * DO NOTHING`. New installs get force-allowed out of the box.
 * Existing installs that have explicitly set the row (true OR
 * false) are NOT overwritten — admin policy wins. Same pattern
 * `_backupPathsBoot.js` uses for the canonical backup_paths rows.
 *
 * **Default-ON rationale (matches Stage A's principle)**
 *
 * Stage A defaulted inline DB dumps to ON because the cost of
 * forgetting was data loss. By the same logic, `restore_allow_force`
 * defaults ON because the cost of forgetting is being unable to
 * recover from a disaster. Audit logging captures every forced
 * restore so the accountability story stays intact.
 *
 * If/when the broader "exclude restore-meta settings from being
 * overwritten by restore" follow-up lands (the second half of this
 * chicken-and-egg), this self-heal becomes the safety net for
 * fresh installs only — existing installs by that point have the
 * row preserved across restores.
 */

const SEEDS = [
  {
    setting_key: 'restore_allow_force',
    setting_value: 'true',
    setting_type: 'restore',
    rationale: 'Default ON so fresh installs can recover from disaster '
      + 'without a SQL incantation. Admins who want to require manual '
      + 'intervention can disable via the admin UI.',
  },
];

/**
 * Installs that ran migration 032 BEFORE the 2026-05-30 in-place edit
 * have a `restore_allow_force` row with the deprecated `false` default
 * (literal string `'false'` from `JSON.stringify(false)`). Per
 * [[feedback_self_heal_pattern]] knex won't re-run the corrected
 * migration on those installs, so we have to bump the row to `true`
 * here ONCE at boot.
 *
 * The bump is guarded by a tracking row `restore_allow_force_auto_upgraded`
 * so we don't fight an admin who explicitly disables force later:
 *   - Tracking row absent → bump if the value is the deprecated `'false'`
 *   - Tracking row present → never touch `restore_allow_force` again
 *
 * The bump applies ONLY when the existing value EXACTLY equals the old
 * migration default. Any other value (`'true'`, admin-set anything,
 * empty, null) is left alone — those reflect either the fixed
 * migration's output or a deliberate admin choice.
 */
const DEPRECATED_DEFAULT_VALUE = 'false';
const AUTO_UPGRADE_FLAG_KEY = 'restore_allow_force_auto_upgraded';

let booted = false;

/**
 * Seed the canonical restore-meta settings on fresh installs.
 *
 * @param {object} db      knex instance
 * @param {object} logger  app logger (must expose .info / .warn)
 * @returns {Promise<{ seeded: string[], upgraded: string[] }>}
 */
async function seedRestoreSettingsAtBoot(db, logger) {
  const log = logger || { info: () => {}, warn: () => {} };
  if (booted) return { seeded: [], upgraded: [] };

  if (!(await db.schema.hasTable('app_settings'))) {
    log.warn('app_settings table missing at boot — restore-settings self-heal skipped');
    return { seeded: [], upgraded: [] };
  }

  const seeded = [];
  const upgraded = [];

  // Step 1: fresh-install seeding. Insert rows that don't exist at all.
  for (const seed of SEEDS) {
    try {
      const existing = await db('app_settings')
        .where('setting_key', seed.setting_key)
        .first();
      if (existing) continue;

      await db('app_settings').insert({
        setting_key: seed.setting_key,
        setting_value: seed.setting_value,
        setting_type: seed.setting_type,
        updated_at: new Date(),
      });
      seeded.push(seed.setting_key);
      log.info(`Seeded restore-meta setting ${seed.setting_key}=${seed.setting_value}`);
    } catch (err) {
      log.warn(`Failed to seed restore-meta setting ${seed.setting_key}: ${err.message}`);
    }
  }

  // Step 2: one-time auto-upgrade for installs that ran the OLD
  // migration 032 (which seeded restore_allow_force='false'). Bump
  // to 'true' iff the value is still the deprecated default AND the
  // auto-upgrade tracking flag hasn't already been set.
  try {
    const guard = await db('app_settings')
      .where('setting_key', AUTO_UPGRADE_FLAG_KEY)
      .first();

    if (!guard) {
      const row = await db('app_settings')
        .where('setting_key', 'restore_allow_force')
        .first();

      if (row && row.setting_value === DEPRECATED_DEFAULT_VALUE) {
        await db('app_settings')
          .where('setting_key', 'restore_allow_force')
          .update({
            setting_value: 'true',
            updated_at: new Date(),
          });
        upgraded.push('restore_allow_force');
        log.info('Auto-upgraded restore_allow_force from deprecated migration-032 default \'false\' to \'true\' '
          + '(fresh-install disaster recovery now works without SQL incantation)');
      }

      // Always set the guard, even if no upgrade happened — prevents
      // the bump from firing later if an admin sets the value to
      // false on purpose.
      await db('app_settings').insert({
        setting_key: AUTO_UPGRADE_FLAG_KEY,
        setting_value: 'true',
        setting_type: 'restore',
        updated_at: new Date(),
      });
    }
  } catch (err) {
    log.warn(`restore_allow_force auto-upgrade failed: ${err.message}`);
  }

  booted = true;
  return { seeded, upgraded };
}

// Test-only: reset the module-level boot flag so jest can re-exercise
// the seeder against a fresh test DB inside a single worker.
function _resetBootForTests() {
  booted = false;
}

module.exports = { seedRestoreSettingsAtBoot, _resetBootForTests, SEEDS };
