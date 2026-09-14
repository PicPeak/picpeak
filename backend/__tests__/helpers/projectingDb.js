/**
 * A knex-chain stand-in for `jest.mock('.../database/db')` that honours the
 * projection.
 *
 * The usual unit-test stub makes `select()` a no-op and resolves the whole
 * fixture row from `first()`, which cannot see a missing column in a
 * projection: the row always comes back complete. Two auth bugs shipped past
 * green suites exactly that way. PR 1434: sessionAccessService's roles-join
 * fallback dropped `must_change_password`, so adminAuth read undefined and let
 * a flagged admin through. PR 1436: apiTokenAuth's fallback selected
 * `role_id`, the very column whose absence sends it there.
 *
 * This chain closes both:
 *  - only the selected columns come back, so a dropped column reads undefined
 *    the way it does against a real driver (the PR 1434 shape);
 *  - the fixture row's keys ARE the schema, so selecting a column it lacks
 *    rejects with SQLite's own wording (the PR 1436 shape).
 *
 * Use it from inside a jest.mock factory, which may require() this file (any
 * fixture variable the factory reads must be `mock`-prefixed):
 *
 *   jest.mock('../../src/database/db', () => ({
 *     db: require('../helpers/projectingDb').projectingDb(({ table, joined }) => mockRow),
 *   }));
 *
 * The resolver receives `{ table, joined, columns }` and returns the fixture
 * row keyed by output name (the alias, for `x as y`), `null`/`undefined` for
 * no row, or an Error to reject the query with.
 */

// `roles.name as role_name` -> key `role_name`, reported as `roles.name`;
// `email` on admin_users -> key `email`, reported as `admin_users.email`.
function parseColumn(column, table) {
  const [expr, alias] = String(column).split(/\s+as\s+/i);
  const bare = expr.split('.').pop();
  return { key: alias || bare, name: expr.includes('.') ? expr : `${table}.${bare}` };
}

function project(row, columns, table) {
  if (columns.length === 0 || columns.includes('*')) return { ...row };
  const out = {};
  for (const column of columns) {
    const { key, name } = parseColumn(column, table);
    if (!(key in row)) {
      // Same text node-sqlite3 puts after knex's SQL prefix, so
      // isMissingRolesSchema() classifies it the way it would in production.
      throw Object.assign(new Error(`SQLITE_ERROR: no such column: ${name}`), { code: 'SQLITE_ERROR' });
    }
    out[key] = row[key];
  }
  return out;
}

function projectingDb(resolve) {
  return (table) => ({
    _joined: false,
    _columns: [],
    leftJoin() { this._joined = true; return this; },
    where() { return this; },
    select(...columns) { this._columns.push(...columns.flat()); return this; },
    update() { return Promise.resolve(1); },
    async first(...columns) {
      this.select(...columns);
      const row = await resolve({ table, joined: this._joined, columns: this._columns });
      if (row instanceof Error) throw row;
      return row == null ? undefined : project(row, this._columns, table);
    },
  });
}

module.exports = { projectingDb };
