/**
 * customerDocumentRescanService — hourly re-scan of pending customer
 * documents (#1444, plan slice 8; migration 242).
 *
 * A document stays `pending` when no scanner was registered at upload, or
 * the scanner was down, timed out or answered `pending`. Once a scanner is
 * registered this job gives each such row another scan and moves it to
 * `clean` or `rejected`.
 *
 * Multi-replica safe: each row is claimed with a conditional update on
 * scan_claimed_until (an epoch-ms lease), so two workers never scan the same
 * row, and the verdict is written only while the row is still `pending` —
 * an admin's manual decision in the meantime wins over the scan.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { scheduledTask } = require('./scheduledTask');
const { db, logActivity } = require('../database/db');
const logger = require('../utils/logger');
const { getStorage } = require('./storage');
const { getStoragePath } = require('../config/storage');
const { assertPathInside } = require('../utils/safePath');
const documentScanService = require('./documentScanService');
const customerDocumentsService = require('./customerDocumentsService');

// Long enough for a clamd timeout plus the copy out of S3.
const LEASE_MS = 10 * 60 * 1000;
const BATCH = 100;

const task = scheduledTask(runCustomerDocumentRescan, { schedule: '40 * * * *' });
function startCustomerDocumentRescan() { task.start(); }
const stopCustomerDocumentRescan = () => task.stop();

/** A local path for the stored bytes, and how to clean up after the scan. */
async function localCopy(row) {
  const storage = getStorage();
  const prefix = path.join(getStoragePath(), customerDocumentsService.STORAGE_PREFIX);
  if (storage.kind() === 'local') {
    return { file: assertPathInside(storage.resolveLocalPath(row.storage_key), [prefix]), cleanup: async () => {} };
  }
  const dir = path.join(getStoragePath(), 'temp', 'customer-documents');
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `rescan-${crypto.randomUUID()}.tmp`);
  await storage.getToFile(row.storage_key, file);
  return { file, cleanup: () => fs.promises.unlink(file).catch(() => {}) };
}

async function rescanRow(row, now) {
  const claimed = await db('customer_documents')
    .where({ id: row.id, status: 'pending' })
    .whereNull('deleted_at')
    .andWhere((q) => q.whereNull('scan_claimed_until').orWhere('scan_claimed_until', '<', now))
    .update({ scan_claimed_until: now + LEASE_MS });
  if (claimed !== 1) return null;

  let verdict = 'pending';
  let copy = null;
  try {
    copy = await localCopy(row);
    verdict = await documentScanService.scanFile(copy.file);
  } catch (err) {
    logger.warn('Could not re-scan a customer document', { documentId: row.id, error: err.message });
  } finally {
    if (copy) await copy.cleanup();
  }

  const stamp = new Date().toISOString();
  if (verdict === 'pending') {
    // Release the lease so the next run tries again.
    await db('customer_documents').where({ id: row.id }).update({ scan_claimed_until: null });
    return 'pending';
  }
  const update = verdict === 'clean'
    ? { status: 'clean', reviewed_at: stamp, scanned_at: stamp, scan_claimed_until: null, updated_at: stamp }
    : {
      status: 'rejected',
      reviewed_at: stamp,
      scanned_at: stamp,
      scan_claimed_until: null,
      review_note: 'The file did not pass the security check.',
      updated_at: stamp,
    };
  // Still pending: an admin who decided in the meantime wins.
  const written = await db('customer_documents').where({ id: row.id, status: 'pending' }).update(update);
  if (written !== 1) {
    await db('customer_documents').where({ id: row.id }).update({ scan_claimed_until: null });
    return null;
  }
  await logActivity(verdict === 'clean' ? 'customer_document_scan_cleared' : 'customer_document_scan_rejected',
    { documentId: row.id, customerId: row.customer_account_id }, row.event_id || null, { type: 'system', name: null });
  return verdict;
}

/** @returns {Promise<{ clean: number, rejected: number, pending: number }>} */
async function runCustomerDocumentRescan(now = Date.now()) {
  const result = { clean: 0, rejected: 0, pending: 0 };
  if (!documentScanService.hasScanner()) return result;
  const rows = await db('customer_documents')
    .where({ status: 'pending' })
    .whereNull('deleted_at')
    .whereNull('purged_at')
    .andWhere((q) => q.whereNull('scan_claimed_until').orWhere('scan_claimed_until', '<', now))
    .orderBy('id', 'asc')
    .limit(BATCH)
    .select('id', 'customer_account_id', 'event_id', 'storage_key');
  for (const row of rows) {
    const verdict = await rescanRow(row, now);
    if (verdict) result[verdict] += 1;
  }
  if (result.clean || result.rejected) {
    logger.info(`Customer documents: re-scan cleared ${result.clean}, rejected ${result.rejected}`);
  }
  return result;
}

module.exports = {
  startCustomerDocumentRescan,
  stopCustomerDocumentRescan,
  runCustomerDocumentRescan,
};
