const { summarisePurchaseOrder } = require('../adminOrders');

describe('photo sales admin order summaries', () => {
  it('summarises order metadata and remaining access', () => {
    const order = {
      order_id: 'ord_123',
      buyer_email: 'buyer@example.com',
      total_cents: 3400,
      currency: 'EUR',
      purchased_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2026-01-10T00:00:00.000Z',
      access_token: 'token-123',
    };

    const rows = [
      { id: 1, photo_id: 10 },
      { id: 2, photo_id: 11 },
      { id: 3, photo_id: 12 },
    ];

    const summary = summarisePurchaseOrder(order, rows);

    expect(summary).toMatchObject({
      order_id: 'ord_123',
      buyer_email: 'buyer@example.com',
      photo_count: 3,
      total_cents: 3400,
      currency: 'EUR',
      expires_at: '2026-01-10T00:00:00.000Z',
      access_token: 'token-123',
      remaining_days: expect.any(Number),
    });
    expect(summary.remaining_days).toBeGreaterThanOrEqual(0);
  });
});
