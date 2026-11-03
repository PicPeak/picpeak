/**
 * Customer gifts: who qualifies at a milestone (migration 343).
 *
 * Pure date logic over a customer's paid invoices, kept apart from the
 * database so every boundary can be tested on its own. All dates are
 * 'YYYY-MM-DD' strings. A booking is one deal: installments of a job count
 * once, and an invoice without a deal counts as its own booking.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_RULES = Object.freeze({
  milestoneYears: [3, 5, 10],
  minBookings: 3,
  activityMinInvoices: 1,
  activityPeriodYears: 1,
  rhythmMarginMonths: 3,
  graceDays: 60,
});

const toUtc = (date) => Date.parse(`${date}T00:00:00Z`);
const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);

function addDays(date, days) {
  return fromUtc(toUtc(date) + days * DAY_MS);
}

/** Adds whole months, holding the day where the target month allows it (29 Feb → 28 Feb). */
function addMonths(date, months) {
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return fromUtc(target.getTime());
}

const addYears = (date, years) => addMonths(date, years * 12);

const daysBetween = (from, to) => Math.round((toUtc(to) - toUtc(from)) / DAY_MS);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Groups paid invoices into bookings, oldest first.
 * @param {{key: string, paidOn: string}[]} payments
 * @returns {{key: string, firstPaidOn: string, lastPaidOn: string}[]}
 */
function toBookings(payments) {
  const byKey = new Map();
  for (const { key, paidOn } of payments) {
    const booking = byKey.get(key);
    if (!booking) {
      byKey.set(key, { key, firstPaidOn: paidOn, lastPaidOn: paidOn });
    } else {
      if (paidOn < booking.firstPaidOn) booking.firstPaidOn = paidOn;
      if (paidOn > booking.lastPaidOn) booking.lastPaidOn = paidOn;
    }
  }
  return [...byKey.values()].sort((a, b) => a.firstPaidOn.localeCompare(b.firstPaidOn));
}

/** The latest milestone reached by `today`; earlier ones don't carry over. */
function latestMilestone(startDate, today, milestoneYears) {
  let latest = null;
  for (const years of [...milestoneYears].sort((a, b) => a - b)) {
    const date = addYears(startDate, years);
    if (date <= today) latest = { years, date };
  }
  return latest;
}

/** Still active through the customer's own rhythm: their typical gap plus the margin. */
function withinRhythm(bookings, milestoneDate, lastPaidOn, marginMonths) {
  if (bookings.length < 3) return false;
  const gaps = [];
  for (let i = 1; i < bookings.length; i += 1) {
    gaps.push(daysBetween(bookings[i - 1].firstPaidOn, bookings[i].firstPaidOn));
  }
  const cutoff = addMonths(addDays(milestoneDate, -Math.round(median(gaps))), -marginMonths);
  return lastPaidOn >= cutoff;
}

/**
 * Where a customer stands on their latest milestone.
 *
 * `state` is:
 *   'none'          no milestone reached, or no start date to count from
 *   'due'           qualifies
 *   'waiting'       doesn't qualify yet, still inside the grace period
 *   'not_qualified' grace period over, the admin decides
 *
 * A late payment can still qualify during the grace period, so everything is
 * read up to the earlier of today and the end of the grace period.
 */
function evaluate({ payments, startDateOverride = null, today, rules = DEFAULT_RULES }) {
  const firstPaidOn = payments.reduce(
    (first, { paidOn }) => (!first || paidOn < first ? paidOn : first),
    null,
  );
  const startDate = startDateOverride || firstPaidOn;
  if (!startDate) return { state: 'none' };

  const milestone = latestMilestone(startDate, today, rules.milestoneYears);
  if (!milestone) return { state: 'none', startDate };

  const graceEnd = addDays(milestone.date, rules.graceDays);
  const readUntil = today < graceEnd ? today : graceEnd;
  const counted = payments.filter(({ paidOn }) => paidOn <= readUntil);
  const bookings = toBookings(counted);
  const lastPaidOn = counted.reduce(
    (last, { paidOn }) => (!last || paidOn > last ? paidOn : last),
    null,
  );

  const result = {
    startDate,
    milestoneYears: milestone.years,
    milestoneDate: milestone.date,
    graceEnd,
    bookingCount: bookings.length,
    lastPaidOn,
  };

  let reason = null;
  if (bookings.length < rules.minBookings) {
    reason = 'too_few_bookings';
  } else {
    const periodStart = addYears(milestone.date, -rules.activityPeriodYears);
    const inPeriod = toBookings(counted.filter(({ paidOn }) => paidOn > periodStart)).length;
    const active = inPeriod >= rules.activityMinInvoices
      || withinRhythm(bookings, milestone.date, lastPaidOn, rules.rhythmMarginMonths);
    if (!active) reason = 'inactive';
  }

  if (!reason) return { ...result, state: 'due' };
  return { ...result, state: today <= graceEnd ? 'waiting' : 'not_qualified', reason };
}

module.exports = {
  DAY_MS, DEFAULT_RULES, addDays, addMonths, addYears, toBookings, latestMilestone, evaluate,
};
