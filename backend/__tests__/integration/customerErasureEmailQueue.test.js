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
const crypto = require('crypto');

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

  it('does not let the mark-sent write undo an erasure that commits during the SMTP call', async () => {
    // The stillPending re-check runs before the send; the erasure here lands
    // DURING it (inside the mocked transport for this very row). The
    // trailing mark-sent update must not flip the row back to 'sent' or
    // restore the pre-erasure variables and rendered HTML.
    await db('email_queue').where('status', 'pending').update({ status: 'cancelled' });

    const midSend = await insertCustomer(db);
    const now = new Date().toISOString();
    const insert = await db('email_queue').insert({
      recipient_email: midSend.email, email_type: 'gallery_created',
      email_data: JSON.stringify({
        customer_name: 'Mid Send Customer', host_name: 'Mid Send Customer', event_name: 'Mid Send Event', event_date: '2026-09-07',
        gallery_link: 'https://photos.example/gallery/mid-send/tok', gallery_password: 'pw-secret',
        expiry_date: null, welcome_message: '',
      }),
      status: 'pending', created_at: now, scheduled_at: now, retry_count: 0,
    }).returning('id');
    const queueId = insert[0]?.id ?? insert[0];

    const { eraseCustomer } = require('../../src/services/customerAccountsService');
    const stub = stubWebhookTransport(async (mail) => {
      await eraseCustomer(midSend.id, null);
      return { messageId: `sent-${mail.to}` };
    });
    try {
      const { processEmailQueue } = require('../../src/services/emailProcessor');
      await processEmailQueue({ ignoreSchedule: true, onlyId: queueId });
      expect(stub.mails.map((m) => m.to)).toEqual([midSend.email]);
    } finally { stub.restore(); }

    const row = await db('email_queue').where({ id: queueId }).first();
    expect(row.status).toBe('cancelled');
    expect(row.recipient_email).not.toBe(midSend.email);
    expect(JSON.parse(row.email_data)).toEqual({ redacted: true, reason: 'customer_erased' });
    expect(row.rendered_html).toBeFalsy();
    expect(JSON.stringify(row)).not.toContain('Mid Send Customer');
  });

  it('keeps a campaign recipient cancelled when the erasure commits during its send', async () => {
    await db('email_queue').where('status', 'pending').update({ status: 'cancelled' });

    const recipient = await insertCustomer(db);
    const [campaignId] = await db('email_campaigns').insert({
      name: 'Mid-send erasure campaign', subject: 'Hello', body_html: '<p>Hi</p>',
      status: 'sending', recipient_count: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id').then((r) => r.map((x) => x?.id ?? x));

    const now = new Date().toISOString();
    const insert = await db('email_queue').insert({
      recipient_email: recipient.email, email_type: 'newsletter', campaign_id: campaignId,
      email_data: JSON.stringify({ customerId: recipient.id, customer_name: 'Campaign Mid Send' }),
      status: 'pending', created_at: now, scheduled_at: now, retry_count: 0,
    }).returning('id');
    const queueId = insert[0]?.id ?? insert[0];
    await db('email_campaign_recipients').insert({
      campaign_id: campaignId, customer_account_id: recipient.id, email: recipient.email,
      email_queue_id: queueId, status: 'queued', created_at: now,
    });

    const { eraseCustomer } = require('../../src/services/customerAccountsService');
    const stub = stubWebhookTransport(async (mail) => {
      await eraseCustomer(recipient.id, null);
      return { messageId: `sent-${mail.to}` };
    });
    try {
      const { processEmailQueue } = require('../../src/services/emailProcessor');
      await processEmailQueue({ ignoreSchedule: true, onlyId: queueId });
      expect(stub.mails.map((m) => m.to)).toEqual([recipient.email]);
    } finally { stub.restore(); }

    const row = await db('email_queue').where({ id: queueId }).first();
    expect(row.status).toBe('cancelled');
    expect(JSON.parse(row.email_data)).toEqual({ redacted: true, reason: 'customer_erased' });
    expect(row.rendered_html).toBeFalsy();

    const recipientRow = await db('email_campaign_recipients').where({ campaign_id: campaignId, email_queue_id: queueId }).first();
    expect(recipientRow.status).toBe('cancelled');
    const campaign = await db('email_campaigns').where({ id: campaignId }).first();
    expect(Number(campaign.sent_count)).toBe(0);
  });

  it('matches queued mail to the customer\'s address case-insensitively', async () => {
    const mixed = await insertCustomer(db);
    const now = new Date().toISOString();
    const [pendingIns] = await db('email_queue').insert({
      recipient_email: mixed.email.toUpperCase(), email_type: 'gallery_created', status: 'pending',
      email_data: JSON.stringify({ customer_name: 'Mixed Case' }), created_at: now,
    }).returning('id');
    const [sentIns] = await db('email_queue').insert({
      recipient_email: `Erase-Mailq-${mixed.email.slice('erase-mailq-'.length)}`, email_type: 'gallery_created',
      status: 'sent', email_data: JSON.stringify({ customer_name: 'Mixed Case' }), rendered_html: '<p>Mixed Case</p>',
      created_at: now,
    }).returning('id');

    const { eraseCustomer } = require('../../src/services/customerAccountsService');
    await eraseCustomer(mixed.id, null);

    const pending = await db('email_queue').where({ id: pendingIns?.id ?? pendingIns }).first();
    expect(pending.status).toBe('cancelled');
    expect(pending.recipient_email).toMatch(/@deleted\.invalid$/);
    expect(JSON.parse(pending.email_data)).toEqual({ redacted: true, reason: 'customer_erased' });
    const sent = await db('email_queue').where({ id: sentIns?.id ?? sentIns }).first();
    expect(sent.status).toBe('sent');
    expect(sent.recipient_email).toMatch(/@deleted\.invalid$/);
    expect(sent.rendered_html).toBeFalsy();
  });

  it('redacts mail held back for a customer who takes no administrative emails', async () => {
    // Migration 300: such mail is stored as `suppressed` instead of sent, with
    // the same template variables (document numbers, names) as a sent row.
    const optedOut = await insertCustomer(db);
    const now = new Date().toISOString();
    const [ins] = await db('email_queue').insert({
      recipient_email: optedOut.email, email_type: 'invoice_sent', status: 'suppressed',
      email_data: JSON.stringify({ customer_name: 'Opted Out', invoice_number: 'R-2026-0001' }), created_at: now,
    }).returning('id');

    const { eraseCustomer } = require('../../src/services/customerAccountsService');
    await eraseCustomer(optedOut.id, null);

    const row = await db('email_queue').where({ id: ins?.id ?? ins }).first();
    expect(row.status).toBe('suppressed');
    expect(row.recipient_email).toMatch(/@deleted\.invalid$/);
    // pg returns the json column as an object, SQLite as text.
    const data = typeof row.email_data === 'string' ? JSON.parse(row.email_data) : row.email_data;
    expect(data).toEqual({ redacted: true, reason: 'customer_erased' });
  });

  // Former-address tests (issue 1971) pin every time: the history entries are
  // restamped after the fact so a tenure can span whole seconds.
  const T0 = Math.floor((Date.now() - 3600000) / 1000) * 1000; // a whole second
  const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();
  const queueAt = async (recipient, status, createdAt, name) => {
    const [row] = await db('email_queue').insert({
      recipient_email: recipient, email_type: 'gallery_created', status,
      email_data: JSON.stringify({ customer_name: name }), rendered_html: `<p>${name}</p>`,
      created_at: createdAt, scheduled_at: createdAt, retry_count: 0,
    }).returning('id');
    return row?.id ?? row;
  };
  /** Restamp this customer's change-history entries, oldest first. */
  const stampHistory = async (customerId, times) => {
    const rows = await db('accounting_change_history')
      .where({ document_type: 'customer', document_id: customerId }).orderBy('id', 'asc').select('id');
    expect(rows).toHaveLength(times.length);
    for (const [i, row] of rows.entries()) {
      await db('accounting_change_history').where({ id: row.id }).update({ created_at: times[i] });
    }
  };
  const expectUntouched = async (id, recipient, name, status) => {
    const row = await db('email_queue').where({ id }).first();
    expect(row.status).toBe(status);
    expect(row.recipient_email).toBe(recipient);
    expect(JSON.parse(row.email_data).customer_name).toBe(name);
    expect(row.rendered_html).toBe(`<p>${name}</p>`);
  };
  const expectRedacted = async (id, status) => {
    const row = await db('email_queue').where({ id }).first();
    expect(row.status).toBe(status);
    expect(row.recipient_email).toMatch(/@deleted\.invalid$/);
    expect(row.rendered_html).toBeFalsy();
    return row;
  };

  it('cancels and redacts mail to a former address, but only from the time the customer held it (issue 1971)', async () => {
    await db('email_queue').where('status', 'pending').update({ status: 'cancelled' });
    const { eraseCustomer, updateCustomer } = require('../../src/services/customerAccountsService');
    const formerAddress = 'former-1971@example.com';

    // Another customer held the address until 10s; the customer took it at 20s
    // and left it at 40.1s, and a third customer has it since.
    const earlierOwner = await insertCustomer(db, { email: formerAddress });
    await updateCustomer(earlierOwner.id, { email: 'earlier-owner-1971@example.com' }, null);
    await stampHistory(earlierOwner.id, [at(10)]);
    const mover = await insertCustomer(db, { email: 'mover-start-1971@example.com' });
    await updateCustomer(mover.id, { email: formerAddress }, null);
    await updateCustomer(mover.id, { email: 'mover-now-1971@example.com' }, null);
    // Taken at 20.9999s: more fractional digits than the app writes, which
    // SQLite reads rounded to the millisecond.
    await stampHistory(mover.id, [at(20.999).replace('Z', '9Z'), at(40.1)]);
    await insertCustomer(db, { email: formerAddress });

    const earlierOwnerMail = await queueAt(formerAddress, 'sent', at(5), 'Earlier Owner');
    // Just before the taking; SQLite rounds it onto the 21s boundary.
    const beforeTaking = await queueAt(formerAddress, 'sent', at(20.999).replace('Z', '6Z'), 'Before Taking');
    const pendingOld = await queueAt(formerAddress, 'pending', at(30), 'Mover Pending');
    const sentOld = await queueAt(formerAddress, 'sent', at(30), 'Mover Sent');
    // The last whole second before the hand-over second is still the customer's.
    const lastSecond = await queueAt(formerAddress, 'sent', at(39.5), 'Mover Last Second');
    const laterOwnerMail = await queueAt(formerAddress, 'pending', at(50), 'Later Owner');
    // Same second as the hand-over, and the same instant floored to the
    // second the way a restore stores SQLite queue times: the next owner's.
    const handOver = await queueAt(formerAddress, 'pending', at(40.1), 'Hand-over');
    const restored = await db('email_queue').insert({
      recipient_email: formerAddress, email_type: 'gallery_created', status: 'sent',
      email_data: JSON.stringify({ customer_name: 'Restored' }), rendered_html: '<p>Restored</p>',
      created_at: T0 + 40000, scheduled_at: null, retry_count: 0, // sent at 40.9s
    }).returning('id');
    const restoredId = restored[0]?.id ?? restored[0];

    await eraseCustomer(mover.id, null);

    const pending = await expectRedacted(pendingOld, 'cancelled');
    expect(JSON.parse(pending.email_data)).toEqual({ redacted: true, reason: 'customer_erased' });
    const sent = await expectRedacted(sentOld, 'sent');
    expect(JSON.stringify(sent)).not.toContain('Mover Sent');
    await expectRedacted(lastSecond, 'sent');
    await expectUntouched(earlierOwnerMail, formerAddress, 'Earlier Owner', 'sent');
    await expectUntouched(beforeTaking, formerAddress, 'Before Taking', 'sent');
    await expectUntouched(laterOwnerMail, formerAddress, 'Later Owner', 'pending');
    await expectUntouched(handOver, formerAddress, 'Hand-over', 'pending');
    await expectUntouched(restoredId, formerAddress, 'Restored', 'sent');
  });

  it('matches the customer\'s first address only from the account\'s creation (issue 1971)', async () => {
    await db('email_queue').where('status', 'pending').update({ status: 'cancelled' });
    const { eraseCustomer, updateCustomer } = require('../../src/services/customerAccountsService');
    const firstAddress = 'first-1971@example.com';

    // An earlier owner of the address until 10s.
    const earlierOwner = await insertCustomer(db, { email: firstAddress });
    await updateCustomer(earlierOwner.id, { email: 'earlier-moved-1971@example.com' }, null);
    await stampHistory(earlierOwner.id, [at(10)]);

    // Created through the audited path at 20s, as every account since
    // migration 219 is: its `created` history entry is what establishes the
    // first address. Accepting an invitation issued at 15s: an invitation
    // does not reserve the address (a passive account holding it can move
    // off before the acceptance), so mail before the creation stays.
    const { auditedInsert } = require('../../src/services/accountingHistory');
    const [created] = await auditedInsert(db, 'customer_accounts', {
      email: firstAddress, display_name: 'First Address 1971', preferred_language: 'de',
      is_active: 1, created_at: at(20),
    }, { actor: 'customer-invitation', source: 'test' });
    const adminId = (await db('admin_users').first('id')).id;
    await db('customer_invitations').insert({
      email: firstAddress, token: 'digest-1971-first', token_digest: 'digest-1971-first',
      invited_by: adminId, expires_at: new Date(Date.now() + 86400000).toISOString(),
      accepted_at: at(20), accepted_customer_id: created.id, created_at: at(15),
    });
    await updateCustomer(created.id, { email: 'first-moved-1971@example.com' }, null);
    await stampHistory(created.id, [at(20), at(40)]);

    const earlierPending = await queueAt(firstAddress, 'pending', at(5), 'Earlier Pending');
    const earlierSent = await queueAt(firstAddress, 'sent', at(5), 'Earlier Sent');
    const beforeCreation = await queueAt(firstAddress, 'sent', at(15), 'Before Creation');
    const ownMail = await queueAt(firstAddress, 'sent', at(30), 'Own Sent');

    await eraseCustomer(created.id, null);

    await expectRedacted(ownMail, 'sent');
    await expectUntouched(beforeCreation, firstAddress, 'Before Creation', 'sent');
    await expectUntouched(earlierPending, firstAddress, 'Earlier Pending', 'pending');
    await expectUntouched(earlierSent, firstAddress, 'Earlier Sent', 'sent');
  });

  it('redacts the invitation the customer accepted, queued before the account existed', async () => {
    await db('email_queue').where('status', 'pending').update({ status: 'cancelled' });
    const { eraseCustomer, updateCustomer } = require('../../src/services/customerAccountsService');
    const { auditedInsert } = require('../../src/services/accountingHistory');
    const { digestCapabilityToken } = require('../../src/utils/capabilityToken');
    const { encryptEmailData, PROTECTED_PENDING_STATUS } = require('../../src/utils/emailQueueEncryption');
    const { redactRecoveryLinksInData } = require('../../src/utils/emailSecretRedaction');
    const address = 'invited-first@example.com';
    const adminId = (await db('admin_users').first('id')).id;

    // Stored the way production stores them: encrypted while pending, the
    // link token masked once sent. Nothing in the variables names the
    // invitation any more.
    const queueInvitation = async (token, status, createdAt, name) => {
      const data = { customer_name: name, invite_link: `https://photos.example.com/customer/invite/${token}` };
      const [row] = await db('email_queue').insert({
        recipient_email: address, email_type: 'customer_invitation', status,
        email_data: JSON.stringify(status === PROTECTED_PENDING_STATUS
          ? encryptEmailData('customer_invitation', data, address)
          : redactRecoveryLinksInData(data)),
        rendered_html: `<p>${name}</p>`, created_at: createdAt, scheduled_at: createdAt, retry_count: 0,
      }).returning('id');
      return row?.id ?? row;
    };
    const invitationRow = (token, overrides) => ({
      email: address, token: digestCapabilityToken(token), token_digest: digestCapabilityToken(token),
      invited_by: adminId, ...overrides,
    });

    // An invitation nobody accepted (created 10s, expired 12s), then the one
    // accepted at 20s into a new account that moves off the address at 40s.
    // The accepted one was mailed (15s) and its link also copied before the
    // mail went out, so a second copy still waits encrypted (15.5s).
    const otherToken = crypto.randomBytes(32).toString('hex');
    const ownToken = crypto.randomBytes(32).toString('hex');
    const otherInvitation = await queueInvitation(otherToken, 'sent', at(10.2), 'Other Invitation');
    const ownSent = await queueInvitation(ownToken, 'sent', at(15.1), 'Own Invitation');
    const ownPending = await queueInvitation(ownToken, PROTECTED_PENDING_STATUS, at(15.5), 'Own Pending');
    const [created] = await auditedInsert(db, 'customer_accounts', {
      email: address, display_name: 'Invited 1971', preferred_language: 'de',
      is_active: 1, created_at: at(20),
    }, { actor: 'customer-invitation', source: 'test' });
    await db('customer_invitations').insert([
      invitationRow(otherToken, { expires_at: at(12), created_at: at(10) }),
      invitationRow(ownToken, {
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        accepted_at: at(20), accepted_customer_id: created.id, created_at: at(15.05),
      }),
    ]);
    await updateCustomer(created.id, { email: 'invited-moved@example.com' }, null);
    await stampHistory(created.id, [at(20), at(40)]);
    // Someone else invited to the address after the customer moved off it.
    const laterToken = crypto.randomBytes(32).toString('hex');
    // An invitation cancelled 30 ms before the accepted one replaced it, in
    // the same second (cancelInvitation deletes the invitation, not its mail).
    const cancelledInvitation = await queueInvitation(crypto.randomBytes(32).toString('hex'), 'sent', at(15.02), 'Cancelled Invitation');
    const laterInvitation = await queueInvitation(laterToken, 'sent', at(50), 'Later Invitation');
    // The still-encrypted copy resent by an admin after the acceptance.
    const { resendEmail } = require('../../src/services/projectService');
    const ownResent = (await resendEmail(ownPending)).id;

    await eraseCustomer(created.id, null);

    await expectRedacted(ownSent, 'sent');
    await expectRedacted(ownPending, 'cancelled');
    await expectRedacted(ownResent, 'cancelled');
    for (const [id, name] of [[otherInvitation, 'Other Invitation'], [laterInvitation, 'Later Invitation'], [cancelledInvitation, 'Cancelled Invitation']]) {
      const row = await db('email_queue').where({ id }).first();
      expect(row.status).toBe('sent');
      expect(row.recipient_email).toBe(address);
      expect(row.rendered_html).toBe(`<p>${name}</p>`);
    }
  });

  it('does not match the first recorded address of an account created before the change history (issue 1971)', async () => {
    await db('email_queue').where('status', 'pending').update({ status: 'cancelled' });
    const { eraseCustomer, updateCustomer } = require('../../src/services/customerAccountsService');
    const unrecorded = 'unrecorded-1971@example.com';

    // No `created` entry, and a move to the address the history never saw
    // (both happened before migration 219): the account's start on it is unknown.
    const legacy = await insertCustomer(db, { email: 'legacy-start-1971@example.com' });
    await db('customer_accounts').where({ id: legacy.id }).update({ email: unrecorded });
    await updateCustomer(legacy.id, { email: 'legacy-now-1971@example.com' }, null);
    await stampHistory(legacy.id, [at(40)]);
    const otherOwnerMail = await queueAt(unrecorded, 'sent', at(5), 'Other Owner');

    await eraseCustomer(legacy.id, null);

    await expectUntouched(otherOwnerMail, unrecorded, 'Other Owner', 'sent');
  });

  it('leaves invitations on a former address to whoever accepted them (issue 1971)', async () => {
    await db('email_queue').where('status', 'pending').update({ status: 'cancelled' });
    const { eraseCustomer, updateCustomer } = require('../../src/services/customerAccountsService');
    const { auditedInsert } = require('../../src/services/accountingHistory');
    const shared = 'passive-1971@example.com';

    // A passive account holds the address from 0s to 10s. An invitation to
    // the address goes out at 5s; the account moves off, and the invitation
    // is accepted into a new account that holds the address since.
    const [passive] = await auditedInsert(db, 'customer_accounts', {
      email: shared, display_name: 'Passive 1971', preferred_language: 'de',
      is_active: 1, created_at: at(0),
    }, { actor: 'admin:1', source: 'test' });
    await updateCustomer(passive.id, { email: 'passive-moved-1971@example.com' }, null);
    await stampHistory(passive.id, [at(0), at(10)]);
    await insertCustomer(db, { email: shared });

    const ownMail = await queueAt(shared, 'sent', at(3), 'Passive Own');
    const [inv] = await db('email_queue').insert({
      recipient_email: shared, email_type: 'customer_invitation', status: 'sent',
      email_data: JSON.stringify({ customer_name: 'Invitation' }), rendered_html: '<p>Invitation</p>',
      created_at: at(5), scheduled_at: at(5), retry_count: 0,
    }).returning('id');
    const invitation = inv?.id ?? inv;
    // An admin invitation to the address is the admin account's, not the holder's.
    const [adminInv] = await db('email_queue').insert({
      recipient_email: shared, email_type: 'admin_invitation', status: 'sent',
      email_data: JSON.stringify({ customer_name: 'Admin Invitation' }), rendered_html: '<p>Admin Invitation</p>',
      created_at: at(6), scheduled_at: at(6), retry_count: 0,
    }).returning('id');
    const adminInvitation = adminInv?.id ?? adminInv;

    await eraseCustomer(passive.id, null);

    await expectRedacted(ownMail, 'sent');
    await expectUntouched(invitation, shared, 'Invitation', 'sent');
    await expectUntouched(adminInvitation, shared, 'Admin Invitation', 'sent');
  });

  it('matches no former address when the history times do not follow its order (issue 1971)', async () => {
    await db('email_queue').where('status', 'pending').update({ status: 'cancelled' });
    const { eraseCustomer, updateCustomer } = require('../../src/services/customerAccountsService');
    const shuffled = 'shuffled-1971@example.com';

    const { auditedInsert } = require('../../src/services/accountingHistory');
    const [mover] = await auditedInsert(db, 'customer_accounts', {
      email: 'shuffled-start-1971@example.com', display_name: 'Shuffled 1971', preferred_language: 'de',
      is_active: 1, created_at: at(20),
    }, { actor: 'admin:1', source: 'test' });
    await updateCustomer(mover.id, { email: shuffled }, null);
    await updateCustomer(mover.id, { email: 'shuffled-now-1971@example.com' }, null);
    // The taking carries a time before the creation: read in order, it would
    // open the window at 10s and claim another holder's mail at 15s.
    await stampHistory(mover.id, [at(20), at(10), at(40)]);
    const mail = await queueAt(shuffled, 'sent', at(15), 'Shuffled');

    await eraseCustomer(mover.id, null);

    await expectUntouched(mail, shuffled, 'Shuffled', 'sent');
  });

  it('keeps matching when only an entry without an email change is out of order (issue 1971)', async () => {
    await db('email_queue').where('status', 'pending').update({ status: 'cancelled' });
    const { eraseCustomer, updateCustomer } = require('../../src/services/customerAccountsService');
    const { auditedInsert } = require('../../src/services/accountingHistory');
    const skewed = 'skewed-1971@example.com';

    const [customer] = await auditedInsert(db, 'customer_accounts', {
      email: skewed, display_name: 'Skewed 1971', preferred_language: 'de',
      is_active: 1, created_at: at(20),
    }, { actor: 'admin:1', source: 'test' });
    await updateCustomer(customer.id, { display_name: 'Skewed 1971 renamed' }, null);
    await updateCustomer(customer.id, { email: 'skewed-now-1971@example.com' }, null);
    // The rename carries a time before the creation (a skewed clock); it
    // sets no window bound, so the tenure from 20s to 40s still counts.
    await stampHistory(customer.id, [at(20), at(19), at(40)]);
    const mail = await queueAt(skewed, 'sent', at(30), 'Skewed Own');

    await eraseCustomer(customer.id, null);

    await expectRedacted(mail, 'sent');
  });

  it('matches the current address only from the recorded change to it', async () => {
    await db('email_queue').where('status', 'pending').update({ status: 'cancelled' });
    const { eraseCustomer, updateCustomer } = require('../../src/services/customerAccountsService');
    const address = 'current-taken@example.com';

    // Another customer held the address until 10s; the customer took it at 20.5s.
    const earlier = await insertCustomer(db, { email: address });
    await updateCustomer(earlier.id, { email: 'current-earlier-moved@example.com' }, null);
    await stampHistory(earlier.id, [at(10)]);
    const taker = await insertCustomer(db, { email: 'current-taker-start@example.com' });
    await updateCustomer(taker.id, { email: address }, null);
    await stampHistory(taker.id, [at(20.5)]);

    const earlierSent = await queueAt(address, 'sent', at(5), 'Earlier Sent');
    const earlierPending = await queueAt(address, 'pending', at(8), 'Earlier Pending');
    const takingSecond = await queueAt(address, 'sent', at(20.2), 'Taking Second');
    const ownPending = await queueAt(address, 'pending', at(30), 'Own Pending');
    const ownSent = await queueAt(address, 'sent', at(30), 'Own Sent');

    await eraseCustomer(taker.id, null);

    await expectRedacted(ownPending, 'cancelled');
    await expectRedacted(ownSent, 'sent');
    await expectUntouched(earlierSent, address, 'Earlier Sent', 'sent');
    await expectUntouched(earlierPending, address, 'Earlier Pending', 'pending');
    await expectUntouched(takingSecond, address, 'Taking Second', 'sent');
  });

  it('matches the current address from the second it was taken when no other holder is recorded', async () => {
    await db('email_queue').where('status', 'pending').update({ status: 'cancelled' });
    const { eraseCustomer } = require('../../src/services/customerAccountsService');
    const { auditedInsert } = require('../../src/services/accountingHistory');
    const address = 'current-fresh@example.com';

    // Created directly at 20.3s; mail follows 100 ms later (a portal
    // invitation, sent by now, and a gallery mail still pending).
    const [created] = await auditedInsert(db, 'customer_accounts', {
      email: address, display_name: 'Fresh 1971', preferred_language: 'de',
      is_active: 1, created_at: at(20.3),
    }, { actor: 'admin:1', source: 'test' });
    await stampHistory(created.id, [at(20.3)]);
    const [inv] = await db('email_queue').insert({
      recipient_email: address, email_type: 'customer_invitation', status: 'sent',
      email_data: JSON.stringify({ customer_name: 'Fresh Invitation' }), rendered_html: '<p>Fresh Invitation</p>',
      created_at: at(20.4), scheduled_at: at(20.4), retry_count: 0,
    }).returning('id');
    const invitation = inv?.id ?? inv;
    const pending = await queueAt(address, 'pending', at(20.4), 'Fresh Pending');
    const before = await queueAt(address, 'sent', at(19.5), 'Before Creation');

    await eraseCustomer(created.id, null);

    await expectRedacted(invitation, 'sent');
    await expectRedacted(pending, 'cancelled');
    await expectUntouched(before, address, 'Before Creation', 'sent');
  });

  it('still matches an earlier tenure on the current address after the customer returned to it', async () => {
    await db('email_queue').where('status', 'pending').update({ status: 'cancelled' });
    const { eraseCustomer, updateCustomer } = require('../../src/services/customerAccountsService');
    const { auditedInsert } = require('../../src/services/accountingHistory');
    const address = 'current-return@example.com';

    // Held the address from 20s to 40s, then from 60s on.
    const [customer] = await auditedInsert(db, 'customer_accounts', {
      email: address, display_name: 'Return 1971', preferred_language: 'de',
      is_active: 1, created_at: at(20),
    }, { actor: 'admin:1', source: 'test' });
    await updateCustomer(customer.id, { email: 'current-return-away@example.com' }, null);
    await updateCustomer(customer.id, { email: address }, null);
    await stampHistory(customer.id, [at(20), at(40), at(60)]);

    const firstTenure = await queueAt(address, 'sent', at(30), 'First Tenure');
    const away = await queueAt(address, 'sent', at(50), 'While Away');
    const secondTenure = await queueAt(address, 'sent', at(70), 'Second Tenure');

    await eraseCustomer(customer.id, null);

    await expectRedacted(firstTenure, 'sent');
    await expectRedacted(secondTenure, 'sent');
    await expectUntouched(away, address, 'While Away', 'sent');
  });

  it('bounds the current address of an account without history by another customer\'s change of it', async () => {
    await db('email_queue').where('status', 'pending').update({ status: 'cancelled' });
    const { eraseCustomer, updateCustomer } = require('../../src/services/customerAccountsService');
    const address = 'current_legacy%shared@example.com'; // LIKE wildcards in the address

    // Another customer moved off the address at 10s; this account took it in
    // a change the history never saw (before migration 219).
    const earlier = await insertCustomer(db, { email: address });
    await updateCustomer(earlier.id, { email: 'current-legacy-moved@example.com' }, null);
    await stampHistory(earlier.id, [at(10)]);
    const legacy = await insertCustomer(db, { email: address });

    const earlierMail = await queueAt(address, 'sent', at(5), 'Earlier Holder');
    const ownMail = await queueAt(address, 'sent', at(30), 'Legacy Own');

    await eraseCustomer(legacy.id, null);

    await expectRedacted(ownMail, 'sent');
    await expectUntouched(earlierMail, address, 'Earlier Holder', 'sent');
  });

  it('finds another customer\'s change of the address however its JSON spells it', async () => {
    await db('email_queue').where('status', 'pending').update({ status: 'cancelled' });
    const { eraseCustomer } = require('../../src/services/customerAccountsService');
    const address = 'current-spelled@example.com';
    const earlier = await insertCustomer(db, { email: 'current-spelled-earlier@example.com' });
    // Upper case and an escaped "@": the same address once parsed.
    await db('accounting_change_history').insert({
      document_type: 'customer', document_id: earlier.id, entity_type: 'customer', entity_id: earlier.id,
      action: 'updated', actor_type: 'system', created_at: at(10),
      changes: '{"email":{"from":"CURRENT-SPELLED\\u0040EXAMPLE.COM","to":"current-spelled-earlier@example.com"}}',
    });
    const legacy = await insertCustomer(db, { email: address });
    const earlierMail = await queueAt(address, 'sent', at(5), 'Spelled Earlier');
    const ownMail = await queueAt(address, 'sent', at(30), 'Spelled Own');

    await eraseCustomer(legacy.id, null);

    await expectRedacted(ownMail, 'sent');
    await expectUntouched(earlierMail, address, 'Spelled Earlier', 'sent');
  });

  it('leaves admin mail on the current address to the admin account', async () => {
    await db('email_queue').where('status', 'pending').update({ status: 'cancelled' });
    const { eraseCustomer, updateCustomer } = require('../../src/services/customerAccountsService');
    const queueTyped = async (recipient, type, createdAt, name) => {
      const [row] = await db('email_queue').insert({
        recipient_email: recipient, email_type: type, status: 'sent',
        email_data: JSON.stringify({ customer_name: name }), rendered_html: `<p>${name}</p>`,
        created_at: createdAt, scheduled_at: createdAt, retry_count: 0,
      }).returning('id');
      return row?.id ?? row;
    };

    // Bounded by the account's creation (no history) and by a recorded change to it.
    const legacy = await insertCustomer(db, { email: 'current-admin-legacy@example.com', created_at: at(0) });
    const mover = await insertCustomer(db, { email: 'current-admin-start@example.com' });
    await updateCustomer(mover.id, { email: 'current-admin-moved@example.com' }, null);
    await stampHistory(mover.id, [at(20)]);

    const rows = [];
    for (const customer of [{ ...legacy }, { ...mover, email: 'current-admin-moved@example.com' }]) {
      rows.push({
        email: customer.email,
        adminInvitation: await queueTyped(customer.email, 'admin_invitation', at(30), 'Admin Invitation'),
        adminReset: await queueTyped(customer.email, 'admin_password_reset', at(30), 'Admin Reset'),
        // Sent to the holder (the passive-account promote path): theirs.
        customerInvitation: await queueTyped(customer.email, 'customer_invitation', at(30), 'Customer Invitation'),
      });
    }

    await eraseCustomer(legacy.id, null);
    await eraseCustomer(mover.id, null);

    for (const row of rows) {
      await expectUntouched(row.adminInvitation, row.email, 'Admin Invitation', 'sent');
      await expectUntouched(row.adminReset, row.email, 'Admin Reset', 'sent');
      await expectRedacted(row.customerInvitation, 'sent');
    }
  });

  it('matches the current address of an account without history from the account\'s creation', async () => {
    await db('email_queue').where('status', 'pending').update({ status: 'cancelled' });
    const { eraseCustomer } = require('../../src/services/customerAccountsService');
    // Created at 20.4s, before migration 219 (no history entry), and nobody
    // else's history names the address: an earlier holder left no trace.
    const legacy = await insertCustomer(db, { email: 'current-legacy-only@example.com', created_at: at(20.4) });
    const earlierHolderMail = await queueAt(legacy.email, 'sent', at(5), 'Earlier Holder');
    const earlierPending = await queueAt(legacy.email, 'pending', at(19.9), 'Earlier Pending');
    // From the start of the creation second, like a recorded creation.
    const creationSecond = await queueAt(legacy.email, 'sent', at(20.1), 'Creation Second');
    const ownMail = await queueAt(legacy.email, 'pending', at(30), 'Legacy Own');

    await eraseCustomer(legacy.id, null);

    await expectRedacted(creationSecond, 'sent');
    await expectRedacted(ownMail, 'cancelled');
    await expectUntouched(earlierHolderMail, legacy.email, 'Earlier Holder', 'sent');
    await expectUntouched(earlierPending, legacy.email, 'Earlier Pending', 'pending');
  });

  it('keeps matching the current address unbounded when the account\'s creation time cannot be read', async () => {
    await db('email_queue').where('status', 'pending').update({ status: 'cancelled' });
    const { eraseCustomer } = require('../../src/services/customerAccountsService');
    const legacy = await insertCustomer(db, { email: 'current-legacy-undated@example.com', created_at: null });
    const oldMail = await queueAt(legacy.email, 'sent', at(-3600), 'Legacy Old');

    await eraseCustomer(legacy.id, null);

    await expectRedacted(oldMail, 'sent');
  });

  it('attributes a resent copy by the time of the mail it repeats, not the resend', async () => {
    await db('email_queue').where('status', 'pending').update({ status: 'cancelled' });
    const { eraseCustomer, updateCustomer } = require('../../src/services/customerAccountsService');
    const { resendEmail } = require('../../src/services/projectService');
    const address = 'resent-1971@example.com';

    // The mover held the address from 20s to 40.1s; a later holder has it since.
    const mover = await insertCustomer(db, { email: 'resent-mover-start@example.com' });
    await updateCustomer(mover.id, { email: address }, null);
    await updateCustomer(mover.id, { email: 'resent-mover-now@example.com' }, null);
    await stampHistory(mover.id, [at(20), at(40.1)]);
    const later = await insertCustomer(db, { email: address, created_at: at(41) });

    // The mover's mail, resent (and the copy resent again) after the hand-over.
    const original = await queueAt(address, 'sent', at(30), 'Mover Original');
    const copy = (await resendEmail(original)).id;
    await db('email_queue').where({ id: copy }).update({ status: 'sent' });
    const copyOfCopy = (await resendEmail(copy)).id;
    const laterOwn = await queueAt(address, 'pending', at(50), 'Later Own');

    // The later holder's erasure leaves the copies alone, although they were
    // queued while that holder had the address.
    await eraseCustomer(later.id, null);
    await expectRedacted(laterOwn, 'cancelled');
    for (const id of [copy, copyOfCopy]) {
      const row = await db('email_queue').where({ id }).first();
      expect(row.recipient_email).toBe(address);
      expect(JSON.parse(row.email_data).customer_name).toBe('Mover Original');
    }

    // The mover's erasure takes the original and both copies.
    await eraseCustomer(mover.id, null);
    await expectRedacted(original, 'sent');
    await expectRedacted(copy, 'sent');
    await expectRedacted(copyOfCopy, 'cancelled');
  });

  it('matches the address the account has when the erasure runs, not the one read before planning', async () => {
    await db('email_queue').where('status', 'pending').update({ status: 'cancelled' });
    const { eraseCustomer, updateCustomer } = require('../../src/services/customerAccountsService');
    const contractErasure = require('../../src/services/contract/erasure');
    const oldAddress = 'planning-old@example.com';
    const customer = await insertCustomer(db, { email: oldAddress });

    // While the erasure plans its contracts, the customer's address changes
    // and another customer takes the old one and gets mail on it.
    let successorMail;
    const realPlan = contractErasure.plan;
    const plan = jest.spyOn(contractErasure, 'plan').mockImplementationOnce(async (...args) => {
      await updateCustomer(customer.id, { email: 'planning-new@example.com' }, null);
      await insertCustomer(db, { email: oldAddress });
      successorMail = await queueAt(oldAddress, 'pending', new Date(Date.now() + 5000).toISOString(), 'Successor');
      return realPlan(...args);
    });
    try {
      await eraseCustomer(customer.id, null);
    } finally { plan.mockRestore(); }

    await expectUntouched(successorMail, oldAddress, 'Successor', 'pending');
    const erased = await db('customer_accounts').where({ id: customer.id }).first();
    expect(erased.email).toMatch(/@deleted\.invalid$/);
  });

  it('covers contract mail to a signer address only when it names a contract this erasure redacts', async () => {
    const fieldEncryption = require('../../src/utils/fieldEncryption');
    const owner = await insertCustomer(db);
    const other = await insertCustomer(db);
    const signerEmail = 'co-signer@example.com';
    const now = new Date().toISOString();

    const mkContract = async (customerAccountId, number) => {
      const [row] = await db('contracts').insert({
        contract_number: number, customer_account_id: customerAccountId, status: 'sent',
        issue_date: '2026-09-01', created_at: now, updated_at: now,
      }).returning('id');
      const contractId = row?.id ?? row;
      await db('contract_signers').insert({
        contract_id: contractId, position: 1, role: 'customer', slot_key: 'customer-1', status: 'invited',
        name_enc: fieldEncryption.encrypt('Co Signer'), email_enc: fieldEncryption.encrypt(signerEmail),
        email_hash: fieldEncryption.hashEmail(signerEmail), created_at: now, updated_at: now,
      });
      return contractId;
    };
    await mkContract(owner.id, 'V-ERASE-OWN');
    await mkContract(other.id, 'V-ERASE-OTHER');

    const queue = async (recipient, data) => {
      const [row] = await db('email_queue').insert({
        recipient_email: recipient, email_type: 'contract_sent', status: 'pending',
        email_data: JSON.stringify(data), created_at: now,
      }).returning('id');
      return row?.id ?? row;
    };
    const ownInvite = await queue('Co-Signer@Example.com', { contract_number: 'V-ERASE-OWN', customer_name: 'Co Signer' });
    const otherInvite = await queue(signerEmail, { contract_number: 'V-ERASE-OTHER', customer_name: 'Co Signer' });
    const unattributed = await queue(signerEmail, { customer_name: 'Co Signer' });

    const { eraseCustomer } = require('../../src/services/customerAccountsService');
    await eraseCustomer(owner.id, null);

    const own = await db('email_queue').where({ id: ownInvite }).first();
    expect(own.status).toBe('cancelled');
    expect(JSON.parse(own.email_data)).toEqual({ redacted: true, reason: 'customer_erased' });
    expect(own.recipient_email).not.toMatch(/co-signer/i);

    // Same address, another customer's contract: not this customer's mail.
    const foreign = await db('email_queue').where({ id: otherInvite }).first();
    expect(foreign.status).toBe('pending');
    expect(foreign.recipient_email).toBe(signerEmail);
    expect(JSON.parse(foreign.email_data).contract_number).toBe('V-ERASE-OTHER');

    // Same address, nothing tying it to a contract: left alone.
    const loose = await db('email_queue').where({ id: unattributed }).first();
    expect(loose.status).toBe('pending');
    expect(loose.recipient_email).toBe(signerEmail);
  });
});
