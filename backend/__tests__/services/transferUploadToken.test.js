'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
jest.mock('../../src/database/db', () => ({ db: jest.fn() }));

const { UPLOAD_TOKEN_LENGTH, generateUniqueUploadToken } = require('../../src/services/transferService');
const ALPHABET = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/;
const conn = (clash) => () => ({ where: () => ({ first: async () => clash }) });

test('issues ten unambiguous characters', async () => {
  expect(UPLOAD_TOKEN_LENGTH).toBe(10);
  const token = await generateUniqueUploadToken(conn(null));
  expect(token).toHaveLength(10);
  expect(token).toMatch(ALPHABET);
});

test('the clash fallback is longer but still accepted by the public route', async () => {
  const token = await generateUniqueUploadToken(conn({ id: 1 }));
  expect(token.length).toBeGreaterThan(UPLOAD_TOKEN_LENGTH);
  expect(token.length).toBeLessThanOrEqual(16);
  expect(token).toMatch(ALPHABET);
});
