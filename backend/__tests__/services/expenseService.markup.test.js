/**
 * Unit tests for the accounting money logic — re-bill markup (incoming
 * invoices) and internal-expense amount/build. Pure functions via _internal.
 */
const expenseService = require('../../src/services/expenseService');

const { computeMarkupMinor, resolveMarkup, computeExpenseAmount, buildExpenseInsert, buildInboundLineItem, isInvoiceMutable, resolveTaxTreatment } = expenseService._internal;

describe('computeMarkupMinor', () => {
  it('percent of base, rounded', () => {
    expect(computeMarkupMinor(10000, { type: 'percent', percent: 10 })).toBe(1000);
    expect(computeMarkupMinor(333, { type: 'percent', percent: 10 })).toBe(33);
    expect(computeMarkupMinor(335, { type: 'percent', percent: 10 })).toBe(34);
  });
  it('flat / none', () => {
    expect(computeMarkupMinor(10000, { type: 'flat', flatMinor: 500 })).toBe(500);
    expect(computeMarkupMinor(10000, { type: 'none' })).toBe(0);
    expect(computeMarkupMinor(10000, { type: 'percent', percent: null })).toBe(0);
  });
});

describe('resolveMarkup precedence (no contract / no DB)', () => {
  it('override > source clause', async () => {
    await expect(resolveMarkup({ markupType: 'flat', markupFlatMinor: 999 }, { markupType: 'percent', markupPercent: 5 }, null, null))
      .resolves.toEqual({ type: 'percent', percent: 5, flatMinor: null });
  });
  it("source clause when no override", async () => {
    await expect(resolveMarkup({ markupType: 'flat', markupFlatMinor: 200 }, {}, null, null))
      .resolves.toEqual({ type: 'flat', percent: null, flatMinor: 200 });
  });
  it('none when nothing set', async () => {
    await expect(resolveMarkup({ markupType: 'none' }, {}, null, null))
      .resolves.toEqual({ type: 'none', percent: null, flatMinor: null });
  });
});

describe('computeExpenseAmount', () => {
  it('mileage / per-diem = quantity x rate, rounded', () => {
    expect(computeExpenseAmount('mileage', 42, 70, null)).toBe(2940); // 42 km x CHF 0.70
    expect(computeExpenseAmount('per_diem', 3, 8000, null)).toBe(24000); // 3 days x CHF 80
    expect(computeExpenseAmount('mileage', 10.5, 71, null)).toBe(746); // 745.5 -> 746
  });
  it('amount = the entered minor amount', () => {
    expect(computeExpenseAmount('amount', null, null, 5000)).toBe(5000);
  });
  it('null when quantity or rate missing', () => {
    expect(computeExpenseAmount('mileage', null, 70, null)).toBeNull();
    expect(computeExpenseAmount('mileage', 42, null, null)).toBeNull();
  });
});

describe('buildExpenseInsert (internal expense)', () => {
  it('defaults: kind=amount, disposition=eigener_aufwand, tax=domestic, status=open', () => {
    const row = buildExpenseInsert({ chfAmountMinor: 5000 }, 7);
    expect(row.kind).toBe('amount');
    expect(row.disposition).toBe('eigener_aufwand');
    expect(row.tax_treatment).toBe('domestic');
    expect(row.status).toBe('open');
    expect(row.chf_amount_minor).toBe(5000);
    expect(row.created_by_admin_id).toBe(7);
    expect(row.inbound_document_id).toBeNull();
  });

  it('mileage uses the override rate, else the settings km rate', () => {
    const withDefault = buildExpenseInsert({ kind: 'mileage', quantity: 42 }, 1, { kmRateMinor: 70 });
    expect(withDefault.rate_minor).toBe(70);
    expect(withDefault.chf_amount_minor).toBe(2940);

    const withOverride = buildExpenseInsert({ kind: 'mileage', quantity: 42, rateMinor: 100 }, 1, { kmRateMinor: 70 });
    expect(withOverride.rate_minor).toBe(100);
    expect(withOverride.chf_amount_minor).toBe(4200);
  });

  it('per_diem uses days x per-diem rate', () => {
    const row = buildExpenseInsert({ kind: 'per_diem', quantity: 2 }, 1, { perDiemRateMinor: 8000 });
    expect(row.rate_minor).toBe(8000);
    expect(row.chf_amount_minor).toBe(16000);
  });

  it('event_id null = booked to company; proof path carried', () => {
    const company = buildExpenseInsert({ kind: 'amount', chfAmountMinor: 100 }, 1, { receiptPath: '/p/x.pdf' });
    expect(company.event_id).toBeNull();
    expect(company.receipt_path).toBe('/p/x.pdf');
    const evt = buildExpenseInsert({ kind: 'amount', chfAmountMinor: 100, eventId: 9 }, 1);
    expect(evt.event_id).toBe(9);
  });
});

