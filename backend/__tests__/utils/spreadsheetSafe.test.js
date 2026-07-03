const { neutralizeSpreadsheetFormula } = require('../../src/utils/spreadsheetSafe');
const { _internal } = require('../../src/services/ledgerService');

describe('neutralizeSpreadsheetFormula — CSV/Banana formula-injection defence (PR #622 blocker 1)', () => {
  it.each([
    ['=', '=cmd|"/C calc"!A1'],
    ['+', '+1+1'],
    ['-', '-2+3'],
    ['@', '@SUM(1+1)'],
    ['tab', '\tSUM(A1)'],
    ['carriage-return', '\rSUM(A1)'],
  ])('prefixes a single quote when the cell starts with %s', (_label, payload) => {
    const out = neutralizeSpreadsheetFormula(payload);
    expect(out).toBe(`'${payload}`);
    expect(out[0]).toBe("'");
  });

  it('leaves safe values untouched', () => {
    expect(neutralizeSpreadsheetFormula('LBM-R-2026-0001')).toBe('LBM-R-2026-0001');
    expect(neutralizeSpreadsheetFormula('Acme GmbH')).toBe('Acme GmbH');
    expect(neutralizeSpreadsheetFormula('29.40')).toBe('29.40');
    // A minus only mid-string is fine — only a LEADING risky char matters.
    expect(neutralizeSpreadsheetFormula('Q-2026-0001')).toBe('Q-2026-0001');
  });

  it('coerces null/undefined to empty string', () => {
    expect(neutralizeSpreadsheetFormula(null)).toBe('');
    expect(neutralizeSpreadsheetFormula(undefined)).toBe('');
  });

  it('ledgerService.csvEscape applies the prefix AND the RFC-4180 quote wrap', () => {
    // formula cell → prefixed then quote-wrapped
    expect(_internal.csvEscape('=1+1')).toBe('"\'=1+1"');
    // embedded quotes still doubled; safe value not prefixed
    expect(_internal.csvEscape('a"b')).toBe('"a""b"');
  });
});
