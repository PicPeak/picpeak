/**
 * Migration 374 (freezeInvoicePaymentTerms) on SQLite with the full
 * core-migration run (helpers/crmDb). PostgreSQL runs the same code through
 * the backend CI's PG job.
 *
 * Pins:
 *   - invoices without a term, or with part of one, get the term they render
 *     today (own snapshot, else the quote's, Skonto from the defaults; 30 net
 *     days for an issued one without any, the setting for a scheduled one);
 *   - a frozen term is left as it is, a re-run changes nothing, and each
 *     write is in the accounting history;
 *   - afterwards a changed quote or default no longer reaches the invoice;
 *   - the guards: no invoices table, no history table.
 */

const crypto = require('crypto');
const knexLib = require('knex');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');
const { freezeInvoicePaymentTerms } = require('../../migrations/core/374_freeze_invoice_payment_terms');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let adminId;
let customerId;
let buildInvoiceRenderContext;
let resolveSkontoPercentForInvoice;

const prevCwd = process.cwd();

async function insertId(table, row) {
  const [inserted] = await db(table).insert(row).returning('id');
  return inserted?.id ?? inserted;
}

async function setSetting(key, value) {
  await db('app_settings').where({ setting_key: key }).del();
  await db('app_settings').insert({
    setting_key: key, setting_value: JSON.stringify(value), setting_type: 'crm', updated_at: new Date().toISOString(),
  });
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  ({ adminId, customerId } = await seedMinimal(db));
  ({ buildInvoiceRenderContext } = require('../../src/services/invoice/render'));
  ({ resolveSkontoPercentForInvoice } = require('../../src/services/invoiceService'));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

let seq = 0;
const quote = (snapshot) => insertId('quotes', {
  quote_number: `FRZ-Q-${++seq}`, issue_date: '2026-05-01', valid_until: '2026-06-01', customer_account_id: customerId, status: 'accepted', currency: 'CHF',
  net_amount_minor: 10000, vat_amount_minor: 0, total_amount_minor: 10000, created_by_admin_id: adminId,
  deal_uuid: crypto.randomUUID(), payment_term_snapshot: snapshot == null ? null : JSON.stringify(snapshot),
  created_at: new Date().toISOString(),
});
const invoice = (extra) => insertId('invoices', {
  invoice_number: `FRZ-I-${++seq}`, customer_account_id: customerId, issue_date: '2026-06-01', due_date: '2026-06-30',
  status: 'sent', currency: 'CHF', net_amount_minor: 10000, vat_amount_minor: 0, total_amount_minor: 10000,
  created_by_admin_id: adminId, deal_uuid: crypto.randomUUID(), ...extra,
});
const load = (id) => db('invoices').where({ id }).first();
// The PDF block reads each field for truthiness: an absent description and a
// null one print the same.
const rendered = async (id) => {
  const { paymentTerm: t } = await buildInvoiceRenderContext(await load(id), []);
  return { description: t.description ?? null, netDays: t.netDays ?? null, skontoPercent: t.skontoPercent ?? null, skontoWithinDays: t.skontoWithinDays ?? null };
};
const snapshotOf = async (id) => JSON.parse((await load(id)).payment_term_snapshot);

test('freezes the term each invoice renders today, leaves frozen ones, and a re-run is a no-op', async () => {
  await db('invoices').del();
  await setSetting('crm_invoices_skonto_percent_default', 2);
  await setSetting('crm_invoices_skonto_business_days', 7);
  await setSetting('crm_payment_default_net_days', 21);

  const q3 = await quote({ description: 'Q', net_days: 20, skonto_percent: 3, skonto_within_days: 10, installments: [{ percent: 100 }] });
  const qNoSkonto = await quote({ description: null, net_days: 30, skonto_percent: null, skonto_within_days: null });
  const qNone = await quote(null);
  const frozenTerm = { description: 'kept', net_days: 5, skonto_percent: null, skonto_within_days: null, installments: null, frozen: true };

  const ids = {
    fromQuote: await invoice({ source_quote_id: q3 }),
    fromQuoteNoSkonto: await invoice({ source_quote_id: qNoSkonto }),
    fromQuoteWithout: await invoice({ source_quote_id: qNone }),
    partialOwn: await invoice({ source_quote_id: q3, payment_term_snapshot: JSON.stringify({ net_days: 14 }) }),
    issuedBare: await invoice({}),
    scheduledBare: await invoice({ status: 'scheduled' }),
    frozen: await invoice({ source_quote_id: q3, payment_term_snapshot: JSON.stringify(frozenTerm) }),
  };
  const before = {};
  for (const [name, id] of Object.entries(ids)) before[name] = await rendered(id);
  const frozenRaw = (await load(ids.frozen)).payment_term_snapshot;

  expect(await freezeInvoicePaymentTerms(db)).toBe(6);

  // An issued invoice renders exactly what it did. A scheduled one without a
  // term printed a fixed 30 days while its send re-anchored the due date with
  // the setting; it now shows the setting's days too.
  for (const [name, id] of Object.entries(ids)) {
    const expected = name === 'scheduledBare' ? { ...before[name], netDays: 21 } : before[name];
    expect({ name, term: await rendered(id) }).toEqual({ name, term: expected });
  }
  expect(await snapshotOf(ids.fromQuote)).toEqual({
    description: 'Q', net_days: 20, skonto_percent: 3, skonto_within_days: 10, installments: [{ percent: 100 }], frozen: true,
  });
  expect(await snapshotOf(ids.fromQuoteNoSkonto)).toEqual(expect.objectContaining({ net_days: 30, skonto_percent: 2, skonto_within_days: 7 }));
  expect(await snapshotOf(ids.fromQuoteWithout)).toEqual(expect.objectContaining({ net_days: 30, skonto_percent: 2, frozen: true }));
  expect(await snapshotOf(ids.partialOwn)).toEqual(expect.objectContaining({ net_days: 14, skonto_percent: 2, skonto_within_days: 7 }));
  expect(await snapshotOf(ids.issuedBare)).toEqual(expect.objectContaining({ net_days: 30, skonto_percent: 2 }));
  expect(await snapshotOf(ids.scheduledBare)).toEqual(expect.objectContaining({ net_days: 21, skonto_percent: 2 }));
  expect((await load(ids.frozen)).payment_term_snapshot).toBe(frozenRaw);

  const history = await db('accounting_change_history').where({ entity_type: 'invoice', source: 'invoice.paymentTerm.freeze' });
  expect(history.map((h) => Number(h.entity_id)).sort((a, b) => a - b))
    .toEqual(Object.entries(ids).filter(([n]) => n !== 'frozen').map(([, id]) => Number(id)).sort((a, b) => a - b));

  // Re-run: nothing left.
  const snapshots = await db('invoices').orderBy('id').select('id', 'payment_term_snapshot');
  expect(await freezeInvoicePaymentTerms(db)).toBe(0);
  expect(await db('invoices').orderBy('id').select('id', 'payment_term_snapshot')).toEqual(snapshots);

  // The quote and the defaults change; the invoices don't.
  await db('quotes').where({ id: q3 }).update({ payment_term_snapshot: JSON.stringify({ net_days: 10, skonto_percent: 1, skonto_within_days: 5 }) });
  await setSetting('crm_invoices_skonto_percent_default', 5);
  expect(await rendered(ids.fromQuote)).toEqual(before.fromQuote);
  expect(await rendered(ids.fromQuoteNoSkonto)).toEqual(before.fromQuoteNoSkonto);
  expect(await resolveSkontoPercentForInvoice(await load(ids.fromQuote))).toBe(3);
  expect(await resolveSkontoPercentForInvoice(await load(ids.fromQuoteNoSkonto))).toBe(2);
});

test('processes more invoices than one batch', async () => {
  await db('invoices').del();
  const rows = Array.from({ length: 1203 }, (_, i) => ({
    invoice_number: `FRZ-B-${i}`, customer_account_id: customerId, issue_date: '2026-06-01', due_date: '2026-06-30',
    status: 'sent', currency: 'CHF', net_amount_minor: 100, vat_amount_minor: 0, total_amount_minor: 100,
    created_by_admin_id: adminId, deal_uuid: crypto.randomUUID(),
  }));
  await db.batchInsert('invoices', rows, 200);
  expect(await freezeInvoicePaymentTerms(db)).toBe(1203);
  const left = (await db('invoices').select('payment_term_snapshot'))
    .filter((r) => JSON.parse(r.payment_term_snapshot)?.frozen !== true);
  expect(left).toHaveLength(0);
});

describe('guards', () => {
  let mem;
  beforeEach(() => { mem = knexLib({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true }); });
  afterEach(async () => { await mem.destroy(); });

  it('skips a database without invoices', async () => {
    expect(await freezeInvoicePaymentTerms(mem)).toBe(0);
  });

  it('writes directly without the accounting history, quotes or settings', async () => {
    await mem.schema.createTable('invoices', (t) => {
      t.increments('id');
      t.string('status');
      t.text('payment_term_snapshot');
    });
    await mem('invoices').insert([{ status: 'sent' }, { status: 'scheduled', payment_term_snapshot: '{"net_days":14}' }]);
    expect(await freezeInvoicePaymentTerms(mem)).toBe(2);
    expect(await freezeInvoicePaymentTerms(mem)).toBe(0);
    const rows = (await mem('invoices').orderBy('id')).map((r) => JSON.parse(r.payment_term_snapshot));
    expect(rows).toEqual([
      { description: null, net_days: 30, skonto_percent: null, skonto_within_days: null, installments: null, frozen: true },
      { description: null, net_days: 14, skonto_percent: null, skonto_within_days: null, installments: null, frozen: true },
    ]);
  });
});
