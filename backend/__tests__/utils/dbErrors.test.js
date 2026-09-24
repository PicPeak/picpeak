const { isUniqueViolation, isMissingRolesSchema } = require('../../src/utils/dbErrors');

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

describe('isMissingRolesSchema on Postgres (audit L1)', () => {
  const pg = (code, message) => Object.assign(new Error(message), { code });

  it('accepts the roles table being absent on the SQLSTATE alone', () => {
    expect(isMissingRolesSchema(pg('42P01', 'relation "roles" does not exist'))).toBe(true);
  });

  it('accepts a missing column only when it is one the roles join needs', () => {
    expect(isMissingRolesSchema(pg('42703', 'column admin_users.role_id does not exist'))).toBe(true);
    expect(isMissingRolesSchema(pg('42703', 'column roles.name does not exist'))).toBe(true);
  });

  it('rejects a missing column the join merely projects, so it cannot fabricate super_admin', () => {
    // A column added to the projection later than the install's schema: a
    // broken query on a half-migrated install, not a pre-roles one.
    expect(isMissingRolesSchema(pg('42703', 'column admin_users.avatar_url does not exist'))).toBe(false);
    expect(isMissingRolesSchema(pg('42703', 'column "must_change_password" does not exist'))).toBe(false);
    expect(isMissingRolesSchema(pg('42703', 'column "x" does not exist'))).toBe(false);
  });
});
