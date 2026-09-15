/**
 * documentScanService — the scan step for customer documents (#1444).
 *
 * No scanner ships today. scanFile() reports `pending`, so every customer
 * upload stays unavailable until an admin marks it clean or rejects it
 * (decision #24b). A ClamAV sidecar (clamd over TCP) plugs in here later by
 * registering a scanner at boot:
 *
 *   documentScanService.registerScanner(async (localPath) => 'clean' | 'rejected' | 'pending');
 *
 * A scanner that throws, or answers anything else, leaves the file pending:
 * a failed scan never makes a file available.
 */

const logger = require('../utils/logger');

let scanner = null;

function registerScanner(fn) {
  scanner = typeof fn === 'function' ? fn : null;
}

function hasScanner() {
  return scanner !== null;
}

/**
 * @param {string} localPath  the uploaded file, still in its temp location
 * @returns {Promise<'pending'|'clean'|'rejected'>}
 */
async function scanFile(localPath) {
  if (!scanner) return 'pending';
  try {
    const verdict = await scanner(localPath);
    return verdict === 'clean' || verdict === 'rejected' ? verdict : 'pending';
  } catch (err) {
    logger.warn('Document scan failed; the file stays pending', { error: err.message });
    return 'pending';
  }
}

module.exports = { registerScanner, hasScanner, scanFile };
