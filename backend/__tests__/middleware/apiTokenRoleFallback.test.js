/**
 * The roles-join fallback in apiTokenAuth grants `super_admin` (upgrade-path
 * parity with adminAuth). It must therefore fire ONLY when the roles schema is
 * genuinely absent — a catch-all turns any transient database failure into a
 * privilege escalation that reopens GHSA-9697 for a demoted token owner.
 */

const { isMissingRolesSchema } = require('../../src/middleware/apiTokenAuth');

describe('apiTokenAuth roles-schema fallback predicate (GHSA-9697)', () => {
  it('accepts a genuinely missing roles table on both engines', () => {
    expect(isMissingRolesSchema(new Error('SQLITE_ERROR: no such table: roles'))).toBe(true);
    expect(isMissingRolesSchema(
      Object.assign(new Error('relation "roles" does not exist'), { code: '42P01' }),
    )).toBe(true);
    expect(isMissingRolesSchema(
      Object.assign(new Error('column roles.name does not exist'), { code: '42703' }),
    )).toBe(true);
  });

  it('rejects transient failures that must not elevate the caller', () => {
    expect(isMissingRolesSchema(new Error('Connection terminated unexpectedly'))).toBe(false);
    expect(isMissingRolesSchema(new Error('deadlock detected'))).toBe(false);
    expect(isMissingRolesSchema(new Error('Knex: Timeout acquiring a connection'))).toBe(false);
    expect(isMissingRolesSchema(new Error('canceling statement due to statement timeout'))).toBe(false);
    expect(isMissingRolesSchema(undefined)).toBe(false);
  });

  it('rejects a missing-table error for an unrelated table', () => {
    expect(isMissingRolesSchema(new Error('SQLITE_ERROR: no such table: api_tokens'))).toBe(false);
  });

  // knex prefixes the failing SQL to err.message, and that SQL always names
  // `roles` on this join — so the message substring proves nothing about the
  // error, and only an exact driver phrase (or a SQLSTATE) may be trusted.
  // These are real knex message shapes, captured from the actual query.
  describe('with knex\'s SQL prefix on the message (#968)', () => {
    const withSql = (driverMessage) => new Error(
      'select `roles`.`name` as `role_name` from `admin_users` '
      + 'left join `roles` on `roles`.`id` = `admin_users`.`role_id` '
      + `where \`admin_users\`.\`id\` = 1 limit 1 - ${driverMessage}`,
    );

    it('accepts both legitimate upgrade-window states', () => {
      // pre-054: the roles table does not exist yet
      expect(isMissingRolesSchema(
        Object.assign(withSql('SQLITE_ERROR: no such table: roles'), { code: 'SQLITE_ERROR' }),
      )).toBe(true);
      // post-054, pre-057: roles exists, admin_users.role_id not added yet
      expect(isMissingRolesSchema(
        Object.assign(withSql('SQLITE_ERROR: no such column: admin_users.role_id'), { code: 'SQLITE_ERROR' }),
      )).toBe(true);
    });

    it('rejects an unrelated "does not exist" fault despite the SQL naming roles', () => {
      // pgbouncer transaction pooling loses a named prepared statement
      // (SQLSTATE 26000). Transient — the fallback query would succeed on a
      // fresh connection, so accepting this would fabricate super_admin.
      expect(isMissingRolesSchema(
        Object.assign(withSql('prepared statement "S_1" does not exist'), { code: '26000' }),
      )).toBe(false);
      // The DB role/user, not the roles table.
      expect(isMissingRolesSchema(
        Object.assign(withSql('role "picpeak" does not exist'), { code: '28000' }),
      )).toBe(false);
      expect(isMissingRolesSchema(
        Object.assign(withSql('database "picpeak" does not exist'), { code: '3D000' }),
      )).toBe(false);
      expect(isMissingRolesSchema(withSql('Connection terminated unexpectedly'))).toBe(false);
    });
  });
});
