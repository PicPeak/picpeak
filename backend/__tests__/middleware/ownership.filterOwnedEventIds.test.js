/**
 * Regression test for the bulk archive/delete ownership bypass.
 *
 * bulk-archive and bulk-delete acted on body-supplied event ids with no
 * ownership filter, so an admin/editor scoped to their own events (the
 * single-event routes enforce requireEventOwnership) could archive or
 * cascade-delete ANY event by id. filterOwnedEventIds is the helper those
 * routes now use to drop foreign/non-existent ids.
 */

// events owned by admin 7; event 3 owned by someone else; event 4 is
// ownerless (legacy). The mock models:
//   whereIn('id', ids).andWhere(created_by IS NULL OR created_by = admin.id)
const EVENTS = [
  { id: 1, created_by: 7 },
  { id: 2, created_by: 7 },
  { id: 3, created_by: 99 },   // foreign
  { id: 4, created_by: null }, // ownerless/legacy
];

jest.mock('../../src/database/db', () => ({
  db: () => {
    const q = {
      _ids: null,
      _adminId: null,
      whereIn(_col, ids) { this._ids = ids; return this; },
      andWhere(cb) {
        // Emulate the (created_by IS NULL OR created_by = admin.id) builder
        // by capturing the admin id the callback closes over via a probe.
        const probe = {
          _adminId: null,
          whereNull() { return this; },
          orWhere(_col, id) { this._adminId = id; return this; },
        };
        cb(probe);
        this._adminId = probe._adminId;
        return this;
      },
      select() {
        return Promise.resolve(
          EVENTS
            .filter((e) => this._ids.includes(e.id))
            .filter((e) => e.created_by === null || e.created_by === this._adminId)
            .map((e) => ({ id: e.id }))
        );
      },
    };
    return q;
  },
}));

const { filterOwnedEventIds } = require('../../src/middleware/ownership');

describe('filterOwnedEventIds', () => {
  it('super_admin gets every id, nothing denied', async () => {
    const { allowed, denied } = await filterOwnedEventIds(
      { id: 7, roleName: 'super_admin' }, [1, 3, 4, 999]
    );
    expect(allowed).toEqual([1, 3, 4, 999]);
    expect(denied).toEqual([]);
  });

  it('non-super_admin keeps owned + ownerless, denies foreign and non-existent', async () => {
    const { allowed, denied } = await filterOwnedEventIds(
      { id: 7, roleName: 'admin' }, [1, 2, 3, 4, 999]
    );
    expect(allowed.sort()).toEqual([1, 2, 4]);   // owns 1,2; 4 is ownerless
    expect(denied.sort()).toEqual([3, 999]);      // 3 foreign, 999 missing
  });

  it('foreign-only request yields empty allowed', async () => {
    const { allowed, denied } = await filterOwnedEventIds(
      { id: 7, roleName: 'editor' }, [3]
    );
    expect(allowed).toEqual([]);
    expect(denied).toEqual([3]);
  });
});
