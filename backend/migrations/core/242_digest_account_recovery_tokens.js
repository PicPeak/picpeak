/**
 * Remove raw account-recovery capabilities from backup-eligible tables.
 *
 * The reusable hardening pass also runs after portable imports, whose data can
 * predate this migration while the target's migration ledger stays current.
 * Database guards fail old-replica writes closed during rolling upgrades.
 * This is a forward-only boundary: deploy the new backend to every replica
 * promptly. A recovery action attempted on an old replica can fail after its
 * credential change and must be retried on a new replica.
 */
const {
  ensureAccountRecoveryDigestColumns,
  hardenAccountRecoveryStorage,
  installAccountRecoveryWriteGuards,
} = require('../../src/services/accountRecoveryStorageHardening');

exports.up = async function up(knex) {
  await ensureAccountRecoveryDigestColumns(knex);
  await hardenAccountRecoveryStorage(knex);
  await installAccountRecoveryWriteGuards(knex);
};

// Token invalidation, credential rotation and write guards are irreversible.
exports.down = async function down() {};
