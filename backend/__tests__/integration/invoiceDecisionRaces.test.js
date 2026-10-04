/**
 * One decision per invoice: payment-check links and cancellation.
 *
 * Payment-check links were independent rows. An unused 72-hour link outlived
 * the payment or Storno that settled the invoice and could restore `overdue`
 * with a late fee and a reminder; two live links could each confirm the full
 * payment from the same snapshot. Now a new link supersedes the older ones, a
 * settled invoice revokes its pending links, and the redemption decides in one
 * transaction: lock, state check, outstanding amount, claim of every pending
 * link.
 *
 * Cancellation read the original unlocked, so two cancellations could each
 * insert a Storno; the flip to `cancelled` is a compare-and-set now, and a
 * reissue refuses to create a second live replacement.
 */
const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db; let cleanup; let tmpDir; let adminId; let customerId; let token;
let invoiceApp; let invoiceService; let payments; let sending; let reminders;
const prevCwd = process.cwd();

const auth = () => ({ Authorization: `Bearer ${token}` });
const codeOf = async (promise) => {
  try { await promise; return null; } catch (err) { return err.code || err.statusCode; }
};
const invoiceRow = (id) => db('invoices').where({ id }).first();
const tokensOf = (id) => db('invoice_payment_check_tokens').where({ invoice_id: id }).orderBy('id');
let seq = 0;

async function createViaRoute() {
  const res = await request(invoiceApp).post('/api/admin/invoices').set(auth()).send({
    customerAccountId: customerId,
    currency: 'CHF',
    lineItems: [{ position: 1, quantity: 1, description: 'Coverage', unitPriceMinor: 10000, discountPercent: 0 }],
  });
  expect(res.status).toBe(201);
  return res.body.invoiceIds.map(Number);
}

async function sentInvoice() {
  const [id] = await createViaRoute();
  await request(invoiceApp).post(`/api/admin/invoices/${id}/send`).set(auth()).send({}).expect(200);
  return id;
}

/** A live payment-check link inserted directly, the way an older email's would still exist. */
async function liveToken(invoiceId) {
  seq += 1;
  const value = `${seq.toString(16).padStart(4, '0')}${'b'.repeat(60)}`;
  await db('invoice_payment_check_tokens').insert({
    invoice_id: invoiceId,
    token: value,
    expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
  });
  return value;
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);

  // Under jest's vm sandbox node-sqlite3 stores service-created Dates as
  // "[object Object]"; normalise bindings the way the other invoice suites do.
  const clientProto = Object.getPrototypeOf(db.client);
  const origQuery = clientProto._query;
  clientProto._query = function patchedQuery(connection, obj) {
    if (obj && Array.isArray(obj.bindings)) {
      obj.bindings = obj.bindings.map(
        (b) => (b && typeof b === 'object' && typeof b.toISOString === 'function' ? b.toISOString() : b),
      );
    }
    return origQuery.call(this, connection, obj);
  };
  db.client.pool.acquireTimeoutMillis = 2000;

  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  const updated = await db('feature_flags').where({ key: 'bills' }).update({ value: true });
  if (!updated) await db('feature_flags').insert({ key: 'bills', value: true });
  const profile = await db('business_profile').first();
  if (profile) await db('business_profile').where({ id: profile.id }).update({ email: 'studio@example.com' });

  invoiceService = require('../../src/services/invoiceService');
  payments = require('../../src/services/invoice/payments');
  sending = require('../../src/services/invoice/sending');
  reminders = require('../../src/services/invoice/reminders');
  invoiceApp = buildRouteApp('/api/admin/invoices', require('../../src/routes/adminInvoices'));
});

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

