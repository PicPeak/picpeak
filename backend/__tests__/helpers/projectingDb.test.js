/**
 * Contract for the projection-honouring db stub the auth suites share. If this
 * drifts back towards "select() is a no-op", those suites go blind to a dropped
 * column again without a single one of them failing.
 */

const { projectingDb } = require('./projectingDb');
const { isMissingRolesSchema } = require('../../src/utils/dbErrors');

describe('projectingDb', () => {
  const row = { id: 1, username: 'owner', password_changed_at: null, role_name: 'editor' };

  it('returns only the selected columns, keyed by alias or bare name', async () => {
    const db = projectingDb(() => row);

    await expect(db('admin_users').select('admin_users.id', 'roles.name as role_name').first())
      .resolves.toEqual({ id: 1, role_name: 'editor' });
    await expect(db('admin_users').select(['id']).first('username'))
      .resolves.toEqual({ id: 1, username: 'owner' });
  });

  it('keeps a selected null column rather than dropping it', async () => {
    const db = projectingDb(() => row);

    await expect(db('admin_users').select('password_changed_at').first())
      .resolves.toEqual({ password_changed_at: null });
  });

  it('returns the whole row when nothing, or *, is selected', async () => {
    const db = projectingDb(() => row);

    await expect(db('admin_users').where({ id: 1 }).first()).resolves.toEqual(row);
    await expect(db('events').select('*').first()).resolves.toEqual(row);
  });

  it('rejects a column the fixture lacks with the SQLite driver wording', async () => {
    const db = projectingDb(() => row);

    const bare = await db('admin_users').select('id', 'role_id').first().catch((e) => e);
    expect(bare.code).toBe('SQLITE_ERROR');
    expect(bare.message).toBe('SQLITE_ERROR: no such column: admin_users.role_id');
    // The roles fallbacks key on this exact wording.
    expect(isMissingRolesSchema(bare)).toBe(true);

    const qualified = await db('admin_users').select('roles.display_name as role_display_name').first()
      .catch((e) => e);
    expect(qualified.message).toBe('SQLITE_ERROR: no such column: roles.display_name');
  });

  it('hands the resolver the query shape and relays no-row and errors', async () => {
    const resolve = jest.fn(({ joined }) => (joined ? new Error('SQLITE_ERROR: no such table: roles') : null));
    const db = projectingDb(resolve);

    await expect(db('admin_users').where({ id: 1 }).select('id').first()).resolves.toBeUndefined();
    expect(resolve).toHaveBeenLastCalledWith({ table: 'admin_users', joined: false, columns: ['id'] });

    await expect(db('admin_users').leftJoin('roles', 'roles.id', 'admin_users.role_id').first())
      .rejects.toThrow('no such table: roles');
    expect(resolve).toHaveBeenLastCalledWith({ table: 'admin_users', joined: true, columns: [] });
  });
});
