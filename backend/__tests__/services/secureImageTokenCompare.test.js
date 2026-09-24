'use strict';

// The HMAC on a secure image token is compared in constant time, and a
// malformed signature is refused rather than thrown on.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
jest.mock('../../src/database/db', () => ({ db: jest.fn() }));

const crypto = require('crypto');
const service = require('../../src/services/secureImageService');

afterAll(() => { if (typeof service.dispose === 'function') service.dispose(); });

const mint = () => service.generateSecureToken(1, 'session', { clientFingerprint: 'fp' });
// The Map lookup is by the whole token, so a tampered copy has to sit in the
// cache under its own key to reach the compare at all.
const plant = (token, tampered) => { service.tokenCache.set(tampered, service.tokenCache.get(token)); return tampered; };

test('accepts the token it issued', () => {
  expect(service.verifySecureToken(mint(), 'fp').valid).toBe(true);
});

test('refuses a flipped signature bit in constant time', () => {
  const token = mint();
  const [payload, signature] = token.split('.');
  const flipped = (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1);
  const spy = jest.spyOn(crypto, 'timingSafeEqual');
  expect(service.verifySecureToken(plant(token, `${payload}.${flipped}`), 'fp')).toMatchObject({ valid: false, reason: 'Token tampered' });
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
});

test('refuses a signature of the wrong length or shape without throwing', () => {
  const token = mint();
  const [payload] = token.split('.');
  for (const bad of ['', 'zz', 'ab', 'x'.repeat(64)]) {
    expect(service.verifySecureToken(plant(token, `${payload}.${bad}`), 'fp')).toMatchObject({ valid: false, reason: 'Token tampered' });
  }
});