describe('payment-check links', () => {
  it('a new link supersedes the older unused one', async () => {
    const id = await sentInvoice();
    const older = await liveToken(id);

    const result = await payments.queuePaymentCheckEmail(id, { skipThrottle: true });
    expect(result.sent).toBe(true);

    const rows = await tokensOf(id);
    expect(rows).toHaveLength(2);
    const olderRow = rows.find((r) => r.token === older);
    expect(olderRow.used_at).not.toBeNull();
    expect(olderRow.used_action).toBe('superseded');
    expect(rows.find((r) => r.token === result.token).used_at).toBeNull();
    expect(await codeOf(payments.getPaymentCheckByToken(older))).toBe('TOKEN_ALREADY_USED');
    expect(await codeOf(payments.recordPaymentCheckAction({ token: older, action: 'unpaid' }))).toBe('TOKEN_ALREADY_USED');
  });

  it('keeps the older link live when the replacement cannot be queued', async () => {
    const id = await sentInvoice();
    const older = await liveToken(id);
    const emailProcessor = require('../../src/services/emailProcessor');
    const spy = jest.spyOn(emailProcessor, 'queueEmail').mockRejectedValueOnce(new Error('queue offline'));

    await expect(payments.queuePaymentCheckEmail(id, { skipThrottle: true })).rejects.toThrow('queue offline');
    spy.mockRestore();

    // The recipient still holds a usable link; the never-emailed one is gone.
    const rows = await tokensOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ token: older, used_at: null });
    expect(await codeOf(payments.getPaymentCheckByToken(older))).toBeNull();
  });

  it('two overlapping resends are issued one after the other; the last link is the live one', async () => {
    const id = await sentInvoice();
    const older = await liveToken(id);

    const [a, b] = await Promise.all([
      payments.queuePaymentCheckEmail(id, { skipThrottle: true }),
      payments.queuePaymentCheckEmail(id, { skipThrottle: true }),
    ]);
    expect(a.sent && b.sent).toBe(true);

    const rows = await tokensOf(id);
    expect(rows.find((r) => r.token === older)).toMatchObject({ used_action: 'superseded' });
    // Never both dead (each used to retire the other's fresh link), and
    // never two live: the later issuance replaces the earlier, mailed one.
    const fresh = [a.token, b.token].map((t) => rows.find((r) => r.token === t));
    expect(fresh.filter((r) => r.used_at === null)).toHaveLength(1);
    expect(fresh.filter((r) => r.used_action === 'superseded')).toHaveLength(1);
  });

  it('a second resend does not snapshot or retire a link whose email is still being queued', async () => {
    const id = await sentInvoice();
    const older = await liveToken(id);
    const emailProcessor = require('../../src/services/emailProcessor');
    const real = emailProcessor.queueEmail;
    let openGate;
    const gate = new Promise((resolve) => { openGate = resolve; });
    const liveAtQueueTime = [];
    let calls = 0;
    const spy = jest.spyOn(emailProcessor, 'queueEmail').mockImplementation(async (...args) => {
      calls += 1;
      // Resend A stops here: its token is inserted, its email is not out yet.
      if (calls === 1) await gate;
      // Whatever link this email carries has to be redeemable when it is queued.
      const carried = /payment-check\/([a-f0-9]{64})/.exec(args[3].paid_url)[1];
      liveAtQueueTime.push((await db('invoice_payment_check_tokens').where({ token: carried }).first()).used_at === null);
      return real(...args);
    });

    try {
      const first = payments.queuePaymentCheckEmail(id, { skipThrottle: true });
      while (calls < 1) await new Promise((resolve) => setTimeout(resolve, 10));
      const second = payments.queuePaymentCheckEmail(id, { skipThrottle: true });
      await new Promise((resolve) => setTimeout(resolve, 100));
      // B is held back: no second token, no second email, nothing retired.
      expect(calls).toBe(1);
      const during = await tokensOf(id);
      expect(during).toHaveLength(2);
      expect(during.every((r) => r.used_at === null)).toBe(true);

      openGate();
      const [a, b] = await Promise.all([first, second]);

      expect(liveAtQueueTime).toEqual([true, true]);
      const rows = await tokensOf(id);
      expect(rows.find((r) => r.token === older)).toMatchObject({ used_action: 'superseded' });
      expect(rows.find((r) => r.token === a.token)).toMatchObject({ used_action: 'superseded' });
      expect(rows.find((r) => r.token === b.token).used_at).toBeNull();
    } finally {
      openGate();
      spy.mockRestore();
    }
  });

  it('a refused action hands the link and its fallbacks back', async () => {
    const id = await sentInvoice();
    const sibling = await liveToken(id);
    const { token } = await payments.queuePaymentCheckEmail(id, { skipThrottle: true });
    // The sibling predates the new link and is superseded by it; give the
    // invoice two live links the way two emails within the window would.
    await db('invoice_payment_check_tokens').where({ token: sibling }).update({ used_at: null, used_action: null });

    // No Skonto on this invoice: the action is refused after the claim.
    await db('invoices').where({ id }).update({ skonto_disabled: true });
    expect(await codeOf(payments.recordPaymentCheckAction({ token, action: 'paid_with_skonto' })))
      .toBe('SKONTO_NOT_CONFIGURED');

    const rows = await tokensOf(id);
    expect(rows.find((r) => r.token === token).used_at).toBeNull();
    expect(rows.find((r) => r.token === sibling).used_at).toBeNull();
    expect((await invoiceRow(id)).status).toBe('sent');
    // The same link still works for an action that applies.
    expect(await codeOf(payments.recordPaymentCheckAction({ token, action: 'unpaid' }))).toBeNull();
  });

  it('keeps the claims spent once a business write has committed, so a retry cannot pay twice', async () => {
    const id = await sentInvoice();
    const sibling = await liveToken(id);
    const { token } = await payments.queuePaymentCheckEmail(id, { skipThrottle: true });
    await db('invoice_payment_check_tokens').where({ token: sibling }).update({ used_at: null, used_action: null });
    const before = await invoiceRow(id);

    // partial: recordPayment commits, then the reminder's PDF render fails.
    const pdfService = require('../../src/services/pdfService');
    const spy = jest.spyOn(pdfService, 'renderInvoiceToBuffer').mockRejectedValueOnce(new Error('renderer down'));
    await expect(payments.recordPaymentCheckAction({ token, action: 'partial', amountMinor: 1000 }))
      .rejects.toThrow('renderer down');
    spy.mockRestore();

    const after = await invoiceRow(id);
    expect(Number(after.paid_amount_minor)).toBe(Number(before.paid_amount_minor || 0) + 1000);
    const rows = await tokensOf(id);
    expect(rows.find((r) => r.token === token).used_at).not.toBeNull();
    expect(rows.find((r) => r.token === sibling)).toMatchObject({ used_action: 'superseded' });
    // A retry through either link is refused and records nothing again.
    expect(await codeOf(payments.recordPaymentCheckAction({ token, action: 'partial', amountMinor: 1000 }))).toBe('TOKEN_ALREADY_USED');
    expect(await codeOf(payments.recordPaymentCheckAction({ token: sibling, action: 'partial', amountMinor: 1000 }))).toBe('TOKEN_ALREADY_USED');
    expect(Number((await invoiceRow(id)).paid_amount_minor)).toBe(Number(after.paid_amount_minor));
  });

  it('a recorded payment revokes the pending links', async () => {
    const id = await sentInvoice();
    const link = await liveToken(id);

    await invoiceService.markPaid(id, { amountMinor: 10000 }, adminId);

    expect((await invoiceRow(id)).status).toBe('paid');
    const [row] = await tokensOf(id);
    expect(row.token).toBe(link);
    expect(row.used_action).toBe('revoked');
    expect(await codeOf(payments.recordPaymentCheckAction({ token: link, action: 'unpaid' }))).toBe('TOKEN_ALREADY_USED');
  });

  it('a link that somehow outlived the payment cannot reopen a paid invoice', async () => {
    const id = await sentInvoice();
    await invoiceService.markPaid(id, { amountMinor: 10000 }, adminId);
    const stale = await liveToken(id);
    const before = await invoiceRow(id);
    const emailsBefore = await db('email_queue').count('* as n').first();

    expect(await codeOf(payments.getPaymentCheckByToken(stale))).toBe('INVOICE_NOT_ACTIONABLE');
    expect(await codeOf(payments.recordPaymentCheckAction({ token: stale, action: 'unpaid' }))).toBe('INVOICE_NOT_ACTIONABLE');
    expect(await codeOf(payments.recordPaymentCheckAction({ token: stale, action: 'paid_full' }))).toBe('INVOICE_NOT_ACTIONABLE');

    const after = await invoiceRow(id);
    expect(after.status).toBe('paid');
    expect(after.reminder_level).toBe(before.reminder_level);
    expect(Number(after.late_fee_amount_minor || 0)).toBe(0);
    expect(Number(after.paid_amount_minor)).toBe(10000);
    // Nothing was consumed either: the refusal is before the claim.
    expect((await tokensOf(id)).find((r) => r.token === stale).used_at).toBeNull();
    expect(await db('email_queue').count('* as n').first()).toEqual(emailsBefore);
    expect(await db('invoice_payment_log').where({ invoice_id: id })).toHaveLength(1);
  });

  it('a link cannot act on a cancelled invoice', async () => {
    const id = await sentInvoice();
    const link = await liveToken(id);

    await invoiceService.cancelInvoice(id, adminId);

    // Cancelling revoked it…
    expect((await tokensOf(id))[0].used_action).toBe('revoked');
    // …and a link inserted afterwards is refused on the invoice's state.
    const stale = await liveToken(id);
    expect(await codeOf(payments.recordPaymentCheckAction({ token: stale, action: 'unpaid' }))).toBe('INVOICE_NOT_ACTIONABLE');
    expect(await codeOf(payments.recordPaymentCheckAction({ token: link, action: 'unpaid' }))).toBe('TOKEN_ALREADY_USED');
    const row = await invoiceRow(id);
    expect(row.status).toBe('cancelled');
    expect(Number(row.late_fee_amount_minor || 0)).toBe(0);
  });

  it('two live links confirm one payment, not two', async () => {
    const id = await sentInvoice();
    const first = await liveToken(id);
    const second = await liveToken(id);

    await expect(payments.recordPaymentCheckAction({ token: first, action: 'paid_full', ip: '203.0.113.7' }))
      .resolves.toEqual({ applied: 'paid_full' });
    expect(await codeOf(payments.recordPaymentCheckAction({ token: second, action: 'paid_full' }))).toBe('TOKEN_ALREADY_USED');

    const rows = await tokensOf(id);
    expect(rows.find((r) => r.token === first)).toMatchObject({ used_action: 'paid_full' });
    expect(rows.find((r) => r.token === second)).toMatchObject({ used_action: 'superseded' });
    expect(await db('invoice_payment_log').where({ invoice_id: id })).toHaveLength(1);
    const row = await invoiceRow(id);
    expect(row.status).toBe('paid');
    expect(Number(row.paid_amount_minor)).toBe(10000);
  });

  it('the reminder writer refuses an invoice that is no longer awaiting payment', async () => {
    const id = await sentInvoice();
    await invoiceService.markPaid(id, { amountMinor: 10000 }, adminId);
    const invoice = { ...(await invoiceRow(id)), status: 'sent' }; // a stale snapshot
    const lineItems = await db('invoice_line_items').where({ invoice_id: id });

    expect(await codeOf(reminders.applyReminder(invoice, lineItems, 1, adminId))).toBe('INVOICE_NOT_ACTIONABLE');

    const row = await invoiceRow(id);
    expect(row.status).toBe('paid');
    expect(row.reminder_level).toBe(0);
  });
});

