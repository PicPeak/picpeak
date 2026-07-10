/**
 * Unit tests for the pure helpers in customerHoursService (migration
 * 129). The CRUD paths themselves are exercised end-to-end via the
 * admin/customers routes during manual QA; this file covers the
 * deterministic logic so regressions in the rate / duration / lock
 * resolution show up before they hit a real invoice.
 */

const path = require('path');
const servicePath = path.join(__dirname, '..', '..', 'src', 'services', 'customerHoursService');

// The service imports invoiceService which pulls in the DB. We don't
// need either for the pure helpers — stub the DB layer so the
// require chain doesn't try to connect to anything.
jest.mock('../../src/database/db', () => ({
  db: jest.fn(),
  logActivity: jest.fn(),
  withRetry: (fn) => fn(),
}));
jest.mock('../../src/services/invoiceService', () => ({}));

const { _internal } = require(servicePath);
const { computeDurationMinutes, resolveEffectiveRate, isEntryLocked, buildLineItemFromEntry } = _internal;

describe('computeDurationMinutes', () => {
  it('returns minute count for a basic window', () => {
    expect(computeDurationMinutes('09:00', '11:30')).toBe(150);
  });

  it('handles single-minute precision', () => {
    expect(computeDurationMinutes('09:30', '11:00')).toBe(90);
    expect(computeDurationMinutes('14:15', '14:30')).toBe(15);
  });

  it('rejects malformed input', () => {
    expect(() => computeDurationMinutes('9:00', '11:00')).toThrow(/Invalid start_time/);
    expect(() => computeDurationMinutes('09:00', '25:00')).toThrow(/Invalid end_time/);
  });

  it('rejects zero or negative duration', () => {
    expect(() => computeDurationMinutes('09:00', '09:00')).toThrow(/must be after/);
    expect(() => computeDurationMinutes('11:00', '09:00')).toThrow(/must be after/);
  });
});

describe('resolveEffectiveRate', () => {
  it('prefers the per-entry override when set', () => {
    expect(resolveEffectiveRate(
      { hourly_rate_minor_override: 20000 },
      { hourly_rate_minor: 15000 },
    )).toBe(20000);
  });

  it('falls back to the customer default when no override', () => {
    expect(resolveEffectiveRate(
      { hourly_rate_minor_override: null },
      { hourly_rate_minor: 15000 },
    )).toBe(15000);
  });

  it('throws when override, customer rate, AND install default are all unset', () => {
    expect(() => resolveEffectiveRate(
      { hourly_rate_minor_override: null },
      { hourly_rate_minor: null },
      null,
    )).toThrow(/No hourly rate/);
  });

  it('falls back to the install-wide default when override + customer rate are unset', () => {
    expect(resolveEffectiveRate(
      { hourly_rate_minor_override: null },
      { hourly_rate_minor: null },
      12000,
    )).toBe(12000);
  });

  it('customer rate wins over the install-wide default', () => {
    expect(resolveEffectiveRate(
      { hourly_rate_minor_override: null },
      { hourly_rate_minor: 15000 },
      12000,
    )).toBe(15000);
  });

  it('treats override=0 as "explicitly zero" (not null)', () => {
    // Override === 0 is unusual but legal — pro bono blocks, internal
    // tracking. Must NOT fall through to the customer default.
    expect(resolveEffectiveRate(
      { hourly_rate_minor_override: 0 },
      { hourly_rate_minor: 15000 },
    )).toBe(0);
  });
});

describe('isEntryLocked', () => {
  it('unbilled entry → not locked', () => {
    expect(isEntryLocked({ invoice_id: null }, null)).toBe(false);
  });

  it('monthly draft → not locked (still accumulating)', () => {
    expect(isEntryLocked(
      { invoice_id: 42 },
      { id: 42, is_monthly_draft: true, status: 'scheduled', scheduled_send_at: null },
    )).toBe(false);
  });

  it('standalone draft with no send time → not locked', () => {
    expect(isEntryLocked(
      { invoice_id: 42 },
      { id: 42, is_monthly_draft: false, status: 'scheduled', scheduled_send_at: null },
    )).toBe(false);
  });

  it('future-scheduled draft → not locked', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(isEntryLocked(
      { invoice_id: 42 },
      { id: 42, is_monthly_draft: false, status: 'scheduled', scheduled_send_at: future },
    )).toBe(false);
  });

  it('armed (scheduled_send_at in the past, status still scheduled) → locked', () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(isEntryLocked(
      { invoice_id: 42 },
      { id: 42, is_monthly_draft: false, status: 'scheduled', scheduled_send_at: past },
    )).toBe(true);
  });

  it('sent / paid / overdue / cancelled → locked', () => {
    for (const status of ['sent', 'paid', 'overdue', 'cancelled']) {
      expect(isEntryLocked(
        { invoice_id: 42 },
        { id: 42, is_monthly_draft: false, status, scheduled_send_at: null },
      )).toBe(true);
    }
  });

  it('entry references a deleted invoice (null) → treat as unbilled', () => {
    expect(isEntryLocked({ invoice_id: 42 }, null)).toBe(false);
  });
});

describe('buildLineItemFromEntry', () => {
  const baseEntry = {
    entry_date: '2026-05-20',
    start_time: '09:00',
    end_time: '11:30',
    duration_minutes: 150,
    description: 'Editing wedding photos',
  };

  it('formats the description per spec', () => {
    const li = buildLineItemFromEntry(baseEntry, 15000);
    expect(li.description).toBe('2026-05-20 09:00–11:30 (2.50h): Editing wedding photos');
  });

  it('omits the colon when no description', () => {
    const li = buildLineItemFromEntry({ ...baseEntry, description: null }, 15000);
    expect(li.description).toBe('2026-05-20 09:00–11:30 (2.50h)');
  });

  it('quantity is decimal hours with 2 places', () => {
    const li = buildLineItemFromEntry(baseEntry, 15000);
    expect(li.quantity).toBeCloseTo(2.5, 5);
  });

  it('line_total rounds correctly for non-clean durations', () => {
    // 15 minutes at CHF 100/h = CHF 25.00 = 2500 minor
    const li = buildLineItemFromEntry(
      { ...baseEntry, start_time: '14:00', end_time: '14:15', duration_minutes: 15 },
      10000,
    );
    expect(li.line_total_minor).toBe(2500);
  });

  it('zero-rate line items produce a zero total without exploding', () => {
    const li = buildLineItemFromEntry(baseEntry, 0);
    expect(li.line_total_minor).toBe(0);
    expect(li.unit_price_minor).toBe(0);
  });
});
