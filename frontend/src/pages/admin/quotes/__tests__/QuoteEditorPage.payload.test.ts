/**
 * The quote editor's save payload on update, and the project it keeps when
 * the customer changes.
 */
import { describe, it, expect } from 'vitest';
import { buildPayload, projectAfterCustomerChange, projectAfterCustomerClear, updatePayload } from '../QuoteEditorPage';

type Form = Parameters<typeof buildPayload>[0];

const form = (over: Partial<Form> = {}): Form => ({
  customerAccountId: 3,
  customerLabel: 'Muster AG',
  customerIsPassive: false,
  language: 'de',
  currency: 'CHF',
  issueDate: '2026-09-15',
  validUntil: '',
  eventName: '',
  eventDate: '',
  eventType: '',
  bookingWorkflowId: null,
  eventTimeStart: '',
  eventTimeEnd: '',
  expectedDurationHours: '',
  paymentTermTemplateId: null,
  paymentNetDaysTemplateId: null,
  paymentTimingTemplateId: null,
  installments: null,
  vatRate: 0,
  vatCode: null,
  shippingAmount: 0,
  introText: '',
  outroText: '',
  internalNotes: '',
  ccPdfEmail: '',
  businessBankAccountId: null,
  projectId: null,
  lineItems: [],
  ...over,
});

describe('updatePayload', () => {
  // The issue date has no field in the editor and the server doesn't take it
  // on update; customer and currency stay editable on a draft.
  it('leaves out the issue date and keeps customer and currency', () => {
    const payload = updatePayload(form({ customerAccountId: 7, currency: 'EUR' }));
    expect(payload).not.toHaveProperty('issueDate');
    expect(payload).toEqual(expect.objectContaining({ customerAccountId: 7, currency: 'EUR' }));
  });

  it('still sends the issue date on create', () => {
    expect(buildPayload(form()).issueDate).toBe('2026-09-15');
  });
});

describe('projectAfterCustomerChange', () => {
  // A project holds one customer's work; the server refuses a quote whose
  // customer differs from its project's.
  it('drops the project when the customer switches to another one', () => {
    expect(projectAfterCustomerChange({ customerAccountId: 3, projectId: 12 }, 7)).toBeNull();
  });

  it('keeps it for the same customer or a first pick', () => {
    expect(projectAfterCustomerChange({ customerAccountId: 3, projectId: 12 }, 3)).toBe(12);
    expect(projectAfterCustomerChange({ customerAccountId: null, projectId: 12 }, 7)).toBe(12);
  });

  it('drops the project when the customer is cleared and another one picked', () => {
    const cleared = { customerAccountId: null, projectId: projectAfterCustomerClear({ customerAccountId: 3, projectId: 12 }) };
    expect(cleared.projectId).toBeNull();
    expect(projectAfterCustomerChange(cleared, 7)).toBeNull();
  });

  it('keeps a project chosen before any customer when the empty picker is cleared', () => {
    expect(projectAfterCustomerClear({ customerAccountId: null, projectId: 12 })).toBe(12);
  });
});
