/**
 * A verified gallery viewer's own image fetches do not spend the anonymous
 * per-IP budget (#1287).
 *
 * Since gallery tokens stopped earning the authenticated skip, a guest on a
 * 546-photo grid ran out of the default 300 requests per 15 minutes
 * mid-scroll; the rest of the tiles came back 429 and rendered blank, and the
 * next refresh found the photo list limited too. Reproduced in iOS Safari
 * against a seeded gallery: loading in bursts, then nothing, no error
 * anywhere. The image routes are exempt for a token that verifies and names
 * the gallery in the path; everything else stays on the budget.
 */
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'gallery-image-skip-secret';

jest.mock('../../src/database/db', () => ({ db: jest.fn(), withRetry: (fn) => fn() }));
jest.mock('../../src/utils/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));

const { isOwnGalleryImageRequest, shouldSkipRateLimit } = require('../../src/services/rateLimitService');

const iat = Math.floor(Date.now() / 1000) - 10;
const galleryToken = (eventSlug) => jwt.sign({ type: 'gallery', eventId: 1, eventSlug, iat }, process.env.JWT_SECRET, { issuer: 'picpeak-auth' });
const adminToken = () => jwt.sign({ type: 'admin', id: 1, iat }, process.env.JWT_SECRET, { issuer: 'picpeak-auth' });
const req = (path, token, method = 'GET') => ({
  path, method, cookies: {}, headers: token ? { authorization: `Bearer ${token}` } : {},
});
const config = { enabled: true, skipAuthenticated: true, publicEndpointsOnly: false };

describe('a gallery viewer fetching its own images', () => {
  it.each(['thumbnail', 'preview', 'hero', 'photo'])('skips the budget on /%s', (route) => {
    const r = req(`/api/gallery/wedding-2026/${route}/42`, galleryToken('wedding-2026'));
    expect(isOwnGalleryImageRequest(r)).toBe(true);
    expect(shouldSkipRateLimit(r, config)).toBe(true);
  });

  it('also reads the per-slug gallery cookie, as the browser sends it', () => {
    const r = { path: '/api/gallery/wedding-2026/thumbnail/42', method: 'GET', headers: {},
      cookies: { 'gallery_token_wedding-2026': galleryToken('wedding-2026') } };
    expect(isOwnGalleryImageRequest(r)).toBe(true);
  });
});

describe('everything else stays on the budget', () => {
  it('the photo list, downloads and feedback', () => {
    const token = galleryToken('wedding-2026');
    for (const path of ['/api/gallery/wedding-2026/photos', '/api/gallery/wedding-2026/download/42',
      '/api/gallery/wedding-2026/download-all', '/api/gallery/wedding-2026/info', '/api/gallery/wedding-2026/feedback/42']) {
      expect(isOwnGalleryImageRequest(req(path, token))).toBe(false);
      expect(shouldSkipRateLimit(req(path, token), config)).toBe(false);
    }
  });

  it('a token minted for a different gallery', () => {
    const r = req('/api/gallery/wedding-2026/thumbnail/42', galleryToken('other-gallery'));
    expect(isOwnGalleryImageRequest(r)).toBe(false);
    expect(shouldSkipRateLimit(r, config)).toBe(false);
  });

  it('no token, a garbage token, a token under another secret, a token without a slug', () => {
    const path = '/api/gallery/wedding-2026/thumbnail/42';
    const foreign = jwt.sign({ type: 'gallery', eventSlug: 'wedding-2026', iat }, 'someone-elses-secret');
    const slugless = jwt.sign({ type: 'gallery', eventId: 1, iat }, process.env.JWT_SECRET);
    for (const token of [undefined, 'not-a-jwt', foreign, slugless]) {
      expect(isOwnGalleryImageRequest(req(path, token))).toBe(false);
    }
  });

  it('a non-GET on an image path', () => {
    expect(isOwnGalleryImageRequest(req('/api/gallery/wedding-2026/photo/42', galleryToken('wedding-2026'), 'DELETE'))).toBe(false);
  });

  it('an admin token still skips everywhere, and is not what this checks', () => {
    const r = req('/api/gallery/wedding-2026/thumbnail/42', adminToken());
    expect(isOwnGalleryImageRequest(r)).toBe(false);
    expect(shouldSkipRateLimit(r, config)).toBe(true);
  });

  it('the operator switch skip_authenticated=false counts guests too', () => {
    const r = req('/api/gallery/wedding-2026/thumbnail/42', galleryToken('wedding-2026'));
    expect(shouldSkipRateLimit(r, { ...config, skipAuthenticated: false })).toBe(false);
  });
});
