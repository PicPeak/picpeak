/**
 * Migration 151: admin MFA (TOTP) enrollment support — issue #738.
 *
 * The `admin_users.two_factor_enabled` / `two_factor_secret` columns already
 * exist from the legacy migration 016 but were never wired to any code. This
 * migration adds the two columns the real TOTP flow needs on top of them:
 *
 *   - two_factor_recovery_codes: JSON array of one-time backup codes, stored
 *     HASHED (never plaintext), so a locked-out admin can log in without the
 *     authenticator. Consumed on use.
 *   - two_factor_enrolled_at: when the admin completed enrollment (audit /
 *     display only).
 *
 * The TOTP secret itself continues to live in the existing `two_factor_secret`
 * column, but is now stored ENCRYPTED at rest (AES-256-GCM) by mfaService —
 * the column type is unchanged (the encrypted blob is short).
 *
 * Additive and idempotent: only adds columns, guarded by hasColumn, so it is
 * safe to re-run and touches no existing data.
 */
exports.up = async function (knex) {
  const hasRecovery = await knex.schema.hasColumn('admin_users', 'two_factor_recovery_codes');
  const hasEnrolledAt = await knex.schema.hasColumn('admin_users', 'two_factor_enrolled_at');
  const hasEnabled = await knex.schema.hasColumn('admin_users', 'two_factor_enabled');
  const hasSecret = await knex.schema.hasColumn('admin_users', 'two_factor_secret');

  await knex.schema.alterTable('admin_users', (t) => {
    // Backfill the legacy columns too, in case an install somehow lacks them
    // (016 is a legacy migration; guard defensively).
    if (!hasEnabled) {
      t.boolean('two_factor_enabled').defaultTo(false);
    }
    if (!hasSecret) {
      t.string('two_factor_secret').nullable();
    }
    if (!hasRecovery) {
      t.text('two_factor_recovery_codes').nullable();
    }
    if (!hasEnrolledAt) {
      t.timestamp('two_factor_enrolled_at').nullable();
    }
  });
};

exports.down = async function (knex) {
  const hasRecovery = await knex.schema.hasColumn('admin_users', 'two_factor_recovery_codes');
  const hasEnrolledAt = await knex.schema.hasColumn('admin_users', 'two_factor_enrolled_at');

  await knex.schema.alterTable('admin_users', (t) => {
    // Only drop what THIS migration added; leave the legacy 016 columns.
    if (hasRecovery) {
      t.dropColumn('two_factor_recovery_codes');
    }
    if (hasEnrolledAt) {
      t.dropColumn('two_factor_enrolled_at');
    }
  });
};