describe('buildInboundLineItem (re-bill line)', () => {
  it('rebill: base + percent markup, Weiterverrechnung suffix', () => {
    const li = buildInboundLineItem({ totalAmountMinor: 10000, supplierName: 'ACME' }, 'rebill', { type: 'percent', percent: 10 });
    expect(li.unit_price_minor).toBe(11000);
    expect(li.line_total_minor).toBe(11000);
    expect(li.quantity).toBe(1);
    expect(li.description).toBe('ACME (Weiterverrechnung)');
  });

  it('passthrough: distinct suffix, no markup passes through at cost', () => {
    const li = buildInboundLineItem({ totalAmountMinor: 5000, supplierName: 'SBB' }, 'durchlaufend', { type: 'none' });
    expect(li.unit_price_minor).toBe(5000);
    expect(li.description).toBe('SBB (Durchlaufende Position)');
  });

  it('falls back to net amount + generic label when total/supplier missing', () => {
    const li = buildInboundLineItem({ totalAmountMinor: null, netAmountMinor: 7000 }, 'rebill', { type: 'flat', flatMinor: 300 });
    expect(li.unit_price_minor).toBe(7300);
    expect(li.description).toBe('Weiterverrechnete Auslage (Weiterverrechnung)');
  });

  it('throws when there is no amount to re-bill', () => {
    expect(() => buildInboundLineItem({ totalAmountMinor: null, netAmountMinor: null }, 'rebill', { type: 'none' }))
      .toThrow(/no amount/i);
  });
});

describe('resolveTaxTreatment (supplier-country auto-default)', () => {
  const reclaim = ['CH', 'LI'];
  it('explicit valid treatment always wins', () => {
    expect(resolveTaxTreatment('reverse_charge_service', 'DE', reclaim)).toBe('reverse_charge_service');
    expect(resolveTaxTreatment('import_goods', 'CH', reclaim)).toBe('import_goods');
  });
  it('country in the reclaim list → domestic', () => {
    expect(resolveTaxTreatment(undefined, 'CH', reclaim)).toBe('domestic');
    expect(resolveTaxTreatment(null, 'li', reclaim)).toBe('domestic'); // case-insensitive
  });
  it('country outside the reclaim list → foreign non-reclaimable', () => {
    expect(resolveTaxTreatment(undefined, 'DE', reclaim)).toBe('foreign_vat_non_reclaimable');
    expect(resolveTaxTreatment(undefined, 'US', reclaim)).toBe('foreign_vat_non_reclaimable');
  });
  it('unknown / empty country falls back to domestic', () => {
    expect(resolveTaxTreatment(undefined, '', reclaim)).toBe('domestic');
    expect(resolveTaxTreatment(undefined, null, reclaim)).toBe('domestic');
  });
  it('an UNCONFIGURED (empty) reclaim list never auto-classifies as foreign (PR #636 #1)', () => {
    expect(resolveTaxTreatment(undefined, 'CH', [])).toBe('domestic');
    expect(resolveTaxTreatment(undefined, 'DE', [])).toBe('domestic');
    expect(resolveTaxTreatment(undefined, 'US', undefined)).toBe('domestic');
  });
  it('invalid explicit treatment is ignored (falls through to country logic)', () => {
    expect(resolveTaxTreatment('bogus', 'DE', reclaim)).toBe('foreign_vat_non_reclaimable');
  });
});

describe('isInvoiceMutable (re-categorise unwind guard)', () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const past = new Date(Date.now() - 86400000).toISOString();
  it('monthly draft and not-yet-armed scheduled are mutable', () => {
    expect(isInvoiceMutable(null)).toBe(true); // referenced invoice gone
    expect(isInvoiceMutable({ is_monthly_draft: true })).toBe(true);
    expect(isInvoiceMutable({ is_monthly_draft: 1 })).toBe(true);
    expect(isInvoiceMutable({ status: 'scheduled', scheduled_send_at: null })).toBe(true);
    expect(isInvoiceMutable({ status: 'scheduled', scheduled_send_at: future })).toBe(true);
  });
  it('armed / issued invoices are locked', () => {
    expect(isInvoiceMutable({ status: 'scheduled', scheduled_send_at: past })).toBe(false);
    expect(isInvoiceMutable({ status: 'sent' })).toBe(false);
    expect(isInvoiceMutable({ status: 'paid' })).toBe(false);
    expect(isInvoiceMutable({ status: 'cancelled' })).toBe(false);
  });
});
