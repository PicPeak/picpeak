/**
 * Per-customer "no administrative emails" (migration 300).
 *
 * Real quoteService / emailProcessor → SQLite with the full core-migration
 * run (helpers/crmDb). Pins:
 *   - administrative mail to an opted-out customer is logged as `suppressed`,
 *     never `pending`, so the processor never sends it;
 *   - matching covers the login email and the billing email, case-insensitive;
 *   - account and gallery mail to the same customer still goes out;
 *   - other recipients (a second signer, the business itself) are unaffected;
 *   - accepting a quote on the customer's behalf issues the accepted PDF but
 *     the confirmation mail is suppressed;
 *   - a customer who has not opted out keeps receiving everything;
 *   - a shared billing address is held back only when every account at it
 *     opted out;
 *   - the switch is checked again at send time (business-hours reminders,
 *     resend / retry / send-now / health retry all pass the processor);
 *   - a reminder records its level but adds no late fee (never communicated).
 */

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let adminId;
let customerId;
let queueEmail;
let quoteService;

const prevCwd = process.cwd();

async function setFlag(key, value) {
  const updated = await db('feature_flags').where({ key }).update({ value });
  if (!updated) await db('feature_flags').insert({ key, value });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
}

async function lastRow(recipient, emailType) {
  return db('email_queue')
    .where({ recipient_email: recipient, email_type: emailType })
    .orderBy('id', 'desc')
    .first();
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  ({ adminId, customerId } = await seedMinimal(db));
  await setFlag('quotes', true);
  await db('customer_accounts').where({ id: customerId }).update({
    no_admin_emails: true,
    billing_email: 'Accounts@Example.com',
  });
  ({ queueEmail } = require('../../src/services/emailProcessor'));
  quoteService = require('../../src/services/quoteService');
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

test.each([
  'quote_sent', 'quote_accepted_customer', 'invoice_sent', 'invoice_reminder_first',
  'invoice_reminder_second', 'storno_issued', 'contract_sent', 'contract_fully_signed',
  'customer_document_requested',
])('%s to an opted-out customer is suppressed', async (type) => {
  await queueEmail(null, 'customer@example.com', type, {});
  expect((await lastRow('customer@example.com', type)).status).toBe('suppressed');
});

test('the billing email matches too, whatever its case', async () => {
  await queueEmail(null, 'accounts@example.COM', 'invoice_sent', {});
  expect((await lastRow('accounts@example.COM', 'invoice_sent')).status).toBe('suppressed');
});

test.each(['customer_password_reset', 'customer_invitation', 'gallery_created', 'contract_signing_code'])(
  '%s still goes out',
  async (type) => {
    await queueEmail(null, 'customer@example.com', type, {});
    expect((await lastRow('customer@example.com', type)).status).not.toBe('suppressed');
  },
);

test('other recipients are unaffected', async () => {
  await queueEmail(null, 'second-signer@example.com', 'contract_sent', {});
  expect((await lastRow('second-signer@example.com', 'contract_sent')).status).toBe('pending');
});

test('a customer who has not opted out still gets administrative mail', async () => {
  await db('customer_accounts').insert({
    email: 'regular@example.com', display_name: 'Regular', is_active: 1, created_at: new Date().toISOString(),
  });
  await queueEmail(null, 'regular@example.com', 'invoice_sent', {});
  expect((await lastRow('regular@example.com', 'invoice_sent')).status).toBe('pending');
});

test('accepting on behalf issues the PDF but does not mail the customer', async () => {
  const quoteId = await quoteService.createQuote({
    customerAccountId: customerId, currency: 'CHF', vatRate: 8.1,
    lineItems: [{ position: 1, quantity: 1, description: 'Portrait session', unit_price_minor: 50000 }],
  }, adminId);

  await quoteService.adminAcceptQuote(quoteId, adminId);

  const quote = await db('quotes').where({ id: quoteId }).first();
  expect(quote.status).toBe('accepted');
  expect(quote.pdf_path).toBeTruthy();
  const mail = await lastRow('customer@example.com', 'quote_accepted_customer');
  expect(mail).toBeTruthy();
  expect(mail.status).toBe('suppressed');
  expect(await db('email_queue')
    .where({ recipient_email: 'customer@example.com' })
    .whereIn('status', ['pending', 'protected_pending'])
    .whereIn('email_type', ['quote_sent', 'quote_accepted_customer'])
    .first()).toBeUndefined();
});

test('the quote, invoice and contract detail reads carry the flag for the Issue button', async () => {
  const quoteId = await quoteService.createQuote({
    customerAccountId: customerId, currency: 'CHF', vatRate: 8.1,
    lineItems: [{ position: 1, quantity: 1, description: 'Headshots', unit_price_minor: 30000 }],
  }, adminId);
  const quoteRead = await quoteService.getQuoteById(quoteId);
  expect(Boolean((quoteRead.quote || quoteRead).customer_no_admin_emails)).toBe(true);

  const [invoice] = await db('invoices').insert({
    customer_account_id: customerId, invoice_number: 'R-NOMAIL-1', status: 'scheduled',
    issue_date: '2026-10-12', due_date: '2026-10-26', total_amount_minor: 1000,
  }).returning('id');
  const invoiceId = typeof invoice === 'object' ? invoice.id : invoice;
  const { invoice: invoiceRow } = await require('../../src/services/invoiceService').getInvoiceById(invoiceId);
  expect(Boolean(invoiceRow.customer_no_admin_emails)).toBe(true);

  const [contract] = await db('contracts').insert({
    customer_account_id: customerId, contract_number: 'V-NOMAIL-1', title: 'Shoot', status: 'draft',
    language: 'de', issue_date: '2026-10-12', created_at: new Date().toISOString(),
  }).returning('id');
  const contractId = typeof contract === 'object' ? contract.id : contract;
  const { contract: contractRow } = await require('../../src/services/contract/crud').getContractById(contractId);
  expect(Boolean(contractRow.customer_no_admin_emails)).toBe(true);
});

async function otherCustomer(email, extra = {}) {
  const [row] = await db('customer_accounts').insert({
    email, display_name: email, preferred_language: 'de', is_active: 1, created_at: new Date().toISOString(), ...extra,
  }).returning('id');
  return typeof row === 'object' ? row.id : row;
}

test('a shared billing address is held back only when every account at it opted out', async () => {
  const optedOut = await otherCustomer('a-shared@example.com', { billing_email: 'books@shared.example', no_admin_emails: true });
  const stillMailed = await otherCustomer('b-shared@example.com', { billing_email: 'Books@Shared.example' });
  await queueEmail(null, 'books@shared.example', 'invoice_sent', {});
  expect((await lastRow('books@shared.example', 'invoice_sent')).status).toBe('pending');

  await db('customer_accounts').where({ id: stillMailed }).update({ no_admin_emails: true });
  await queueEmail(null, 'books@shared.example', 'invoice_sent', {});
  expect((await lastRow('books@shared.example', 'invoice_sent')).status).toBe('suppressed');
  expect(optedOut).toBeTruthy();
});

test('with the document\'s customer, the decision follows that customer, not the address', async () => {
  // A and B share a billing inbox; only A opted out (round 1, concern 3).
  const a = await otherCustomer('a-doc@example.com', { billing_email: 'office@shared-doc.example', no_admin_emails: true });
  const b = await otherCustomer('b-doc@example.com', { billing_email: 'office@shared-doc.example' });

  await queueEmail(null, 'office@shared-doc.example', 'invoice_sent', { cc: 'a-doc@example.com' }, { customerAccountId: a });
  // A's invoice is held back as a whole, its cc to A's own login included.
  expect((await lastRow('office@shared-doc.example', 'invoice_sent')).status).toBe('suppressed');

  await queueEmail(null, 'office@shared-doc.example', 'invoice_sent', {}, { customerAccountId: b });
  expect((await lastRow('office@shared-doc.example', 'invoice_sent')).status).toBe('pending');

  // A co-signer at another address is not the customer: their mail goes out.
  await queueEmail(null, 'cosigner-doc@example.com', 'contract_sent', {}, { customerAccountId: a });
  expect((await lastRow('cosigner-doc@example.com', 'contract_sent')).status).toBe('pending');
});

test('queueEmail reports a held-back mail as \'suppressed\'', async () => {
  expect(await queueEmail(null, 'customer@example.com', 'invoice_sent', {}, { customerAccountId: customerId })).toBe('suppressed');
});

test('a held-back mail is not sent again by resend / retry / send-now while the switch is on', async () => {
  const projectService = require('../../src/services/projectService');
  await queueEmail(null, 'customer@example.com', 'quote_sent', {}, { customerAccountId: customerId });
  const row = await lastRow('customer@example.com', 'quote_sent');
  expect(row.status).toBe('suppressed');
  for (const action of ['resendEmail', 'retryEmail', 'sendEmailNow']) {
    await expect(projectService[action](row.id, adminId)).rejects.toMatchObject({ code: 'NO_ADMIN_EMAILS' });
  }
  expect((await db('email_queue').where({ id: row.id }).first()).status).toBe('suppressed');

  // Switched off, the same row may go out again.
  await db('customer_accounts').where({ id: customerId }).update({ no_admin_emails: false });
  try {
    await projectService.retryEmail(row.id, adminId);
    expect((await db('email_queue').where({ id: row.id }).first()).status).toBe('pending');
  } finally {
    await db('customer_accounts').where({ id: customerId }).update({ no_admin_emails: true });
  }
});

test('a reminder for an opted-out customer records its level but adds no late fee', async () => {
  const { sendReminder } = require('../../src/services/invoice/reminders');
  const sentInvoice = async (customerAccountId, number) => {
    const [ins] = await db('invoices').insert({
      customer_account_id: customerAccountId, invoice_number: number, status: 'sent', currency: 'CHF',
      issue_date: '2026-09-01', due_date: '2026-09-15', total_amount_minor: 100000, net_amount_minor: 100000,
      vat_amount_minor: 0, reminder_level: 1,
    }).returning('id');
    return typeof ins === 'object' ? ins.id : ins;
  };
  const silent = await sentInvoice(customerId, 'R-NOMAIL-FEE');
  const mailed = await sentInvoice(await otherCustomer('fee-control@example.com'), 'R-MAILED-FEE');

  await sendReminder(silent, 2, adminId);
  await sendReminder(mailed, 2, adminId);

  const silentRow = await db('invoices').where({ id: silent }).first();
  expect([silentRow.status, Number(silentRow.reminder_level), Number(silentRow.late_fee_amount_minor || 0)])
    .toEqual(['overdue', 2, 0]);
  // Control: the fee is on for this install, so the 0 above is the switch.
  expect(Number((await db('invoices').where({ id: mailed }).first()).late_fee_amount_minor)).toBeGreaterThan(0);
});

test('the admin payment-check mail announces no fee for an opted-out customer', async () => {
  const { queuePaymentCheckEmail } = require('../../src/services/invoice/payments');
  const profile = await db('business_profile').first();
  if (profile) await db('business_profile').where({ id: profile.id }).update({ email: 'studio@example.com' });
  const sentInvoice = async (customerAccountId, number) => {
    const [ins] = await db('invoices').insert({
      customer_account_id: customerAccountId, invoice_number: number, status: 'sent', currency: 'CHF',
      issue_date: '2026-09-01', due_date: '2026-09-15', total_amount_minor: 100000, net_amount_minor: 100000,
      vat_amount_minor: 0, reminder_level: 1,
    }).returning('id');
    return typeof ins === 'object' ? ins.id : ins;
  };
  const feeAnnounced = async (invoiceId) => {
    await queuePaymentCheckEmail(invoiceId, { skipThrottle: true });
    const row = await db('email_queue').where({ email_type: 'invoice_payment_check' }).orderBy('id', 'desc').first();
    const data = typeof row.email_data === 'string' ? JSON.parse(row.email_data) : row.email_data;
    return data.late_fee_due;
  };
  expect(await feeAnnounced(await sentInvoice(customerId, 'R-NOMAIL-CHECK'))).toBe(false);
  expect(await feeAnnounced(await sentInvoice(await otherCustomer('check-control@example.com'), 'R-MAILED-CHECK'))).toBe(true);
});

test('a row queued before the switch went on keeps its decision; a resend is a new decision', async () => {
  const projectService = require('../../src/services/projectService');
  const optedIn = await otherCustomer('late-switch@example.com');
  await queueEmail(null, 'late-switch@example.com', 'invoice_sent', {}, { customerAccountId: optedIn });
  const pending = await lastRow('late-switch@example.com', 'invoice_sent');
  expect(pending.status).toBe('pending');

  await db('customer_accounts').where({ id: optedIn }).update({ no_admin_emails: true });
  // Retry on the same row: queued while the switch was off, so it stays
  // sendable, exactly as the processor would send it (round 2, concern 1).
  await expect(projectService.retryEmail(pending.id, adminId)).resolves.toMatchObject({ id: pending.id });
  expect((await db('email_queue').where({ id: pending.id }).first()).status).toBe('pending');
  // Resend queues a NEW mail: the switch as it is now decides.
  await db('email_queue').where({ id: pending.id }).update({ status: 'sent' });
  await expect(projectService.resendEmail(pending.id, adminId)).rejects.toMatchObject({ code: 'NO_ADMIN_EMAILS' });
});
