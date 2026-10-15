// The archive records a portable import writes back (see exportArchiveRecords
// in archiveService.js). Kept apart from archiveService so the restore worker,
// whose process runs without WebAssembly, loads only this and knex, not the
// service's mail, storage and HTTP dependencies.

// The maintenance_jobs row that claims a gallery's archive.
const archiveJobName = (eventId) => `event_archive:${eventId}`;

// An archive zip as this service names them: a direct child of
// events/archived. Records from a portable archive are checked against it,
// as anyone holding the file can edit them.
const isZipKey = (key) => typeof key === 'string' && /^events\/archived\/[^/\\]+\.zip$/.test(key);

const isExpiryAttempt = (attempt) => Boolean(attempt) && typeof attempt === 'object'
  && Number.isSafeInteger(attempt.attempts) && attempt.attempts > 0
  && typeof attempt.at === 'string' && attempt.at.length <= 64
  // The expiry it was made for, epoch ms (null when unreadable, as NaN
  // serialises).
  && (attempt.expiresAt === null || Number.isFinite(attempt.expiresAt));

/**
 * Write the records of a portable import (exportArchiveRecords), inside the
 * import's transaction. The target's own records go first: the import
 * replaces every gallery, so they name zips of galleries that are gone, under
 * ids the imported galleries now hold, and an expiry retry recorded for one of
 * them would be run against the imported gallery. Records for a gallery the
 * import does not carry are dropped.
 */
async function importArchiveRecords(trx, records) {
  await trx('maintenance_jobs')
    .where('job_name', 'like', `${archiveJobName('')}%`)
    .whereNotNull('last_result')
    .update({ last_result: null });
  if (!records || typeof records !== 'object' || Array.isArray(records)) return 0;
  let written = 0;
  for (const [id, record] of Object.entries(records)) {
    const eventId = Number(id);
    if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(eventId)) continue;
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const state = {};
    const superseded = Array.isArray(record.superseded) ? [...new Set(record.superseded.filter(isZipKey))] : [];
    if (superseded.length) state.superseded = superseded;
    if (isExpiryAttempt(record.expiry)) {
      state.expiry = { attempts: record.expiry.attempts, at: record.expiry.at, expiresAt: record.expiry.expiresAt };
    }
    if (!Object.keys(state).length) continue;
    if (!(await trx('events').where('id', eventId).first('id'))) continue;
    const jobName = archiveJobName(eventId);
    const lastResult = JSON.stringify(state);
    const updated = await trx('maintenance_jobs').where({ job_name: jobName }).update({ last_result: lastResult });
    if (!updated) await trx('maintenance_jobs').insert({ job_name: jobName, is_running: false, last_result: lastResult });
    written += 1;
  }
  return written;
}

module.exports = { archiveJobName, isZipKey, isExpiryAttempt, importArchiveRecords };
