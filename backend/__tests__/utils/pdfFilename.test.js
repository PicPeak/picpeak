/**
 * Pure-function tests for the PDF filename builder used on every
 * quote / invoice download endpoint + the PDF's internal Title
 * metadata. No mocks needed — all behavior is deterministic.
 */
const { buildPdfFilename, sanitiseSegment, customerLabel } = require('../../src/utils/pdfFilename');

describe('sanitiseSegment', () => {
  it('returns empty string for null/undefined', () => {
    expect(sanitiseSegment(null)).toBe('');
    expect(sanitiseSegment(undefined)).toBe('');
    expect(sanitiseSegment('')).toBe('');
  });

  it('replaces filesystem-hostile characters with "-"', () => {
    expect(sanitiseSegment('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
  });

  it('collapses spaces into single "-"', () => {
    expect(sanitiseSegment('ACME   GmbH   AG')).toBe('ACME-GmbH-AG');
  });

  it('collapses repeat dashes', () => {
    expect(sanitiseSegment('a-----b')).toBe('a-b');
  });

  it('trims leading + trailing dashes/dots', () => {
    expect(sanitiseSegment('--..--Hello..--..')).toBe('Hello');
  });

  it('preserves non-ASCII letters', () => {
    expect(sanitiseSegment('Müller & Söhne')).toBe('Müller-&-Söhne');
  });

  it('caps length at 80 chars by default', () => {
    const long = 'a'.repeat(120);
    expect(sanitiseSegment(long)).toHaveLength(80);
  });

  it('honors custom maxLen', () => {
    expect(sanitiseSegment('abcdefghij', 5)).toBe('abcde');
  });
});

describe('customerLabel', () => {
  it('prefers company_name over person name', () => {
    expect(customerLabel({
      company_name: 'ACME GmbH',
      first_name: 'Luca', last_name: 'Bresch',
    })).toBe('ACME-GmbH');
  });

  it('falls back to first + last when company_name is empty', () => {
    expect(customerLabel({
      company_name: '',
      first_name: 'Luca', last_name: 'Bresch',
    })).toBe('Luca-Bresch');
  });

  it('falls back to display_name when no company + no person', () => {
    expect(customerLabel({
      display_name: 'Luca B.',
    })).toBe('Luca-B');
  });

  it('falls back to email local-part as a last resort', () => {
    expect(customerLabel({
      email: 'luca@bresch.cc',
    })).toBe('luca');
  });

  it('uses "customer" when everything is missing', () => {
    expect(customerLabel({})).toBe('customer');
    expect(customerLabel(null)).toBe('customer');
  });

  it('trims whitespace before evaluating truthiness', () => {
    // company_name = "   " should NOT trigger the company branch.
    expect(customerLabel({
      company_name: '   ',
      first_name: 'Luca', last_name: 'Bresch',
    })).toBe('Luca-Bresch');
  });
});

describe('buildPdfFilename', () => {
  const customer = { company_name: 'ACME GmbH' };

  it('builds "<docNumber>_<customer>.pdf" for a regular invoice', () => {
    expect(buildPdfFilename({
      docNumber: 'R-2026-0001',
      customer,
    })).toBe('R-2026-0001_ACME-GmbH.pdf');
  });

  it('falls back to the fallback when docNumber is null (preview)', () => {
    expect(buildPdfFilename({
      docNumber: null,
      customer,
      fallback: 'invoice-preview',
    })).toBe('invoice-preview_ACME-GmbH.pdf');
  });

  it('uses "document" when both docNumber + fallback are absent', () => {
    expect(buildPdfFilename({ customer })).toBe('document_ACME-GmbH.pdf');
  });

  it('sanitises the customer half too', () => {
    expect(buildPdfFilename({
      docNumber: 'R-2026-0001',
      customer: { company_name: 'Bad/Name:Inc.' },
    })).toBe('R-2026-0001_Bad-Name-Inc.pdf');
  });

  it('always ends with .pdf', () => {
    expect(buildPdfFilename({
      docNumber: 'R-2026-0001',
      customer: {},
    })).toMatch(/\.pdf$/);
  });
});
