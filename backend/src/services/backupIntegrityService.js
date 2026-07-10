/**
 * Backup-integrity verifier — walks every CRM document-artefact path
 * column and confirms (a) the file exists on disk, (b) when a SHA-256
 * is stored, the file's actual bytes hash to the stored value.
 *
 * **Why this is a separate service**
 *
 * The audit trail captured at issue / sign time (signed_customer_ip,
 * signed_by_customer_at, signed_pdf_sha256, signed_*_signature_path,
 * issue_date, etc.) is worth exactly nothing on its own — what makes
 * it legally meaningful is being able to produce the document the
 * audit trail refers to. A backup that captures the DB but skips
 * `storage/business-docs/` (the bug fixed in this same PR) leaves
 * every `*_path` column a broken FK and every `*_sha256` column with
 * nothing to verify against. This service is the diagnostic for
 * exactly that drift — runs on demand, surfaces missing files +
 * hash mismatches without making any changes.
 *
 * **Verification modes**
 *
 *   - existence — file at `*_path` must exist on disk
 *   - sha256    — file at `*_path` must exist AND its sha256 must
 *                 equal `*_sha256` column (when that column is set)
 *
 * Per-table coverage (lines reference migrations/core/107_crm_consolidated.js):
 *
 *   quotes.pdf_path                            line 844   (existence)
 *   contracts.pdf_path                         line 1245  (existence + sha256 via contracts.pdf_sha256)
 *   contracts.signed_pdf_path                  line 1246  (existence + sha256 via contracts.signed_pdf_sha256)
 *   contracts.signed_customer_signature_path   line 1269  (existence — drawn signatures, no hash column)
 *   contracts.signed_admin_signature_path      line 1273  (existence — admin counter-signature drawing)
 *   invoices.pdf_path                          line 1026  (existence)
 *   invoices.imported_pdf_path                 line 1020  (existence — admin-uploaded scans)
 *
 * Wet uploads (`contracts.signed_pdf_is_wet_upload = true`) DO have a
 * `signed_pdf_sha256` computed at upload time (contractService.js
 * upload route), so they're hash-verified the same as system-rendered
 * contracts — no special case here.
 *
 * **What this service does NOT do**
 *
 *   - Does not write anything (no DB mutations, no fs touches)
 *   - Does not fail the request when a mismatch is found — the
 *     report shape carries the data, the caller decides what to do
 *   - Does not auto-trigger after restore (D2 decision: surface a
 *     CTA on the restore-completed screen instead)
 *   - Does not run on a schedule (D1 decision: on-demand v1; revisit
 *     once we have runtime data on large installs)
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { db } = require('../database/db');
const logger = require('../utils/logger');

const STORAGE_ROOT = () => process.env.STORAGE_PATH || path.join(process.cwd(), 'storage');

/**
 * Every column the verifier walks, declared once so the test suite
 * and the service share a single source of truth. Order is the order
 * the report lists rows in — table-major, then column-by-column.
 */
const CHECKS = [
  { table: 'quotes',    pathColumn: 'pdf_path',                       shaColumn: null,                  scope: 'quote' },
  { table: 'contracts', pathColumn: 'pdf_path',                       shaColumn: 'pdf_sha256',          scope: 'contract' },
  { table: 'contracts', pathColumn: 'signed_pdf_path',                shaColumn: 'signed_pdf_sha256',   scope: 'contract' },
  { table: 'contracts', pathColumn: 'signed_customer_signature_path', shaColumn: null,                  scope: 'contract-signature' },
  { table: 'contracts', pathColumn: 'signed_admin_signature_path',    shaColumn: null,                  scope: 'contract-signature' },
  { table: 'invoices',  pathColumn: 'pdf_path',                       shaColumn: null,                  scope: 'invoice' },
  { table: 'invoices',  pathColumn: 'imported_pdf_path',              shaColumn: null,                  scope: 'invoice' },
];

