'use strict';

// The operator's way out of a restore fence nothing else can lift: the host
// that started the restore is gone, its storage was moved, or recovery keeps
// failing. Run by scripts/clear-portable-restore-fence.js with the backend
// stopped. It decides from the database commit marker alone whether the
// restore took effect, undoes a half-promoted file set if it did not, opens
// the control row and records what it did.
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const restorePaths = require('./portableRestorePaths');
const { getStoragePath } = require('../config/storage');

const CONTROL = 'portable_restore_control';
const INSTANCES = 'portable_restore_instances';

async function describe(db) {
  if (!(await db.schema.hasTable(CONTROL))) return null;
  return (await db(CONTROL).where({ id: 1 }).first()) || null;
}

// Runtimes whose kernel lease is provably held are still running. Clearing
// the fence under them would let them and the restored data diverge.
async function liveRuntimes(db, { leases = require('./linuxKernelLease') } = {}) {
  const live = [];
  for (const instance of await db(INSTANCES).select('instance_id', 'lease_json')) {
    try {
      const lease = JSON.parse(instance.lease_json);
      if ((await leases.probe(lease.path, lease)) === 'busy') live.push(instance.instance_id);
    } catch (_) { /* Unprovable is not live. */ }
  }
  return live;
}

async function clearFence({ db = require('../database/db').db, force = false, leases, actor = 'operator' } = {}) {
  const row = await describe(db);
  if (!row) return { cleared: false, state: 'absent' };
  if (row.state === 'open') {
    if (await restorePaths.readFence()) await restorePaths.writeFence({ fenced: false, generation: row.generation });
    return { cleared: false, state: 'open' };
  }
  const live = await liveRuntimes(db, { leases });
  if (live.length && !force) {
    throw Object.assign(new Error(`${live.length} backend process(es) still hold the restore fence. Stop the backend first, or pass --force.`), { code: 'RESTORE_FENCE_LIVE' });
  }
  const committed = row.attempt_id
    ? await db('portable_restore_commits').where({ attempt_id: row.attempt_id }).first() : null;
  let files = 'none';
  if (row.attempt_id && !committed) {
    // No commit marker: the database is the one from before the restore. Any
    // file the restore already moved into place goes back.
    const { PortableRestoreJournal } = require('./portableRestoreJournal');
    try {
      const journal = await PortableRestoreJournal.load({ storageRoot: getStoragePath(), id: row.attempt_id,
        validateKey: require('./picpeakImportService').importFilePathProblem });
      await journal.rollback();
      files = 'rolled_back';
    } catch (error) {
      if (error.code !== 'ENOENT') throw Object.assign(new Error(`The restore's file journal could not be rolled back: ${error.message}`), { code: 'RESTORE_JOURNAL_UNSAFE' });
    }
  }
  const outcome = committed ? 'committed' : 'rolled_back';
  const generation = row.generation + (row.state === 'restart_required' ? 0 : 1);
  await db.transaction(async trx => {
    await trx(CONTROL).where({ id: 1 }).update({ state: 'open', owner_instance_id: null, generation, revision: row.revision + 1,
      result_json: JSON.stringify({ outcome, clearedBy: actor,
        error: committed ? null : { code: 'RESTORE_FENCE_CLEARED', statusCode: 500, message: 'The interrupted restore was rolled back by the operator' } }),
      updated_at: trx.fn.now() });
    await trx(INSTANCES).del();
  });
  // A higher generation tells every process that was running to restart.
  try { await restorePaths.writeFence({ fenced: false, generation }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (row.attempt_id) await restorePaths.cleanAttempt(row.attempt_id, { committed: Boolean(committed) }).catch(() => {});
  const runtime = path.join(getStoragePath(), restorePaths.MAINTENANCE, 'runtime');
  for (const name of await fs.promises.readdir(runtime).catch(() => [])) await fs.promises.unlink(path.join(runtime, name)).catch(() => {});
  const detail = { previousState: row.state, attemptId: row.attempt_id, outcome, files, forced: Boolean(force && live.length) };
  logger.warn('Portable restore fence cleared by the operator', detail);
  try { await require('../database/db').logActivity('portable_restore_fence_cleared', detail, null, { type: 'system', name: actor }); }
  catch (_) { /* The log line above is the record where the activity table is unavailable. */ }
  return { cleared: true, state: row.state, outcome, files };
}

module.exports = { clearFence, describe, liveRuntimes };
