/**
 * The contact form's confirmation reservation (migration 383, issue 2618) on
 * PostgreSQL: five requests at once, each on its own connection, reserve
 * the same address and day; exactly one gets it.
 *
 * Runs only with PICPEAK_PG_TEST_URL (CI sets it).
 */
const knex = require('knex');
const { randomUUID } = require('crypto');

const pgUrl = process.env.PICPEAK_PG_TEST_URL;
(pgUrl ? describe : describe.skip)('confirmation reservation on PostgreSQL', () => {
  let owner; let db; let schema; let reserve;

  beforeAll(async () => {
    schema = `contact_confirm_${randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    db = knex({ client: 'pg', connection: pgUrl, searchPath: [schema], pool: { min: 0, max: 6 } });
    await require('../../migrations/core/383_website_contact_confirmations').up(db);
    jest.doMock('../../src/database/db', () => ({ db, logActivity: jest.fn() }));
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'contact-confirm-pg-test-secret-at-least-32-chars';
    ({ reserveConfirmation: reserve } = require('../../src/services/website/contact')._internal);
  }, 60000);

  afterAll(async () => {
    if (db) await db.destroy();
    if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
    jest.dontMock('../../src/database/db');
  });

  test('five at once: one reservation', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => reserve('burst@example.com')));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db('website_contact_confirmations').count({ c: '*' }).first()).toMatchObject({ c: '1' });
  });
});
