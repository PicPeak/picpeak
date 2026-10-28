/**
 * Retire replaceable ready archives under the caller's event-row lock.
 * Pending recipients and queued (not yet sent) mail protect their archive.
 * Sent mail may point to an evicted cache entry; normal gallery access and
 * preparing the selection again remain available.
 * Eviction follows creation order, not last access: any viewer preparing a
 * new selection may replace another viewer's eligible ready archive.
 */
async function retireReadyJobs(trx, eventId, needed) {
  if (needed <= 0) return [];
  const jobs = await trx('download_jobs as j')
    .where({ 'j.event_id': eventId, 'j.status': 'ready' })
    .whereNotExists(trx('download_job_recipients as r').select(trx.raw('1'))
      .whereRaw('?? = ??', ['r.job_id', 'j.id']).whereNull('r.notified_at'))
    .whereNotExists(trx('email_queue as m').select(trx.raw('1'))
      .where({ 'm.event_id': eventId, 'm.email_type': 'download_ready', 'm.status': 'pending' })
      .whereRaw('CAST(?? AS TEXT) LIKE (\'%\' || ?? || \'%\')', ['m.email_data', 'j.token']))
    .orderBy('j.created_at', 'asc').orderBy('j.id', 'asc').limit(needed).select('j.*');
  if (jobs.length < needed) return null;
  // The failed rows remain tracked until storage deletion succeeds. Sweeping
  // can retry a failed delete, and notification requests must recheck status.
  const now = new Date().toISOString();
  await trx('download_jobs').whereIn('id', jobs.map((job) => job.id)).where({ status: 'ready' }).update({
    status: 'failed', error: 'This prepared download was replaced. Please request it again.',
    completed_at: now,
  });
  return jobs;
}

module.exports = { retireReadyJobs };
