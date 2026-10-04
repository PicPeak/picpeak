const request = require('supertest');
const express = require('express');

// Unit-level contract of DELETE /clear-all with a stubbed knex: it selects the
// caller's bell rows and records a dismissal per row — it never deletes and
// never writes read_at. The owner-scope and real-database behaviour is in
// __tests__/routes/adminNotificationsScope.test.js.
jest.mock('../../database/db', () => {
  const rows = [{ id: 11 }, { id: 12 }, { id: 13 }];
  const ignoreMock = jest.fn().mockResolvedValue(undefined);
  const insertMock = jest.fn(() => ({ onConflict: () => ({ ignore: ignoreMock }) }));
  const chain = {
    select: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    transacting: jest.fn().mockReturnThis(),
    update: jest.fn().mockResolvedValue(0),
    delete: jest.fn().mockResolvedValue(0),
    del: jest.fn().mockResolvedValue(0),
    insert: insertMock,
  };
  // Awaiting the builder (the clear-all handler's terminal select) resolves
  // the bell rows; sub-queries passed to whereNotIn are never awaited.
  chain.then = (resolve) => resolve(rows);

  // toSQL() (not toNative()): knex placeholders stay `?` for db.raw.
  chain.toSQL = () => ({ sql: 'SELECT ? as admin_id, … FROM activity_logs …', bindings: [1, 'stamp'] });
  const dbMock = jest.fn(() => chain);
  // db.raw builds the select fragments (`? as admin_id`) and runs the
  // INSERT … SELECT; only the latter is awaited.
  const state = { insertError: null };
  const rawMock = jest.fn((sql) => {
    if (!/^INSERT/.test(sql)) return { sql };
    // The PostgreSQL branch: the statement's own rowCount is the answer.
    return state.insertError ? Promise.reject(state.insertError) : Promise.resolve({ rowCount: rows.length });
  });
  dbMock.client = { config: { client: 'pg' } };
  dbMock.raw = rawMock;
  dbMock.__rawMock = rawMock;
  dbMock.__state = state;
  dbMock.__chain = chain;
  dbMock.__insertMock = insertMock;
  dbMock.__ignoreMock = ignoreMock;
  dbMock.__rows = rows;
  return { db: dbMock };
});

jest.mock('../../middleware/auth', () => ({
  adminAuth: (req, _res, next) => { req.admin = { id: 1, roleName: 'super_admin' }; next(); },
}));

jest.mock('../../middleware/permissions', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));

const { db } = require('../../database/db');
const notificationsRouter = require('../adminNotifications');

describe('adminNotifications routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/admin/notifications', notificationsRouter);

  beforeEach(() => {
    jest.clearAllMocks();
    db.__state.insertError = null;
  });

  it('clears all notifications by dismissing them for the caller', async () => {
    const response = await request(app)
      .delete('/admin/notifications/clear-all')
      .expect(200);

    expect(db).toHaveBeenCalledWith('activity_logs');
    expect(db).toHaveBeenCalledWith('notification_dismissals');
    const insert = db.__rawMock.mock.calls.find(([sql]) => /^INSERT/.test(sql));
    expect(insert[0]).toMatch(/^INSERT INTO notification_dismissals \(admin_id, activity_log_id, dismissed_at\) SELECT/);
    expect(insert[0]).toMatch(/ON CONFLICT \(admin_id, activity_log_id\) DO NOTHING$/);
    expect(insert[1]).toEqual([1, 'stamp']);
    expect(db.__insertMock).not.toHaveBeenCalled();
    expect(db.__chain.delete).not.toHaveBeenCalled();
    expect(db.__chain.del).not.toHaveBeenCalled();
    expect(db.__chain.update).not.toHaveBeenCalled();
    expect(response.body).toEqual({
      message: 'All notifications cleared',
      deletedCount: 3,
    });
  });

  it('handles database errors when clearing notifications', async () => {
    db.__state.insertError = new Error('boom');

    const response = await request(app)
      .delete('/admin/notifications/clear-all')
      .expect(500);

    expect(response.body).toEqual({ error: 'Failed to clear notifications' });
  });
});
