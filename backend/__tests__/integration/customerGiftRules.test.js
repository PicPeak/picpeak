/**
 * Customer gifts (migration 343): who qualifies at a milestone. Pure date
 * logic, so every boundary is pinned without a database.
 */
const { DEFAULT_RULES, addMonths, addYears, evaluate } = require('../../src/services/customerGiftRules');

const paid = (...dates) => dates.map((paidOn, i) => ({ key: `deal-${i}`, paidOn }));

describe('dates', () => {
  it('holds the day where the target month allows it', () => {
    expect(addYears('2020-02-29', 3)).toBe('2023-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addYears('2024-03-01', -1)).toBe('2023-03-01');
  });
});

describe('evaluate', () => {
  it('has nothing to say before the first milestone or without a start date', () => {
    expect(evaluate({ payments: [], today: '2026-01-01' }).state).toBe('none');
    expect(evaluate({ payments: paid('2025-01-01'), today: '2026-01-01' }).state).toBe('none');
  });

  it('needs 3 bookings, and 3 is enough', () => {
    const two = evaluate({ payments: paid('2023-01-10', '2025-06-01'), today: '2026-01-20' });
    expect(two).toMatchObject({ state: 'waiting', reason: 'too_few_bookings', bookingCount: 2 });
    const three = evaluate({ payments: paid('2023-01-10', '2024-06-01', '2025-06-01'), today: '2026-01-20' });
    expect(three).toMatchObject({ state: 'due', milestoneYears: 3, milestoneDate: '2026-01-10' });
  });

  it('counts installments of one deal as a single booking', () => {
    const payments = [
      { key: 'a', paidOn: '2023-01-10' },
      { key: 'b', paidOn: '2025-03-01' },
      { key: 'b', paidOn: '2025-06-01' },
      { key: 'b', paidOn: '2025-09-01' },
    ];
    expect(evaluate({ payments, today: '2026-01-20' })).toMatchObject({ bookingCount: 2, reason: 'too_few_bookings' });
  });

  it('looks back from the milestone, not across every year of the relationship', () => {
    const payments = paid('2021-01-10', '2021-06-01', '2025-06-01');
    expect(evaluate({ payments, today: '2026-01-20' })).toMatchObject({ state: 'due', milestoneYears: 5 });
  });

  it('honours a changed activity rule', () => {
    const payments = paid('2021-01-10', '2021-02-01', '2023-06-01');
    const today = '2026-04-01';
    expect(evaluate({ payments, today, rules: { ...DEFAULT_RULES, rhythmMarginMonths: 0 } }))
      .toMatchObject({ state: 'not_qualified', reason: 'inactive' });
    expect(evaluate({
      payments, today, rules: { ...DEFAULT_RULES, rhythmMarginMonths: 0, activityPeriodYears: 3 },
    }).state).toBe('due');
  });

  it('keeps a customer who books every two years, and drops one who stopped', () => {
    const everyTwo = paid('2021-01-10', '2023-01-10', '2024-12-01');
    expect(evaluate({ payments: everyTwo, today: '2026-02-01' })).toMatchObject({ state: 'due', milestoneYears: 5 });
    const backOfYear = paid('2016-01-10', '2018-01-10', '2020-01-10');
    expect(evaluate({ payments: backOfYear, today: '2026-04-01' }))
      .toMatchObject({ state: 'not_qualified', reason: 'inactive', milestoneYears: 10 });
  });

  it('does not let a short rhythm keep a customer who has gone', () => {
    const burst = paid('2021-01-10', '2021-02-10', '2021-03-10');
    expect(evaluate({ payments: burst, today: '2026-04-01' }).reason).toBe('inactive');
  });

  it('gives the third booking in year 4 its gift at year 5, not late at year 3', () => {
    const payments = paid('2020-01-10', '2022-01-10', '2024-01-10');
    expect(evaluate({ payments: payments.slice(0, 2), today: '2023-04-01' }))
      .toMatchObject({ milestoneYears: 3, reason: 'too_few_bookings' });
    expect(evaluate({ payments, today: '2025-01-20' })).toMatchObject({ state: 'due', milestoneYears: 5 });
  });

  it('only ever offers the latest milestone', () => {
    const payments = paid('2014-01-10', '2024-01-10', '2025-06-01');
    expect(evaluate({ payments, today: '2026-01-20' }).milestoneYears).toBe(10);
  });

  it('counts a payment that arrives inside the grace period, not one after it', () => {
    const payments = paid('2021-01-10', '2021-02-10', '2021-03-10', '2023-03-11');
    const rules = { ...DEFAULT_RULES, rhythmMarginMonths: 0 };
    const late = [...payments, { key: 'late', paidOn: '2026-03-10' }];
    expect(evaluate({ payments: late, today: '2026-03-11', rules }).state).toBe('due');
    const tooLate = [...payments, { key: 'late', paidOn: '2026-03-12' }];
    expect(evaluate({ payments: tooLate, today: '2026-03-12', rules }).state).toBe('not_qualified');
  });

  it('moves from waiting to not qualified the day after the grace period', () => {
    const payments = paid('2023-01-10');
    expect(evaluate({ payments, today: '2026-03-11' }).state).toBe('waiting');
    expect(evaluate({ payments, today: '2026-03-12' }).state).toBe('not_qualified');
  });

  it('counts from a start date override', () => {
    const payments = paid('2025-01-01', '2025-06-01', '2025-09-01');
    expect(evaluate({ payments, startDateOverride: '2023-01-10', today: '2026-01-20' }))
      .toMatchObject({ state: 'due', milestoneYears: 3, startDate: '2023-01-10' });
  });
});
