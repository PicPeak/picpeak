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

jest.mock('../../utils/schemaCache', () => ({
  hasColumnCached: jest.fn().mockResolvedValue(true),
}));

jest.mock('../../middleware/auth', () => ({
  adminAuth: (_req, _res, next) => {
    _req.admin = { id: 1, username: 'admin' };
    next();
  },
}));

const { db, logActivity } = require('../../database/db');
const adminAuthRouter = require('../adminAuth');
const { errorHandler } = require('../../middleware/errorHandler');

describe('adminAuth profile updates', () => {
  const app = express();
  app.use(express.json());
  app.use('/auth/admin', adminAuthRouter);
  app.use(errorHandler);

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

    const updateChain = buildChain({ updateResult: 1 });
    db.__setImplementations(
      buildChain({ firstResult: null }),          // username check
      buildChain({ firstResult: null }),          // email check
      buildChain({ firstResult: { email: 'old@example.com' } }), // current email
      updateChain,                                // update
      buildChain({ firstResult: updatedUser }),   // fetch updated user
    );

    const response = await request(app)
      .put('/auth/admin/profile')
      .send({ username: updatedUser.username, email: updatedUser.email })
      .expect(200);

    expect(response.body).toEqual({
      message: 'Admin profile updated successfully',
      user: updatedUser
    });
    // A self-typed email is not proof of ownership: the account stops being
    // eligible for SSO email linking (migration 227).
    expect(updateChain.update).toHaveBeenCalledWith(expect.objectContaining({
      email: updatedUser.email,
      email_link_eligible: expect.anything(),
    }));
    const written = updateChain.update.mock.calls[0][0].email_link_eligible;
    expect(Boolean(written)).toBe(false);
    expect(logActivity).toHaveBeenCalledWith(
      'admin_profile_updated',
      { username: updatedUser.username, email: updatedUser.email },
      null,
      { type: 'admin', id: 1, name: 'admin' }
    );
  });

  it('rejects email conflicts', async () => {
    db.__setImplementations(
      buildChain({ firstResult: null }),          // username check
      buildChain({ firstResult: { id: 2 } }),     // email check
    );

    const response = await request(app)
      .put('/auth/admin/profile')
      .send({ username: 'newadmin', email: 'taken@example.com' })
      .expect(409);

    expect(response.body).toEqual({
      error: 'Email address is already in use',
      code: 'CONFLICT',
      field: 'email'
    });
  });

  it('validates input', async () => {
    const response = await request(app)
      .put('/auth/admin/profile')
      .send({ username: '', email: 'not-an-email' })
      .expect(400);

    expect(response.body.details).toBeDefined();
  });
});
