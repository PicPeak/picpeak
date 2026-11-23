/**
 * The quote editor's save payload: a field the admin cleared is sent as
 * null so the save clears it. Sent as undefined it dropped out of the
 * request, the server kept the old value, and the text came back after
 * saving. Fields where "empty" means "use the default" stay undefined.
 */
import { describe, it, expect } from 'vitest';
import { buildPayload, projectAfterCustomerChange, projectAfterCustomerClear, updatePayload } from '../QuoteEditorPage';

type Form = Parameters<typeof buildPayload>[0];

const form = (over: Partial<Form> = {}): Form => ({
  customerAccountId: 3,
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
  installments: [],
  vatRate: 0,
  vatCode: null,
  shippingAmount: 0,
  introText: '',
  outroText: '',
  internalNotes: '',
  ccPdfEmail: '',
  businessBankAccountId: null,
  projectId: null,
  hours: null,
  days: null,
  lineItems: [],
  ...over,
} as unknown as Form);

describe('buildPayload', () => {
  it('sends cleared texts and event details as null, so the save clears them', () => {
    const payload = buildPayload(form());
    expect(payload).toEqual(expect.objectContaining({
      introText: null, outroText: null, internalNotes: null, ccPdfEmail: null,
      eventName: null, eventDate: null, eventTimeStart: null, eventTimeEnd: null, expectedDurationHours: null,
    }));
  });

  it('sends what the admin typed', () => {
    const payload = buildPayload(form({ introText: 'Hallo', outroText: 'Grüsse', eventName: 'Hochzeit' }));
    expect(payload).toEqual(expect.objectContaining({ introText: 'Hallo', outroText: 'Grüsse', eventName: 'Hochzeit' }));
  });

  it('leaves out an empty valid-until date, which means "use the default"', () => {
    expect(buildPayload(form()).validUntil).toBeUndefined();
  });
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