describe('cancellation and reissue', () => {
  // The read saw a live invoice, but by the time the Storno flips it the row
  // has been cancelled by someone else: what a second concurrent cancellation
  // sees on PostgreSQL once the first commits and its lock is released. The
  // stale read is injected, since SQLite serialises the transactions outright.
  async function withStaleFirstRead(trx, staleRow) {
    let served = false;
    return new Proxy(trx, {
      apply(target, thisArg, args) {
        const query = target(...args);
        if (args[0] === 'invoices' && !served) {
          served = true;
          query.first = async () => staleRow;
        }
        return query;
      },
      get(target, prop) {
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  it('a Storno is only created from the status the original was read in', async () => {
    const id = await sentInvoice();
    const live = await invoiceRow(id);
    await invoiceService.cancelInvoice(id, adminId);
    const stornoCount = async () => (await db('invoices').where({ cancels_invoice_id: id })).length;
    expect(await stornoCount()).toBe(1);
    const sequenceBefore = await db('document_sequences').select('*');

    const code = await codeOf(db.transaction(async (trx) => sending.createStorno(id, adminId, await withStaleFirstRead(trx, live))));

    expect(code).toBe('INVOICE_STATE_CHANGED');
    expect(await stornoCount()).toBe(1);
    const row = await invoiceRow(id);
    expect(row.status).toBe('cancelled');
    expect(row.cancellation_storno_id).toBe((await db('invoices').where({ cancels_invoice_id: id }).first()).id);
    // The loser's sequence claim rolled back with it: the series stays gap-free.
    expect(await db('document_sequences').select('*')).toEqual(sequenceBefore);
  });

  it('a second reissue of the same original is refused instead of creating another replacement', async () => {
    const id = await sentInvoice();

    const first = await invoiceService.reissueInvoice(id, adminId);
    expect(first.replaces).toBe(id);
    expect((await invoiceRow(id)).status).toBe('cancelled');

    const code = await codeOf(invoiceService.reissueInvoice(id, adminId));

    expect(code).toBe('ALREADY_REISSUED');
    expect(await db('invoices').where({ replaces_invoice_id: id })).toHaveLength(1);
    expect(await db('invoices').where({ cancels_invoice_id: id })).toHaveLength(1);
  });
});
