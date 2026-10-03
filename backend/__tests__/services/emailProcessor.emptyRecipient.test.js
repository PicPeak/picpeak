/**
 * Callers pass `customer_email || host_email`, and an event may have neither
 * (issue 1733). A queue row without a recipient can never be sent, so
 * queueEmail writes nothing and reports false instead of throwing — the
 * automated callers run inside loops that must carry on.
 */
process.env.JWT_SECRET = 'empty-recipient-secret-at-least-32-characters';
process.env.NODE_ENV = 'test';

const { bootCrmDb } = require('../integration/helpers/crmDb');

let db, cleanup, queueEmail;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ queueEmail } = require('../../src/services/emailProcessor'));
}, 120000);

afterAll(async () => { await cleanup(); });
beforeEach(async () => { await db('email_queue').del(); });

it.each([[''], ['   '], [null], [undefined]])('queues nothing for the recipient %p', async (recipient) => {
  await expect(queueEmail(null, recipient, 'gallery_created', { event_name: 'X' })).resolves.toBe(false);
  expect(await db('email_queue').count('id as n').first()).toMatchObject({ n: 0 });
});

it('still queues a real address', async () => {
  await expect(queueEmail(null, 'anna@example.com', 'gallery_created', { event_name: 'X' })).resolves.toBe(true);
  const rows = await db('email_queue').select('recipient_email');
  expect(rows.map((r) => r.recipient_email)).toEqual(['anna@example.com']);
});
