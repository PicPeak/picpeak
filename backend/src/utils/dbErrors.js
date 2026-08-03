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
  if (!err) return false;
  const message = String(err.message || '');

  // Postgres is authoritative via SQLSTATE: 42P01 undefined_table, 42703
  // undefined_column. Both are schema conditions, never transient.
  if (err.code === '42P01' || err.code === '42703') return true;

  // SQLite carries no SQLSTATE, so the driver's wording is all there is — but
  // it must be matched EXACTLY, naming the object the roles join needs. A
  // generic /does not exist/ test would be unsound here: knex prefixes the
  // failing SQL to err.message, and that SQL always names `roles` on this
  // join, so any "... does not exist" fault on the connection (e.g. pgbouncer
  // losing a named prepared statement, SQLSTATE 26000) would read as a missing
  // roles schema and fabricate super_admin.
  //
  // Two states are legitimate, per the migration order:
  //   pre-054           → roles table absent
  //   post-054, pre-057 → roles exists, admin_users.role_id not added yet
  return /no such table: roles\b/i.test(message)
    || /no such column: (roles\.|admin_users\.role_id\b)/i.test(message);
}

module.exports = { isUniqueViolation, isMissingRolesSchema };
