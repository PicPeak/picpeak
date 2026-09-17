/**
 * The payment-check link's expiry has to hold for every shape the column is
 * stored in.
 *
 * `invoice_payment_check_tokens.expires_at` is NOT NULL (migration 107), and
 * the reads used to be `row.expires_at && new Date(row.expires_at).getTime()
 * < Date.now()`: for a value that can't be parsed — and for a missing one —
 * that comparison is false, so the link kept working past its expiry instead
 * of being refused. PostgreSQL hands back a Date and production SQLite stores
 * a bare Date as epoch ms, both of which `new Date(...)` reads, so this is
 * hardening rather than a live bypass; the shape that isn't readable is the
 * one a service's `new Date()` produces under Jest, which is exactly why it
 * has to be pinned here.
 *
 * Which shapes exist depends on the engine, so the cases are gated on it: a
 * `timestamptz` column refuses epoch ms, and refuses anything unparseable at
 * insert time, and that refusal is itself the argument that only SQLite can
 * hold them. Everything the two engines share — ISO, an expiry in the past,
 * the stamps the service writes — runs on both.
 */

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let customerId;
let payments;
let sequence = 0;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ customerId } = await seedMinimal(db));
  payments = require('../../src/services/invoice/payments');
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

const idOf = (inserted) => (typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]);
const isPg = () => db.client.config.client === 'pg';

async function invoiceWithToken(expiresAt) {
  sequence += 1;
  const invoiceId = idOf(await db('invoices').insert({
    invoice_number: `PAY-${sequence}`,
    customer_account_id: customerId,
    status: 'sent',
    issue_date: '2026-09-01',
    due_date: '2026-09-30',
    total_amount_minor: 10000,
  }).returning('id'));
  const token = `token-${sequence}-${'a'.repeat(50)}`;
  await db('invoice_payment_check_tokens').insert({
    invoice_id: invoiceId,
    token,
    expires_at: expiresAt,
    created_at: new Date().toISOString(),
  });
  return { invoiceId, token };
}

// An invoice queuePaymentCheckEmail will act on: overdue, with an admin
// address for it to send to.
async function overdueInvoice(prefix) {
  sequence += 1;
  const invoiceId = idOf(await db('invoices').insert({
    invoice_number: `${prefix}-${sequence}`,
    customer_account_id: customerId,
    status: 'overdue',
    issue_date: '2026-08-01',
    due_date: '2026-08-15',
    total_amount_minor: 5000,
  }).returning('id'));
  const profile = await db('business_profile').first();
  if (profile) await db('business_profile').where({ id: profile.id }).update({ email: 'studio@example.com' });
  return { invoiceId };
}

const codeOf = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err.code || err.statusCode;
  }
};

test('a live link opens, in every shape the engines store', async () => {
  // ISO — what the service writes now — on both engines. The second shape is
  // whichever one this engine keeps a Date as: epoch ms on SQLite, a Date on
  // PostgreSQL, where it is a perfectly good future expiry and the link
  // should open. Under Jest + SQLite that same Date is unreadable, so there
  // it belongs to the case below instead.
  const inThreeDays = Date.now() + 72 * 60 * 60 * 1000;
  const shapes = [new Date(inThreeDays).toISOString(), isPg() ? new Date(inThreeDays) : inThreeDays];
  for (const shape of shapes) {
    const { token } = await invoiceWithToken(shape);
    const view = await payments.getPaymentCheckByToken(token);
    expect(view).toEqual(expect.objectContaining({ outstandingMinor: 10000 }));
  }
});

test('an expiry in the past is refused', async () => {
  const { token } = await invoiceWithToken(new Date(Date.now() - 60 * 1000).toISOString());
  expect(await codeOf(payments.getPaymentCheckByToken(token))).toBe('TOKEN_EXPIRED');
  expect(await codeOf(payments.recordPaymentCheckAction({ token, action: 'paid_full' }))).toBe('TOKEN_EXPIRED');
});

test('an expiry nothing can read is refused, not treated as no expiry at all', async () => {
  // SQLite only, and not for want of trying: `timestamptz` rejects every
  // shape below at insert time, so on PostgreSQL the column cannot hold an
  // unreadable expiry in the first place.
  if (isPg()) return;
  // What a bare `new Date()` from another realm becomes in SQLite, and what
  // a garbled or truncated value looks like: `new Date(x).getTime()` is NaN,
  // and `NaN < Date.now()` is false — so both reads let the link through.
  for (const unreadable of ['[object Object]', 'not a date', '', new Date(Date.now() + 72 * 60 * 60 * 1000)]) {
    const { token } = await invoiceWithToken(unreadable);
    expect(await codeOf(payments.getPaymentCheckByToken(token))).toBe('TOKEN_EXPIRED');
    expect(await codeOf(payments.recordPaymentCheckAction({ token, action: 'paid_full' }))).toBe('TOKEN_EXPIRED');
  }
});

test('the token the service writes is readable back', async () => {
  // queuePaymentCheckEmail writes the expiry; reading it back has to give a
  // time, or the check above has nothing to compare.
  const { toMillis } = require('../../src/utils/queueTimestamps');
  const { invoiceId } = await overdueInvoice('PAY-Q');

  const result = await payments.queuePaymentCheckEmail(invoiceId);
  expect(result.sent).toBe(true);

  const row = await db('invoice_payment_check_tokens').where({ invoice_id: invoiceId }).first();
  expect(Number.isFinite(toMillis(row.expires_at))).toBe(true);
  expect(toMillis(row.expires_at)).toBeGreaterThan(Date.now());
  // …and the link it just wrote opens.
  await expect(payments.getPaymentCheckByToken(row.token)).resolves.toBeTruthy();
});

test('the 24h throttle holds on the stamp the service writes', async () => {
  // The same class one column over: queuePaymentCheckEmail writes
  // last_payment_check_at and reads it back to throttle. A stamp it cannot
  // read makes `now - NaN < 24h` false, so the throttle stops holding and
  // every scheduler tick mails the admin about the same invoice again.
  const { invoiceId } = await overdueInvoice('PAY-T');

  expect((await payments.queuePaymentCheckEmail(invoiceId)).sent).toBe(true);
  expect(await payments.queuePaymentCheckEmail(invoiceId))
    .toEqual(expect.objectContaining({ sent: false, reason: 'throttled_24h' }));

  // …and a stamp nothing can read leaves the invoice mailable rather than
  // throttled for good — the opposite choice from the expiry, because the
  // cost of reading it wrong here is one extra email, not a live link.
  if (isPg()) return;
  await db('invoices').where({ id: invoiceId }).update({ last_payment_check_at: '[object Object]' });
  expect((await payments.queuePaymentCheckEmail(invoiceId)).sent).toBe(true);
});
