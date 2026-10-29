import { describe, expect, it } from 'vitest';
import { purchaseAccessUntil, buildPhotoSalesConfig } from '../photoSales';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('purchaseAccessUntil', () => {
  it('runs the access days from now', () => {
    expect(purchaseAccessUntil(30, '2027-01-01T00:00:00.000Z', NOW).getTime()).toBe(NOW + 30 * DAY);
  });

  it('never runs past the gallery expiry (the backend caps the same way)', () => {
    expect(purchaseAccessUntil(30, '2026-10-28T00:00:00.000Z', NOW).toISOString()).toBe('2026-10-28T00:00:00.000Z');
  });

  it('runs the access days for a gallery without an expiry', () => {
    expect(purchaseAccessUntil(7, null, NOW).getTime()).toBe(NOW + 7 * DAY);
  });
});

describe('photo checkout configuration', () => {
  it('requires server checkout configuration before offering purchases', () => {
    const event = { is_priced: true, photo_price: 5 };
    expect(buildPhotoSalesConfig({ slug: 'g', event }).checkoutReady).toBe(false);
    expect(buildPhotoSalesConfig({ slug: 'g', event, checkoutConfigured: true }).checkoutReady).toBe(true);
    expect(buildPhotoSalesConfig({ slug: 'g', event: { ...event, is_priced: false }, checkoutConfigured: true }).checkoutReady).toBe(false);
  });
});
