import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { contractStatusLabel } from '../contractStatus';

// Echo the key and the interpolation values, so the test sees which label
// was chosen and with what.
const t = ((key: string, _fb?: unknown, opts?: Record<string, unknown>) => (
  opts ? `${key}:${opts.signed}/${opts.total}` : key
)) as unknown as TFunction;

describe('contractStatusLabel', () => {
  it('derives "partly signed" from the signers of a contract still out for signature', () => {
    expect(contractStatusLabel(t, 'sent', { signed: 1, total: 2 })).toBe('contracts.status.partlySigned:1/2');
  });

  it('keeps the stored status when nobody or everybody has signed, or with one signer', () => {
    expect(contractStatusLabel(t, 'sent', { signed: 0, total: 2 })).toBe('contracts.status.sent');
    expect(contractStatusLabel(t, 'sent', { signed: 1, total: 1 })).toBe('contracts.status.sent');
    expect(contractStatusLabel(t, 'sent', null)).toBe('contracts.status.sent');
  });

  it('never derives anything for another status', () => {
    expect(contractStatusLabel(t, 'expired', { signed: 1, total: 2 })).toBe('contracts.status.expired');
  });
});
