'use strict';

/**
 * Open monthly drafts' billing period, moved onto the days the cadence names.
 *
 * Drafts used to store their period as `toISOString()` of local midnight,
 * which east of UTC is the day before: a period of 1–15 August was stored as
 * 31 July – 14 August. The scheduler compared that end with a "today" shifted
 * the same way, so drafts still fired on the right day, but the invoice
 * printed the shifted service period. Drafts and the scheduler now use the
 * local day (utils/dateOnly), so a draft stored the old way would fire one day
 * before its cadence day.
 *
 * A stored day is only moved when it is one day before the day the cadence
 * names, so this needs no knowledge of the zone it was written in, and a draft
 * written in or west of UTC is left alone:
 *   - the period start is always the 1st, so a start on the last day of a
 *     month moves to the 1st that follows;
 *   - the period end is the customer's billing_cycle_day in its month (see
 *     computeMonthlyCadenceDate), so an end that is not, while the day after it
 *     is, moves to that day. An end that matches neither (the cycle day was
 *     changed since) is left as it is.
 * Only open drafts (is_monthly_draft): issued invoices are records and keep
 * the period they were sent with.
 *
 * Run by migration 358 (actor "upgrade"), and by the portable import for an
 * archive that predates 358 (actor "import"). A second run changes nothing.
 */

const { toDateOnly } = require('./dateOnly');

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDay(value) {
  const match = DAY.exec(String(toDateOnly(value) || ''));
  return match ? { y: Number(match[1]), m: Number(match[2]) - 1, d: Number(match[3]) } : null;
}

const monthLength = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

// The day of month the cadence names (helpers.computeMonthlyCadenceDate).
function cadenceDay(y, m, cycleDay) {
  const day = Number.isFinite(Number(cycleDay)) ? Math.trunc(Number(cycleDay)) : 1;
  const len = monthLength(y, m);
  if (day > 0) return Math.min(day, len);
  if (day < 0) return Math.max(1, len + day);
  return 1;
}

function nextDay({ y, m, d }) {
  const next = new Date(Date.UTC(y, m, d + 1));
  return { y: next.getUTCFullYear(), m: next.getUTCMonth(), d: next.getUTCDate() };
}

const format = ({ y, m, d }) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// The corrected { monthly_period_start, monthly_period_end } for one draft,
// holding only the fields that move.
function repairedPeriod(row, cycleDay) {
  const updates = {};
  const start = parseDay(row.monthly_period_start);
  if (start && start.d === monthLength(start.y, start.m) && start.d !== 1) {
    updates.monthly_period_start = format(nextDay(start));
  }
  const end = parseDay(row.monthly_period_end);
  if (end && end.d !== cadenceDay(end.y, end.m, cycleDay)) {
    const next = nextDay(end);
    if (next.d === cadenceDay(next.y, next.m, cycleDay)) updates.monthly_period_end = format(next);
  }
  return updates;
}

async function repairMonthlyDraftPeriods(knex, { actor = 'upgrade' } = {}) {
  if (!(await knex.schema.hasTable('invoices'))) return 0;
  for (const column of ['is_monthly_draft', 'monthly_period_start', 'monthly_period_end']) {
    if (!(await knex.schema.hasColumn('invoices', column))) return 0;
  }
  const hasCycleDay = await knex.schema.hasColumn('customer_accounts', 'billing_cycle_day');
  const drafts = await knex('invoices as i')
    .leftJoin('customer_accounts as c', 'c.id', 'i.customer_account_id')
    .where('i.is_monthly_draft', true)
    .whereNotNull('i.monthly_period_end')
    .select('i.id', 'i.monthly_period_start', 'i.monthly_period_end',
      hasCycleDay ? 'c.billing_cycle_day' : knex.raw('1 as billing_cycle_day'));
  const { auditedUpdate } = require('../services/accountingHistory');
  let moved = 0;
  for (const row of drafts) {
    const updates = repairedPeriod(row, row.billing_cycle_day);
    if (!Object.keys(updates).length) continue;
    await auditedUpdate(knex, 'invoices', { id: row.id, is_monthly_draft: true }, updates,
      { actor, source: 'invoice.monthlyPeriod.localDay' });
    moved += 1;
  }
  return moved;
}

module.exports = { repairMonthlyDraftPeriods, repairedPeriod };
