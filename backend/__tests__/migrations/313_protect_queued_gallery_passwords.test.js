/**
 * Migration 313: no gallery password or client PIN stays in clear text in the
 * mail or WhatsApp queue. Final rows keep the archive mask; rows that can
 * still be sent keep the value sealed and still deliver it.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'migration-313-test-secret-at-least-32-chars';

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const migration = require('../../migrations/core/313_protect_queued_gallery_passwords');
const { MASK } = require('../../src/utils/emailSecretRedaction');

jest.setTimeout(120000);

const PASSWORD = 'Lantern-19!';
const PIN = '4321';
let db; let cleanup;

const galleryData = () => JSON.stringify({
  customer_name: 'Ada', event_name: 'Lantern Wedding', gallery_link: 'https://photos.example/g/lantern',
  gallery_password: PASSWORD, client_password: PIN, expiry_date: null,
});
const text = (raw) => (typeof raw === 'string' ? raw : JSON.stringify(raw));
const insertMail = async (row) => {
  const ids = await db('email_queue').insert({
    recipient_email: 'client@example.com', email_type: 'gallery_created', email_data: galleryData(),
    retry_count: 0, created_at: new Date().toISOString(), scheduled_at: null, ...row,
  }).returning('id');
  return ids[0]?.id ?? ids[0];
};

function stubWebhookTransport() {
  const transport = require('../../src/services/emailWebhookTransport');
  const savedFrom = process.env.EMAIL_FROM;
  process.env.EMAIL_FROM = 'noreply@example.com';
  const mails = [];
  const enabled = jest.spyOn(transport, 'isEnabled').mockReturnValue(true);
  const send = jest.spyOn(transport, 'send').mockImplementation(async (mail) => { mails.push(mail); return { messageId: 'm' }; });
  return {
    mails,
    restore() {
      enabled.mockRestore(); send.mockRestore();
      if (savedFrom === undefined) delete process.env.EMAIL_FROM; else process.env.EMAIL_FROM = savedFrom;
    },
  };
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  await seedMinimal(db);
});

afterAll(async () => { if (cleanup) await cleanup(); });

test('scrubs final rows, seals waiting ones, and the waiting mail still sends the password', async () => {
  const sent = await insertMail({
    status: 'sent', sent_at: new Date().toISOString(),
    rendered_html: `<p>Password: ${PASSWORD}</p><p>PIN: ${PIN}</p>`,
  });
  const pending = await insertMail({ status: 'pending' });
  const failed = await insertMail({ status: 'failed', retry_count: 3 });
  const unrelated = await insertMail({
    email_type: 'gallery_expired', status: 'sent', email_data: JSON.stringify({ event_name: 'Lantern Wedding' }),
  });
  const waPending = (await db('whatsapp_queue').insert({
    recipient_phone: '+491700000009', message_type: 'gallery_created', message_data: galleryData(),
    status: 'pending', retry_count: 0, created_at: new Date().toISOString(),
  }).returning('id'))[0];
  const waSent = (await db('whatsapp_queue').insert({
    recipient_phone: '+491700000008', message_type: 'gallery_created', message_data: galleryData(),
    status: 'sent', retry_count: 0, created_at: new Date().toISOString(),
  }).returning('id'))[0];

  await migration.up(db);
  const after = await db('email_queue').where('id', sent).first();
  // idempotent: a second pass changes nothing
  await migration.up(db);

  const sentRow = await db('email_queue').where('id', sent).first();
  expect(text(sentRow.email_data)).toBe(text(after.email_data));
  expect(JSON.parse(text(sentRow.email_data)).gallery_password).toBe(MASK);
  expect(JSON.parse(text(sentRow.email_data)).client_password).toBe(MASK);
  expect(sentRow.rendered_html).not.toContain(PASSWORD);
  expect(sentRow.rendered_html).not.toContain(PIN);

  for (const id of [pending, failed]) {
    // eslint-disable-next-line no-await-in-loop
    const row = await db('email_queue').where('id', id).first();
    expect(text(row.email_data)).not.toContain(PASSWORD);
    expect(text(row.email_data)).not.toContain(PIN);
    expect(JSON.parse(text(row.email_data)).customer_name).toBe('Ada');
  }
  expect(JSON.parse(text((await db('email_queue').where('id', unrelated).first()).email_data)))
    .toEqual({ event_name: 'Lantern Wedding' });

  const waPendingId = waPending?.id ?? waPending;
  const waSentId = waSent?.id ?? waSent;
  expect(text((await db('whatsapp_queue').where('id', waPendingId).first()).message_data)).not.toContain(PASSWORD);
  expect(JSON.parse(text((await db('whatsapp_queue').where('id', waSentId).first()).message_data)).gallery_password)
    .toBe(MASK);

  const stub = stubWebhookTransport();
  try {
    const { processEmailQueue } = require('../../src/services/emailProcessor');
    await processEmailQueue({ ignoreSchedule: true, onlyId: pending });
  } finally { stub.restore(); }
  expect(stub.mails).toHaveLength(1);
  expect(String(stub.mails[0].html)).toContain(PASSWORD);
  expect((await db('email_queue').where('id', pending).first()).status).toBe('sent');
});
