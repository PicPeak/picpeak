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

describe('neutralizeSpreadsheetFormula — negative amounts stay numbers (security review 2026-09-29)', () => {
  // Cost rows in the tax report and storno invoices in the ledger are
  // written with a leading minus. Prefixing them turned every one into a
  // text cell, and a SUM over the imported column silently dropped them.
  it.each([
    ['-120.00'],
    ['-120,50'],
    ['-7'],
    ['-0.5'],
  ])('leaves the strict numeric %s untouched', (value) => {
    expect(neutralizeSpreadsheetFormula(value)).toBe(value);
  });

  it.each([
    ['-2+3', 'an expression'],
    ['-1e5', 'scientific notation is not a plain amount'],
    ['--1', 'double sign'],
    ['- 5', 'sign then space'],
    ['-', 'a bare minus'],
    ['-1.2.3', 'two separators'],
    ['+1+1', 'plus is never exempt'],
  ])('still neutralises %s (%s)', (value) => {
    expect(neutralizeSpreadsheetFormula(value)).toBe(`'${value}`);
  });
});
