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
 *     the row just cancelled) has its variables, recipient AND rendered_html
 *     (migration 119's exact-sent-HTML column, read by the Project Overview
 *     preview) redacted, while the row itself, its `email_type` and its
 *     timestamps are kept as the audit trail;
 *   - a cancellation that lands mid-flight — the queue processor already
 *     pulled its batch and is about to send this exact row — cannot
 *     resurrect the row: emailProcessor.js re-checks the row is still
 *     `pending` immediately before sending (the same guard the newsletter
 *     branch already had), so the erasure's cancellation survives the race;
 *   - a cancelled row that belongs to a newsletter campaign also flips its
 *     `email_campaign_recipients` row and rolls the campaign's counters, so
 *     the campaign doesn't stay stuck at `queued`/`sending` forever when the
 *     erased customer was its last outstanding recipient.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-erase-mailq-')), 'db.sqlite');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'erase-mailq-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-erase-mailq-storage-'));

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

let customerSeq = 0;
/** Insert a minimal extra customer_accounts row, distinct from the shared one. */
async function insertCustomer(db, overrides = {}) {
  customerSeq += 1;
  const [row] = await db('customer_accounts').insert({
    email: `erase-mailq-${customerSeq}@example.com`,
    display_name: `Erase Test Customer ${customerSeq}`,
    preferred_language: 'de',
    is_active: 1,
    created_at: new Date().toISOString(),
    ...overrides,
  }).returning('id');
  const id = row?.id ?? row;
  return { id, email: overrides.email || `erase-mailq-${customerSeq}@example.com` };
}

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
      // The exact HTML that went out (migration 119) — the Project Overview
      // preview reads this verbatim, so it must be wiped too, not just
      // email_data.
      rendered_html: '<p>Hallo Ada Erase,</p><p>Bitte laden Sie Reisepass Kopie bis Freitag hoch.</p>',
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
    expect(sentRow.rendered_html).toBeFalsy();
    expect(JSON.stringify(sentRow)).not.toContain('Reisepass Kopie');
    expect(JSON.stringify(sentRow)).not.toContain('Freitag');
    expect(JSON.stringify(sentRow)).not.toContain('Hallo Ada Erase');

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

  it('does not let a send already in flight resurrect a row erased mid-batch', async () => {
    // The queue processor SELECTs its whole batch up front, then sends each
    // row in a loop. If an erasure cancels+redacts a row AFTER the SELECT
    // but BEFORE the loop reaches it, the processor must not send it (or
    // its trailing "mark as sent" write would overwrite the erasure's
    // cancellation with the pre-erasure, unredacted data). Two rows,
    // ordered so the decoy is sent first; erasure runs from inside the
    // decoy's mocked transport call, simulating that exact gap.

    // Isolation: the previous test deliberately leaves an untouched pending
    // row behind (proving erasure doesn't touch other addresses). Clear it
    // so the unscoped sweep below only picks up this test's own two rows.
    await db('email_queue').where('status', 'pending').update({ status: 'cancelled' });

    const raceCustomer = await insertCustomer(db);
    const earlier = new Date(Date.now() - 1000).toISOString();
    const later = new Date().toISOString();

    const decoyEventInsert = await db('events').insert({
      slug: `erase-race-decoy-${customerSeq}`, event_type: 'wedding', event_name: 'Decoy Event', event_date: '2026-09-07',
      customer_email: 'decoy@example.com', customer_name: 'Decoy', password_hash: 'x',
      share_link: `/gallery/erase-race-decoy-${customerSeq}/tok`, share_token: `tok-${customerSeq}`,
      expires_at: new Date(Date.now() + 86400000).toISOString(), is_active: true, created_at: new Date().toISOString(),
    }).returning('id');
    const decoyEventId = decoyEventInsert[0]?.id ?? decoyEventInsert[0];
    const galleryVars = (name) => ({
      customer_name: name, host_name: name, event_name: 'Decoy Event', event_date: '2026-09-07',
      gallery_link: 'https://photos.example/gallery/erase-race/tok', gallery_password: 'pw-secret',
      client_link: 'https://photos.example/gallery/erase-race/client?token=abc', client_password: '1234',
      expiry_date: null, welcome_message: '',
    });

    const decoyInsert = await db('email_queue').insert({
      event_id: decoyEventId, recipient_email: 'decoy@example.com', email_type: 'gallery_created',
      email_data: JSON.stringify(galleryVars('Decoy')),
      status: 'pending', created_at: earlier, scheduled_at: earlier, retry_count: 0,
    }).returning('id');
    const decoyId = decoyInsert[0]?.id ?? decoyInsert[0];

    const raceInsert = await db('email_queue').insert({
      event_id: decoyEventId, recipient_email: raceCustomer.email, email_type: 'gallery_created',
      email_data: JSON.stringify(galleryVars('Race Customer')),
      status: 'pending', created_at: later, scheduled_at: later, retry_count: 0,
    }).returning('id');
    const raceId = raceInsert[0]?.id ?? raceInsert[0];

    const { eraseCustomer } = require('../../src/services/customerAccountsService');
    const stub = stubWebhookTransport(async (mail) => {
      if (mail.to === 'decoy@example.com') {
        await eraseCustomer(raceCustomer.id, null);
      }
      return { messageId: `sent-${mail.to}` };
    });
    try {
      const { processEmailQueue } = require('../../src/services/emailProcessor');
      const result = await processEmailQueue({ ignoreSchedule: true, limit: 10 });
      expect(result.sent).toBe(1);
      expect(stub.mails.map((m) => m.to)).toEqual(['decoy@example.com']);
    } finally { stub.restore(); }

    const raceRow = await db('email_queue').where({ id: raceId }).first();
    expect(raceRow.status).toBe('cancelled'); // the erasure's cancellation survives the race
    expect(raceRow.recipient_email).not.toBe(raceCustomer.email);
    expect(JSON.stringify(raceRow)).not.toContain('pw-secret');

    const decoyRow = await db('email_queue').where({ id: decoyId }).first();
    expect(decoyRow.status).toBe('sent'); // unrelated row, unaffected
  });

  it('cancels a queued campaign recipient and rolls the campaign counters', async () => {
    const soleRecipient = await insertCustomer(db);
    const [soleCampaignId] = await db('email_campaigns').insert({
      name: 'Sole recipient campaign', subject: 'Hello', body_html: '<p>Hi</p>',
      status: 'sending', recipient_count: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id').then((r) => r.map((x) => x?.id ?? x));

    const soleQueueInsert = await db('email_queue').insert({
      recipient_email: soleRecipient.email, email_type: 'newsletter', campaign_id: soleCampaignId,
      email_data: JSON.stringify({ customer_name: 'Sole Recipient' }),
      status: 'pending', created_at: new Date().toISOString(), scheduled_at: new Date().toISOString(), retry_count: 0,
    }).returning('id');
    const soleQueueId = soleQueueInsert[0]?.id ?? soleQueueInsert[0];

    await db('email_campaign_recipients').insert({
      campaign_id: soleCampaignId, customer_account_id: soleRecipient.id, email: soleRecipient.email,
      email_queue_id: soleQueueId, status: 'queued', created_at: new Date().toISOString(),
    });

    // A second campaign with TWO outstanding recipients — erasing one must
    // not close out the campaign while the other is still queued.
    const stillOutstanding = await insertCustomer(db);
    const alsoErased = await insertCustomer(db);
    const [twoRecipientCampaignId] = await db('email_campaigns').insert({
      name: 'Two recipient campaign', subject: 'Hello', body_html: '<p>Hi</p>',
      status: 'sending', recipient_count: 2, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id').then((r) => r.map((x) => x?.id ?? x));

    const keepQueueInsert = await db('email_queue').insert({
      recipient_email: stillOutstanding.email, email_type: 'newsletter', campaign_id: twoRecipientCampaignId,
      email_data: JSON.stringify({ customer_name: 'Stays Queued' }),
      status: 'pending', created_at: new Date().toISOString(), scheduled_at: new Date().toISOString(), retry_count: 0,
    }).returning('id');
    const keepQueueId = keepQueueInsert[0]?.id ?? keepQueueInsert[0];
    await db('email_campaign_recipients').insert({
      campaign_id: twoRecipientCampaignId, customer_account_id: stillOutstanding.id, email: stillOutstanding.email,
      email_queue_id: keepQueueId, status: 'queued', created_at: new Date().toISOString(),
    });

    const erasedQueueInsert = await db('email_queue').insert({
      recipient_email: alsoErased.email, email_type: 'newsletter', campaign_id: twoRecipientCampaignId,
      email_data: JSON.stringify({ customer_name: 'Gets Erased' }),
      status: 'pending', created_at: new Date().toISOString(), scheduled_at: new Date().toISOString(), retry_count: 0,
    }).returning('id');
    const erasedQueueId = erasedQueueInsert[0]?.id ?? erasedQueueInsert[0];
    await db('email_campaign_recipients').insert({
      campaign_id: twoRecipientCampaignId, customer_account_id: alsoErased.id, email: alsoErased.email,
      email_queue_id: erasedQueueId, status: 'queued', created_at: new Date().toISOString(),
    });

    const { eraseCustomer } = require('../../src/services/customerAccountsService');
    await eraseCustomer(soleRecipient.id, null);
    await eraseCustomer(alsoErased.id, null);

    // Sole-recipient campaign: no longer stuck — recomputeCounts resolves it
    // to a terminal status instead of staying 'queued'/'sending' forever.
    const soleRecipientRow = await db('email_campaign_recipients').where({ campaign_id: soleCampaignId, email_queue_id: soleQueueId }).first();
    expect(soleRecipientRow.status).toBe('cancelled');
    const soleCampaign = await db('email_campaigns').where({ id: soleCampaignId }).first();
    expect(['sent', 'failed', 'cancelled']).toContain(soleCampaign.status);
    expect(soleCampaign.status).not.toBe('sending');
    expect(soleCampaign.status).not.toBe('queued');

    // Two-recipient campaign: erasing one leaves the other queued, so the
    // campaign correctly stays in flight rather than being force-closed.
    const erasedRecipientRow = await db('email_campaign_recipients').where({ campaign_id: twoRecipientCampaignId, email_queue_id: erasedQueueId }).first();
    expect(erasedRecipientRow.status).toBe('cancelled');
    const keepRecipientRow = await db('email_campaign_recipients').where({ campaign_id: twoRecipientCampaignId, email_queue_id: keepQueueId }).first();
    expect(keepRecipientRow.status).toBe('queued');
    const twoRecipientCampaign = await db('email_campaigns').where({ id: twoRecipientCampaignId }).first();
    expect(twoRecipientCampaign.status).toBe('sending');

    const erasedQueueRow = await db('email_queue').where({ id: erasedQueueId }).first();
    expect(erasedQueueRow.status).toBe('cancelled');
    expect(erasedQueueRow.recipient_email).not.toBe(alsoErased.email);
  });
});
