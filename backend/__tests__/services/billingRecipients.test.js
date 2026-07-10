/**
 * Unit tests for the recipient resolver that routes invoice / Storno /
 * reminder emails to a bookkeeper address when one is configured,
 * while keeping the decision-maker (primary email) on CC.
 *
 * Pure helper, no DB, no side effects.
 */

const { resolveBillingRecipients } = require('../../src/services/_billingRecipients');

describe('resolveBillingRecipients', () => {
  it('routes to the primary email when no billing_email is set', () => {
    expect(resolveBillingRecipients({ email: 'bride@example.com' }, null))
      .toEqual({ to: 'bride@example.com', cc: undefined });
  });

  it('routes to billing_email and CCs the primary when both are set', () => {
    expect(resolveBillingRecipients({
      email: 'bride@example.com',
      billing_email: 'books@example.com',
    }, null)).toEqual({
      to: 'books@example.com',
      cc: ['bride@example.com'],
    });
  });

  it('folds the per-document cc_pdf_email into the CC list', () => {
    expect(resolveBillingRecipients({
      email: 'bride@example.com',
      billing_email: 'books@example.com',
    }, 'advisor@example.com')).toEqual({
      to: 'books@example.com',
      cc: ['bride@example.com', 'advisor@example.com'],
    });
  });

  it('uses cc_pdf_email alone when there is no billing_email', () => {
    expect(resolveBillingRecipients({
      email: 'bride@example.com',
    }, 'advisor@example.com')).toEqual({
      to: 'bride@example.com',
      cc: ['advisor@example.com'],
    });
  });

  it('does not CC the primary onto itself when billing_email equals email', () => {
    expect(resolveBillingRecipients({
      email: 'same@example.com',
      billing_email: 'same@example.com',
    }, null)).toEqual({
      to: 'same@example.com',
      cc: undefined,
    });
  });

  it('is case-insensitive when deduping addresses', () => {
    // RFC 5321 says mailbox local-parts MAY be case sensitive, but in
    // practice every mail server treats them as insensitive — and the
    // admin entering "BRIDE@example.com" in one field and
    // "bride@example.com" in another should not produce two copies.
    expect(resolveBillingRecipients({
      email: 'BRIDE@example.com',
      billing_email: 'books@example.com',
    }, 'bride@example.com')).toEqual({
      to: 'books@example.com',
      cc: ['BRIDE@example.com'],
    });
  });

  it('trims whitespace around the addresses', () => {
    expect(resolveBillingRecipients({
      email: '  bride@example.com  ',
      billing_email: '  books@example.com\n',
    }, '\tadvisor@example.com ')).toEqual({
      to: 'books@example.com',
      cc: ['bride@example.com', 'advisor@example.com'],
    });
  });

  it('treats empty-string billing_email as not set', () => {
    expect(resolveBillingRecipients({
      email: 'bride@example.com',
      billing_email: '',
    }, null)).toEqual({
      to: 'bride@example.com',
      cc: undefined,
    });
  });

  it('returns an empty To when neither email nor billing_email is set', () => {
    // Caller is responsible for surfacing this — emailProcessor's own
    // validation will reject the empty recipient. The helper just
    // refuses to crash.
    expect(resolveBillingRecipients({}, null))
      .toEqual({ to: '', cc: undefined });
  });

  it('tolerates a null customer without throwing', () => {
    // Per-doc cc alone is never promoted to To: — it stays
    // supplemental. A missing customer is a caller bug; we just refuse
    // to crash and let emailProcessor reject the empty recipient.
    expect(resolveBillingRecipients(null, 'a@b.com'))
      .toEqual({ to: '', cc: undefined });
  });
});
