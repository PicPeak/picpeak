/**
 * When an unissued invoice may still change (service options PR): the shared
 * send-time rule (isArmed) and the two lock checks that use it, the re-bill
 * unwind's isInvoiceMutable and the hours isEntryLocked. They agree on every
 * shape a stored send time can have.
 */
const { isArmed } = require('../../src/services/invoice/drafts');
const { isInvoiceMutable } = require('../../src/services/expenseService')._internal;
const { isEntryLocked } = require('../../src/services/customerHoursService')._internal;

const past = new Date(Date.now() - 60000).toISOString();
const future = new Date(Date.now() + 3600000).toISOString();

describe('isArmed', () => {
  it('no send time is not armed', () => {
    expect(isArmed(null)).toBe(false);
    expect(isArmed(undefined)).toBe(false);
    expect(isArmed('')).toBe(false);
  });
  it('a passed send time is armed, a future one is not', () => {
    expect(isArmed(past)).toBe(true);
    expect(isArmed(future)).toBe(false);
  });
  it('an unreadable send time counts as armed', () => {
    expect(isArmed('not a date')).toBe(true);
  });
  it('reads a zone-less SQLite time as UTC', () => {
    const naive = new Date(Date.now() - 60000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    expect(isArmed(naive)).toBe(true);
  });
});

describe('both lock checks agree', () => {
  const cases = [
    ['open draft', { status: 'scheduled' }, true],
    ['future send time', { status: 'scheduled', scheduled_send_at: future }, true],
    ['armed', { status: 'scheduled', scheduled_send_at: past }, false],
    ['unreadable send time', { status: 'scheduled', scheduled_send_at: 'not a date' }, false],
    ['running monthly draft, send time passed', { status: 'scheduled', is_monthly_draft: 1, scheduled_send_at: past }, true],
    // Paid or cancelled but still flagged until the scheduler's next pass.
    ['paid, still flagged monthly', { status: 'paid', is_monthly_draft: 1 }, false],
    ['cancelled, still flagged monthly', { status: 'cancelled', is_monthly_draft: true }, false],
    ['sent', { status: 'sent' }, false],
  ];
  it.each(cases)('%s', (_name, invoice, editable) => {
    expect(isInvoiceMutable(invoice)).toBe(editable);
    expect(isEntryLocked({ invoice_id: 1 }, invoice)).toBe(!editable);
  });
});
