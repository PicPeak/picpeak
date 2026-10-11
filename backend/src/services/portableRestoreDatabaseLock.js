'use strict';

// Lock acquisition is DB-server terminal proof, not a worker heartbeat or a
// client socket promise. In particular, PostgreSQL may finish a sent COMMIT
// after the client dies. Recovery must wait for that transaction before it
// decides whether the matching commit marker exists.
const LOCK_CLASS = 0x50696350; // PicP
const LOCK_RESOURCE = 0x52657374; // Rest

async function acquireRestoreDatabaseLock(trx, { attemptId, epoch, states = ['restoring', 'recovery_required'] }) {
  if (!trx?.isTransaction) throw new Error('Portable recovery requires a database transaction');
  const pg = ['pg', 'postgres', 'postgresql'].includes(trx.client.config.client);
  if (pg) await trx.raw('SELECT pg_advisory_xact_lock(?, ?)', [LOCK_CLASS, LOCK_RESOURCE]);
  // UPDATE takes a real SQLite write lock (BEGIN alone is deferred). It also
  // validates the durable epoch on the SAME connection after the PG lock.
  // This does not advance a control revision or change business rows.
  const changed = await trx('portable_restore_control').where({ id: 1, attempt_id: attemptId, epoch })
    .whereIn('state', states).update({ revision: trx.raw('revision') });
  if (changed !== 1) throw Object.assign(new Error('Portable restore epoch is no longer fenced'), { code: 'RESTORE_EPOCH_CHANGED' });
}

async function acquireRestoreTableLocks(trx) {
  if (!trx?.isTransaction) throw new Error('Portable table barrier requires a database transaction');
  if (!['pg', 'postgres', 'postgresql'].includes(trx.client.config.client)) return [];
  // The control-row check has already issued a query. A REPEATABLE READ
  // snapshot from before this wait could still miss the eventual old rows.
  // Restore/recovery explicitly request READ COMMITTED; other callers fail
  // closed rather than confusing a table-lock grant with a fresh snapshot.
  const isolation = await trx.raw('SHOW transaction_isolation');
  if (isolation.rows[0]?.transaction_isolation !== 'read committed') {
    throw Object.assign(new Error('Portable table barrier requires READ COMMITTED isolation'), { code: 'RESTORE_ISOLATION_UNSUPPORTED' });
  }
  // Exporter exclusions are NOT a drain boundary. Ordinary transactions may
  // still hold locks on S3 read representations, media lifetime/queue state,
  // biometric tables, or bookkeeping after their runtime process has died.
  // Introspect every target public base table on this same held transaction.
  const rows = await trx('information_schema.tables').select('table_name')
    .where({ table_schema: 'public', table_type: 'BASE TABLE' });
  const tables = rows.map(row => row.table_name).sort();
  if (!tables.length) throw new Error('Portable table barrier found no target tables');
  // PostgreSQL owns these locks until COMMIT/ROLLBACK, even if this worker
  // dies. Existing INSERT/UPDATE/DELETE/SELECT table locks conflict, so an
  // old accepted transaction must finish before row replacement or file undo.
  // Identifiers are bound, never interpolated from table names. A stable
  // order avoids introducing different lock orders between restore workers.
  await trx.raw('LOCK TABLE ' + tables.map(() => '??.??').join(', ') + ' IN ACCESS EXCLUSIVE MODE',
    tables.flatMap(table => ['public', table]));
  return tables;
}

module.exports = { acquireRestoreDatabaseLock, acquireRestoreTableLocks, LOCK_CLASS, LOCK_RESOURCE };
