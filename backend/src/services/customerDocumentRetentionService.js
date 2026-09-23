/**
 * customerDocumentRetentionService — retention sweep for customer documents
 * (#1444, migration 225).
 *
 * Runs hourly and drives two transitions, both measured against
 * `customer_documents_retention_days` (default 30):
 *
 *   1. A rejected document is deleted (soft) once it has been rejected for
 *      the retention period.
 *   2. The bytes of a deleted document are removed once it has been deleted
 *      for the retention period. The row stays, with purged_at set, as the
 *      record that the file existed.
 *
 * A contract-linked document is skipped by both: it is part of a contractual
 * record, and erasure already keeps such a document rather than destroying
 * it. Deleting one is refused while the link stands (#1444), so a row that
 * reaches the sweep still linked came from before that rule or from a direct
 * database edit — either way, purging its bytes is the silent destruction
 * the issue rules out.
 *
 * Every run also retries any purge whose claim (purge_claimed_at) survived a
 * crash between the claim and the delete, once that claim is stale (#1592,
 * migration 231) — see customerDocumentsService.retryStalePurgeClaims().
 *
 * Time comparisons run in JS: a timestamp written through knex is epoch
 * milliseconds on SQLite and a Date on Postgres (see utils/queueTimestamps).
 */

const { scheduledTask } = require('./scheduledTask');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { toMillis } = require('../utils/queueTimestamps');
const customerDocumentsService = require('./customerDocumentsService');

const DAY_MS = 24 * 60 * 60 * 1000;

const task = scheduledTask(runCustomerDocumentRetention, { schedule: '25 * * * *' });
function startCustomerDocumentRetention() { task.start(); }
const stopCustomerDocumentRetention = () => task.stop();

const isDue = (value, cutoff) => {
  const at = toMillis(value);
  return at !== null && at <= cutoff;
};

async function runCustomerDocumentRetention(now = Date.now()) {
  const days = await customerDocumentsService.getRetentionDays();
  const cutoff = now - days * DAY_MS;

  const rejected = await db('customer_documents')
    .where('status', 'rejected')
    .whereNull('deleted_at')
    .whereNull('contract_id')
    .select('id', 'reviewed_at');
  const expiredRejections = rejected.filter((r) => isDue(r.reviewed_at, cutoff)).map((r) => r.id);
  if (expiredRejections.length > 0) {
    const stamp = new Date(now).toISOString();
    // contract_id is asserted again here, not only in the select: a link
    // made between the two would otherwise have this soft-delete a
    // contract-linked document.
    await db('customer_documents').whereIn('id', expiredRejections)
      .whereNull('contract_id')
      .whereNull('deleted_at')
      .update({ deleted_at: stamp, updated_at: stamp });
    logger.info(`Customer documents: deleted ${expiredRejections.length} rejected file(s) after ${days} days`);
  }

  const deleted = await db('customer_documents')
    .whereNotNull('deleted_at')
    .whereNull('purged_at')
    .whereNull('contract_id')
    .select('id', 'storage_key', 'deleted_at');
  const due = deleted.filter((r) => isDue(r.deleted_at, cutoff));
  if (due.length > 0) {
    await customerDocumentsService.purgeFiles(due);
    logger.info(`Customer documents: removed the files of ${due.length} deleted document(s)`);
  }

  // A purge claimed by a process that then crashed before storage.delete()
  // ran leaves purge_claimed_at set with no matching purged_at forever,
  // invisible to the query above once it is claimed again -- this is what
  // retries it (#1592).
  await customerDocumentsService.retryStalePurgeClaims(now);
}

module.exports = {
  startCustomerDocumentRetention,
  stopCustomerDocumentRetention,
  runCustomerDocumentRetention,
};
