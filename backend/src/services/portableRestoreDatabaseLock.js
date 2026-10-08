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

module.exports = { acquireRestoreDatabaseLock, LOCK_CLASS, LOCK_RESOURCE };
