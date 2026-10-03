const request = require('supertest');
const express = require('express');

jest.mock('../../database/db', () => {
  // clear-all marks the caller's visible rows read (it never deletes
  // activity_logs any more); the terminal call is update().
  const updateMock = jest.fn().mockResolvedValue(5);
  const chain = {
    select: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    whereNotNull: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    update: updateMock,
    delete: jest.fn().mockResolvedValue(0),
    count: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue({ count: 0 }),
  };

  const dbMock = jest.fn(() => chain);
  dbMock.raw = jest.fn();
  dbMock.__chain = chain;
  dbMock.__updateMock = updateMock;
  return { db: dbMock };
});

jest.mock('../../middleware/auth', () => ({
  adminAuth: (req, _res, next) => { req.admin = { id: 1, roleName: 'super_admin' }; next(); },
}));

// requirePermission is its own module — without this mock the real
// implementation runs, queries role_permissions on the mocked db, and
// 403s before we ever reach the handler.
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
  });

  it('clears all notifications', async () => {
    db.__updateMock.mockResolvedValueOnce(8);

    const response = await request(app)
      .delete('/admin/notifications/clear-all')
      .expect(200);

    expect(db).toHaveBeenCalledWith('activity_logs');
    expect(db.__updateMock).toHaveBeenCalledTimes(1);
    expect(db.__chain.delete).not.toHaveBeenCalled();
    expect(db.__updateMock.mock.calls[0][0]).toHaveProperty('read_at');
    expect(response.body).toEqual({
      message: 'All notifications cleared',
      deletedCount: 8,
    });
  });

  it('handles database errors when clearing notifications', async () => {
    db.__updateMock.mockRejectedValueOnce(new Error('boom'));

    const response = await request(app)
      .delete('/admin/notifications/clear-all')
      .expect(500);

    expect(response.body).toEqual({ error: 'Failed to clear notifications' });
  });
});
