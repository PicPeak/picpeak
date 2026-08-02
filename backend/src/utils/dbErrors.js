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

/**
 * Does this error mean the `roles` table/column genuinely isn't there yet
 * (mid-upgrade), as opposed to the database being briefly unhappy?
 *
 * The distinction matters because both auth paths fall back to granting
 * super_admin when the roles join fails: a catch-all would turn any transient
 * failure — connection reset, deadlock, statement timeout, pool exhaustion —
 * into a privilege escalation that hands a demoted viewer exactly the access
 * GHSA-9697 closes. Callers must rethrow anything this returns false for.
 */
function isMissingRolesSchema(err) {
  const message = String(err?.message || '');
  if (!/roles/i.test(message)) return false;
  // PG: 42P01 undefined_table / 42703 undefined_column. SQLite carries no
  // codes, so match its wording too.
  return err?.code === '42P01' || err?.code === '42703'
    || /no such table|no such column|does not exist|unknown column/i.test(message);
}

module.exports = { isUniqueViolation, isMissingRolesSchema };
