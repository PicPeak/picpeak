import { describe, expect, it } from 'vitest';
import { purchaseAccessUntil, snipcartItemProps } from '../photoSales';

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

describe('snipcartItemProps description', () => {
  const args = { slug: 'g', priceCheckUrl: '/api/gallery/g/price-check', price: 5, photo: { id: 3, sale_token: 'x' } };

  it('puts the access note on the cart line', () => {
    expect(snipcartItemProps({ ...args, description: 'Download until 28.10.2026.' })?.['data-item-description'])
      .toBe('Download until 28.10.2026.');
  });
});
