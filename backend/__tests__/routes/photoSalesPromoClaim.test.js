/**
 * Photo sales: the one-time promo code is a single-use Snipcart discount.
 * Two processes healing the same gallery at once (two replicas starting)
 * must end with one code and one discount — two discounts for the code
 * would honour the free photos twice.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-sales-promo-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'sales-promo-test-secret';
process.env.SNIPCART_SECRET_API_KEY = 'sk_test_promo';

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

describe('promo discount creation', () => {
  let db; let cleanup; let promo; let eventId;
  const created = [];

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    promo = require('../../src/modules/photoSales/promoDiscount');
    const row = await db('events').insert({
      slug: 'promo-race',
      event_type: 'wedding',
      event_name: 'Promo race',
      event_date: '2026-10-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: '/gallery/promo-race/s',
      share_token: 'promo-race-share',
      expires_at: new Date(Date.now() + 30 * 864e5).toISOString(),
      is_active: 1,
      is_priced: 1,
      photo_price: 5,
      free_photo_count: 2,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = row[0]?.id ?? row[0];

    global.fetch = jest.fn(async (url, init = {}) => {
      if (init.method === 'POST' && url.endsWith('/api/discounts')) {
        // Slow enough that both processes are inside the sync at once.
        await new Promise((resolve) => setTimeout(resolve, 30));
        const body = JSON.parse(init.body);
        created.push(body);
        return { ok: true, status: 201, json: async () => ({ id: `disc-${created.length}` }) };
      }
      throw new Error(`unexpected fetch ${init.method} ${url}`);
    });
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('creates one code and one discount when two processes heal the gallery at once', async () => {
    await Promise.all([promo.startupSync(), promo.startupSync()]);

    const event = await db('events').where({ id: eventId }).first('promo_code', 'snipcart_discount_id');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ code: event.promo_code, amount: 10, maxNumberOfUsages: 1 });
    expect(event.snipcart_discount_id).toBe('disc-1');
    expect(promo.isDiscountId(event.snipcart_discount_id)).toBe(true);
  });

  it('does not count a creation claim as a discount', () => {
    expect(promo.isDiscountId('pending:123')).toBe(false);
    expect(promo.isDiscountId(null)).toBe(false);
  });
});
