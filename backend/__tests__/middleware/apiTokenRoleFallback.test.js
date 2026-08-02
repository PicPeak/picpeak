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
});