/** Stream-hash a file to sha256 hex without buffering the whole thing. */
function hashFile(absPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absPath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * @param {object} [options]
 * @param {string[]} [options.scope]  Filter checks by scope tag:
 *   'quote' | 'contract' | 'contract-signature' | 'invoice'.
 *   Defaults to all four (full scan).
 * @returns {Promise<{
 *   scannedAt: string,
 *   scopes: string[],
 *   summary: {
 *     totalRows: number,
 *     verifiedOk: number,
 *     missingFiles: number,
 *     hashMismatches: number,
 *     existsButNoHash: number,
 *   },
 *   missing: Array<{ table, rowId, column, expectedPath }>,
 *   hashMismatches: Array<{ table, rowId, column, expectedPath, expectedSha, actualSha }>,
 *   existsButNoHash: Array<{ table, rowId, column, path }>,
 * }>}
 *
 * `existsButNoHash` is the existence-only-verified bucket — the file
 * was found but no `*_sha256` column exists for it (quote/invoice PDFs,
 * signature PNGs). Surfaced separately so admins can distinguish
 * "verified by hash" from "verified by existence only" — the latter
 * is weaker evidence in a legal dispute.
 */
async function verifyDocumentArtefacts(options = {}) {
  const scopes = Array.isArray(options.scope) && options.scope.length > 0
    ? options.scope.slice()
    : Array.from(new Set(CHECKS.map((c) => c.scope)));

  const checksToRun = CHECKS.filter((c) => scopes.includes(c.scope));
  const storageRoot = STORAGE_ROOT();

  const missing = [];
  const hashMismatches = [];
  const existsButNoHash = [];
  let totalRows = 0;
  let verifiedOk = 0;

  for (const check of checksToRun) {
    // Skip the check cleanly when the column or table doesn't exist
    // on this install — keeps the verifier safe to run on partial
    // migrations or installs that have features disabled.
    if (!(await db.schema.hasTable(check.table))) continue;
    if (!(await db.schema.hasColumn(check.table, check.pathColumn))) continue;

    const select = ['id', check.pathColumn];
    const hasHashColumn = check.shaColumn
      && (await db.schema.hasColumn(check.table, check.shaColumn));
    if (hasHashColumn) select.push(check.shaColumn);

    const rows = await db(check.table)
      .whereNotNull(check.pathColumn)
      .select(...select);

    for (const row of rows) {
      totalRows += 1;
      const storedPath = row[check.pathColumn];
      // Stored paths can be absolute (older rows) or relative-to-
      // storage (newer rows). Normalize: resolve relative paths
      // against STORAGE_PATH; absolute paths are used verbatim.
      const absPath = path.isAbsolute(storedPath)
        ? storedPath
        : path.join(storageRoot, storedPath);

      let exists = false;
      try {
        exists = fs.existsSync(absPath);
      } catch (_) { exists = false; }

      if (!exists) {
        missing.push({
          table: check.table,
          rowId: row.id,
          column: check.pathColumn,
          expectedPath: storedPath,
        });
        continue;
      }

      const expectedSha = hasHashColumn ? row[check.shaColumn] : null;
      if (!expectedSha) {
        // File exists but we have no hash to verify it against.
        existsButNoHash.push({
          table: check.table,
          rowId: row.id,
          column: check.pathColumn,
          path: storedPath,
        });
        continue;
      }

      let actualSha;
      try {
        actualSha = await hashFile(absPath);
      } catch (err) {
        logger.warn(`backupIntegrity: failed to hash ${absPath}: ${err.message}`);
        missing.push({
          table: check.table,
          rowId: row.id,
          column: check.pathColumn,
          expectedPath: storedPath,
        });
        continue;
      }

      if (actualSha !== expectedSha) {
        hashMismatches.push({
          table: check.table,
          rowId: row.id,
          column: check.pathColumn,
          expectedPath: storedPath,
          expectedSha,
          actualSha,
        });
        continue;
      }

      verifiedOk += 1;
    }
  }

  return {
    scannedAt: new Date().toISOString(),
    scopes,
    summary: {
      totalRows,
      verifiedOk,
      missingFiles: missing.length,
      hashMismatches: hashMismatches.length,
      existsButNoHash: existsButNoHash.length,
    },
    missing,
    hashMismatches,
    existsButNoHash,
  };
}

module.exports = {
  verifyDocumentArtefacts,
  // Exported for tests; not part of the route API.
  _internal: { CHECKS, hashFile },
};
