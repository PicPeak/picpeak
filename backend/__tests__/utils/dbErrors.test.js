const { isUniqueViolation } = require('../../src/utils/dbErrors');

describe('isUniqueViolation (PR #622 blocker 2 race-safety detector)', () => {
  it('true for Postgres SQLSTATE 23505', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });
  it('true for node-sqlite3 SQLITE_CONSTRAINT code', () => {
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT' })).toBe(true);
  });
  it('true for a better-sqlite3 "UNIQUE constraint failed" message', () => {
    expect(isUniqueViolation({ message: 'UNIQUE constraint failed: received_emails.message_id' })).toBe(true);
  });
  it('false for unrelated errors and nullish', () => {
    expect(isUniqueViolation({ code: '23503' })).toBe(false); // FK violation
    expect(isUniqueViolation({ message: 'connection refused' })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});
