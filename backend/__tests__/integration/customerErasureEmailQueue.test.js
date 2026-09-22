/**
 * Customer erasure and `email_queue` (#1593).
 *
 * `eraseCustomer()` used to anonymise `customer_accounts` and stop there:
 * `email_queue` rows addressed to the erased customer were never touched, so
 * a pending reminder or newsletter still went out after the erasure, and a
 * sent row kept the customer's data (address, template variables such as
 * document titles and review notes) in the archive and in backups
 * indefinitely. The rule now (customerAccountsService.js eraseCustomer):
 *
 *   - a `pending` row addressed to the customer's stored email is cancelled,
 *     so the processor's `status = 'pending'` query never picks it up again;
 *   - every row for that address that isn't already gone (sent, failed, or
 *     the row just cancelled) has its variables and recipient redacted,
 *     while the row itself, its `email_type` and its timestamps are kept as
 *     the audit trail.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-erase-mailq-')), 'db.sqlite');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'erase-mailq-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-erase-mailq-storage-'));

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

function stubWebhookTransport(impl) {
  const transport = require('../../src/services/emailWebhookTransport');
  const savedFrom = process.env.EMAIL_FROM;
  process.env.EMAIL_FROM = 'noreply@example.com';
  const mails = [];
  const enabled = jest.spyOn(transport, 'isEnabled').mockReturnValue(true);
  const send = jest.spyOn(transport, 'send').mockImplementation(async (mail) => { mails.push(mail); return impl(mail); });
  return {
    mails,
    restore() {
      enabled.mockRestore();
      send.mockRestore();
      if (savedFrom === undefined) delete process.env.EMAIL_FROM; else process.env.EMAIL_FROM = savedFrom;
    },
  };
}

describe('customer erasure clears email_queue', () => {
  let db; let cleanup; let customerId; let customerEmail;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ customerId } = await seedMinimal(db));
    customerEmail = (await db('customer_accounts').where({ id: customerId }).first('email')).email;
  }, 120000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  it('cancels the pending row and redacts both rows, without touching another customer\'s mail', async () => {
    const pendingInsert = await db('email_queue').insert({
      recipient_email: customerEmail,
      email_type: 'document_review_reminder',
      email_data: JSON.stringify({
        customer_name: 'Ada Erase', document_title: 'Vertrag Hochzeit Muster', review_notes: 'Bitte Abschnitt 3 pruefen',
      }),
      status: 'pending', created_at: new Date().toISOString(), scheduled_at: new Date().toISOString(), retry_count: 0,
    }).returning('id');
    const pendingId = pendingInsert[0]?.id ?? pendingInsert[0];

    const sentInsert = await db('email_queue').insert({
      recipient_email: customerEmail,
      email_type: 'document_request',
      email_data: JSON.stringify({
        customer_name: 'Ada Erase', document_title: 'Reisepass Kopie', request_text: 'Bitte bis Freitag hochladen',
      }),
      status: 'sent', created_at: new Date().toISOString(), sent_at: new Date().toISOString(), retry_count: 0,
    }).returning('id');
    const sentId = sentInsert[0]?.id ?? sentInsert[0];

    // A row for a different address must be left alone — the match is on
    // the erased customer's own stored address only.
    const otherInsert = await db('email_queue').insert({
      recipient_email: 'untouched@example.com',
      email_type: 'document_request',
      email_data: JSON.stringify({ customer_name: 'Someone Else', document_title: 'Other document' }),
      status: 'pending', created_at: new Date().toISOString(), scheduled_at: new Date().toISOString(), retry_count: 0,
    }).returning('id');
    const otherId = otherInsert[0]?.id ?? otherInsert[0];

    const { eraseCustomer } = require('../../src/services/customerAccountsService');
    await eraseCustomer(customerId, null);

    const pendingRow = await db('email_queue').where({ id: pendingId }).first();
    expect(pendingRow.status).toBe('cancelled');
    expect(pendingRow.email_type).toBe('document_review_reminder'); // template type kept for the audit trail
    expect(pendingRow.recipient_email).not.toBe(customerEmail);
    const pendingData = JSON.parse(pendingRow.email_data);
    expect(pendingData).toEqual({ redacted: true, reason: 'customer_erased' });
    expect(JSON.stringify(pendingRow)).not.toContain('Vertrag Hochzeit Muster');
    expect(JSON.stringify(pendingRow)).not.toContain('Abschnitt 3');

    const sentRow = await db('email_queue').where({ id: sentId }).first();
    expect(sentRow.status).toBe('sent'); // kept as the audit trail, not rewound
    expect(sentRow.sent_at).toBeTruthy();
    expect(sentRow.recipient_email).not.toBe(customerEmail);
    expect(JSON.parse(sentRow.email_data)).toEqual({ redacted: true, reason: 'customer_erased' });
    expect(JSON.stringify(sentRow)).not.toContain('Reisepass Kopie');
    expect(JSON.stringify(sentRow)).not.toContain('Freitag');

    const otherRow = await db('email_queue').where({ id: otherId }).first();
    expect(otherRow.status).toBe('pending');
    expect(otherRow.recipient_email).toBe('untouched@example.com');
    expect(JSON.parse(otherRow.email_data).document_title).toBe('Other document');

    // The processor's own pending query is what actually gates sending —
    // confirm the cancelled row is skipped rather than mailed.
    const stub = stubWebhookTransport(async () => ({ messageId: 'should-not-send' }));
    try {
      const { processEmailQueue } = require('../../src/services/emailProcessor');
      const result = await processEmailQueue({ ignoreSchedule: true, onlyId: pendingId });
      expect(result.processed).toBe(0);
      expect(stub.mails).toHaveLength(0);
    } finally { stub.restore(); }

    const pendingAfterFlush = await db('email_queue').where({ id: pendingId }).first();
    expect(pendingAfterFlush.status).toBe('cancelled');
  });
});
