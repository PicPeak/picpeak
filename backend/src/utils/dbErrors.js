/**
 * Cross-driver detector for a unique-constraint violation. The error shape
 * varies by driver: Postgres → SQLSTATE `23505`; better-sqlite3 →
 * "UNIQUE constraint failed"; node-sqlite3 → `SQLITE_CONSTRAINT`. Used by the
 * claim-then-work concurrency patterns (document_sequences, monthly-draft, the
 * IMAP intake claim) to converge cleanly when a concurrent writer wins the race.
 */
function isUniqueViolation(err) {
  if (!err) return false;
  if (err.code === '23505' || err.code === 'SQLITE_CONSTRAINT') return true;
  const msg = String(err.message || '');
  return /unique/i.test(msg) || /sqlite_constraint/i.test(msg);
}

module.exports = { isUniqueViolation };
