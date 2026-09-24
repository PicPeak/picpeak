'use strict';

// Client upload codes are typed by guests, so they stay in the unambiguous
// alphabet, but six of those characters were under 30 bits against an
// unauthenticated endpoint. Ten characters, and the clash fallback stays
// within what the public route accepts.
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
