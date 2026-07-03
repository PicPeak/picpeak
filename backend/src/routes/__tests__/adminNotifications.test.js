const request = require('supertest');
const express = require('express');

jest.mock('../../database/db', () => {
  const deleteMock = jest.fn().mockResolvedValue(5);
  const chain = {
    select: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    whereNotNull: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: deleteMock,
    count: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue({ count: 0 }),
  };

  const dbMock = jest.fn(() => chain);
  dbMock.raw = jest.fn();
  dbMock.__chain = chain;
  dbMock.__deleteMock = deleteMock;
  return { db: dbMock };
});

jest.mock('../../middleware/auth', () => ({
  adminAuth: (_req, _res, next) => next(),
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
    db.__deleteMock.mockResolvedValueOnce(8);

    const response = await request(app)
      .delete('/admin/notifications/clear-all')
      .expect(200);

    expect(db).toHaveBeenCalledWith('activity_logs');
    expect(db.__deleteMock).toHaveBeenCalledTimes(1);
    expect(response.body).toEqual({
      message: 'All notifications cleared',
      deletedCount: 8,
    });
  });

  it('handles database errors when clearing notifications', async () => {
    db.__deleteMock.mockRejectedValueOnce(new Error('boom'));

    const response = await request(app)
      .delete('/admin/notifications/clear-all')
      .expect(500);

    expect(response.body).toEqual({ error: 'Failed to clear notifications' });
  });
});
