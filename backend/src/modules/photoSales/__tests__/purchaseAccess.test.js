const {
  createPurchaseAccessToken,
  isPurchaseAccessActive,
  verifyPurchaseAccess,
  buildPurchasedDownloadUrl,
  findValidPhotoPurchaseAccess,
} = require('../purchaseAccess');

describe('purchase access helpers', () => {
  it('creates a non-empty token and treats a future expiry as active', () => {
    const token = createPurchaseAccessToken();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(20);

    const record = {
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };

    expect(isPurchaseAccessActive(record)).toBe(true);
    expect(verifyPurchaseAccess(record)).toBe(true);
  });

  it('rejects a purchase whose access has expired', () => {
    const record = {
      expires_at: new Date(Date.now() - 60 * 1000).toISOString(),
    };

    expect(isPurchaseAccessActive(record)).toBe(false);
    expect(verifyPurchaseAccess(record)).toBe(false);
  });

  it('builds the purchased-download URL for a valid access token', () => {
    expect(buildPurchasedDownloadUrl({ baseUrl: 'https://example.com', accessToken: 'abc123' }))
      .toBe('https://example.com/purchased-downloads/abc123');
    expect(buildPurchasedDownloadUrl({ accessToken: 'abc123' }))
      .toBe('/purchased-downloads/abc123');
  });

  it('accepts a valid photo purchase for an active access token only', () => {
    const now = Date.now();
    const valid = {
      order_id: 'ord-1',
      gallery_id: 9,
      photo_id: 42,
      access_token: 'token-1',
      expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
    };
    const expired = {
      order_id: 'ord-2',
      gallery_id: 9,
      photo_id: 42,
      access_token: 'token-2',
      expires_at: new Date(now - 60 * 1000).toISOString(),
    };

    expect(findValidPhotoPurchaseAccess({ galleryId: 9, photoId: 42, accessToken: 'token-1', rows: [valid] })).toEqual(valid);
    expect(findValidPhotoPurchaseAccess({ galleryId: 9, photoId: 42, accessToken: 'token-2', rows: [expired] })).toBeNull();
    expect(findValidPhotoPurchaseAccess({ galleryId: 9, photoId: 99, accessToken: 'token-1', rows: [valid] })).toBeNull();
  });
});
