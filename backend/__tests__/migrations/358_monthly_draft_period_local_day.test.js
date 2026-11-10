/**
 * Migration 358: open monthly drafts whose period was stored a day early
 * (toISOString of local midnight, east of UTC) move onto the days the cadence
 * names. A draft already on those days, an end that matches neither day (the
 * cycle day changed since), a manual draft without a period and an issued
 * invoice are left alone. Each move is in the invoice's history, and a second
 * run changes nothing.
 */
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const { repairedPeriod } = require('../../src/utils/monthlyDraftPeriods');
const { toDateOnly } = require('../../src/utils/dateOnly');

describe('repairedPeriod', () => {
  it('moves a start on the last day of a month to the 1st', () => {
    expect(repairedPeriod({ monthly_period_start: '2026-07-31', monthly_period_end: '2026-08-15' }, 15))
      .toEqual({ monthly_period_start: '2026-08-01' });
  });

  it('moves an end one day before the cycle day', () => {
    expect(repairedPeriod({ monthly_period_start: '2026-08-01', monthly_period_end: '2026-08-14' }, 15))
      .toEqual({ monthly_period_end: '2026-08-15' });
    // Cycle day 1: the end is stored on the last day of the month before.
    expect(repairedPeriod({ monthly_period_start: '2026-07-31', monthly_period_end: '2026-08-31' }, 1))
      .toEqual({ monthly_period_start: '2026-08-01', monthly_period_end: '2026-09-01' });
    // Negative cycle day: -3 is the 28th of a 31-day month.
    expect(repairedPeriod({ monthly_period_start: '2026-08-01', monthly_period_end: '2026-08-27' }, -3))
      .toEqual({ monthly_period_end: '2026-08-28' });
    // A cycle day past the month's end is clamped to its last day.
    expect(repairedPeriod({ monthly_period_start: '2026-02-01', monthly_period_end: '2026-02-27' }, 31))
      .toEqual({ monthly_period_end: '2026-02-28' });
  });

  it('leaves a period already on the cadence days, or one it cannot place', () => {
    expect(repairedPeriod({ monthly_period_start: '2026-08-01', monthly_period_end: '2026-08-15' }, 15)).toEqual({});
    expect(repairedPeriod({ monthly_period_start: '2026-08-01', monthly_period_end: '2026-08-10' }, 15)).toEqual({});
    expect(repairedPeriod({ monthly_period_start: null, monthly_period_end: null }, 15)).toEqual({});
  });

  it('reads a pg Date (local midnight) as its day', () => {
    expect(repairedPeriod({ monthly_period_start: new Date(2026, 6, 31), monthly_period_end: new Date(2026, 7, 14) }, 15))
      .toEqual({ monthly_period_start: '2026-08-01', monthly_period_end: '2026-08-15' });
  });
});

describe('migration 358', () => {
  let db; let cleanup; let template;

  // One open draft per customer (partial unique index), so each gets its own.
  const draft = async (number, overrides) => {
    const [row] = await db('customer_accounts').insert({
      ...template, email: `${number.toLowerCase()}@example.com`, display_name: number,
      billing_cadence: 'monthly', billing_cycle_day: 15,
    }).returning('id');
    return db('invoices').insert({
      invoice_number: number, customer_account_id: row?.id ?? row, status: 'scheduled', currency: 'CHF',
      issue_date: '2026-08-14', due_date: '2026-09-13', is_monthly_draft: true,
      net_amount_minor: 0, vat_amount_minor: 0, total_amount_minor: 0, ...overrides,
    });
  };

  const periods = async () => (await db('invoices').where('invoice_number', 'like', 'R-358-%').orderBy('invoice_number')
    .select('invoice_number', 'monthly_period_start', 'monthly_period_end'))
    .map((r) => [r.invoice_number, toDateOnly(r.monthly_period_start), toDateOnly(r.monthly_period_end)]);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { customerId } = await seedMinimal(db);
    const { id: _id, email: _email, ...rest } = await db('customer_accounts').where({ id: customerId }).first();
    template = Object.fromEntries(Object.entries(rest).filter(([k]) => ['password_hash', 'preferred_language', 'is_active', 'created_at'].includes(k)));
    await draft('R-358-A-shifted', { monthly_period_start: '2026-07-31', monthly_period_end: '2026-08-14' });
    await draft('R-358-B-right', { monthly_period_start: '2026-08-01', monthly_period_end: '2026-08-15' });
    await draft('R-358-C-cycle-changed', { monthly_period_start: '2026-08-01', monthly_period_end: '2026-08-09' });
    await draft('R-358-D-manual', { monthly_period_start: null, monthly_period_end: null });
    await draft('R-358-E-issued', { is_monthly_draft: false, status: 'sent', monthly_period_start: '2026-06-30', monthly_period_end: '2026-07-14' });
  }, 120000);

  afterAll(async () => { await cleanup(); });

  it('moves only the open draft stored a day early, and records the move', async () => {
    await require('../../migrations/core/358_monthly_draft_period_local_day').up(db);
    expect(await periods()).toEqual([
      ['R-358-A-shifted', '2026-08-01', '2026-08-15'],
      ['R-358-B-right', '2026-08-01', '2026-08-15'],
      ['R-358-C-cycle-changed', '2026-08-01', '2026-08-09'],
      ['R-358-D-manual', null, null],
      ['R-358-E-issued', '2026-06-30', '2026-07-14'],
    ]);
    const { id } = await db('invoices').where({ invoice_number: 'R-358-A-shifted' }).first('id');
    const history = await db('accounting_change_history')
      .where({ entity_type: 'invoice', entity_id: id, action: 'updated' }).orderBy('id', 'desc').first('actor_name');
    expect(history.actor_name).toBe('upgrade');
  });

  it('changes nothing on a second run', async () => {
    const before = await periods();
    await require('../../migrations/core/358_monthly_draft_period_local_day').up(db);
    expect(await periods()).toEqual(before);
  });
});
