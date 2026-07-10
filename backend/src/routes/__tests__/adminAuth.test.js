const request = require('supertest');
const express = require('express');

const buildChain = ({ firstResult, updateResult } = {}) => {
  const chain = {
    where: jest.fn().mockReturnThis(),
    whereNot: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    update: jest.fn().mockResolvedValue(updateResult ?? 1),
    first: jest.fn().mockResolvedValue(firstResult),
  };
  return chain;
};

jest.mock('../../database/db', () => {
  const dbMock = jest.fn();
  dbMock.raw = jest.fn();
  dbMock.__setImplementations = (...chains) => {
    dbMock.mockReset();
    chains.forEach((chain) => {
      dbMock.mockImplementationOnce(() => chain);
    });
  };
  return {
    db: dbMock,
    logActivity: jest.fn().mockResolvedValue(undefined),
  };
});

jest.mock('../../middleware/auth', () => ({
  adminAuth: (_req, _res, next) => {
    _req.admin = { id: 1, username: 'admin' };
    next();
  },
}));

const { db, logActivity } = require('../../database/db');
const adminAuthRouter = require('../adminAuth');

describe('adminAuth profile updates', () => {
  const app = express();
  app.use(express.json());
  app.use('/auth/admin', adminAuthRouter);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('updates the admin profile', async () => {
    const updatedUser = {
      id: 1,
      username: 'newadmin',
      email: 'newadmin@example.com',
      must_change_password: false,
    };

    db.__setImplementations(
      buildChain({ firstResult: null }),          // email check
      buildChain({ firstResult: null }),          // username check
      buildChain({ updateResult: 1 }),            // update
      buildChain({ firstResult: updatedUser }),   // fetch updated user
    );

    const response = await request(app)
      .put('/auth/admin/profile')
      .send({ username: updatedUser.username, email: updatedUser.email })
      .expect(200);

    expect(response.body).toEqual({ user: updatedUser });
    expect(logActivity).toHaveBeenCalledWith(
      'admin_profile_updated',
      { admin_id: 1, updated_fields: ['username', 'email'] },
      null,
      { type: 'admin', id: 1, name: updatedUser.username }
    );
  });

  it('rejects email conflicts', async () => {
    db.__setImplementations(
      buildChain({ firstResult: { id: 2 } })
    );

    const response = await request(app)
      .put('/auth/admin/profile')
      .send({ username: 'newadmin', email: 'taken@example.com' })
      .expect(409);

    expect(response.body).toEqual({ error: 'Email is already in use by another admin' });
  });

  it('validates input', async () => {
    const response = await request(app)
      .put('/auth/admin/profile')
      .send({ username: '', email: 'not-an-email' })
      .expect(400);

    expect(response.body.errors).toBeDefined();
  });
});
